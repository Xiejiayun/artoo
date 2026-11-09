import { TextDecoder } from "node:util";
import type { ApplicationBootstrapInput } from "./application-bootstrap-control.js";
import type { ApplicationPublicationServiceIdentityV1 } from "@artoo/domain/dist/application-publication.js";
import { APPLICATION_PUBLICATION_CONTROL_LIMITS as limits, ApplicationPublicationControlSelectionSchema,
  ApplicationPublicationControlStatusSchema, ApplicationPublicationQuiescenceSchema, decodeApplicationPublicationControlCommand,
  type ApplicationPublicationControlCommand, type ApplicationPublicationControlSelection,
  type ApplicationPublicationControlStatus, type ApplicationPublicationQuiescence } from "./application-publication-control-protocol.js";

export interface ApplicationPublicationHostOperations {
  /** Synchronously closes business admission, then joins original transports and owners. */
  pause(): Promise<ApplicationPublicationQuiescence>;
  /** Arms synchronously; resolves only after the one permitted request and its owners settle. */
  probe(path: string, nonce: string): Promise<ApplicationPublicationQuiescence>;
  resume(): void;
  drain(): Promise<void>;
}

/** Additional publication-only protocol on the same original stdin. It cannot
 * alter the original service identity, lease, read path, or native owner. */
export function installApplicationPublicationBootstrapControl(input: ApplicationBootstrapInput, options: {
  identity: ApplicationPublicationServiceIdentityV1; selection: ApplicationPublicationControlSelection;
  signal?: AbortSignal;
  onStatus(status: ApplicationPublicationControlStatus): Promise<void>;
}) {
  const identity = structuredClone(options.identity), selection = ApplicationPublicationControlSelectionSchema.parse(options.selection);
  const controller = new AbortController(), decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let state: "starting" | "pausing" | "quiesced" | "probe" | "resumed" | "draining" = "starting";
  let owner: ApplicationPublicationHostOperations | undefined, previous: ApplicationPublicationQuiescence | undefined;
  let sequence = 0, cycle = 0, bytes = 0, pending = Buffer.alloc(0), disposed = false, ended = false;
  let failure: Error | undefined, drainWork: Promise<void> | undefined;
  let resolveEnd!: () => void, rejectEnd!: (error: unknown) => void;
  const finalInputClosed = new Promise<void>((resolve, reject) => { resolveEnd = resolve; rejectEnd = reject; });
  void finalInputClosed.catch(() => {});
  const work = new Set<Promise<void>>(), nonces = new Set<string>();
  const draining = () => state === "draining";
  const fail = (cause: unknown) => {
    failure ??= cause instanceof Error ? cause : Error("Publication control failed", { cause });
    controller.abort(failure); rejectEnd(failure);
  };
  const status = (commandSequence: number, phase: ApplicationPublicationControlStatus["state"], proof: ApplicationPublicationQuiescence) =>
    ApplicationPublicationControlStatusSchema.parse({ version: 1, kind: "application-publication.control", identity,
      sequence: commandSequence, cycle, state: phase, ...proof });
  const retain = (promise: Promise<void>, interruptible = false) => {
    const joined = promise.catch(error => {
      // The final drain owns the same transport/owner joins. Interrupting a
      // pending probe must not turn a requested normal stop into cancellation.
      if (!interruptible || state !== "draining") fail(error);
    });
    // Retain the normalized join, including when a status write is still
    // pending. finish() may already be awaiting this work when drain interrupts
    // the probe; the original rejection must not escape that interruption rule.
    work.add(joined); void joined.then(() => work.delete(joined));
  };
  function command(value: ApplicationPublicationControlCommand): void {
    if (JSON.stringify(value.identity) !== JSON.stringify(identity) || value.sequence !== sequence || state === "draining")
      throw Error("Publication control changed its original identity or sequence");
    if (value.kind === "pause") {
      if (!owner || state !== "resumed" || value.cycle !== cycle + 1) throw Error("Publication pause requires the next original running cycle");
      sequence++; cycle = value.cycle; state = "pausing";
      const paused = owner.pause(); // Admission closes before this command callback returns.
      retain(paused.then(async proof => {
        if (state === "draining") return;
        previous = ApplicationPublicationQuiescenceSchema.parse(proof); state = "quiesced";
        await options.onStatus(status(value.sequence, "quiesced", previous));
      }), true);
      return;
    }
    if (value.cycle !== cycle) throw Error("Publication control changed its original pause cycle");
    sequence++;
    if (value.kind === "drain") {
      state = "draining";
      if (!owner) { fail(Error("Publication drain cancelled startup before readiness")); return; }
      drainWork = owner.drain(); retain(drainWork); return;
    }
    if (!owner || state !== "quiesced" || !previous) throw Error("Publication control requires actual original quiescence");
    if (value.kind === "resume") {
      owner.resume(); state = "resumed";
      retain(options.onStatus(status(value.sequence, "resumed", previous))); return;
    }
    if (value.path !== "/" && value.path !== selection.read_path || nonces.has(value.nonce))
      throw Error("Publication probe changed its fixed path or reused its private nonce");
    nonces.add(value.nonce); state = "probe";
    const settled = owner.probe(value.path, value.nonce); // One exact request is armed synchronously.
    void settled.catch(() => {});
    retain((async () => {
      await options.onStatus(status(value.sequence, "probe-ready", previous!));
      const proof = await settled;
      if (draining()) return;
      previous = ApplicationPublicationQuiescenceSchema.parse(proof); state = "quiesced";
      await options.onStatus(status(value.sequence, "quiesced", previous));
    })(), true);
  }
  const data = (chunk: unknown) => {
    if (disposed || failure) return;
    try {
      if (!Buffer.isBuffer(chunk) || ended || state === "draining" && chunk.length) throw Error("Publication control requires an open original raw stream");
      bytes += chunk.length;
      if (bytes > limits.bytes) throw Error("Publication control cumulative byte bound exceeded");
      pending = Buffer.concat([pending, chunk]);
      while (pending.length) {
        const newline = pending.indexOf(10);
        if (newline < 0) { if (pending.length >= limits.lineBytes) throw Error("Publication control line bound exceeded"); break; }
        if (newline + 1 > limits.lineBytes || sequence >= limits.messages) throw Error("Publication control message bound exceeded");
        const line = decoder.decode(pending.subarray(0, newline + 1)); pending = pending.subarray(newline + 1);
        command(decodeApplicationPublicationControlCommand(line));
        if (state === "draining" && pending.length) throw Error("Publication control received data after final drain");
      }
    } catch (error) { fail(error); }
  };
  const end = () => {
    if (disposed || failure) return;
    if (ended || pending.length || state !== "draining") { fail(Error("Publication control EOF is missing its exact final drain")); return; }
    ended = true; resolveEnd();
  };
  const error = (cause: unknown) => fail(Error("Publication control input failed", { cause }));
  const aborted = () => fail(options.signal?.reason ?? Error("Original publication control was cancelled"));
  options.signal?.addEventListener("abort", aborted, { once: true }); if (options.signal?.aborted) aborted();
  if (input.readableObjectMode !== false || input.readableEncoding !== null || input.readableEnded || input.destroyed)
    fail(Error("Publication control requires an open raw original input"));
  else { input.on("data", data); input.on("end", end); input.on("error", error); }
  return Object.freeze({ signal: controller.signal,
    get failure() { return failure; }, get reason() { return state === "draining" ? "stdin-drain" as const : undefined; },
    async attach(operations: ApplicationPublicationHostOperations): Promise<ApplicationPublicationControlStatus> {
      if (owner || state !== "starting" || failure) throw failure ?? Error("Publication controller already attached or stopped");
      owner = operations; state = "pausing";
      const proof = await owner.pause();
      if (draining() || failure) throw failure ?? Error("Publication startup was stopped before initial quiescence");
      previous = ApplicationPublicationQuiescenceSchema.parse(proof); state = "quiesced";
      return status(-1, "quiesced", previous);
    },
    async finish(): Promise<void> {
      await finalInputClosed; await drainWork; await Promise.all([...work]);
      if (failure) throw failure;
    },
    dispose(): void { if (disposed) return; disposed = true; options.signal?.removeEventListener("abort", aborted);
      input.off("data", data); input.off("end", end); input.off("error", error); input.pause(); },
  });
}
