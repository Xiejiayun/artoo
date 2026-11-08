import type { ApplicationDataErrorCode } from "./application-data-contract.js";
import type { ApplicationDataReply } from "./application-data-broker.js";
import type { ApplicationHostMessage, ApplicationWireRequest, ApplicationWireResponse } from "./application-wire-v1.js";

// Evaluate this fixed bootstrap before product modules, inside the eventual isolated
// guest. Type imports are erased; no Node module or host callback is used at runtime.
const parse = JSON.parse, stringify = JSON.stringify, keys = Object.keys, own = Object.hasOwn;
const create = Object.create, freeze = Object.freeze, setPrototype = Object.setPrototypeOf, array = Array.isArray;
const finite = Number.isFinite, apply = Reflect.apply, GuestPromise = Promise, GuestError = Error;
const charCode = Function.prototype.call.bind(String.prototype.charCodeAt) as (text: string, index: number) => number;
const test = Function.prototype.call.bind(RegExp.prototype.test) as (pattern: RegExp, text: string) => boolean;
const resolve = Promise.resolve.bind(Promise) as (value?: unknown) => Promise<unknown>;
const then = Function.prototype.call.bind(Promise.prototype.then) as
  (promise: Promise<unknown>, yes: (value: unknown) => unknown, no?: (reason: unknown) => unknown) => Promise<unknown>;

/** Portable serialization/state ceilings corresponding to the existing wire and
 * invocation contracts. They grant no authority and do not replace host limits. */
export const APPLICATION_RUNTIME_GUEST_LIMITS = freeze({
  messageBytes: 1_048_576, bodyBytes: 262_144, dataRequestBytes: 65_536, dataReplyBytes: 262_144,
  jsonDepth: 32, jsonEntries: 16_384, objectEntries: 128, arrayEntries: 1_024,
  active: 8, invocations: 256, dataCallsPerInvocation: 32, dataCalls: 2_048,
  inputMessages: 4_096, inputBytes: 33_554_432,
  queuedMessages: 256, queuedBytes: 16_777_216, outputBytes: 16_777_216, drainMessages: 64,
});
const limits = APPLICATION_RUNTIME_GUEST_LIMITS;
const identity = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const dataErrors = freeze({ "invalid-schema": true, "invalid-request": true, "scope-mismatch": true,
  unauthorized: true, expired: true, revoked: true, aborted: true, "idempotency-conflict": true,
  limit: true, "storage-unavailable": true, closed: true });
type Failure = "protocol" | "limit" | "pending-data";
const invalid = (): never => { throw new GuestError("Invalid application guest data"); };
const dictionary = <T>(): Record<string, T> => create(null) as Record<string, T>;

/** Actual UTF-8 bytes and JSON string bytes, rejecting malformed UTF-16. */
function stringBytes(value: string, json = false): number {
  let bytes = json ? 2 : 0;
  for (let index = 0; index < value.length; index++) {
    const code = charCode(value, index);
    if (json && (code === 34 || code === 92)) bytes += 2;
    else if (json && code < 32) bytes += code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6;
    else if (code < 128) bytes++;
    else if (code < 2048) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const low = charCode(value, ++index); if (!(low >= 0xdc00 && low <= 0xdfff)) return invalid(); bytes += 4;
    } else if (code >= 0xdc00 && code <= 0xdfff) return invalid();
    else bytes += 3;
  }
  return bytes;
}

// Snapshot before stringify: no JSON coercion of NaN/undefined, no toJSON hooks,
// cycles, sparse arrays or unbounded depth/entries. Getters/proxies can run here
// only inside the guest; the external owner must bound their CPU and allocation.
function snapshot(value: unknown, maximum: number, reservedEntries = 0): unknown {
  let bytes = 0, entries = 1 + reservedEntries;
  const ancestors: object[] = [];
  const charge = (count: number) => { bytes += count; if (bytes > maximum) invalid(); };
  const visit = (item: unknown, depth: number): unknown => {
    if (item === null) { charge(4); return null; }
    if (typeof item === "boolean") { charge(item ? 4 : 5); return item; }
    if (typeof item === "string") { if (item.length > maximum) return invalid(); charge(stringBytes(item, true)); return item; }
    if (typeof item === "number" && finite(item)) { charge(stringify(item).length); return item; }
    if (typeof item !== "object" || item === null || depth >= limits.jsonDepth) return invalid();
    for (let index = 0; index < ancestors.length; index++) if (ancestors[index] === item) return invalid();
    const isArray = array(item), names = keys(item);
    if (names.length > (isArray ? limits.arrayEntries : limits.objectEntries)) return invalid();
    if (isArray && (item as unknown[]).length !== names.length) return invalid();
    entries += names.length * (isArray ? 1 : 2); if (entries > limits.jsonEntries) return invalid();
    const copy: Record<string, unknown> = isArray ? setPrototype([], null) as unknown as Record<string, unknown> : dictionary();
    charge(2 + (names.length ? names.length - 1 : 0));
    ancestors[ancestors.length] = item;
    for (let index = 0; index < names.length; index++) {
      const name = names[index]!;
      if (isArray) { if (name !== "" + index) return invalid(); }
      else charge(stringBytes(name, true) + 1);
      copy[name] = visit((item as Record<string, unknown>)[name], depth + 1);
    }
    ancestors.length--; return freeze(copy);
  };
  return visit(value, 0);
}
function json(text: unknown, maximum: number): unknown {
  if (typeof text !== "string" || text.length > maximum || stringBytes(text) > maximum) return invalid();
  let depth = 0, quoted = false, escaped = false;
  for (let index = 0; index < text.length; index++) {
    const code = charCode(text, index);
    if (quoted) { if (escaped) escaped = false; else if (code === 92) escaped = true; else if (code === 34) quoted = false; }
    else if (code === 34) quoted = true;
    else if (code === 123 || code === 91) { if (++depth > limits.jsonDepth) return invalid(); }
    else if (code === 125 || code === 93) { if (--depth < 0) return invalid(); }
  }
  if (quoted || depth !== 0) return invalid();
  const value: unknown = parse(text);
  snapshot(value, maximum);
  // The safe serialization copy has no prototypes/toJSON hooks. SDK consumers
  // must instead receive normal JSON arrays with map/iteration intact. These
  // values came only from JSON.parse, so freezing invokes no product getters.
  const freezeParsed = (item: unknown): void => {
    if (item === null || typeof item !== "object") return;
    for (const key of keys(item)) freezeParsed((item as Record<string, unknown>)[key]);
    freeze(item);
  };
  freezeParsed(value); return value;
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || array(value)) return invalid();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, expected: readonly string[]): void {
  if (keys(value).length !== expected.length) return invalid();
  for (const key of expected) if (!own(value, key)) invalid();
}
function id(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 128 || !test(identity, value)) invalid();
}
function hostMessage(text: string): ApplicationHostMessage {
  const item = record(json(text, limits.messageBytes));
  if (item.kind === "shutdown") exact(item, ["kind"]);
  else {
    id(item.call_id);
    if (item.kind === "invoke") {
      exact(item, ["kind", "call_id", "request"]);
      const request = record(item.request); exact(request, ["request_id", "method", "path", "query", "body"]); id(request.request_id);
      if (request.method !== "GET" && request.method !== "POST" && request.method !== "PATCH" && request.method !== "DELETE") invalid();
      if (typeof request.path !== "string" || request.path.length > 2048
        || !test(/^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*\/?)?$/u, request.path)
        || test(/(?:^|\/)\.{1,2}(?:\/|$)/u, request.path)) invalid();
      const query = record(request.query); if (keys(query).length > 32) invalid();
      for (const key of keys(query)) if (!test(/^[A-Za-z0-9_.-]{1,64}$/u, key)
        || typeof query[key] !== "string" || stringBytes(query[key] as string) > 4096) invalid();
      snapshot(request.body, limits.bodyBytes);
    } else if (item.kind === "cancel") exact(item, ["kind", "call_id"]);
    else if (item.kind === "data-result" || item.kind === "data-error") {
      id(item.data_call_id);
      if (item.kind === "data-result") {
        exact(item, ["kind", "call_id", "data_call_id", "reply_json"]); record(json(item.reply_json, limits.dataReplyBytes));
      } else {
        exact(item, ["kind", "call_id", "data_call_id", "code"]);
        if (typeof item.code !== "string" || !own(dataErrors, item.code)) invalid();
      }
    } else invalid();
  }
  return item as unknown as ApplicationHostMessage;
}
function response(value: unknown): ApplicationWireResponse {
  const item = record(snapshot(value, limits.messageBytes)); exact(item, ["status", "body"]);
  const status = item.status;
  if (status !== 200 && status !== 201 && status !== 204 && status !== 400 && status !== 404
    && status !== 409 && status !== 422 && status !== 500) invalid();
  if (status === 204 && item.body !== null) invalid();
  snapshot(item.body, limits.bodyBytes); return item as unknown as ApplicationWireResponse;
}
function dataError(code: ApplicationDataErrorCode): Error & { code: ApplicationDataErrorCode } {
  const error = new GuestError("Application data request failed: " + code) as Error & { code: ApplicationDataErrorCode };
  error.name = "ApplicationDataError"; error.code = code; return error;
}

export interface ApplicationRuntimeGuestContext {
  readonly data: { readonly execute: (request: unknown) => Promise<ApplicationDataReply> };
}
export type ApplicationRuntimeGuestHandler = (request: ApplicationWireRequest, context: ApplicationRuntimeGuestContext) =>
  ApplicationWireResponse | PromiseLike<ApplicationWireResponse>;
export interface ApplicationRuntimeGuest {
  /** Existing message fields only. The trusted external owner owns binary framing and sequence numbers. */
  receive(messageJson: string): void;
  /** FIFO bounded JSON messages, to be validated/framed by the existing host wire encoder. */
  drain(): readonly string[];
  readonly status: "open" | "shutdown" | "failed";
}
interface Pending { resolve(value: ApplicationDataReply): void; reject(reason: Error): void; handedOff: boolean }
interface Invocation { readonly id: string; pending: Record<string, Pending>; issued: number; active: boolean; cancelled: boolean }
interface Queued { readonly callId: string; readonly dataId?: string; readonly text: string; readonly bytes: number }

/** Called inside the guest with the admitted guest-local export, never a Node-evaluated product function.
 * This is a data/Promise adapter, not module admission, an authorization engine or a sandbox. */
export function createApplicationRuntimeGuest(handle: ApplicationRuntimeGuestHandler): ApplicationRuntimeGuest {
  if (typeof handle !== "function") throw new GuestError("Application guest handler unavailable");
  const active = dictionary<Invocation>(), used = dictionary<boolean>(), cancelled = dictionary<Record<string, boolean>>();
  let activeCount = 0, started = 0, dataCalls = 0, outputBytes = 0, queuedBytes = 0, inputMessages = 0, inputBytes = 0;
  let queue: Queued[] = [], failure: Failure | undefined, stopped = false;
  const failureError = () => new GuestError("Application guest failed: " + (failure ?? "closed"));
  function retire(state: Invocation, code: "aborted" | "closed"): void {
    state.active = false; state.cancelled = code === "aborted";
    for (const dataId of keys(state.pending)) state.pending[dataId]!.reject(dataError(code));
    state.pending = dictionary(); delete active[state.id]; activeCount--;
  }
  function stop(code?: Failure): void {
    failure ??= code; stopped = true; queue = []; queuedBytes = 0;
    for (const callId of keys(active)) retire(active[callId]!, "closed");
  }
  function enqueue(callId: string, message: unknown, dataId?: string): void {
    // Reserve the two host-added version/sequence keys in the complete wire graph.
    const text = stringify(snapshot(message, limits.messageBytes - 64, 4)), bytes = stringBytes(text);
    if (queue.length >= limits.queuedMessages || queuedBytes + bytes > limits.queuedBytes || outputBytes + bytes > limits.outputBytes) {
      stop("limit"); throw failureError();
    }
    queue[queue.length] = { callId, dataId, text, bytes }; queuedBytes += bytes; outputBytes += bytes;
  }
  function execute(state: Invocation, request: unknown): Promise<ApplicationDataReply> {
    const result = new GuestPromise<ApplicationDataReply>((yes, no) => {
      try {
        if (!state.active || stopped) { no(dataError(state.cancelled ? "aborted" : "closed")); return; }
        const requestJson = stringify(record(snapshot(request, limits.dataRequestBytes)));
        // Generated getters may reenter this SDK while snapshotting; recheck all state afterwards.
        if (!state.active || stopped) { no(dataError(state.cancelled ? "aborted" : "closed")); return; }
        if (state.issued >= limits.dataCallsPerInvocation || dataCalls >= limits.dataCalls) { no(dataError("limit")); return; }
        const dataId = "d" + (++state.issued); dataCalls++;
        state.pending[dataId] = { resolve: yes, reject: no, handedOff: false };
        enqueue(state.id, { kind: "data-call", call_id: state.id, data_call_id: dataId, request_json: requestJson }, dataId);
      } catch { no(dataError(stopped ? "closed" : "invalid-request")); }
    });
    // Mark system-triggered cancellation rejections as observed even when product code
    // abandons a Promise. The original Promise still rejects for its actual consumer.
    void then(result, () => undefined, () => undefined); return result;
  }
  function complete(state: Invocation, value: unknown, rejected = false): void {
    if (!state.active || stopped) return;
    if (keys(state.pending).length) { stop("pending-data"); return; }
    let reply: ApplicationWireResponse;
    try {
      if (rejected) invalid(); reply = response(value);
      // Validate the final message depth/entries too, including the host envelope.
      // A malformed handler result gets a fixed 500; lifetime queue exhaustion is separate.
      snapshot({ kind: "response", call_id: state.id, response: reply }, limits.messageBytes - 64, 4);
    }
    catch { reply = { status: 500, body: { error: "application_handler_failed" } }; }
    if (!state.active || stopped) return;
    if (keys(state.pending).length) { stop("pending-data"); return; }
    try {
      enqueue(state.id, { kind: "response", call_id: state.id, response: reply });
      retire(state, "closed");
    } catch { if (!stopped) stop("limit"); }
  }
  function accept(message: ApplicationHostMessage): void {
    if (message.kind === "shutdown") { stop(); return; }
    const state = active[message.call_id];
    if (message.kind === "invoke") {
      if (own(used, message.call_id)) invalid();
      if (activeCount >= limits.active || started >= limits.invocations) { stop("limit"); throw failureError(); }
      used[message.call_id] = true; started++; activeCount++;
      const invocation: Invocation = { id: message.call_id, pending: dictionary(), issued: 0, active: true, cancelled: false };
      active[message.call_id] = invocation;
      const context = freeze({ data: freeze({ execute: (request: unknown) => execute(invocation, request) }) });
      const work = then(resolve(), () => invocation.active && !stopped ? apply(handle, undefined, [message.request, context]) : undefined);
      void then(work, value => complete(invocation, value), () => complete(invocation, undefined, true));
    } else if (message.kind === "cancel") {
      if (!own(used, message.call_id)) invalid();
      if (state) {
        const pending = dictionary<boolean>();
        for (const dataId of keys(state.pending)) if (state.pending[dataId]!.handedOff) pending[dataId] = true;
        cancelled[message.call_id] = pending; retire(state, "aborted");
      }
      const retained: Queued[] = [];
      for (const item of queue) {
        if (item.callId === message.call_id) queuedBytes -= item.bytes;
        else retained[retained.length] = item;
      }
      queue = retained;
    } else {
      if (!state) {
        const late = cancelled[message.call_id];
        if (!late || !own(late, message.data_call_id)) return invalid();
        delete late[message.data_call_id]; return; // A cancelled Promise is never resumed.
      }
      const pending = state.pending[message.data_call_id]; if (!pending || !pending.handedOff) return invalid();
      delete state.pending[message.data_call_id];
      if (message.kind === "data-error") pending.reject(dataError(message.code));
      else pending.resolve(record(json(message.reply_json, limits.dataReplyBytes)) as unknown as ApplicationDataReply);
    }
  }
  return freeze({
    receive(messageJson: string) {
      if (stopped) throw failureError();
      try {
        if (typeof messageJson !== "string" || messageJson.length > limits.messageBytes) invalid();
        inputMessages++; inputBytes += stringBytes(messageJson);
        if (inputMessages > limits.inputMessages || inputBytes > limits.inputBytes) { stop("limit"); throw failureError(); }
        accept(hostMessage(messageJson));
      }
      catch { if (!stopped) stop("protocol"); throw failureError(); }
    },
    drain() {
      if (failure) throw failureError();
      const result: string[] = [], retained: Queued[] = [];
      for (let index = 0; index < queue.length; index++) {
        const item = queue[index]!;
        if (index < limits.drainMessages) {
          if (item.dataId) {
            const pending = active[item.callId]?.pending[item.dataId];
            if (!pending) { stop("protocol"); throw failureError(); }
            pending.handedOff = true; // Returned to the owner, not proof of OS transport or broker execution.
          }
          result[result.length] = item.text; queuedBytes -= item.bytes;
        }
        else retained[retained.length] = item;
      }
      queue = retained; return freeze(result);
    },
    get status() { return failure ? "failed" as const : stopped ? "shutdown" as const : "open" as const; },
  });
}
