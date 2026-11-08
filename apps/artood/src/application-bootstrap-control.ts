import { Buffer } from "node:buffer";
import type { EventEmitter } from "node:events";
import { TextDecoder } from "node:util";

export interface ApplicationBootstrapInput extends Pick<EventEmitter, "on" | "off"> {
  readonly readableObjectMode: boolean;
  readonly readableEncoding: string | null;
  readonly readableEnded: boolean;
  readonly destroyed: boolean;
  pause(): unknown;
}
export interface ApplicationBootstrapSignals {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}
export interface ApplicationBootstrapControl {
  /** Existing shutdown, OS signals and control failure cancel the current owner. */
  readonly signal: AbortSignal;
  /** Notification only: never forward this signal as an owner's cancellation. */
  readonly drainSignal: AbortSignal;
  readonly failure: Error | undefined;
  readonly reason: "stdin" | "stdin-drain" | "SIGINT" | "SIGTERM" | undefined;
  enableStdin(): void;
  dispose(): void;
}

// Each fixed wire command has precisely these two literal fields, in either
// order. Duplicate keys, escaped field names and additional commands reject.
const commandLine = /^[ \t\r]*\{[ \t\r]*(?:"version"[ \t\r]*:[ \t\r]*1[ \t\r]*,[ \t\r]*"kind"[ \t\r]*:[ \t\r]*"(shutdown|drain)"|"kind"[ \t\r]*:[ \t\r]*"(shutdown|drain)"[ \t\r]*,[ \t\r]*"version"[ \t\r]*:[ \t\r]*1)[ \t\r]*\}[ \t\r]*$/u;

/** Local parent control only. It can request a drain or cancel startup/service; it
 * grants no execution, installation, recovery or process-closure authority. */
export function installApplicationBootstrapControl(input: ApplicationBootstrapInput,
  host: ApplicationBootstrapSignals): ApplicationBootstrapControl {
  const controller = new AbortController(), drain = new AbortController();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let failure: Error | undefined, reason: ApplicationBootstrapControl["reason"];
  let disposed = false, enabled = false, attached = false, requested = false, ended = false;
  let bytesSeen = 0, pending = "";
  const reject = (detail: string, cause?: unknown) => {
    if (disposed || failure) return;
    failure = Error(`Application bootstrap stdin control ${detail}`, cause === undefined ? undefined : { cause });
    controller.abort();
  };
  const stop = (value: NonNullable<ApplicationBootstrapControl["reason"]>) => {
    if (disposed || failure) return;
    reason ??= value; controller.abort();
  };
  const interrupted = () => stop("SIGINT"), terminated = () => stop("SIGTERM");
  const data = (chunk: unknown) => {
    if (disposed || failure) return;
    try {
      if (!Buffer.isBuffer(chunk) || ended) throw Error("raw input required");
      if (!chunk.length) return;
      bytesSeen += chunk.length;
      if (bytesSeen > 4096 || requested) throw Error("command byte/count limit");
      const newline = chunk.indexOf(10);
      // Check raw framing before decoding: even an incomplete UTF-8 suffix after
      // the command's LF is forbidden trailing data.
      if (newline !== -1 && newline !== chunk.length - 1) throw Error("trailing data");
      pending += decoder.decode(chunk, { stream: true });
      if (newline === -1) return;
      pending += decoder.decode();
      const command = pending.endsWith("\n") ? commandLine.exec(pending.slice(0, -1)) : null;
      if (!command) throw Error("invalid command");
      pending = ""; requested = true;
      if ((command[1] ?? command[2]) === "drain") {
        reason ??= "stdin-drain"; drain.abort();
      } else stop("stdin"); // The original v1 shutdown remains cancellation.
    } catch (error) { reject("was invalid", error); }
  };
  const end = () => {
    if (disposed || failure) return;
    try {
      if (ended) throw Error("duplicate EOF");
      ended = true; pending += decoder.decode();
      if (pending.length || !requested) throw Error("control command missing or truncated");
    } catch (error) { reject("was lost or truncated", error); }
  };
  const error = (cause: unknown) => reject("transport failed", cause);
  host.on("SIGINT", interrupted); host.on("SIGTERM", terminated);
  return Object.freeze({ signal: controller.signal, drainSignal: drain.signal,
    get failure() { return failure; }, get reason() { return reason; },
    enableStdin() {
      if (disposed || enabled || failure || controller.signal.aborted) return;
      enabled = true;
      if (input.readableObjectMode !== false || input.readableEncoding !== null || input.readableEnded || input.destroyed) {
        reject("requires an open raw byte stream"); return;
      }
      attached = true;
      input.on("error", error); input.on("end", end); input.on("data", data);
    },
    dispose() {
      if (disposed) return; disposed = true;
      host.off("SIGINT", interrupted); host.off("SIGTERM", terminated);
      if (attached) { input.off("data", data); input.off("end", end); input.off("error", error); input.pause(); }
    },
  });
}
