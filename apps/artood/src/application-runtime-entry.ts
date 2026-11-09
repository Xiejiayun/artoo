import { statSync } from "node:fs";
import { serveApplicationRuntime } from "./application-runtime-stdio.js";
import { createApplicationRuntime } from "./application-runtime-loader.js";

function startup(): void {
  if (process.platform !== "win32" || process.arch !== "x64" || process.execArgv.length !== 1
    || process.execArgv[0] !== "--max-old-space-size=256" || process.argv.length !== 5
    || process.argv[2] !== "--application-runtime-v1" || !/^sha256:[a-f0-9]{64}$/u.test(process.argv[4]!)
    || process.stdin.readableObjectMode || process.stdin.readableEncoding !== null) throw Error("runtime-startup");
  // Exact previously exercised DEVELOPMENT names. Their source is unproven;
  // telemetry values are never read or changed and unknown names fail closed.
  const allowed = new Set(["SYSTEMROOT", "WINDIR", "AI_TELEMETRY_SESSION_ID", "AI_TELEMETRY_SOURCE", "AI_TELEMETRY_HOOK_DLL_PATH"]);
  const names = Object.keys(process.env);
  if (names.length !== 5 || new Set(names.map(name => name.toUpperCase())).size !== 5
    || names.some(name => !allowed.has(name.toUpperCase()) || /^(?:SystemRoot|WINDIR)$/iu.test(name)
      && (typeof process.env[name] !== "string" || process.env[name]!.length === 0))) throw Error("runtime-environment");
}
try { startup(); await serveApplicationRuntime(process.stdin, process.stdout, deadline => createApplicationRuntime({
  path: process.argv[3]!, bytes: statSync(process.argv[3]!).size, sha256: process.argv[4]!,
}, deadline)); }
catch {
  process.exitCode = 1; process.stdin.destroy();
  // No paths, request text, vendor stacks or configuration values enter stderr.
  process.stderr.write("application_runtime_failed\n");
}
