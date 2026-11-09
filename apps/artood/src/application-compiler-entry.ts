import { encodeApplicationCompilerResponse, readApplicationCompilerRequest } from "./application-compiler-protocol.js";
import type { ApplicationBuildTextFile } from "./application-build-core.js";

// Replaced only by the fixed packaging script. The unbundled entry has no library fallback.
declare const __ARTOO_PACKAGED_COMPILER_LIBRARIES__: readonly ApplicationBuildTextFile[];

let transportFailed = false, failureWritten = false;
function fail(): void {
  transportFailed = true; process.exitCode = 1; process.stdin.destroy();
  if (!failureWritten && !process.stderr.destroyed && process.stderr.writable) {
    failureWritten = true;
    // Both callback and event paths are observed: broken pipes must not emit an
    // uncaught error/stack, recurse, retry indefinitely, or reset the failure state.
    process.stderr.write("application_compiler_failed\n", error => { if (error) fail(); });
  }
}
process.stdin.on("error", fail);
process.stdout.on("error", fail);
process.stderr.on("error", fail);

async function main(): Promise<void> {
  if (process.argv.length !== 3 || process.argv[2] !== "--application-compiler-v1" || process.execArgv.length
    || Object.keys(process.env).some(key => /^(?:NODE_OPTIONS|NODE_PATH|TSC_.*|NODE_INSPECTOR_IPC|VSCODE_INSPECTOR_OPTIONS)$/iu.test(key))
    || typeof __ARTOO_PACKAGED_COMPILER_LIBRARIES__ === "undefined") throw Error("configuration");
  const request = await readApplicationCompilerRequest(process.stdin);
  // esbuild resolves this fixed import inside the single bundle. The packaging audit rejects
  // any surviving dynamic import. TypeScript initializes only after startup/request checks.
  const { compileApplicationDraft, assertApplicationBuildOutput } = await import("./application-build-core.js");
  const result = compileApplicationDraft({ version: 1, source: request.source, libraries: __ARTOO_PACKAGED_COMPILER_LIBRARIES__ });
  if (result.status === "compiled") assertApplicationBuildOutput(result, request.source, result.files);
  const output = encodeApplicationCompilerResponse({ version: 1, kind: "compile-result", request_id: request.request_id,
    qualified_for_product: false, result });
  if (transportFailed) throw Error("transport");
  await new Promise<void>((resolve, reject) => process.stdout.write(output, error => error || transportFailed ? reject(Error("transport")) : resolve()));
}

// This entry performs trusted text compilation only. It never loads emitted product JavaScript.
void main().catch(fail);
