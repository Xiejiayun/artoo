import { TextDecoder } from "node:util";
import type { ApplicationBuildDraft, ApplicationBuildRejection, ApplicationBuildTextFile } from "./application-build-core.js";

/** Transport limits are independent of decoded source/output limits and are not OS memory limits. */
export const APPLICATION_COMPILER_LIMITS = Object.freeze({ inputBytes: 52 * 1024 * 1024, outputBytes: 100 * 1024 * 1024 });
export interface ApplicationCompilerRequest {
  readonly version: 1; readonly kind: "compile"; readonly request_id: string;
  readonly source: readonly ApplicationBuildTextFile[];
}
export interface ApplicationCompilerResponse {
  readonly version: 1; readonly kind: "compile-result"; readonly request_id: string;
  readonly qualified_for_product: false; readonly result: ApplicationBuildDraft | ApplicationBuildRejection;
}
const invalid = (): never => { throw Error("application_compiler_protocol_failed"); };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: readonly string[]): boolean =>
  Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));

export function decodeApplicationCompilerRequest(bytes: Uint8Array): ApplicationCompilerRequest {
  if (bytes.byteLength > APPLICATION_COMPILER_LIMITS.inputBytes) invalid();
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)); }
  catch { return invalid(); }
  if (!object(value) || !keys(value, ["version", "kind", "request_id", "source"])
    || value.version !== 1 || value.kind !== "compile" || typeof value.request_id !== "string"
    || !/^[A-Za-z0-9_-]{1,64}$/u.test(value.request_id) || !Array.isArray(value.source)
    || value.source.length < 2 || value.source.length > 256) return invalid();
  for (const file of value.source) {
    if (!object(file) || !keys(file, ["path", "text"]) || typeof file.path !== "string"
      || file.path.length < 1 || file.path.length > 512 || typeof file.text !== "string") invalid();
  }
  return value as unknown as ApplicationCompilerRequest;
}

/** One JSON value followed by EOF. Count actual chunks before retaining or parsing them. */
export async function readApplicationCompilerRequest(input: AsyncIterable<Uint8Array>): Promise<ApplicationCompilerRequest> {
  // A fixed buffer also bounds retained structure when a producer supplies one-byte
  // or empty chunks. An array per incoming chunk would not be bounded by byte count.
  const buffer = Buffer.allocUnsafe(APPLICATION_COMPILER_LIMITS.inputBytes); let bytes = 0;
  for await (const chunk of input) {
    if (chunk.byteLength > APPLICATION_COMPILER_LIMITS.inputBytes - bytes) invalid();
    buffer.set(chunk, bytes); bytes += chunk.byteLength;
  }
  return decodeApplicationCompilerRequest(buffer.subarray(0, bytes));
}

/** JSON escaping can expand a single source byte to six encoded bytes. Measure the actual response. */
export function encodeApplicationCompilerResponse(value: ApplicationCompilerResponse): Buffer {
  const json = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(json, "utf8") > APPLICATION_COMPILER_LIMITS.outputBytes) invalid();
  return Buffer.from(json, "utf8");
}
