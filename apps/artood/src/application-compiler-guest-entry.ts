import type TypeScript from "typescript";
import { createApplicationBuildKernel, type ApplicationBuildPlatform, type ApplicationBuildTextFile } from "./application-build-kernel.js";
import { applicationSha256, applicationUtf8ByteLength, applicationVirtualDirname, isWellFormedApplicationUtf8,
  resolveApplicationVirtualPath } from "./application-build-primitives.js";
import { APPLICATION_COMPILER_LIMITS, applicationCompilerResponseText, invalidApplicationCompilerProtocol,
  parseApplicationCompilerRequestText } from "./application-compiler-contract.js";

// Replaced only by the fixed guest packager. No source/request can choose the compiler or libraries.
declare const __ARTOO_GUEST_TYPESCRIPT__: typeof TypeScript;
declare const __ARTOO_PACKAGED_COMPILER_LIBRARIES__: readonly ApplicationBuildTextFile[];
const compiler = __ARTOO_GUEST_TYPESCRIPT__;
const forbiddenGlobals = ["process", "require", "module", "Buffer", "fetch", "XMLHttpRequest", "WebSocket", "WebAssembly", "Deno", "Bun"];
let compilerInUse = false;
const guardCompilerSystemCalls: ApplicationBuildPlatform["guardCompilerSystemCalls"] = (operation, reject) => {
  if (compilerInUse || compiler.version !== "5.9.3" || compiler.sys !== undefined
    || forbiddenGlobals.some(name => typeof (globalThis as Record<string, unknown>)[name] !== "undefined")) reject("host-fallback", "compiler");
  compilerInUse = true;
  try { return operation(); } finally { compilerInUse = false; }
};
// These are guest-local functions. No vm.newFunction, host hash callback, resolver or I/O is supplied.
const kernel = createApplicationBuildKernel(compiler, Object.freeze({
  utf8ByteLength: applicationUtf8ByteLength, isWellFormedUtf8: isWellFormedApplicationUtf8, sha256: applicationSha256,
  dirname: applicationVirtualDirname, resolvePath: resolveApplicationVirtualPath, guardCompilerSystemCalls,
}));

/** Trusted fixed entry only. The returned JSON carries no WeakMap identity or execution capability. */
export function compileApplicationGuestRequestJson(text: string): string {
  if (typeof text !== "string" || applicationUtf8ByteLength(text) > APPLICATION_COMPILER_LIMITS.inputBytes
    || !isWellFormedApplicationUtf8(text)) return invalidApplicationCompilerProtocol();
  const request = parseApplicationCompilerRequestText(text);
  const result = kernel.compileApplicationDraft({ version: 1, source: request.source, libraries: __ARTOO_PACKAGED_COMPILER_LIBRARIES__ });
  if (result.status === "compiled") kernel.assertApplicationBuildOutput(result, request.source, result.files);
  const output = applicationCompilerResponseText({ version: 1, kind: "compile-result", request_id: request.request_id,
    qualified_for_product: false, result });
  if (applicationUtf8ByteLength(output) > APPLICATION_COMPILER_LIMITS.outputBytes) return invalidApplicationCompilerProtocol();
  return output;
}
