import { isPromise } from "node:util/types";
import type { ApplicationQuickJSSession, ApplicationQuickJSSessionStatus } from "./application-quickjs-session.js";
import { APPLICATION_QUICKJS_SESSION_LIMITS as sessionLimits } from "./application-quickjs-session.js";
import { APPLICATION_WIRE_LIMITS as wireLimits, ApplicationWireDecoder, ApplicationWireEncoder } from "./application-wire-v1.js";

/** Fixed child-side framing only. No listener, process, storage or authority is created. */
export const APPLICATION_RUNTIME_CHANNEL_LIMITS = Object.freeze({
  inputChunks: 8_192,
  inputMessages: sessionLimits.inputMessages,
  outputMessages: sessionLimits.outputMessages,
  // The canonical version/sequence envelope and four-byte header add less than
  // 64 bytes per message. Raw input whitespace still counts against this budget.
  inputWireBytes: sessionLimits.inputBytes + 64 * sessionLimits.inputMessages,
  outputWireBytes: sessionLimits.outputBytes + 64 * sessionLimits.outputMessages,
  outputChunkBytes: wireLimits.chunkBytes,
  outputBatchMessages: sessionLimits.drainMessages,
});

type State = "initializing" | "ready" | "closed" | "failed";
type Failure = "input" | "output" | "limit" | "session" | "owner" | "dispose";
type CloseReason = "shutdown" | "input-eof" | "owner-close" | "failure";
export class ApplicationRuntimeChannelError extends Error {
  constructor(readonly code: Failure | "closed") { super("Application runtime channel stopped: " + code); }
}
export interface ApplicationRuntimeChannelStatus {
  readonly state: State;
  readonly failure: Failure | null;
  readonly closeReason: CloseReason | null;
  /** The original owner called endInput; this is not independent pipe-EOF evidence. */
  readonly inputEnded: boolean;
  readonly inputChunks: number;
  readonly inputMessages: number;
  readonly inputWireBytes: number;
  readonly outputMessages: number;
  readonly outputWireBytes: number;
  readonly pendingOutputBytes: number;
  /** Removed from this queue only; neither OS writes nor peer receipt are implied. */
  readonly handedOffBytes: number;
  readonly discardedOutputBytes: number;
  readonly guestDisposed: boolean;
  readonly qualifiedForProduct: false;
}
export interface ApplicationRuntimeChannel {
  receive(chunk: Uint8Array): void;
  /** At most one original bounded pump, followed by one bounded drain. Output
   * backpressure prevents any further pumping until readOutput empties the queue. */
  advance(): ApplicationRuntimeChannelStatus;
  /** One copied FIFO chunk, at most 64 KiB. Returning it is not a write ACK. */
  readOutput(): Uint8Array | undefined;
  /** Only the original stream owner calls this on its actual natural input EOF. */
  endInput(): ApplicationRuntimeChannelStatus;
  /** Host cancellation/disposal. This never reports native closure or settlement. */
  close(): ApplicationRuntimeChannelStatus;
  readonly status: ApplicationRuntimeChannelStatus;
}

const limits = APPLICATION_RUNTIME_CHANNEL_LIMITS;
const usedSessions = new WeakSet<object>();
const promiseThen = Promise.prototype.then;
/** A rejected native Promise is still an invalid synchronous return. Observe it
 * with the captured intrinsic, without awaiting it or inspecting thenables. */
function observeUnexpectedPromise(value: unknown): boolean {
  if (!isPromise(value)) return false;
  try { void Reflect.apply(promiseThen, value, [() => undefined, () => undefined]); }
  catch { /* An invalid return never becomes an accepted session result. */ }
  return true;
}
const statusFields = ["state", "failure", "jobs", "operations", "guestDisposed", "qualifiedForProduct"] as const;
const sessionFailures = new Set(["input", "output", "module", "guest", "deadline", "jobs", "operations", "owner", "dispose"]);
function checkedStatus(value: unknown): ApplicationQuickJSSessionStatus | undefined {
  // These are the six data fields produced by the actual session. Tagged
  // Promises, thenables, getters and null cannot become disposal evidence.
  if (observeUnexpectedPromise(value) || !value || typeof value !== "object") return;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return;
    const fields = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(fields);
    if (keys.length !== statusFields.length || keys.some(key => typeof key !== "string" || !statusFields.includes(key as never))
      || statusFields.some(key => !fields[key] || !("value" in fields[key]))) return;
    const state = fields.state!.value, failure = fields.failure!.value, jobs = fields.jobs!.value, operations = fields.operations!.value;
    const guestDisposed = fields.guestDisposed!.value, qualified = fields.qualifiedForProduct!.value;
    if (!["initializing", "ready", "closed", "failed"].includes(state) || typeof guestDisposed !== "boolean" || qualified !== false
      || !Number.isSafeInteger(jobs) || jobs < 0 || !Number.isSafeInteger(operations) || operations < 0
      || (state === "failed" ? !sessionFailures.has(failure) : failure !== null)
      || (state === "initializing" || state === "ready") && guestDisposed || state === "closed" && !guestDisposed) return;
    return { state, failure, jobs, operations, guestDisposed, qualifiedForProduct: false };
  } catch { return; }
}

/** The fixed runtime entry supplies its actual, exclusively owned session. A
 * structural interface or this adapter cannot establish process/VM qualification. */
export function createApplicationRuntimeChannel(session: ApplicationQuickJSSession): ApplicationRuntimeChannel {
  if (!session || typeof session !== "object" || usedSessions.has(session)) throw new ApplicationRuntimeChannelError("owner");
  const methods = ["receive", "pump", "drain", "close"] as const;
  const captured = methods.map(name => {
    const descriptor = Object.getOwnPropertyDescriptor(session, name);
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") throw new ApplicationRuntimeChannelError("owner");
    return descriptor.value as (...args: never[]) => unknown;
  });
  const statusDescriptor = Object.getOwnPropertyDescriptor(session, "status");
  if (!statusDescriptor?.get || statusDescriptor.set) throw new ApplicationRuntimeChannelError("owner");
  const getStatus = statusDescriptor.get.bind(session);
  const readSessionStatus = (): ApplicationQuickJSSessionStatus => {
    const value = checkedStatus(getStatus());
    if (!value) throw new ApplicationRuntimeChannelError("owner");
    return value;
  };
  const receive = captured[0]!.bind(session) as (json: string) => void;
  const pump = captured[1]!.bind(session) as () => ApplicationQuickJSSessionStatus;
  const drain = captured[2]!.bind(session) as () => readonly string[];
  const dispose = captured[3]!.bind(session) as () => void;
  usedSessions.add(session);

  const decoder = new ApplicationWireDecoder("host-to-application");
  const encoder = new ApplicationWireEncoder("application-to-host");
  let state: State = "initializing", failure: ApplicationRuntimeChannelError | undefined, closeReason: CloseReason | null = null;
  let inputEnded = false, inputChunks = 0, inputMessages = 0, inputWireBytes = 0;
  let outputMessages = 0, outputWireBytes = 0, queuedBytes = 0, handedOffBytes = 0, discardedOutputBytes = 0;
  let queue: Buffer[] = [], offset = 0, cleanupAttempted = false, guestDisposed = false;
  const snapshot = (): ApplicationRuntimeChannelStatus => Object.freeze({
    state, failure: (failure?.code as Failure | undefined) ?? null, closeReason, inputEnded,
    inputChunks, inputMessages, inputWireBytes, outputMessages, outputWireBytes,
    pendingOutputBytes: queuedBytes, handedOffBytes, discardedOutputBytes, guestDisposed, qualifiedForProduct: false,
  });
  function discard(): void {
    discardedOutputBytes += queuedBytes; queue = []; offset = 0; queuedBytes = 0;
  }
  function cleanup(): void {
    // A previous failed close/status read cannot be upgraded by another call.
    if (cleanupAttempted) return;
    cleanupAttempted = true;
    let completed = false;
    try { const result: unknown = dispose(); observeUnexpectedPromise(result); completed = result === undefined; }
    catch { /* The original uncertainty is retained. */ }
    try {
      const observed = readSessionStatus();
      guestDisposed = completed && observed.guestDisposed === true
        && (observed.state === "closed" || observed.state === "failed") && observed.qualifiedForProduct === false;
    } catch { guestDisposed = false; }
    if (!guestDisposed) { failure ??= new ApplicationRuntimeChannelError("dispose"); state = "failed"; }
  }
  function fail(code: Failure): never {
    failure ??= new ApplicationRuntimeChannelError(code); state = "failed"; closeReason = "failure";
    discard(); cleanup(); throw failure;
  }
  function open(): void {
    if (failure) throw failure;
    if (state === "closed") throw new ApplicationRuntimeChannelError("closed");
  }
  function synchronize(): void {
    let observed: ApplicationQuickJSSessionStatus;
    try { observed = readSessionStatus(); } catch { return fail("owner"); }
    if (!observed || observed.qualifiedForProduct !== false || typeof observed.guestDisposed !== "boolean") return fail("owner");
    if (observed.state === "failed") return fail("session");
    if ((observed.state !== "initializing" && observed.state !== "ready") || observed.guestDisposed
      || observed.failure !== null || (state === "ready" && observed.state === "initializing")) return fail("owner");
    state = observed.state;
  }
  function stop(reason: CloseReason): ApplicationRuntimeChannelStatus {
    if (state !== "closed" && state !== "failed") {
      closeReason = reason; state = "closed"; discard(); cleanup();
      if (failure) closeReason = "failure";
    }
    return snapshot();
  }
  synchronize();

  return Object.freeze({
    get status() { return snapshot(); },
    receive(chunk: Uint8Array) {
      open(); synchronize();
      if (!(chunk instanceof Uint8Array) || chunk.byteLength > wireLimits.chunkBytes) return fail("input");
      inputChunks++; inputWireBytes += chunk.byteLength;
      if (inputChunks > limits.inputChunks || inputWireBytes > limits.inputWireBytes) return fail("limit");
      if (state !== "ready") return fail("input");
      let messages;
      try { messages = decoder.push(chunk); } catch { return fail("input"); }
      if (inputMessages + messages.length > limits.inputMessages) return fail("limit");
      // The persistent decoder validates the whole available batch first. In
      // particular, data after shutdown rejects before delivering its prefix.
      if (messages.some(message => message.kind === "shutdown") && queuedBytes) return fail("output");
      inputMessages += messages.length;
      for (const envelope of messages) {
        const { version: _version, sequence: _sequence, ...message } = envelope;
        try {
          const result: unknown = receive(JSON.stringify(message)); observeUnexpectedPromise(result);
          if (result !== undefined) return fail("owner");
        }
        catch { return fail("session"); }
        if (message.kind === "shutdown") {
          let observed: ApplicationQuickJSSessionStatus;
          try { observed = readSessionStatus(); } catch { return fail("owner"); }
          if (observed.state !== "closed" || observed.guestDisposed !== true || observed.failure !== null
            || observed.qualifiedForProduct !== false) return fail("session");
          stop("shutdown");
          if (failure) throw failure;
        } else synchronize();
      }
    },
    advance() {
      open(); synchronize();
      if (queuedBytes) return snapshot();
      try {
        const pumped = checkedStatus(pump());
        if (!pumped || !["initializing", "ready"].includes(pumped.state)
          || pumped.qualifiedForProduct !== false || pumped.guestDisposed || pumped.failure !== null) return fail("session");
      } catch { return fail("session"); }
      synchronize();
      if (state !== "ready") return snapshot();
      let messages: readonly string[];
      try { messages = drain(); observeUnexpectedPromise(messages); } catch { return fail("session"); }
      synchronize();
      if (!Array.isArray(messages) || messages.length > limits.outputBatchMessages) return fail("output");
      if (outputMessages + messages.length > limits.outputMessages) return fail("limit");
      const batch: Buffer[] = []; let bytes = 0;
      for (let index = 0; index < messages.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(messages, String(index));
        if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") return fail("output");
        let frame: Buffer;
        try { frame = encoder.encode(descriptor.value); } catch { return fail("output"); }
        bytes += frame.byteLength;
        if (outputWireBytes + bytes > limits.outputWireBytes) return fail("limit");
        batch.push(frame);
      }
      // No frame from an invalid/over-budget batch escapes. Earlier handed-off
      // output and database work are separate facts; this is never rollback.
      queue = batch; queuedBytes = bytes; outputMessages += batch.length; outputWireBytes += bytes;
      return snapshot();
    },
    readOutput() {
      open(); synchronize();
      const first = queue[0]; if (!first) return;
      const length = Math.min(limits.outputChunkBytes, first.byteLength - offset);
      // A caller may mutate the handed-off chunk without changing later chunks.
      const bytes = Buffer.from(first.subarray(offset, offset + length));
      offset += length; queuedBytes -= length; handedOffBytes += length;
      if (offset === first.byteLength) { queue.shift(); offset = 0; }
      return bytes;
    },
    endInput() {
      if (inputEnded) return snapshot();
      inputEnded = true;
      if (failure) return snapshot();
      try { decoder.finish(); } catch { return fail("input"); }
      if (queuedBytes) return fail("output");
      return stop("input-eof");
    },
    close() { return stop("owner-close"); },
  });
}
