import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApplicationBrokerAction } from "./application-broker-control.js";
import { assertApplicationClientReader, readApplicationClientArtifact, type ApplicationClientReader } from "./application-artifact-admission.js";
import { APPLICATION_WIRE_LIMITS, ApplicationWireEncoder, type ApplicationWireRequest,
  type ApplicationWireResponse } from "./application-wire-v1.js";
import { readApplicationBootstrapPublication, type PreparedApplicationBootstrapAdmission } from "./application-bootstrap-admission.js";
import { applicationPublicationProbeHeaders, type ApplicationPublicationCounters } from "./application-publication-process-protocol.js";
import { APPLICATION_PUBLICATION_CONTROL_PROBE_HEADER } from "./application-publication-control-protocol.js";

/** Host-only HTTP adapter. It creates no listener, process, database or authority. */
export const APPLICATION_HTTP_LIMITS = Object.freeze({
  concurrent: 8, requests: 256, headerBytes: 16_384, headers: 64, targetBytes: 8_192,
  bodyBytes: APPLICATION_WIRE_LIMITS.bodyBytes, chunkBytes: 65_536, chunks: 4_096,
  timeoutMs: 30_000,
});
type Begin = Extract<ApplicationBrokerAction, { kind: "begin" }>;
export interface ApplicationHttpInvocation {
  /** One existing broker responses member as JSON: { invocation, response }.
   * The original invocation must match begin; no arbitrary object crosses this API. */
  readonly response: Promise<string>;
  /** The trusted owner confirms no further work/authority remains for this invocation.
   * Cancellation/response delivery alone cannot resolve this promise. Not an OS receipt. */
  readonly settled: Promise<void>;
  cancel(): void | Promise<void>;
}
export interface ApplicationHttpService {
  /** Fixed maximum of the actual dedicated guest AND broker channel, not a request claim. */
  readonly maximumAccess: "read" | "write";
  /** Returns the original host handle synchronously, including while startup is pending.
   * A throwing begin must have created no work; otherwise it must return a cancellable handle. */
  begin(action: Readonly<Begin>, signal: AbortSignal): ApplicationHttpInvocation;
}
export interface ApplicationHttpIngressOptions {
  readonly origin: string;
  readonly purpose: Begin["purpose"];
  readonly access: Begin["access"];
  readonly timeoutMs: number;
  readonly maximumConcurrent?: number;
  readonly service: ApplicationHttpService;
  /** Trusted local application policy only. GET receives a read grant even when
   * the dedicated service has a write ceiling. The broker still enforces it. */
  readonly readOnlyGet?: boolean;
  /** Explicit same-origin v1 opt-in. /api and /api/... keep their complete path;
   * other targets may serve captured client bytes and never begin a broker. */
  readonly clientReader?: ApplicationClientReader;
  /** Original fixed host admission, never model or request supplied headers. */
  readonly publication?: PreparedApplicationBootstrapAdmission;
}
export type ApplicationHttpAdmissionStop = "closed" | "failed" | "budget_exhausted" | "draining";
export interface ApplicationHttpIngress {
  /** Resolves after HTTP finish/close, not backend/process closure. */
  handle(request: IncomingMessage, response: ServerResponse, signal?: AbortSignal): Promise<void>;
  /** Stops admission and forwards cancellation. The owner separately owes actual closure. */
  close(): void;
  /** Stops admission only. Existing requests retain their original deadlines and
   * owners; this returns no transport, owner or native closure observation. */
  drain(): void;
  /** Admission status only: never a transport or original-owner closure receipt. */
  readonly admissionStopped: Promise<ApplicationHttpAdmissionStop>;
  /** Independent failure upgrade, including a failure after budget exhaustion. */
  readonly admissionFailed: Promise<void>;
}
const limits = APPLICATION_HTTP_LIMITS;
const responseMarkers = new WeakMap<ServerResponse, Readonly<Record<string, string>>>();
const ingressCounters = new WeakMap<object, { read(): ApplicationPublicationCounters;
  subscribe(listener: (counters: ApplicationPublicationCounters) => void): () => void }>();
export interface ApplicationPublicationHttpControl {
  readonly mode: "paused" | "armed" | "running" | "ended";
  pause(): void;
  probe(path: string, nonce: string): Promise<void>;
  resume(): void;
}
const publicationControls = new WeakMap<object, ApplicationPublicationHttpControl>();
export function readApplicationPublicationHttpControl(ingress: ApplicationHttpIngress): ApplicationPublicationHttpControl {
  const control = publicationControls.get(ingress); if (!control) throw Error("Original controlled publication ingress required"); return control;
}
export function readApplicationHttpCounters(ingress: ApplicationHttpIngress): ApplicationPublicationCounters {
  const saved = ingressCounters.get(ingress); if (!saved) throw Error("Original application ingress required"); return saved.read();
}
export function subscribeApplicationHttpCounters(ingress: ApplicationHttpIngress, listener: (counters: ApplicationPublicationCounters) => void): () => void {
  const saved = ingressCounters.get(ingress); if (!saved) throw Error("Original application ingress required"); return saved.subscribe(listener);
}
class Rejection extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
const bad = (): never => { throw new Rejection(400, "invalid_request"); };
const forbidden = (): never => { throw new Rejection(403, "request_forbidden"); };

function parseJson(text: string, maximum: number): unknown {
  if (typeof text !== "string" || text.length > maximum || Buffer.byteLength(text) > maximum
    || Buffer.from(text).toString("utf8") !== text) return bad();
  let depth = 0, quoted = false, escaped = false;
  for (const character of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{" || character === "[") {
      if (++depth > APPLICATION_WIRE_LIMITS.jsonDepth) return bad();
    } else if ((character === "}" || character === "]") && --depth < 0) return bad();
  }
  if (quoted || depth !== 0) return bad();
  try {
    // JSON.parse accepts 1e999 as Infinity. Reject it before JSON.stringify can
    // silently replace it with null ahead of the existing wire validation.
    return JSON.parse(text, (_key, value: unknown) => {
      if (typeof value === "number" && !Number.isFinite(value)) return bad();
      return value;
    });
  } catch { return bad(); }
}
function headers(request: IncomingMessage): Readonly<Record<string, string>> {
  const raw = request.rawHeaders;
  if (request.httpVersion !== "1.1" || !Array.isArray(raw) || raw.length % 2 || raw.length > 2 * limits.headers) return bad();
  const result: Record<string, string> = Object.create(null); let bytes = 0;
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index]!, value = raw[index + 1]!;
    if (typeof name !== "string" || typeof value !== "string"
      || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) || /[^\t\x20-\x7e]/u.test(value)) return bad();
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    const key = name.toLowerCase();
    if (bytes > limits.headerBytes || Object.hasOwn(result, key)) return bad();
    result[key] = value;
  }
  // Never infer authority/origin from forwarding headers, upgrade, credentials or trailers.
  if (result.upgrade !== undefined || result.expect !== undefined || result.trailer !== undefined
    || result.forwarded !== undefined || Object.keys(result).some(key => key.startsWith("x-forwarded-"))
    || result.connection?.split(",").some(value => value.trim().toLowerCase() === "upgrade")) return bad();
  return result;
}
function target(text: string | undefined): Pick<ApplicationWireRequest, "path" | "query"> {
  if (typeof text !== "string" || text.length > limits.targetBytes || /[^\x21-\x7e]/u.test(text)
    || !text.startsWith("/") || text.startsWith("//") || /[#\\]/u.test(text)) return bad();
  const separator = text.indexOf("?"), path = separator < 0 ? text : text.slice(0, separator);
  if (Buffer.byteLength(path) > 2_048 || !/^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*\/?)?$/u.test(path)
    || path.split("/").some(part => part === "." || part === "..")) return bad();
  const query: Record<string, string> = Object.create(null);
  if (separator >= 0) {
    const pairs = text.slice(separator + 1).split("&");
    if (pairs.length > APPLICATION_WIRE_LIMITS.queryEntries) return bad();
    for (const pair of pairs) {
      const equals = pair.indexOf("="), key = pair.slice(0, equals);
      if (equals < 1 || !/^[A-Za-z0-9_.-]{1,64}$/u.test(key) || Object.hasOwn(query, key)) return bad();
      let value: string;
      try { value = decodeURIComponent(pair.slice(equals + 1).replace(/\+/gu, " ")); } catch { return bad(); }
      if (Buffer.byteLength(value) > APPLICATION_WIRE_LIMITS.queryValueBytes) return bad();
      query[key] = value;
    }
  }
  return { path, query };
}
function body(request: IncomingMessage, length: number | undefined, jsonType: boolean, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []; let bytes = 0, chunks = 0, done = false;
    const finish = (error?: unknown, value?: unknown) => {
      if (done) return; done = true;
      request.off("data", data); request.off("end", end); signal.removeEventListener("abort", abort);
      if (error) { request.pause(); reject(error); } else resolve(value);
    };
    const abort = () => finish(new Rejection(503, "request_cancelled"));
    const data = (chunk: unknown) => {
      if (!Buffer.isBuffer(chunk) || chunk.length > limits.chunkBytes) return finish(new Rejection(400, "invalid_request"));
      bytes += chunk.length;
      if (++chunks > limits.chunks || bytes > limits.bodyBytes) return finish(new Rejection(413, "body_too_large"));
      if (request.method === "GET" || length !== undefined && bytes > length) return finish(new Rejection(400, "invalid_request"));
      if (!jsonType) return finish(new Rejection(415, "json_required"));
      parts.push(Buffer.from(chunk));
    };
    const end = () => {
      try {
        if (!request.complete || length !== undefined && length !== bytes || request.rawTrailers.length) return bad();
        const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts, bytes));
        finish(undefined, bytes ? parseJson(text, limits.bodyBytes) : null);
      } catch (error) { finish(error); }
    };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    request.on("data", data); request.once("end", end);
  });
}
function send(response: ServerResponse, status: number, bytes: Buffer, contentType = "application/json; charset=utf-8", head = false): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) { response.destroy(); return; }
  response.statusCode = status;
  response.setHeader("connection", "close");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("content-length", bytes.length);
  if (status !== 204) response.setHeader("content-type", contentType);
  for (const [name, value] of Object.entries(responseMarkers.get(response) ?? {})) response.setHeader(name, value);
  response.end(head ? undefined : bytes);
}
function sendError(response: ServerResponse, failure: Rejection): void {
  send(response, failure.status, Buffer.from(JSON.stringify({ error: failure.code })));
}
function rejectHttp(request: IncomingMessage, response: ServerResponse, timeoutMs: number): Promise<void> {
  request.pause();
  return new Promise(resolve => {
    const complete = () => {
      clearTimeout(timer); response.off("finish", complete); response.off("close", complete); response.off("error", failed); resolve();
    };
    const failed = () => { response.destroy(); complete(); };
    const timer = setTimeout(failed, timeoutMs);
    response.once("finish", complete); response.once("close", complete); response.once("error", failed);
    try { sendError(response, new Rejection(503, "service_unavailable")); } catch { failed(); }
    if (response.destroyed || response.writableFinished) complete();
  });
}
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Rejection(503, "request_cancelled"));
    const clean = () => signal.removeEventListener("abort", abort);
    // Both branches observe the underlying work, including a rejection after abort.
    void work.then(value => { clean(); resolve(value); }, error => { clean(); reject(error); });
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
}

export function createApplicationHttpIngress(options: ApplicationHttpIngressOptions): ApplicationHttpIngress {
  const { origin, purpose, access, timeoutMs } = options;
  const readOnlyGet = options.readOnlyGet ?? false;
  const clientReader = options.clientReader;
  const publication = options.publication ? readApplicationBootstrapPublication(options.publication) : undefined;
  if (options.publication && (!publication || publication.identity.origin !== origin)) throw Error("Original publication HTTP binding required");
  const markers = publication ? applicationPublicationProbeHeaders(publication) : undefined;
  const concurrent = options.maximumConcurrent ?? limits.concurrent, service = options.service;
  const maximumAccess = service.maximumAccess, begin = service.begin.bind(service);
  const url = new URL(origin);
  if (url.origin !== origin || !["http:", "https:"].includes(url.protocol) || url.username || url.password
    || !["application", "health", "peer"].includes(purpose) || !["read", "write"].includes(access)
    || !["read", "write"].includes(maximumAccess) || access === "write" && maximumAccess !== "write"
    || purpose !== "application" && (access !== "read" || maximumAccess !== "read")
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > limits.timeoutMs
    || !Number.isSafeInteger(concurrent) || concurrent < 1 || concurrent > limits.concurrent
    || typeof readOnlyGet !== "boolean" || readOnlyGet && purpose !== "application") throw Error("Invalid fixed application HTTP binding");
  if (clientReader !== undefined) {
    if (purpose !== "application" || !readOnlyGet) throw Error("Same-origin clients require the fixed read-only GET policy");
    assertApplicationClientReader(clientReader);
  }
  const active = new Set<{ stop(failure: Rejection): void }>(); let closed = false, cancelled = false, started = 0;
  let mode: ApplicationPublicationHttpControl["mode"] = publication?.control ? "paused" : "running";
  type Probe = { path: string; nonce: string; resolve(): void; reject(error: Error): void };
  let armed: Probe | undefined, probePending: Probe | undefined;
  const usedNonces = new Set<string>();
  let closedTransports = 0;
  const listeners = new Set<(counters: ApplicationPublicationCounters) => void>();
  const counters = (): ApplicationPublicationCounters => Object.freeze({ observed_at: new Date().toISOString(),
    requests_used: started, in_flight: active.size, closed_transports: closedTransports });
  const changed = () => {
    const value = counters();
    for (const listener of listeners) { try { listener(value); } catch { close("failed"); } }
  };
  let resolveAdmissionStop!: (reason: ApplicationHttpAdmissionStop) => void;
  const admissionStopped = new Promise<ApplicationHttpAdmissionStop>(resolve => { resolveAdmissionStop = resolve; });
  let resolveAdmissionFailure!: () => void;
  const admissionFailed = new Promise<void>(resolve => { resolveAdmissionFailure = resolve; });
  const stopAdmission = (reason: ApplicationHttpAdmissionStop) => {
    if (!closed) { closed = true; mode = "ended"; armed = undefined;
      probePending?.reject(Error("Original publication probe was stopped")); probePending = undefined; resolveAdmissionStop(reason); }
  };
  const close = (reason: ApplicationHttpAdmissionStop = "closed") => {
    if (reason === "failed") resolveAdmissionFailure();
    stopAdmission(reason);
    if (cancelled) return; cancelled = true;
    for (const pending of active) pending.stop(new Rejection(503, "service_closed"));
  };
  const result = Object.freeze({ close: () => close(), drain: () => stopAdmission("draining"), admissionStopped, admissionFailed, handle(request: IncomingMessage, response: ServerResponse, signal?: AbortSignal): Promise<void> {
    if (markers) responseMarkers.set(response, markers);
    let selectedProbe: Probe | undefined;
    if (publication?.control) {
      try {
        const input = headers(request), nonce = input[APPLICATION_PUBLICATION_CONTROL_PROBE_HEADER];
        if (mode === "armed" && armed && request.method === "GET" && request.url === armed.path && nonce === armed.nonce) {
          selectedProbe = armed; armed = undefined; mode = "paused"; // Consume before any await or owner creation.
        } else if (mode !== "running" || nonce !== undefined) return rejectHttp(request, response, timeoutMs);
      } catch { return rejectHttp(request, response, timeoutMs); }
    }
    if (closed || started >= limits.requests || active.size >= concurrent) {
      selectedProbe?.reject(Error("Original publication probe could not be admitted"));
      return rejectHttp(request, response, timeoutMs);
    }
    started++;
    // Closing admission does not cancel the last admitted request. Its listener
    // owner must still observe every original settlement before declaring closure.
    if (started === limits.requests) stopAdmission("budget_exhausted");
    const controller = new AbortController(), deadline = performance.now() + timeoutMs;
    let transportDone = false, ownerSettled = true, cancellationSent = false;
    let transportCutoff: ReturnType<typeof setImmediate> | undefined;
    let cancellation: (() => void | Promise<void>) | undefined, stopped: Rejection | undefined;
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const release = () => { if (transportDone && ownerSettled && active.delete(pending)) {
      changed();
      if (selectedProbe) {
        if (closed || cancelled || stopped) selectedProbe.reject(Error("Original publication probe did not settle normally"));
        else selectedProbe.resolve();
        if (probePending === selectedProbe) probePending = undefined;
      }
    } };
    const cancelOwner = () => {
      if (!cancellation || cancellationSent || ownerSettled) return;
      cancellationSent = true;
      try { void Promise.resolve(cancellation()).catch(() => close("failed")); } catch { close("failed"); }
    };
    const stop = (failure: Rejection) => {
      if (!stopped) { stopped = failure; controller.abort(); request.pause(); }
      cancelOwner();
      try {
        if (response.headersSent && !response.writableFinished) response.destroy();
        else sendError(response, stopped);
      } catch { response.destroy(); }
    };
    const pending = { stop }; active.add(pending);
    const onAbort = () => stop(new Rejection(503, "request_cancelled"));
    const onClientLoss = () => { onAbort(); response.destroy(); };
    const onClose = () => { if (!response.writableFinished) onAbort(); complete(); };
    const complete = () => {
      if (transportDone) return; transportDone = true; closedTransports++;
      clearTimeout(timer); if (transportCutoff) clearImmediate(transportCutoff);
      signal?.removeEventListener("abort", onAbort);
      request.off("aborted", onClientLoss); request.off("error", onClientLoss);
      response.off("finish", complete); response.off("close", onClose); response.off("error", onClientLoss);
      release(); finish();
    };
    const timer = setTimeout(() => {
      stop(new Rejection(504, "request_deadline"));
      // The first deadline reply can itself block. Give an immediately writable
      // fixed error this event-loop turn, then end transport without extending
      // the request deadline or pretending that its original owner settled.
      if (!transportDone && !response.destroyed && !response.writableFinished)
        transportCutoff = setImmediate(() => { if (!response.writableFinished) response.destroy(); });
    }, timeoutMs);
    request.once("aborted", onClientLoss); request.once("error", onClientLoss);
    response.once("finish", complete); response.once("close", onClose); response.once("error", onClientLoss);
    signal?.addEventListener("abort", onAbort, { once: true });
    try { changed(); } catch { close("failed"); }
    const remaining = () => {
      const milliseconds = Math.floor(deadline - performance.now());
      if (milliseconds < 1) throw new Rejection(504, "request_deadline");
      if (controller.signal.aborted) throw stopped ?? new Rejection(503, "request_cancelled");
      return milliseconds;
    };
    if (signal?.aborted || request.aborted || response.destroyed) {
      onClientLoss();
      if (response.destroyed) complete();
    }
    void (async () => {
      try {
        remaining();
        const input = headers(request), method = request.method;
        const invocationAccess = readOnlyGet && method === "GET" ? "read" : access;
        const encrypted = Boolean((request.socket as typeof request.socket & { encrypted?: boolean } | undefined)?.encrypted);
        if (encrypted !== (url.protocol === "https:")) return bad();
        if (!["GET", "POST", "PATCH", "DELETE", ...(clientReader ? ["HEAD"] : [])].includes(method ?? "")) throw new Rejection(405, "method_not_allowed");
        if (input.host !== url.host || input.origin !== undefined && input.origin !== origin) return forbidden();
        if (input["sec-fetch-site"] !== undefined && !["same-origin", "none"].includes(input["sec-fetch-site"])) return forbidden();
        const clientTarget = clientReader ? target(request.url) : undefined;
        if (clientReader && clientTarget && clientTarget.path !== "/api" && !clientTarget.path.startsWith("/api/")) {
          if (method !== "GET" && method !== "HEAD") throw new Rejection(405, "method_not_allowed");
          if (input["transfer-encoding"] !== undefined || input["content-encoding"] !== undefined
            || input["content-length"] !== undefined && input["content-length"] !== "0") return bad();
          // Use the same bounded body/EOF check and original deadline as API
          // requests. A GET/HEAD with actual body bytes is never dispatched.
          await body(request, 0, false, controller.signal);
          const relative = clientTarget.path.slice(1);
          const canonical = "client/" + (!relative || relative.endsWith("/") ? relative + "index.html" : relative);
          let artifact: Uint8Array | undefined;
          try { artifact = readApplicationClientArtifact(clientReader, canonical); }
          catch { close("failed"); return; }
          if (!artifact) throw new Rejection(404, "asset_not_found");
          const contentType = canonical.endsWith(".html") ? "text/html; charset=utf-8"
            : canonical.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8";
          const bytes = Buffer.from(artifact);
          remaining();
          send(response, 200, bytes, contentType, method === "HEAD"); return;
        }
        if (method === "HEAD") throw new Rejection(405, "method_not_allowed");
        // The default write-bound GET still requires Origin. Only a fixed local
        // readOnlyGet binding lowers the actual broker grant for browser GET.
        if ((invocationAccess === "write" || method !== "GET") && input.origin !== origin) return forbidden();
        if (purpose !== "application" && method !== "GET") return forbidden();
        if (input["content-encoding"] !== undefined) throw new Rejection(415, "json_required");
        if (input["transfer-encoding"] !== undefined && input["transfer-encoding"] !== "chunked"
          || input["transfer-encoding"] !== undefined && input["content-length"] !== undefined) return bad();
        let length: number | undefined;
        if (input["content-length"] !== undefined) {
          if (!/^(?:0|[1-9][0-9]{0,8})$/u.test(input["content-length"])) return bad();
          length = Number(input["content-length"]);
          if (length > limits.bodyBytes) throw new Rejection(413, "body_too_large");
          if (method === "GET" && length !== 0) return bad();
        }
        const contentType = input["content-type"], jsonType = contentType !== undefined
          && /^application\/json(?:;\s*charset=utf-8)?$/iu.test(contentType);
        if (contentType !== undefined && !jsonType) throw new Rejection(415, "json_required");
        const location = clientTarget ?? target(request.url), value = await body(request, length, jsonType, controller.signal);
        const invocation = randomUUID(), dto = { request_id: invocation, method, ...location, body: value };
        try { new ApplicationWireEncoder("host-to-application").encode(JSON.stringify({ kind: "invoke", call_id: invocation, request: dto })); }
        catch { return bad(); }
        const action: Readonly<Begin> = Object.freeze({ kind: "begin", invocation, requestJson: JSON.stringify(dto), purpose, access: invocationAccess, lifetimeMs: remaining() });
        let handle: ApplicationHttpInvocation;
        try { handle = begin(action, controller.signal); } catch { close("failed"); return; }
        ownerSettled = false;
        let responseWork: Promise<string>, settlement: Promise<void>;
        try {
          cancellation = handle.cancel.bind(handle);
          if (!(handle.response instanceof Promise) || !(handle.settled instanceof Promise)) throw Error("original owner promises required");
          responseWork = handle.response;
          settlement = handle.settled.then(value => { if (value !== undefined) throw Error("invalid owner settlement"); });
        } catch { close("failed"); return; }
        void settlement.then(() => { ownerSettled = true; release(); }, () => close("failed"));
        if (stopped) cancelOwner();
        let responseJson: string;
        try { [responseJson] = await abortable(Promise.all([responseWork, settlement]), controller.signal); }
        catch { if (!controller.signal.aborted) close("failed"); return; }
        remaining();
        let result: ApplicationWireResponse;
        try {
          const item = parseJson(responseJson, APPLICATION_WIRE_LIMITS.frameBytes);
          if (item === null || typeof item !== "object" || Array.isArray(item)
            || Object.keys(item).length !== 2 || !("invocation" in item) || !("response" in item)
            || item.invocation !== invocation) throw Error("response correlation");
          result = item.response as ApplicationWireResponse;
          new ApplicationWireEncoder("application-to-host").encode(JSON.stringify({ kind: "response", call_id: invocation, response: result }));
        } catch { stop(new Rejection(502, "invalid_service_response")); close("failed"); return; }
        const bytes = result.status === 204 ? Buffer.alloc(0) : Buffer.from(JSON.stringify(result.body));
        remaining(); // No successful delivery after a late response or validation work.
        send(response, result.status, bytes);
      } catch (error) { stop(error instanceof Rejection ? error : new Rejection(400, "invalid_request")); }
    })();
    return finished;
  } });
  ingressCounters.set(result, { read: counters, subscribe(listener) {
    if (typeof listener !== "function" || listeners.size >= 1) throw Error("One original ingress observer required");
    listeners.add(listener); return () => { listeners.delete(listener); };
  } });
  if (publication?.control) publicationControls.set(result, Object.freeze({ get mode() { return mode; },
    pause() {
      if (closed || armed || probePending) throw Error("Original publication ingress cannot pause during an armed or active probe");
      mode = "paused";
    },
    probe(path: string, nonce: string): Promise<void> {
      if (closed || mode !== "paused" || active.size || probePending || path !== "/" && path !== publication.control!.read_path
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(nonce)
        || usedNonces.has(nonce) || usedNonces.size >= 512) throw Error("One original fixed-path private publication probe required");
      usedNonces.add(nonce);
      const completed = new Promise<void>((resolve, reject) => { armed = { path, nonce, resolve, reject }; probePending = armed; });
      void completed.catch(() => {}); mode = "armed"; return completed;
    },
    resume() {
      if (closed || mode !== "paused" || active.size || probePending) throw Error("Original publication ingress is not quiescent");
      mode = "running";
    },
  }));
  return result;
}
