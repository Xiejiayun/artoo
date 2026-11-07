import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { ApplicationDataBroker, type ApplicationDataInvocation } from "./application-data-broker.js";
import {
  APPLICATION_DATA_LIMITS, ApplicationDataError, ApplicationDataScopeSchema,
  type ApplicationDataErrorCode, type ApplicationDataScope, type ApplicationDataRequest,
} from "./application-data-contract.js";
import {
  APPLICATION_WIRE_LIMITS, ApplicationWireDecoder, ApplicationWireEncoder,
  type ApplicationWireResponse,
} from "./application-wire-v1.js";

/** Trusted host component only. No generated code, native owner, IPC or HTTP is started. */
export const APPLICATION_INVOCATION_LIMITS = Object.freeze({
  active: 8, invocations: 256, dataCallsPerInvocation: 32, dataCalls: 2_048,
  inputFrames: 4_096, inputBytes: 16_777_216, outputBytes: 33_554_432,
  invocationInputBytes: 1_048_576, invocationOutputBytes: 4_194_304,
});
export type ApplicationInvocationErrorCode = "closed" | "inactive" | "unauthorized" | "scope-mismatch"
  | "clock" | "limit" | "protocol" | "expired" | "aborted" | "broker-failed";
export class ApplicationInvocationError extends Error {
  constructor(readonly code: ApplicationInvocationErrorCode) {
    super(`Application invocation rejected: ${code}`);
    this.name = "ApplicationInvocationError";
  }
}
declare const invocationBrand: unique symbol;
export interface ApplicationInvocationHandle { readonly [invocationBrand]: true }
export interface ApplicationInvocationPolicy {
  readonly purpose: "application" | "health" | "peer";
  readonly access: "read" | "write";
  readonly lifetime_ms: number;
  readonly signal?: AbortSignal;
}
export type ApplicationInvocationEvent =
  | { readonly kind: "send"; readonly frame: Buffer }
  | { readonly kind: "response"; readonly invocation: ApplicationInvocationHandle; readonly response: ApplicationWireResponse }
  | { readonly kind: "terminated"; readonly invocation: ApplicationInvocationHandle; readonly reason: "cancelled" | "aborted" | "expired" };
interface Invocation {
  readonly handle: ApplicationInvocationHandle;
  readonly callId: string;
  readonly access: "read" | "write";
  readonly expires: number;
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  readonly dataIds: Set<string>;
  active: boolean;
  inputBytes: number;
  outputBytes: number;
}
const limits = APPLICATION_INVOCATION_LIMITS;
const sameScope = (left: ApplicationDataScope, right: ApplicationDataScope) =>
  left.product_id === right.product_id && left.data_generation === right.data_generation
  && left.service_generation === right.service_generation && left.artifact_digest === right.artifact_digest;

/** One bridge per original data-channel lifetime. All methods except receive() are
 * host control APIs. A caller must keep this object and the broker out of product code. */
export class ApplicationInvocationBridge {
  private readonly encoder = new ApplicationWireEncoder("host-to-application");
  private readonly decoder = new ApplicationWireDecoder("application-to-host");
  private readonly handles = new WeakMap<ApplicationInvocationHandle, Invocation>();
  private readonly active = new Map<string, Invocation>();
  private readonly session = randomUUID();
  private readonly scope: ApplicationDataScope;
  private readonly header = Buffer.alloc(4);
  private headerUsed = 0;
  private remaining: number | undefined;
  private frameSize = 0;
  private started = 0;
  private dataCalls = 0;
  private inputFrames = 0;
  private inputBytes = 0;
  private outputBytes = 0;
  private lastClock = 0;
  private closed = false;
  private failure: ApplicationInvocationError | undefined;

  constructor(private readonly broker: ApplicationDataBroker, scope: ApplicationDataScope,
    private readonly maximumAccess: "read" | "write", private readonly clock: () => number = () => performance.now()) {
    const parsed = ApplicationDataScopeSchema.safeParse(scope);
    if (!parsed.success || (maximumAccess !== "read" && maximumAccess !== "write"))
      throw new ApplicationInvocationError("unauthorized");
    this.scope = Object.freeze(parsed.data);
    this.checkSession();
  }

  /** requestJson is a request DTO, not an envelope. IDs and authority are host-owned. */
  begin(requestJson: string, policy: ApplicationInvocationPolicy): Readonly<{ invocation: ApplicationInvocationHandle; frame: Buffer }> {
    const now = this.checkSession();
    if (!["application", "health", "peer"].includes(policy.purpose) || !["read", "write"].includes(policy.access)
      || (policy.access === "write" && (this.maximumAccess !== "write" || policy.purpose !== "application"))
      || (policy.purpose !== "application" && this.maximumAccess !== "read")
      || !Number.isSafeInteger(policy.lifetime_ms) || policy.lifetime_ms < 1
      || policy.lifetime_ms > APPLICATION_DATA_LIMITS.permitMilliseconds || typeof requestJson !== "string")
      return this.fail("unauthorized");
    if (policy.signal?.aborted) return this.fail("aborted");
    if (this.active.size >= limits.active || this.started >= limits.invocations) return this.fail("limit");
    const parsedRequest = this.parseRequest(requestJson);
    const handle = Object.freeze({}) as ApplicationInvocationHandle;
    const controller = new AbortController();
    const state: Invocation = {
      handle, callId: `${this.session}:${++this.started}`, access: policy.access, expires: now + policy.lifetime_ms,
      controller, signal: policy.signal ? AbortSignal.any([controller.signal, policy.signal]) : controller.signal,
      dataIds: new Set(), active: true, inputBytes: 0, outputBytes: 0,
    };
    // Parse request text independently: concatenating it into an envelope would permit
    // duplicate-key injection of call_id. Only parsed data reaches JSON.stringify.
    const frame = this.emit(JSON.stringify({ kind: "invoke", call_id: state.callId, request: parsedRequest }), state);
    this.handles.set(handle, state); this.active.set(state.callId, state);
    return Object.freeze({ invocation: handle, frame });
  }

  /** Called with bytes from the original application-to-host stream, in order.
   * A later rejected frame does NOT roll back an earlier committed database request. */
  receive(chunk: Uint8Array): readonly ApplicationInvocationEvent[] {
    this.checkSession();
    if (!(chunk instanceof Uint8Array)) return this.fail("protocol");
    this.inputBytes += chunk.byteLength; // Count malformed and unknown-call input too.
    if (this.inputBytes > limits.inputBytes) return this.fail("limit");
    if (chunk.byteLength > APPLICATION_WIRE_LIMITS.chunkBytes) return this.fail("protocol");
    const sizes = this.measureFrames(chunk);
    let messages;
    try { messages = this.decoder.push(chunk); } catch { return this.fail("protocol"); }
    if (messages.length !== sizes.length) return this.fail("protocol");
    const events: ApplicationInvocationEvent[] = [];
    for (const [index, message] of messages.entries()) {
      const state = "call_id" in message ? this.active.get(message.call_id) : undefined;
      if (!state) return this.fail("inactive");
      this.requireActive(state, this.checkSession());
      state.inputBytes += sizes[index]!;
      if (state.inputBytes > limits.invocationInputBytes) return this.fail("limit");
      if (message.kind === "response") {
        this.end(state);
        events.push(Object.freeze({ kind: "response", invocation: state.handle, response: message.response }));
      } else if (message.kind === "data-call") {
        if (state.dataIds.has(message.data_call_id)) return this.fail("protocol");
        if (state.dataIds.size >= limits.dataCallsPerInvocation || this.dataCalls >= limits.dataCalls) return this.fail("limit");
        state.dataIds.add(message.data_call_id); this.dataCalls++;
        const frame = this.data(state, message.data_call_id, message.request_json);
        events.push(Object.freeze({ kind: "send", frame }));
      } else return this.fail("protocol");
    }
    return Object.freeze(events);
  }

  cancel(handle: ApplicationInvocationHandle): readonly ApplicationInvocationEvent[] {
    this.checkSession();
    const state = this.handles.get(handle);
    if (!state?.active) return this.fail("inactive");
    return Object.freeze(this.terminate(state, "cancelled"));
  }

  /** The owner schedules polling. These are synchronous checks, not hard deadlines. */
  poll(): readonly ApplicationInvocationEvent[] {
    const now = this.checkSession();
    const events: ApplicationInvocationEvent[] = [];
    for (const state of this.active.values()) {
      if (state.signal.aborted) events.push(...this.terminate(state, "aborted"));
      else if (now >= state.expires) events.push(...this.terminate(state, "expired"));
    }
    return Object.freeze(events);
  }

  /** Revokes host invocations; the returned shutdown frame is not a process-stop receipt. */
  close(): Buffer {
    this.checkSession();
    for (const state of this.active.values()) this.end(state);
    const frame = this.emit('{"kind":"shutdown"}');
    this.closed = true;
    return frame;
  }

  /** A caller declaration of framing EOF only. It proves no pipe, Job or process closure. */
  finishInput(): void {
    this.checkSession();
    try { this.decoder.finish(); } catch { return this.fail("protocol"); }
    if (this.active.size) return this.fail("protocol");
    this.closed = true;
  }

  private checkSession(): number {
    if (this.failure) throw this.failure;
    if (this.closed) throw new ApplicationInvocationError("closed");
    let now;
    try { now = this.clock(); } catch { return this.fail("clock"); }
    if (!Number.isFinite(now) || now < this.lastClock) return this.fail("clock");
    this.lastClock = now;
    let current;
    try { current = this.broker.getScope(); } catch { return this.fail("broker-failed"); }
    if (!sameScope(current, this.scope)) return this.fail("scope-mismatch");
    return now;
  }
  private requireActive(state: Invocation, now: number): void {
    if (!state.active) return this.fail("inactive");
    if (state.signal.aborted) return this.fail("aborted");
    if (now >= state.expires) return this.fail("expired");
  }
  private end(state: Invocation): void {
    state.active = false; this.active.delete(state.callId); state.controller.abort();
  }
  private fail(code: ApplicationInvocationErrorCode): never {
    this.failure ??= new ApplicationInvocationError(code);
    for (const state of this.active.values()) this.end(state);
    this.closed = true;
    throw this.failure;
  }
  private terminate(state: Invocation, reason: "cancelled" | "aborted" | "expired"): ApplicationInvocationEvent[] {
    this.end(state);
    const frame = this.emit(JSON.stringify({ kind: "cancel", call_id: state.callId }), state);
    return [Object.freeze({ kind: "send", frame }), Object.freeze({ kind: "terminated", invocation: state.handle, reason })];
  }
  private emit(json: string, state?: Invocation): Buffer {
    let frame;
    try { frame = this.encoder.encode(json); } catch { return this.fail("protocol"); }
    if (this.outputBytes + frame.length > limits.outputBytes
      || (state && state.outputBytes + frame.length > limits.invocationOutputBytes)) return this.fail("limit");
    this.outputBytes += frame.length;
    if (state) state.outputBytes += frame.length;
    return frame;
  }
  private data(state: Invocation, dataId: string, json: string): Buffer {
    // Reserve room for any legal wire reply before authorizing a transaction.
    // This is conservative near the quota; it never promises a successful commit is undone.
    const maximum = APPLICATION_WIRE_LIMITS.frameBytes + 4;
    if (this.outputBytes + maximum > limits.outputBytes || state.outputBytes + maximum > limits.invocationOutputBytes)
      return this.fail("limit");
    let reply: string | undefined, code: ApplicationDataErrorCode | undefined;
    let permit: ApplicationDataInvocation | undefined;
    try {
      const request = this.broker.describeRequest(json);
      if (request.requires_write && state.access !== "write") code = "unauthorized";
      else if (!this.replyGraphFits(json)) code = "limit";
      else {
        const now = this.checkSession(); this.requireActive(state, now);
        const lifetime = Math.floor(state.expires - now);
        if (lifetime < 1) return this.fail("expired");
        permit = this.broker.grantInvocation({ scope: this.scope, request_digest: request.request_digest,
          access: state.access, lifetime_ms: lifetime, signal: state.signal });
        reply = JSON.stringify(this.broker.execute(permit, json));
      }
    } catch (error) {
      if (error instanceof ApplicationInvocationError) throw error;
      if (!(error instanceof ApplicationDataError)) return this.fail("broker-failed");
      if (error.code === "scope-mismatch" || error.code === "expired" || error.code === "aborted") return this.fail(error.code);
      if (!["invalid-request", "limit", "idempotency-conflict"].includes(error.code)) return this.fail("broker-failed");
      code = error.code;
    } finally { if (permit) this.broker.revoke(permit); }
    // Expiration/output rejection after COMMIT is indeterminate delivery, never rollback.
    this.requireActive(state, this.checkSession());
    return this.emit(JSON.stringify(reply === undefined
      ? { kind: "data-error", call_id: state.callId, data_call_id: dataId, code }
      : { kind: "data-result", call_id: state.callId, data_call_id: dataId, reply_json: reply }), state);
  }
  private replyGraphFits(json: string): boolean {
    // Called only after the actual broker's describeRequest validated this same text.
    // Bound a possible reply from declared row/column limits before granting writes.
    // The reply/result/scope objects count 23 entries. A selected row contributes
    // one array entry and two per column; a transaction operation adds 7 entries
    // (mutation), or 5 plus its rows (query). Conflict/replay cannot add a new shape.
    const request = JSON.parse(json) as ApplicationDataRequest;
    const rows = (query: Extract<ApplicationDataRequest, { kind: "read" }>["query"]) =>
      query.limit * (2 * query.columns.length + 1);
    const entries = 23 + (request.kind === "read" ? rows(request.query)
      : request.operations.reduce((total, operation) => total + (operation.kind === "query" ? 5 + rows(operation) : 7), 0));
    return entries <= APPLICATION_WIRE_LIMITS.jsonEntries;
  }
  private parseRequest(json: string): unknown {
    // Bound the standalone input before JSON.parse. The existing encoder then applies
    // the complete envelope's graph, Unicode and exact request-DTO restrictions.
    if (Buffer.byteLength(json, "utf8") > APPLICATION_WIRE_LIMITS.frameBytes) return this.fail("protocol");
    let depth = 0, quoted = false, escaped = false;
    for (const character of json) {
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === "{" || character === "[") {
        if (++depth > APPLICATION_WIRE_LIMITS.jsonDepth) return this.fail("protocol");
      } else if (character === "}" || character === "]") {
        if (--depth < 0) return this.fail("protocol");
      }
    }
    if (quoted || depth !== 0) return this.fail("protocol");
    try { return JSON.parse(json); } catch { return this.fail("protocol"); }
  }
  private measureFrames(chunk: Uint8Array): number[] {
    // The decoder owns format validation. This bounded parallel length counter attributes
    // exact raw frame bytes (including whitespace) to each decoded invocation.
    const sizes: number[] = [];
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (this.headerUsed < 4) {
        const amount = Math.min(4 - this.headerUsed, chunk.byteLength - offset);
        this.header.set(chunk.subarray(offset, offset + amount), this.headerUsed);
        this.headerUsed += amount; offset += amount;
        if (this.headerUsed < 4) continue;
        this.frameSize = this.header.readUInt32BE(0);
        if (++this.inputFrames > limits.inputFrames) return this.fail("limit");
        if (this.frameSize === 0 || this.frameSize > APPLICATION_WIRE_LIMITS.frameBytes) return this.fail("protocol");
        this.remaining = this.frameSize;
      }
      const amount = Math.min(this.remaining!, chunk.byteLength - offset);
      this.remaining! -= amount; offset += amount;
      if (this.remaining === 0) {
        sizes.push(this.frameSize + 4); this.headerUsed = 0; this.remaining = undefined;
      }
    }
    return sizes;
  }
}
