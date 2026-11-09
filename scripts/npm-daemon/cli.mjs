#!/usr/bin/env node
import { dirname, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { disableOptionalWebSocketAddons, readRelease } from "./verify.mjs";

export function parseArguments(args) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return "help";
  if (args.length === 1 && ["--version", "-v"].includes(args[0])) return "version";
  if (!args.length || args.length === 1 && args[0] === "start") return "start";
  if (args.length === 1 && args[0] === "--windows-supervised"
    || args.length === 2 && args[0] === "start" && args[1] === "--windows-supervised") return "supervised";
  throw Error("Unknown arguments. Run artood --help for usage.");
}

export function prepareEnvironment(env, release, mode) {
  const result = { ...env };
  if (mode === "supervised") {
    const native = release.manifest.windows_process;
    if (!native) throw Error("This package does not contain the Windows native process host.");
    const hasDirectory = result.ARTOO_WINDOWS_PROCESS_BUNDLE !== undefined;
    const hasDigest = result.ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256 !== undefined;
    if (hasDirectory !== hasDigest) throw Error("ARTOO_WINDOWS_PROCESS_BUNDLE and ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256 must be supplied together.");
    if (!hasDirectory) {
      result.ARTOO_WINDOWS_PROCESS_BUNDLE = join(release.runtime, native.directory);
      result.ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256 = native.manifest_sha256;
    }
    result.ARTOO_SUPERVISED_BUNDLE_MANIFEST_SHA256 ??= release.metadata.artoo.runtimeManifestSha256;
  }
  // Keep optional ws accelerators from resolving through a parent installation.
  result.WS_NO_BUFFER_UTIL = "1"; result.WS_NO_UTF_8_VALIDATE = "1";
  return result;
}

/** Redact configured secrets if an upstream connection error includes its URL. */
export function safeError(error, env = process.env) {
  let message = error instanceof Error ? error.message : "Daemon startup failed.";
  for (const [key, value] of Object.entries(env)) {
    if (value && /(?:TOKEN|KEY|SECRET|PASSWORD|ARTOO_NODE_URL)$/i.test(key)) message = message.split(value).join("[redacted]");
  }
  return message.replace(/((?:token|key|secret|password)=)[^\s&]+/gi, "$1[redacted]");
}

export async function runCli({ args = process.argv.slice(2), env = process.env,
  packageDirectory = dirname(dirname(fileURLToPath(import.meta.url))), output = value => process.stdout.write(value) } = {}) {
  const mode = parseArguments(args), metadata = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
  if (mode === "version") { output(`${metadata.version}\n`); return; }
  if (mode === "help") {
    output(`${metadata.name} ${metadata.version} — Artoo Windows agent daemon\n\n`
      + "Usage: artood [start] [--windows-supervised]\n       artood --help\n       artood --version\n\n"
      + "Requires Node.js 24 or later on Windows x64. No repository checkout or .NET installation is needed.\n"
      + "Configure ARTOO_NODE_URL, ARTOO_NODE_ID and ARTOO_ALLOWED_ROOTS before start.\n"
      + "Select ARTOO_RUNTIMES and install/login to the corresponding Codex or Claude CLI.\n"
      + "Pair and enroll the computer in the Web platform; NODE_ID is its computer ID.\n"
      + "Keep the node token in your local environment. Never pass it in command arguments.\n\n"
      + "--windows-supervised uses the packaged native host and requires protected local\n"
      + "source/verifier/release profiles. npm installation alone does not provision them.\n"
      + "Ctrl+C requests the existing daemon's graceful shutdown.\n");
    return;
  }
  if (Number(process.versions.node.split(".")[0]) < 24) throw Error("Artoo requires Node.js 24 or later.");
  if (process.platform !== "win32" || process.arch !== "x64") throw Error("This package supports Windows x64.");
  const release = readRelease(packageDirectory), configured = prepareEnvironment(env, release, mode);
  disableOptionalWebSocketAddons();
  const runtime = await import(pathToFileURL(join(release.runtime, "artood.mjs")).href);
  // The runtime reads this host's argv when selecting its unchanged supervisor path.
  const previous = process.argv;
  process.argv = [process.execPath, join(release.runtime, "artood.mjs"), ...(mode === "supervised" ? ["--windows-supervised"] : [])];
  try {
    const node = await runtime.runDaemonEntrypoint(configured);
    if (mode === "start") output("Artoo daemon connected. Confirm the computer and runtime in the Web platform; press Ctrl+C to stop.\n");
    return node;
  }
  finally { process.argv = previous; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
}
