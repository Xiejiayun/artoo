import { APPLICATION_DATA_LIMITS, type ApplicationDataErrorCode } from "./application-data-contract.js";

/** Internal data-channel format only. It grants no process, storage or release authority. */
export const APPLICATION_WIRE_LIMITS = Object.freeze({
  frameBytes: 1_048_576, chunkBytes: 65_536, retainedBytes: 1_048_580,
  jsonDepth: 32, jsonEntries: 16_384, objectEntries: 128, arrayEntries: 1_024,
  bodyBytes: 262_144, queryEntries: 32, queryValueBytes: 4_096,
  maximumSequence: 4_294_967_295,
});
export type ApplicationWireDirection = "host-to-application" | "application-to-host";
export type ApplicationWireJson = null | boolean | number | string | readonly ApplicationWireJson[]
  | { readonly [key: string]: ApplicationWireJson };
export interface ApplicationWireRequest {
  readonly request_id: string; readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly path: string; readonly query: Readonly<Record<string, string>>; readonly body: ApplicationWireJson;
}
export interface ApplicationWireResponse {
  readonly status: 200 | 201 | 204 | 400 | 404 | 409 | 422 | 500; readonly body: ApplicationWireJson;
}
export type ApplicationHostMessage =
  | { readonly kind: "invoke"; readonly call_id: string; readonly request: ApplicationWireRequest }
  | { readonly kind: "data-result"; readonly call_id: string; readonly data_call_id: string; readonly reply_json: string }
  | { readonly kind: "data-error"; readonly call_id: string; readonly data_call_id: string; readonly code: ApplicationDataErrorCode }
  | { readonly kind: "cancel"; readonly call_id: string }
  | { readonly kind: "shutdown" };
export type ApplicationChildMessage =
  | { readonly kind: "response"; readonly call_id: string; readonly response: ApplicationWireResponse }
  | { readonly kind: "data-call"; readonly call_id: string; readonly data_call_id: string; readonly request_json: string };
export type ApplicationWireMessage = ApplicationHostMessage | ApplicationChildMessage;
export type ApplicationWireEnvelope = ApplicationWireMessage & { readonly version: 1; readonly sequence: number };
export type ApplicationWireErrorCode = "invalid-message" | "invalid-json" | "invalid-utf8" | "json-limit"
  | "frame-limit" | "chunk-limit" | "sequence" | "truncated" | "closed";
export class ApplicationWireError extends Error {
  constructor(readonly code: ApplicationWireErrorCode) {
    super(`Application data channel rejected: ${code}`);
    this.name = "ApplicationWireError";
  }
}
const limits = APPLICATION_WIRE_LIMITS;
const identities = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const dataErrors: ReadonlySet<string> = new Set<ApplicationDataErrorCode>([
  "invalid-schema", "invalid-request", "scope-mismatch", "unauthorized", "expired", "revoked", "aborted",
  "idempotency-conflict", "limit", "storage-unavailable", "closed",
]);
function requireWire(condition: boolean, code: ApplicationWireErrorCode = "invalid-message"): asserts condition {
  if (!condition) throw new ApplicationWireError(code);
}
function record(value: unknown): Record<string, unknown> {
  requireWire(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  requireWire(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
}
function text(value: unknown, maximum: number, pattern?: RegExp): asserts value is string {
  requireWire(typeof value === "string" && Buffer.byteLength(value, "utf8") <= maximum && (!pattern || pattern.test(value)));
}
function identity(value: unknown): void { text(value, 128, identities); }
function direction(value: ApplicationWireDirection): void {
  requireWire(value === "host-to-application" || value === "application-to-host");
}

/** Bound nesting before JSON.parse, then bound and freeze the parsed JSON graph.
 * Text input prevents getters, prototypes, toJSON and caller callbacks crossing this API. */
function parseJson(json: string, maximumBytes: number): unknown {
  requireWire(typeof json === "string", "invalid-json");
  requireWire(Buffer.byteLength(json, "utf8") <= maximumBytes, "json-limit");
  requireWire(Buffer.from(json, "utf8").toString("utf8") === json, "invalid-json");
  let depth = 0, quoted = false, escaped = false;
  for (const character of json) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{" || character === "[") {
      depth++;
      requireWire(depth <= limits.jsonDepth, "json-limit");
    } else if (character === "}" || character === "]") {
      depth--;
      requireWire(depth >= 0, "invalid-json");
    }
  }
  requireWire(!quoted && depth === 0, "invalid-json");
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new ApplicationWireError("invalid-json"); }
  freezeJsonGraph(value);
  return value;
}
function freezeJsonGraph(value: unknown): void {
  const pending: unknown[] = [value]; let entries = 1;
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === "string") requireWire(Buffer.from(item, "utf8").toString("utf8") === item, "invalid-json");
    else if (typeof item === "number") requireWire(Number.isFinite(item), "invalid-json");
    else if (item !== null && typeof item === "object") {
      const keys = Object.keys(item);
      requireWire(keys.length <= (Array.isArray(item) ? limits.arrayEntries : limits.objectEntries), "json-limit");
      entries += keys.length * (Array.isArray(item) ? 1 : 2);
      requireWire(entries <= limits.jsonEntries, "json-limit");
      for (const key of keys) {
        requireWire(Buffer.from(key, "utf8").toString("utf8") === key, "invalid-json");
        pending.push((item as Record<string, unknown>)[key]);
      }
      Object.freeze(item);
    }
  }
}
function body(value: unknown): void {
  // Only JSON.parse-created values reach this helper; no user serialization hook runs.
  requireWire(Buffer.byteLength(JSON.stringify(value), "utf8") <= limits.bodyBytes, "json-limit");
}
function request(value: unknown): void {
  const item = record(value);
  exact(item, ["request_id", "method", "path", "query", "body"]);
  identity(item.request_id);
  requireWire(item.method === "GET" || item.method === "POST" || item.method === "PATCH" || item.method === "DELETE");
  text(item.path, 2_048, /^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*\/?)?$/u);
  requireWire(!item.path.split("/").some(part => part === "." || part === ".."));
  const query = record(item.query);
  requireWire(Object.keys(query).length <= limits.queryEntries, "json-limit");
  for (const [key, value] of Object.entries(query)) {
    text(key, 64, /^[A-Za-z0-9_.-]{1,64}$/u);
    text(value, limits.queryValueBytes);
  }
  body(item.body);
}
function response(value: unknown): void {
  const item = record(value);
  exact(item, ["status", "body"]);
  requireWire([200, 201, 204, 400, 404, 409, 422, 500].includes(item.status as number));
  requireWire(item.status !== 204 || item.body === null);
  body(item.body);
}
function message(value: unknown, channel: ApplicationWireDirection, envelope: boolean): ApplicationWireMessage {
  const item = record(value);
  const common = envelope ? ["version", "sequence", "kind"] : ["kind"];
  if (envelope) {
    requireWire(item.version === 1 && typeof item.sequence === "number" && Number.isInteger(item.sequence)
      && item.sequence >= 1 && item.sequence <= limits.maximumSequence);
  }
  if (channel === "host-to-application") {
    switch (item.kind) {
      case "invoke": exact(item, [...common, "call_id", "request"]); identity(item.call_id); request(item.request); break;
      case "data-result":
        exact(item, [...common, "call_id", "data_call_id", "reply_json"]); identity(item.call_id); identity(item.data_call_id);
        text(item.reply_json, APPLICATION_DATA_LIMITS.replyBytes); record(parseJson(item.reply_json, APPLICATION_DATA_LIMITS.replyBytes)); break;
      case "data-error":
        exact(item, [...common, "call_id", "data_call_id", "code"]); identity(item.call_id); identity(item.data_call_id);
        requireWire(typeof item.code === "string" && dataErrors.has(item.code)); break;
      case "cancel": exact(item, [...common, "call_id"]); identity(item.call_id); break;
      case "shutdown": exact(item, common); break;
      default: throw new ApplicationWireError("invalid-message");
    }
  } else {
    switch (item.kind) {
      case "response": exact(item, [...common, "call_id", "response"]); identity(item.call_id); response(item.response); break;
      case "data-call":
        exact(item, [...common, "call_id", "data_call_id", "request_json"]); identity(item.call_id); identity(item.data_call_id);
        text(item.request_json, APPLICATION_DATA_LIMITS.requestBytes); record(parseJson(item.request_json, APPLICATION_DATA_LIMITS.requestBytes)); break;
      default: throw new ApplicationWireError("invalid-message");
    }
  }
  return item as unknown as ApplicationWireMessage;
}

/** One encoder per original directional stream. JSON text contains only message fields;
 * this owner assigns version/sequence. A sequence is correlation, never an authorization. */
export class ApplicationWireEncoder {
  private next = 1;
  private shutdown = false;
  private failure: ApplicationWireError | undefined;
  constructor(private readonly channel: ApplicationWireDirection) { direction(channel); }
  encode(messageJson: string): Buffer {
    if (this.failure) throw this.failure;
    try {
      requireWire(!this.shutdown, "closed");
      requireWire(this.next <= limits.maximumSequence, "sequence");
      const parsed = message(parseJson(messageJson, limits.frameBytes), this.channel, false);
      const envelope = { version: 1, sequence: this.next, ...parsed };
      // The decoder counts the complete envelope, including these two host-owned
      // fields. Apply that same budget before emitting any encoded frame.
      freezeJsonGraph(envelope);
      const bytes = Buffer.from(JSON.stringify(envelope), "utf8");
      requireWire(bytes.length > 0 && bytes.length <= limits.frameBytes, "frame-limit");
      const result = Buffer.allocUnsafe(bytes.length + 4);
      result.writeUInt32BE(bytes.length, 0); bytes.copy(result, 4);
      this.next++;
      this.shutdown = parsed.kind === "shutdown";
      return result;
    } catch (error) {
      this.failure = error instanceof ApplicationWireError ? error : new ApplicationWireError("invalid-message");
      throw this.failure;
    }
  }
}

/** Retains at most a four-byte header and one bounded frame, never the caller's chunk.
 * Returned frames are data only. The future owner must enforce invocation state and queue limits. */
export class ApplicationWireDecoder {
  private readonly header = Buffer.alloc(4);
  private headerUsed = 0;
  private payload: Buffer | undefined;
  private payloadUsed = 0;
  private next = 1;
  private shutdown = false;
  private ended = false;
  private failure: ApplicationWireError | undefined;
  constructor(private readonly channel: ApplicationWireDirection) { direction(channel); }
  private fail(error: unknown): never {
    this.failure ??= error instanceof ApplicationWireError ? error : new ApplicationWireError("invalid-message");
    this.payload = undefined; this.payloadUsed = 0; this.headerUsed = 0;
    throw this.failure;
  }
  push(chunk: Uint8Array): readonly ApplicationWireEnvelope[] {
    if (this.failure) throw this.failure;
    try {
      requireWire(!this.ended && !this.shutdown, "closed");
      requireWire(chunk instanceof Uint8Array && chunk.byteLength <= limits.chunkBytes, "chunk-limit");
      const result: ApplicationWireEnvelope[] = [];
      let offset = 0;
      while (offset < chunk.byteLength) {
        requireWire(!this.shutdown, "closed");
        if (!this.payload) {
          const length = Math.min(4 - this.headerUsed, chunk.byteLength - offset);
          this.header.set(chunk.subarray(offset, offset + length), this.headerUsed);
          this.headerUsed += length; offset += length;
          if (this.headerUsed < 4) continue;
          const size = this.header.readUInt32BE(0);
          requireWire(size > 0 && size <= limits.frameBytes, "frame-limit");
          this.payload = Buffer.allocUnsafe(size); this.payloadUsed = 0;
        }
        const length = Math.min(this.payload.length - this.payloadUsed, chunk.byteLength - offset);
        this.payload.set(chunk.subarray(offset, offset + length), this.payloadUsed);
        this.payloadUsed += length; offset += length;
        if (this.payloadUsed !== this.payload.length) continue;
        let json: string;
        try { json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(this.payload); }
        catch { throw new ApplicationWireError("invalid-utf8"); }
        const parsed = message(parseJson(json, limits.frameBytes), this.channel, true) as ApplicationWireEnvelope;
        requireWire(parsed.sequence === this.next, "sequence");
        this.next++; this.shutdown = parsed.kind === "shutdown";
        this.payload = undefined; this.payloadUsed = 0; this.headerUsed = 0;
        result.push(parsed);
      }
      return Object.freeze(result);
    } catch (error) { return this.fail(error); }
  }
  /** This records input framing EOF only; it is not original pipe/process/Job closure. */
  finish(): void {
    if (this.failure) throw this.failure;
    try {
      requireWire(!this.ended, "closed");
      requireWire(this.headerUsed === 0 && this.payload === undefined, "truncated");
      this.ended = true;
    } catch (error) { this.fail(error); }
  }
}
