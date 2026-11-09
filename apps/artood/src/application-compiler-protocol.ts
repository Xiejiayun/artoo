import { TextDecoder } from "node:util";
import { APPLICATION_COMPILER_LIMITS, applicationCompilerResponseText, invalidApplicationCompilerProtocol as invalid,
  parseApplicationCompilerRequestText, type ApplicationCompilerRequest, type ApplicationCompilerResponse } from "./application-compiler-contract.js";
export { APPLICATION_COMPILER_LIMITS } from "./application-compiler-contract.js";
export type { ApplicationCompilerRequest, ApplicationCompilerResponse } from "./application-compiler-contract.js";

export function decodeApplicationCompilerRequest(bytes: Uint8Array): ApplicationCompilerRequest {
  if (bytes.byteLength > APPLICATION_COMPILER_LIMITS.inputBytes) invalid();
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return invalid(); }
  return parseApplicationCompilerRequestText(text);
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
  const json = applicationCompilerResponseText(value);
  if (Buffer.byteLength(json, "utf8") > APPLICATION_COMPILER_LIMITS.outputBytes) invalid();
  return Buffer.from(json, "utf8");
}
