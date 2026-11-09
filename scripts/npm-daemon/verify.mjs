import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const digest = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const hashPattern = /^sha256:[a-f0-9]{64}$/;
const fail = message => { throw Error(`Artoo npm package: ${message}`); };
const member = value => typeof value === "string" && value.length > 0 && !isAbsolute(value)
  && !/[\\:\u0000-\u001f]/.test(value) && value.split("/").every(part => part && part !== "." && part !== "..");

export function disableOptionalWebSocketAddons() {
  // ws reads the actual process environment during module initialization, before
  // the daemon receives its configuration object. Keep ancestor packages out.
  process.env.WS_NO_BUFFER_UTIL = "1";
  process.env.WS_NO_UTF_8_VALIDATE = "1";
}

/** Read the release pin outside the unchanged desktop-compatible runtime tree. */
export function readRelease(packageDirectory) {
  const root = resolve(packageDirectory), metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (metadata.artoo?.format !== "artoo.npm-daemon.v1" || !hashPattern.test(metadata.artoo.runtimeManifestSha256 ?? ""))
    fail("missing release manifest pin");
  const runtime = join(root, "runtime"), path = join(runtime, "bundle-manifest.json");
  const bytes = readFileSync(path);
  if (digest(bytes) !== metadata.artoo.runtimeManifestSha256) fail("runtime manifest differs from the release pin");
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (manifest.format !== "artoo.desktop-daemon.v1" || manifest.node_target !== "node24"
    || !Array.isArray(manifest.tree?.files) || !Array.isArray(manifest.tree?.directories)) fail("unsupported runtime manifest");
  return { root, runtime, metadata, manifest };
}

/** Verify the installed files, including dependencies that npm can otherwise omit. */
export async function verifyPackage(packageDirectory, { importRuntime = true } = {}) {
  disableOptionalWebSocketAddons();
  const release = readRelease(packageDirectory), { runtime, manifest } = release;
  const expected = new Map(), expectedDirectories = new Set(), names = new Set();
  for (const name of [...manifest.tree.directories, ...manifest.tree.files.map(file => file.path)]) {
    if (!member(name) || names.has(name.toLowerCase()) || name.toLowerCase() === "bundle-manifest.json") fail("invalid or duplicate runtime member");
    names.add(name.toLowerCase());
  }
  for (const directory of manifest.tree.directories) expectedDirectories.add(directory);
  for (const file of manifest.tree.files) {
    if (!Number.isSafeInteger(file.size) || file.size < 0 || !hashPattern.test(file.sha256 ?? "")) fail("invalid runtime file fact");
    expected.set(file.path, file);
  }
  let files = 0, directories = 0, totalBytes = 0;
  const walk = (directory, depth = 0) => {
    if (depth > 64 || files + directories > 30_000) fail("runtime inventory limit exceeded");
    for (const name of readdirSync(directory)) {
      const path = join(directory, name), local = relative(runtime, path).split(sep).join("/");
      const before = lstatSync(path);
      if (before.isSymbolicLink()) fail(`runtime contains a link: ${local}`);
      if (before.isDirectory()) {
        if (!expectedDirectories.has(local)) fail(`unlisted runtime directory: ${local}`);
        directories++; walk(path, depth + 1);
      } else {
        if (!before.isFile() || before.nlink !== 1) fail(`runtime member is not a single-link file: ${local}`);
        if (local === "bundle-manifest.json") continue;
        const fact = expected.get(local);
        if (!fact || fact.size !== before.size) fail(`missing or changed runtime member: ${local}`);
        const bytes = readFileSync(path), after = lstatSync(path);
        if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs
          || after.nlink !== 1 || after.isSymbolicLink() || digest(bytes) !== fact.sha256) fail(`runtime bytes changed: ${local}`);
        files++; totalBytes += bytes.length;
      }
    }
  };
  walk(runtime);
  if (files !== expected.size || directories !== expectedDirectories.size || !expected.has("artood.mjs")) fail("runtime inventory is incomplete");
  const local = createRequire(join(runtime, "artood.mjs"));
  for (const name of ["playwright", "playwright-core"]) {
    const packagePath = local.resolve(`${name}/package.json`);
    if (realpathSync(packagePath) !== realpathSync(join(runtime, "node_modules", name, "package.json"))
      || local(`${name}/package.json`).version !== manifest.playwright_version
      || typeof local(name).chromium.launch !== "function") fail(`runtime dependency is not self-contained: ${name}`);
  }
  if (importRuntime) {
    const entry = await import(pathToFileURL(join(runtime, "artood.mjs")).href);
    if (typeof entry.runDaemonEntrypoint !== "function" || typeof entry.loadConfigFromEnv !== "function") fail("daemon entrypoint is missing");
  }
  return { name: release.metadata.name, version: release.metadata.version, files, bytes: totalBytes,
    runtimeManifestSha256: release.metadata.artoo.runtimeManifestSha256, native: !!manifest.windows_process };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--package-directory") {
    console.error("Usage: node verify.mjs --package-directory <installed package directory>"); process.exitCode = 1;
  } else {
    verifyPackage(args[1]).then(value => console.log(JSON.stringify(value)), error => { console.error(error.message); process.exitCode = 1; });
  }
}
