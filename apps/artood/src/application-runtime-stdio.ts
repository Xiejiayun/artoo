import type { Readable, Writable } from "node:stream";
import { TextDecoder } from "node:util";
import type { ApplicationRuntimeChannel } from "./application-runtime-channel.js";
import { APPLICATION_RUNTIME_PROTOCOL, APPLICATION_RUNTIME_PROCESS_LIMITS as limits,
  ApplicationRuntimeAdmissionSchema, ApplicationRuntimeInputSchema, decodeApplicationRuntimeBytes } from "./application-runtime-process-protocol.js";

export interface OwnedApplicationRuntime {
  readonly channel: ApplicationRuntimeChannel;
  /** Reads the actual original runtime/context alive flags, never closes them. */
  assertDisposed(): void;
  /** Revokes captured artifacts and closes the boundary after channel cleanup. */
  release(): void;
}

/** Fixed entry transport. Its injectable streams/factory are for trusted callers
 * and controlled tests, not remote authority or a substitute native owner. */
export async function serveApplicationRuntime(input: Readable, output: Writable,
  create: (deadline: number) => Promise<OwnedApplicationRuntime>, now: () => number = performance.now.bind(performance)): Promise<void> {
  if (input.readableObjectMode || input.readableEncoding !== null) throw Error("runtime-input-mode");
  const iterator = input[Symbol.asyncIterator]();
  let retained = Buffer.alloc(0), inputBytes = 0, outputBytes = 0, inputSequence = 0, outputSequence = 0;
  let eof = false, closing = false, owned: OwnedApplicationRuntime | undefined;
  let deadline = Infinity, previousTime = now();
  const checkTime = (): void => {
    const time = now();
    if (!Number.isFinite(time) || time < previousTime || time >= deadline) throw Error("runtime-deadline");
    previousTime = time;
  };
  const line = async (): Promise<Buffer | undefined> => {
    for (;;) {
      const end = retained.indexOf(10);
      if (end >= 0) {
        if (end + 1 > limits.childLineBytes) throw Error("runtime-input-line");
        const result = retained.subarray(0, end); retained = retained.subarray(end + 1); return result;
      }
      if (eof) { if (retained.length) throw Error("runtime-input-truncated"); return; }
      if (retained.length >= limits.childLineBytes) throw Error("runtime-input-line");
      const next = await iterator.next();
      if (next.done) {
        if (!input.readableEnded || input.errored != null) throw Error("runtime-input-eof");
        eof = true; continue;
      }
      if (!(next.value instanceof Uint8Array) || next.value.byteLength > limits.childChunkBytes) throw Error("runtime-input-chunk");
      inputBytes += next.value.byteLength;
      if (inputBytes > limits.childInputBytes) throw Error("runtime-input-total");
      retained = Buffer.concat([retained, next.value]);
    }
  };
  const parse = (bytes: Buffer) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  const send = async (kind: string, payload: unknown): Promise<void> => {
    checkTime();
    const bytes = Buffer.from(JSON.stringify({ version: 1, sequence: outputSequence++, kind, payload }) + "\n");
    outputBytes += bytes.length;
    if (outputSequence > limits.inputCommands || bytes.length > limits.childLineBytes || outputBytes > limits.childOutputBytes) throw Error("runtime-output-limit");
    await new Promise<void>((resolve, reject) => output.write(bytes, error => error ? reject(error) : resolve()));
    checkTime();
  };
  let pending: Promise<{ value: Buffer | undefined }> | undefined;
  const readPending = () => {
    if (!pending) { pending = line().then(value => ({ value })); void pending.catch(() => {}); }
    return pending;
  };
  const tick = async () => { await new Promise<void>(resolve => setTimeout(resolve, 1)); checkTime(); };
  try {
    const first = await line();
    if (!first || first.length > 255) throw Error("runtime-admission");
    const admission = ApplicationRuntimeAdmissionSchema.parse(parse(first));
    checkTime(); deadline = previousTime + admission.remainingMs;
    owned = await create(deadline); checkTime();
    while (owned.channel.status.state === "initializing") { owned.channel.advance(); await tick(); }
    if (owned.channel.status.state !== "ready") throw Error("runtime-startup");
    await send("ready", { protocol: APPLICATION_RUNTIME_PROTOCOL, qualifiedForProduct: false });
    for (;;) {
      checkTime();
      // Exactly one original write must finish before another chunk is handed
      // off or another pump can execute. No independent output producer exists.
      if (!closing) {
        for (let bytes = owned.channel.readOutput(); bytes; bytes = owned.channel.readOutput()) {
          await send("output", { data: Buffer.from(bytes).toString("base64") });
        }
      }
      const next = closing ? await readPending() : await Promise.race([readPending(), tick().then(() => null)]);
      if (next === null) { owned.channel.advance(); continue; }
      pending = undefined;
      if (!next.value) {
        if (!closing) throw Error("runtime-unexpected-eof");
        const status = owned.channel.endInput(); // Only this original iterator observed natural EOF.
        if (status.state !== "closed" || !status.guestDisposed || !status.inputEnded || status.discardedOutputBytes !== 0) throw Error("runtime-disposal");
        owned.assertDisposed();
        await send("closed", { guestDisposed: true, inputEnded: true, discardedOutputBytes: 0, qualifiedForProduct: false });
        return;
      }
      if (closing) throw Error("runtime-input-after-close");
      const command = ApplicationRuntimeInputSchema.parse(parse(next.value));
      if (command.sequence !== inputSequence++) throw Error("runtime-input-sequence");
      if (command.kind === "receive") {
        owned.channel.receive(decodeApplicationRuntimeBytes(command.data, limits.childChunkBytes));
        owned.channel.advance();
      } else {
        closing = true;
        const status = owned.channel.close();
        if (!status.guestDisposed || status.discardedOutputBytes !== 0) throw Error("runtime-disposal");
      }
    }
  } finally {
    // The channel is the exclusive session owner. Never supplement its cleanup
    // with a direct session.close that could mask uncertainty.
    try { owned?.channel.close(); } finally { owned?.release(); }
    if (!eof) input.destroy();
    void pending?.catch(() => {});
  }
}
