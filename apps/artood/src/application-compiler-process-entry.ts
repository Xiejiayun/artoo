import { statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { serveApplicationCompiler } from "./application-compiler-process-stdio.js";
import { createApplicationCompiler } from "./application-compiler-loader.js";
function startup(): void {
  if (process.platform !== "win32" || process.arch !== "x64" || process.execArgv.length !== 1
    || process.execArgv[0] !== "--max-old-space-size=256" || process.argv.length !== 5
    || process.argv[2] !== "--application-compiler-process-v1" || !/^sha256:[a-f0-9]{64}$/u.test(process.argv[4]!)
    || basename(process.argv[1]!) !== "application-compiler-process.mjs" || basename(process.argv[3]!) !== "application-compiler-process.json"
    || dirname(process.argv[1]!) !== dirname(process.argv[3]!) || process.stdin.readableObjectMode || process.stdin.readableEncoding !== null)
    throw Error("compiler-startup");
  // Same development-only environment admission as runtime v1. Values of the
  // observed injected telemetry names are never read, changed or exposed.
  const allowed = new Set(["SYSTEMROOT", "WINDIR", "AI_TELEMETRY_SESSION_ID", "AI_TELEMETRY_SOURCE", "AI_TELEMETRY_HOOK_DLL_PATH"]);
  const names = Object.keys(process.env);
  if (names.length !== 5 || new Set(names.map(name => name.toUpperCase())).size !== 5
    || names.some(name => !allowed.has(name.toUpperCase()) || /^(?:SystemRoot|WINDIR)$/iu.test(name)
      && (typeof process.env[name] !== "string" || process.env[name]!.length === 0))) throw Error("compiler-environment");
}
try { startup(); await serveApplicationCompiler(process.stdin, process.stdout, deadline => createApplicationCompiler({
  path: process.argv[3]!, bytes: statSync(process.argv[3]!).size, sha256: process.argv[4]!,
}, deadline)); }
catch { process.exitCode = 1; process.stdin.destroy(); process.stderr.write("application_compiler_failed\n"); }
