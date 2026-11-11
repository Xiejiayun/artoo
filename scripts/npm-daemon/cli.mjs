#!/usr/bin/env node
import { dirname, join } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { disableOptionalWebSocketAddons, readRelease } from "./verify.mjs";
import { assertSupportedPlatform } from "./platforms.mjs";

const modulePath = realpathSync(fileURLToPath(import.meta.url));

export function parseArguments(args) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return "help";
  if (args.length === 1 && ["--version", "-v"].includes(args[0])) return "version";
  if (!args.length || args.length === 1 && args[0] === "start") return "start";
  if (args[0] === "connect") return "connect";
  if (args.length === 1 && ["status", "stop", "--serve"].includes(args[0])) return args[0];
  if (args.length === 2 && args[0] === "start" && args[1] === "--foreground") return "foreground";
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
  packageDirectory = dirname(dirname(modulePath)), output = value => process.stdout.write(value) } = {}) {
  const mode = parseArguments(args);
  if (mode !== "help" && mode !== "version") {
    if (Number(process.versions.node.split(".")[0]) < 24) throw Error("Artoo requires Node.js 24 or later.");
    // Reject unsupported execution before reading local configuration, release
    // files or importing the runtime, especially the Windows-only supervisor.
    assertSupportedPlatform(mode);
  }
  const metadata = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
  if (mode === "version") { output(`${metadata.version}\n`); return; }
  if (mode === "help") {
    output(`${metadata.name} ${metadata.version} — Artoo agent daemon\n\n`
      + "Usage: artood [start] [--windows-supervised]\n       artood --help\n       artood --version\n\n"
      + "Requires Node.js 24 or later on Windows x64, macOS x64/arm64, or Linux x64/arm64.\n"
      + "Windows arm64 is not supported. No repository checkout or .NET installation is needed.\n"
      + "Connect this computer with the single-use command from Web → Machines → Connect Local Node:\n"
      + "  artood connect --server https://your-artoo-site --code XXXX-XXXX [--workspace /absolute/path]\n"
      + "It saves this computer's credentials, enrolls it and starts the daemon in the background.\n"
      + "  artood status             Show the local daemon status\n"
      + "  artood stop               Stop gracefully; keep the saved connection\n"
      + "  artood start              Restart using the saved connection\n"
      + "  artood start --foreground Run in this terminal (Ctrl+C to stop)\n\n"
      + "Codex/Claude authentication stays local. Install and sign in to a model CLI before running tasks.\n"
      + "Existing ARTOO_NODE_URL, ARTOO_NODE_ID and ARTOO_ALLOWED_ROOTS configuration remains supported.\n"
      + "Never pass a long-lived node token in command arguments.\n\n"
      + "--windows-supervised is Windows x64 only, uses the packaged native host and requires protected local\n"
      + "source/verifier/release profiles. npm installation alone does not provision them.\n"
      + "Ctrl+C requests the existing daemon's graceful shutdown.\n");
    return;
  }
  // Validate the immutable runtime pin before reading connection configuration.
  const release = mode === "status" || mode === "stop" ? null : readRelease(packageDirectory);
  if (mode === "connect") {
    const { connectComputer } = await import("./onboarding.mjs");
    return connectComputer({ args: args.slice(1), env, packageDirectory, metadata, output });
  }
  if (mode === "status" || mode === "stop") {
    const { showStatus, stopComputer } = await import("./onboarding.mjs");
    return mode === "status" ? showStatus(env, output) : stopComputer(env, output);
  }
  if (mode === "--serve") {
    const { serveManaged } = await import("./managed.mjs");
    const { stateDirectory, connectionEnvironment } = await import("./local-config.mjs");
    const directory = stateDirectory(env);
    // The node token must not become inherited process.env for model subprocesses.
    const base = { ...env };
    for (const key of Object.keys(process.env)) if (/^ARTOO_/i.test(key)) delete process.env[key];
    return serveManaged({ directory, launch: connection => runCli({ args: ["start"],
      env: connectionEnvironment(connection, base), packageDirectory, output }) });
  }
  const manual = ["ARTOO_NODE_URL", "ARTOO_NODE_ID", "ARTOO_ALLOWED_ROOTS"].some(key => env[key]);
  if (!manual && mode !== "supervised" && (env === process.env || typeof env.ARTOO_HOME === "string")) {
    const { savedConnectionEnvironment } = await import("./onboarding.mjs");
    const saved = await savedConnectionEnvironment(env);
    if (saved) {
      if (mode === "foreground") {
        const { serveManaged } = await import("./managed.mjs");
        for (const key of Object.keys(process.env)) if (/^ARTOO_/i.test(key)) delete process.env[key];
        return serveManaged({ directory: saved.directory,
          launch: () => runCli({ args: ["start"], env: saved.env, packageDirectory, output }) });
      }
      const { startManaged } = await import("./managed.mjs");
      return startManaged({ directory: saved.directory, packageDirectory, env, output });
    }
  }
  const configured = prepareEnvironment(env, release, mode === "foreground" ? "start" : mode);
  disableOptionalWebSocketAddons();
  const runtime = await import(pathToFileURL(join(release.runtime, "artood.mjs")).href);
  // The runtime reads this host's argv when selecting its unchanged supervisor path.
  const previous = process.argv;
  process.argv = [process.execPath, join(release.runtime, "artood.mjs"), ...(mode === "supervised" ? ["--windows-supervised"] : [])];
  try {
    const node = await runtime.runDaemonEntrypoint(configured);
    if (mode === "start" || mode === "foreground") output("Artoo daemon connected. Confirm the computer and runtime in the Web platform; press Ctrl+C to stop.\n");
    return node;
  }
  finally { process.argv = previous; }
}

// npm's POSIX bin is a symlink; compare physical paths while keeping imports inert.
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === modulePath) {
  runCli().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
}
