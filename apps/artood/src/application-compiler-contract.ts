import type { ApplicationBuildDraft, ApplicationBuildRejection, ApplicationBuildTextFile } from "./application-build-kernel.js";

/** Existing wire limits only; these do not establish native memory/CPU or transport qualification. */
export const APPLICATION_COMPILER_LIMITS = Object.freeze({ inputBytes: 52 * 1024 * 1024, outputBytes: 100 * 1024 * 1024 });
export interface ApplicationCompilerRequest {
  readonly version: 1; readonly kind: "compile"; readonly request_id: string;
  readonly source: readonly ApplicationBuildTextFile[];
}
export interface ApplicationCompilerResponse {
  readonly version: 1; readonly kind: "compile-result"; readonly request_id: string;
  readonly qualified_for_product: false; readonly result: ApplicationBuildDraft | ApplicationBuildRejection;
}
export const invalidApplicationCompilerProtocol = (): never => { throw Error("application_compiler_protocol_failed"); };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: readonly string[]): boolean =>
  Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));

/** Shared data shape only; the caller must measure its actual UTF-8 bytes before decoding. */
export function parseApplicationCompilerRequestText(text: string): ApplicationCompilerRequest {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return invalidApplicationCompilerProtocol(); }
  if (!object(value) || !keys(value, ["version", "kind", "request_id", "source"])
    || value.version !== 1 || value.kind !== "compile" || typeof value.request_id !== "string"
    || !/^[A-Za-z0-9_-]{1,64}$/u.test(value.request_id) || !Array.isArray(value.source)
    || value.source.length < 2 || value.source.length > 256) return invalidApplicationCompilerProtocol();
  for (const file of value.source) {
    if (!object(file) || !keys(file, ["path", "text"]) || typeof file.path !== "string"
      || file.path.length < 1 || file.path.length > 512 || typeof file.text !== "string") invalidApplicationCompilerProtocol();
  }
  return value as unknown as ApplicationCompilerRequest;
}

/** Serialization is shared; each adapter measures actual bytes and owns its own I/O. */
export const applicationCompilerResponseText = (value: ApplicationCompilerResponse): string => JSON.stringify(value) + "\n";
