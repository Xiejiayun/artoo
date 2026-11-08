// Host-side response parsing only. The packaged compiler must not import this module.
import { TextDecoder } from "node:util";
import { z } from "zod";
import { APPLICATION_BUILD_EXECUTION_STATUS } from "./application-build-kernel.js";
import { isWellFormedApplicationUtf8 } from "./application-build-primitives.js";
import { APPLICATION_COMPILER_LIMITS, invalidApplicationCompilerProtocol as invalid,
  type ApplicationCompilerResponse } from "./application-compiler-contract.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const pin = z.object({ path: z.string().min(1).max(512), bytes: z.number().int().min(0).max(16 * 1024 * 1024), sha256: digest }).strict();
const diagnostic = z.object({ category: z.enum(["input", "policy", "compiler", "integrity"]),
  code: z.string().min(1).max(128), message: z.string().min(1).max(2048), file: z.string().min(1).max(512).optional(),
  line: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  column: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional() }).strict();
const result = z.discriminatedUnion("status", [
  z.object({ status: z.literal("compiled"), diagnostics: z.tuple([]),
    manifest: z.object({ version: z.literal(1), format: z.literal("artoo.application-build-draft.v1"),
      compiler_version: z.string().min(1).max(64), compiler_lib_digest: digest, sdk_digest: digest,
      source_digest: digest, artifact_digest: digest, source_files: z.array(pin).min(2).max(256),
      compiler_lib_files: z.array(pin).min(1).max(128), artifact_files: z.array(pin).min(2).max(256),
      execution: z.literal(APPLICATION_BUILD_EXECUTION_STATUS) }).strict(),
    files: z.array(z.object({ path: z.string().min(1).max(512),
      text: z.string().max(16 * 1024 * 1024).refine(value =>
        Buffer.byteLength(value, "utf8") <= 16 * 1024 * 1024 && isWellFormedApplicationUtf8(value)) }).strict()).min(2).max(256),
  }).strict(),
  z.object({ status: z.literal("rejected"), diagnostics: z.array(diagnostic).min(1).max(32),
    execution: z.literal(APPLICATION_BUILD_EXECUTION_STATUS) }).strict(),
]);
const response = z.object({ version: z.literal(1), kind: z.literal("compile-result"),
  request_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u), qualified_for_product: z.literal(false), result }).strict();

// Inspect true typed-array storage rather than caller-overridden .byteLength or
// .buffer properties. Shared/resizable/detached storage is not a response chunk.
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const getter = (name: string) => Object.getOwnPropertyDescriptor(typedArray, name)!.get!;
const byteLengthOf = getter("byteLength"), bufferOf = getter("buffer"), byteOffsetOf = getter("byteOffset");
const arrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!;
const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;
function responseView(bytes: Uint8Array): Uint8Array {
  try {
    if (!(bytes instanceof Uint8Array)) return invalid();
    const buffer: unknown = Reflect.apply(bufferOf, bytes, []);
    Reflect.apply(arrayBufferLength, buffer, []);
    if (resizable && Reflect.apply(resizable, buffer, [])) return invalid();
    return new Uint8Array(buffer as ArrayBuffer, Reflect.apply(byteOffsetOf, bytes, []), Reflect.apply(byteLengthOf, bytes, []));
  } catch { return invalid(); }
}
/** Data shape only: parsing a claimed result grants no compiler/process authority. */
export function decodeApplicationCompilerResponse(bytes: Uint8Array): ApplicationCompilerResponse {
  const view = responseView(bytes);
  if (view.byteLength > APPLICATION_COMPILER_LIMITS.outputBytes) return invalid();
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(view)); }
  catch { return invalid(); }
  const parsed = response.safeParse(value);
  if (!parsed.success) return invalid();
  return parsed.data;
}
/** One complete response plus EOF; the caller separately owns deadlines and the
 * original process. EOF and content matching never establish process closure. */
export async function readApplicationCompilerResponse(input: AsyncIterable<Uint8Array>): Promise<ApplicationCompilerResponse> {
  const buffer = Buffer.allocUnsafe(APPLICATION_COMPILER_LIMITS.outputBytes); let bytes = 0;
  for await (const chunk of input) {
    const view = responseView(chunk);
    if (view.byteLength > APPLICATION_COMPILER_LIMITS.outputBytes - bytes) return invalid();
    buffer.set(view, bytes); bytes += view.byteLength;
  }
  return decodeApplicationCompilerResponse(buffer.subarray(0, bytes));
}
