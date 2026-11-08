import { createHash, randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import { parseDeviceToken, SOURCE_LIFECYCLE_ROUTE_V1, SourceSupervisorLaunchV1Schema,
  SourceCleanRestartGrantV1Schema, sourceCleanDigestV1, type SourceSupervisorLaunchV1, type SourceCleanStopIntentV1,
  type SourceCleanStopReceiptV1, type SourceCleanRestartGrantV1 } from "@artoo/domain";
import { SourceLifecycleParentMessageV1Schema, SourceLifecycleServerMessageV1Schema,
  SOURCE_LIFECYCLE_REQUEST_MAX_BYTES_V1, SOURCE_LIFECYCLE_REPLY_MAX_BYTES_V1,
  type SourceLifecycleParentMessageV1, type SourceLifecycleServerMessageV1 } from "@artoo/protocol";
import { consumeOriginalSupervisedCleanClosure, type PreparedSupervisedCleanClosure } from "./windows-clean-supervised-owner.js";

declare const observerBrand: unique symbol, grantBrand: unique symbol;
export interface PreparedSourceLifecycleObserver { readonly [observerBrand]: true }
export interface AuthenticatedSourceCleanRestartGrant { readonly [grantBrand]: true }
type Opened = Extract<SourceLifecycleServerMessageV1, { type: "node.source-lifecycle.opened.v1" }>;
type Reply = Exclude<SourceLifecycleServerMessageV1, Opened>;
type RequestType = SourceLifecycleParentMessageV1["type"];
interface Pending { frame: SourceLifecycleParentMessageV1; encoded: string; expected: Reply["type"];
  resolve(value: Reply): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout>; retries: number; removeAbort?(): void }
interface Observer {
  socket: WebSocket; nodeId: string; origin: string; opened?: Opened; invalid?: Error; ended: boolean;
  sequence: number; pending?: Pending; replies: Map<string, { encoded: string; sequence: number }>;
  queue: Promise<void>; launch?: SourceSupervisorLaunchV1; intent?: SourceCleanStopIntentV1;
  committed?: Promise<SourceCleanStopReceiptV1>; claimStarted: boolean; bindStarted: boolean; prepareStarted: boolean;
  failed: Promise<Error>; fail(error: Error): void; ready: Promise<void>;
}
const observers = new WeakMap<object, Observer>();
const grants = new WeakMap<object, { observer: PreparedSourceLifecycleObserver; value: SourceCleanRestartGrantV1; consumed: boolean }>();
const digest = (value: unknown) => sourceCleanDigestV1(value, bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
function immutable<T>(input: T): T {
  const value = structuredClone(input); const freeze = (part: unknown): void => {
    if (part && typeof part === "object") { Object.values(part).forEach(freeze); Object.freeze(part); }
  }; freeze(value); return value;
}
function current(token: PreparedSourceLifecycleObserver): Observer {
  const value = observers.get(token);
  if (!value || value.invalid || value.ended || !value.opened || value.socket.readyState !== WebSocket.OPEN)
    throw Error("Original live source lifecycle observer is required");
  return value;
}
function messageBytes(data: RawData): Buffer {
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
}

/** Opens the one real parent connection. No injectable transport, identity,
 * challenge, response or saved-file constructor can populate this authority. */
export async function openSourceLifecycleObserver(options: { nodeUrl: string; nodeId: string }): Promise<PreparedSourceLifecycleObserver> {
  const url = new URL(options.nodeUrl), tokens = url.searchParams.getAll("token");
  if (!options.nodeId || options.nodeId.length > 128 || !["ws:", "wss:"].includes(url.protocol)
    || url.username || url.password || url.hash || url.pathname !== "/api/v1/node" || tokens.length !== 1
    || !parseDeviceToken(tokens[0]!) || [...url.searchParams.keys()].some(key => key !== "token")
    || url.protocol === "ws:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw Error("Lifecycle observer requires this node's exact paired endpoint");
  const credential = tokens[0]!; url.pathname = SOURCE_LIFECYCLE_ROUTE_V1; url.search = "";
  const origin = url.origin.replace(/^ws/u, "http");
  // The credential is a header on this original connection, never a query, log,
  // lifecycle payload, child environment field or durable receipt.
  const socket = new WebSocket(url, "artoo", { headers: { authorization: `Bearer ${credential}` }, maxPayload: SOURCE_LIFECYCLE_REPLY_MAX_BYTES_V1,
    followRedirects: false, handshakeTimeout: 10000 });
  let resolveReady!: () => void, rejectReady!: (error: Error) => void, reportFailure!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const failed = new Promise<Error>(resolve => { reportFailure = resolve; });
  const state: Observer = { socket, nodeId: options.nodeId, origin, ended: false, sequence: 0, replies: new Map(),
    queue: Promise.resolve(), claimStarted: false, bindStarted: false, prepareStarted: false, ready, failed, fail(error) {
      if (state.invalid) return; state.invalid = error; rejectReady(error); reportFailure(error);
      if (state.pending) { clearTimeout(state.pending.timer); state.pending.removeAbort?.(); state.pending.reject(error); state.pending = undefined; }
      socket.terminate();
    } };
  const timeout = setTimeout(() => state.fail(Error("Lifecycle observer did not receive its original opening challenge")), 10000);
  socket.on("error", () => state.fail(Error("Original lifecycle observer transport failed")));
  socket.on("close", () => { if (!state.ended) state.fail(Error("Original lifecycle observer disconnected")); });
  socket.on("message", (data, binary) => {
    if (state.ended) return; // A cancelled planned wait cannot revive its original connection.
    try {
      const bytes = messageBytes(data); if (binary || bytes.length > SOURCE_LIFECYCLE_REPLY_MAX_BYTES_V1) throw Error("Invalid lifecycle frame bound");
      const value = SourceLifecycleServerMessageV1Schema.parse(JSON.parse(bytes.toString("utf8")));
      if (value.type === "node.source-lifecycle.opened.v1") {
        if (state.opened || state.sequence) throw Error("Lifecycle opening challenge changed");
        state.opened = immutable(value); clearTimeout(timeout); resolveReady(); return;
      }
      if (!state.opened || value.observer_id !== state.opened.observer_id) throw Error("Lifecycle reply changed its original observer");
      const encoded = JSON.stringify(value), previous = state.replies.get(value.request_id);
      if (previous) { if (previous.encoded !== encoded || previous.sequence !== value.sequence) throw Error("Lifecycle duplicate reply changed"); return; }
      const pending = state.pending;
      if (!pending || value.request_id !== pending.frame.request_id || value.sequence !== pending.frame.sequence)
        throw Error("Lifecycle reply has no original pending request");
      if (value.type === "node.source-lifecycle.error.v1") throw Error("Lifecycle server rejected the original request");
      if (value.type !== pending.expected) throw Error("Lifecycle reply changed operation type");
      clearTimeout(pending.timer); pending.removeAbort?.(); state.pending = undefined;
      state.replies.set(value.request_id, { encoded, sequence: value.sequence });
      if (state.replies.size > 4) throw Error("Lifecycle observer operation capacity exceeded");
      pending.resolve(immutable(value));
    } catch { state.fail(Error("Lifecycle observer received an invalid or unbound response")); }
  });
  try { await ready; } finally { clearTimeout(timeout); }
  const token = Object.freeze({}) as PreparedSourceLifecycleObserver; observers.set(token, state); return token;
}
export function sourceLifecycleObserverIdentity(token: PreparedSourceLifecycleObserver) {
  const state = current(token); return Object.freeze({ observer_id: state.opened!.observer_id, node_id: state.nodeId, server_origin: state.origin });
}
export function sourceLifecycleObserverFailure(token: PreparedSourceLifecycleObserver): Promise<Error> {
  const state = observers.get(token); if (!state) throw Error("Original lifecycle observer required"); return state.failed;
}
function request(token: PreparedSourceLifecycleObserver, type: RequestType, payload: unknown, expected: Reply["type"], signal?: AbortSignal): Promise<Reply> {
  const state = current(token);
  const work = state.queue.then(async () => {
    signal?.throwIfAborted();
    current(token); if (++state.sequence > 4 || state.pending) throw Error("Lifecycle request order or capacity changed");
    const frame = SourceLifecycleParentMessageV1Schema.parse({ version: 1, type, request_id: randomUUID(), sequence: state.sequence,
      observer_id: state.opened!.observer_id, challenge: state.opened!.challenge, payload });
    const encoded = JSON.stringify(frame); if (Buffer.byteLength(encoded) > SOURCE_LIFECYCLE_REQUEST_MAX_BYTES_V1) throw Error("Lifecycle request exceeds native control bound");
    return new Promise<Reply>((resolve, reject) => {
      const pending: Pending = { frame, encoded, expected, resolve, reject, retries: 0 }; state.pending = pending;
      if (signal) {
        // Cancellation is terminal for this original observer. It cannot reset
        // sequence/prepare state or retry a partly prepared transition elsewhere.
        const abort = () => {
          if (state.pending !== pending) return;
          state.ended = true; clearTimeout(pending.timer); pending.removeAbort?.(); state.pending = undefined;
          reject(Error("Planned clean transition cancelled by user stop")); state.socket.close(1000, "user-stop");
        };
        pending.removeAbort = () => signal.removeEventListener("abort", abort);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) { abort(); return; }
      }
      const send = () => {
        try {
          current(token);
          state.socket.send(pending.encoded, error => { if (error) state.fail(Error("Original lifecycle request write failed")); });
          pending.timer = setTimeout(() => {
            if (state.pending !== pending) return;
            if (type !== "node.source-clean-stop.await-prepare.v1" && pending.retries++ === 0) send();
            else state.fail(Error("Original lifecycle reply was not confirmed"));
          }, type === "node.source-clean-stop.await-prepare.v1" ? 86400000 : 10000);
        } catch { state.fail(Error("Original lifecycle request connection was lost")); }
      }; send();
    });
  });
  state.queue = work.then(() => {}, () => {}); return work;
}
export async function bindSourceLifecycleLaunch(token: PreparedSourceLifecycleObserver, input: SourceSupervisorLaunchV1): Promise<void> {
  const state = current(token), launch = immutable(SourceSupervisorLaunchV1Schema.parse(input));
  if (state.bindStarted || launch.observer_id !== state.opened!.observer_id || launch.stable.node_id !== state.nodeId)
    throw Error("Lifecycle launch changed the original observer or node");
  state.bindStarted = true;
  const reply = await request(token, "node.source-lifecycle.bind.v1", launch, "node.source-lifecycle.bound.v1");
  if (reply.type !== "node.source-lifecycle.bound.v1" || reply.payload.observer_id !== launch.observer_id || reply.payload.launch_digest !== digest(launch))
    throw Error("Lifecycle binding reply changed");
  state.launch = launch;
}
export async function prepareSourceCleanStop(token: PreparedSourceLifecycleObserver,
  options: { waitForAcceptedH6?: boolean; signal?: AbortSignal } = {}): Promise<SourceCleanStopIntentV1> {
  const state = current(token); if (!state.launch || state.prepareStarted) throw Error("Clean stop requires one original bound launch");
  if (options.signal && !options.waitForAcceptedH6) throw Error("Only a planned acceptance wait may be cancelled");
  state.prepareStarted = true;
  const reply = await request(token, options.waitForAcceptedH6 ? "node.source-clean-stop.await-prepare.v1" : "node.source-clean-stop.prepare.v1",
    {}, "node.source-clean-stop.prepared.v1", options.signal);
  if (reply.type !== "node.source-clean-stop.prepared.v1" || JSON.stringify(reply.payload.launch) !== JSON.stringify(state.launch))
    throw Error("Clean stop intent changed its bound launch");
  state.intent = reply.payload; return reply.payload;
}
/** A closure is consumed once locally. Network retry reuses this function's one
 * exact encoded request on the original connection; it does not mint a token. */
export function commitSourceCleanStop(token: PreparedSourceLifecycleObserver,
  closure: PreparedSupervisedCleanClosure): Promise<SourceCleanStopReceiptV1> {
  const state = current(token); if (!state.intent || state.committed) throw Error("Original prepared clean stop is absent or already submitted");
  const payload = consumeOriginalSupervisedCleanClosure(closure, token, state.intent);
  return state.committed = (async () => {
    const reply = await request(token, "node.source-clean-stop.commit.v1", payload, "node.source-clean-stop.committed.v1");
    if (reply.type !== "node.source-clean-stop.committed.v1" || reply.payload.stop_id !== state.intent!.stop_id
      || reply.payload.intent_digest !== payload.intent_digest || reply.payload.closure_digest !== digest(payload))
      throw Error("Clean stop receipt changed its original submission");
    return reply.payload;
  })();
}
export async function claimSourceCleanRestart(token: PreparedSourceLifecycleObserver, stopId: string): Promise<AuthenticatedSourceCleanRestartGrant> {
  const state = current(token); if (state.launch || state.claimStarted) throw Error("Restart claim requires one new original parent before launch");
  state.claimStarted = true;
  const reply = await request(token, "node.source-clean-restart.claim.v1", { stop_id: stopId }, "node.source-clean-restart.claimed.v1");
  if (reply.type !== "node.source-clean-restart.claimed.v1") throw Error("Restart grant response changed");
  const value = immutable(SourceCleanRestartGrantV1Schema.parse(reply.payload));
  if (value.claimant_observer_id !== state.opened!.observer_id || value.predecessor.stop_id !== stopId || value.stable.node_id !== state.nodeId)
    throw Error("Restart grant changed its original claimant or predecessor");
  const grant = Object.freeze({}) as AuthenticatedSourceCleanRestartGrant; grants.set(grant, { observer: token, value, consumed: false }); return grant;
}
export function readAuthenticatedSourceCleanRestartGrant(token: AuthenticatedSourceCleanRestartGrant,
  observer: PreparedSourceLifecycleObserver): SourceCleanRestartGrantV1 {
  const grant = grants.get(token); if (!grant || grant.observer !== observer || grant.consumed) throw Error("Original unconsumed authenticated restart grant required");
  current(observer); return grant.value;
}
export function consumeAuthenticatedSourceCleanRestartGrant(token: AuthenticatedSourceCleanRestartGrant,
  observer: PreparedSourceLifecycleObserver): SourceCleanRestartGrantV1 {
  const value = readAuthenticatedSourceCleanRestartGrant(token, observer); grants.get(token)!.consumed = true; return value;
}
export async function closeSourceLifecycleObserver(token: PreparedSourceLifecycleObserver): Promise<void> {
  const state = observers.get(token); if (!state) throw Error("Original lifecycle observer required");
  if (state.pending) throw Error("Cannot close an observer with an unsettled original request");
  state.ended = true;
  if (state.socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { state.socket.terminate(); reject(Error("Original lifecycle observer closure was not confirmed")); }, 10000);
    state.socket.once("close", () => { clearTimeout(timeout); resolve(); }); state.socket.close(1000, "complete");
  });
}
