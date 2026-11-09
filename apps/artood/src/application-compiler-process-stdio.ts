import type { Readable, Writable } from "node:stream";
import { ApplicationCompilerAdmissionSchema, APPLICATION_COMPILER_PROCESS_LIMITS as limits } from "./application-compiler-process-protocol.js";
export interface OwnedApplicationCompiler {
  compile(bytes: Uint8Array): Uint8Array;
  assertDisposed(): void;
  release(): void;
}
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const getter = (name: string) => Object.getOwnPropertyDescriptor(typedArray, name)!.get!;
const lengthOf = getter("byteLength"), bufferOf = getter("buffer"), offsetOf = getter("byteOffset");
const arrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!;
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;
function view(input: Uint8Array): Uint8Array {
  if (!(input instanceof Uint8Array)) throw Error("compiler-stdio-storage");
  const buffer = Reflect.apply(bufferOf, input, []); Reflect.apply(arrayBufferLength, buffer, []);
  if (resizable && Reflect.apply(resizable, buffer, [])) throw Error("compiler-stdio-storage");
  return new Uint8Array(buffer, Reflect.apply(offsetOf, input, []), Reflect.apply(lengthOf, input, []));
}
/** Admission line followed by exactly one raw JSON request and real stdin EOF.
 * Output is emitted only after the actual compiler scopes report disposal. */
export async function serveApplicationCompiler(input: Readable, output: Writable,
  create: (deadline: number) => Promise<OwnedApplicationCompiler>, now = performance.now.bind(performance)): Promise<void> {
  if (input.readableObjectMode || input.readableEncoding !== null || output.writableObjectMode) throw Error("compiler-stdio-mode");
  let previous = now(), deadline = previous + limits.lifetimeMs;
  const check = () => { const time = now(); if (!Number.isFinite(time) || time < previous || time >= deadline) throw Error("compiler-stdio-deadline"); previous = time; };
  if (!Number.isFinite(previous)) throw Error("compiler-stdio-clock");
  const admissionBytes = Buffer.alloc(256), requestBytes = Buffer.allocUnsafe(limits.requestBytes);
  let admissionLength = 0, requestLength = 0, admitted = false, owned: OwnedApplicationCompiler | undefined;
  try {
    for await (const raw of input) {
      check(); const bytes = view(raw); let offset = 0;
      if (bytes.length > limits.childChunkBytes) throw Error("compiler-stdio-chunk");
      if (!admitted) {
        while (offset < bytes.length && !admitted) {
          const value = bytes[offset++]!;
          if (value === 10) {
            if (!admissionLength || admissionLength > 255) throw Error("compiler-stdio-admission");
            const admission = ApplicationCompilerAdmissionSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(admissionBytes.subarray(0, admissionLength))));
            check(); deadline = Math.min(deadline, previous + admission.remainingMs); admitted = true;
          } else {
            if (admissionLength >= 255) throw Error("compiler-stdio-admission"); admissionBytes[admissionLength++] = value;
          }
        }
      }
      const rest = bytes.subarray(offset);
      if (rest.length > limits.requestBytes - requestLength) throw Error("compiler-stdio-input-bound");
      requestBytes.set(rest, requestLength); requestLength += rest.length;
    }
    check();
    if (!input.readableEnded || input.errored != null || !admitted || requestLength < 1) throw Error("compiler-stdio-eof");
    // Loading after real EOF prevents trusted bootstrap allocation while an
    // incomplete/oversized request is still in flight; no renewed deadline.
    owned = await create(deadline); check();
    const compiled = view(owned.compile(requestBytes.subarray(0, requestLength))); check();
    if (compiled.length < 1 || compiled.length > limits.responseBytes) throw Error("compiler-stdio-output-bound");
    owned.assertDisposed(); check(); const releasing = owned; owned = undefined; releasing.release(); check();
    for (let offset = 0; offset < compiled.length; offset += limits.childChunkBytes) {
      await new Promise<void>((resolve, reject) => output.write(compiled.subarray(offset, offset + limits.childChunkBytes), error => error ? reject(error) : resolve()));
      check();
    }
  } finally { owned?.release(); }
}
