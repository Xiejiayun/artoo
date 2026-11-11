import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { parseArguments, prepareEnvironment, runCli, safeError } from "./cli.mjs";
import { parseBuildArguments } from "./build.mjs";
import { readRelease, verifyPackage } from "./verify.mjs";

const supportedTuples = ["win32-x64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"];
const sha = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

// Test the real wrapper dispatch with controlled runtime code. Changing the
// process descriptors is confined to this serial test file; it is not evidence
// of executing native code on the simulated operating system or architecture.
async function withTuple(tuple, action) {
  const descriptors = { platform: Object.getOwnPropertyDescriptor(process, "platform"), arch: Object.getOwnPropertyDescriptor(process, "arch") };
  const [platform, arch] = tuple.split("-");
  Object.defineProperty(process, "platform", { ...descriptors.platform, value: platform });
  Object.defineProperty(process, "arch", { ...descriptors.arch, value: arch });
  try { return await action(); }
  finally {
    Object.defineProperty(process, "platform", descriptors.platform);
    Object.defineProperty(process, "arch", descriptors.arch);
  }
}

function controlledPackage({ omitManifest = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "artoo-npm-dispatch-test-")), runtime = join(directory, "runtime");
  const marker = join(directory, "runtime-imported.txt");
  mkdirSync(runtime);
  const source = `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, 'controlled runtime imported');
export async function runDaemonEntrypoint(env) { return { env, argv: [...process.argv],
  noBufferUtil: process.env.WS_NO_BUFFER_UTIL, noUtf8Validate: process.env.WS_NO_UTF_8_VALIDATE }; }
`;
  const native = { directory: "native/windows-process", manifest_sha256: `sha256:${"b".repeat(64)}` };
  const manifest = JSON.stringify({ format: "artoo.desktop-daemon.v1", node_target: "node24", windows_process: native,
    tree: { directories: [], files: [{ path: "artood.mjs", size: Buffer.byteLength(source), sha256: sha(source) }] } });
  const metadata = { name: "controlled-fixture", version: "0.1.0-test.1", artoo: {
    format: "artoo.npm-daemon.v1", runtimeManifestSha256: sha(manifest), platforms: supportedTuples } };
  writeFileSync(join(directory, "package.json"), JSON.stringify(metadata));
  writeFileSync(join(runtime, "artood.mjs"), source);
  if (!omitManifest) writeFileSync(join(runtime, "bundle-manifest.json"), manifest);
  return { directory, runtime, marker, metadata, native };
}

const unreadableConfiguration = () => new Proxy({}, {
  ownKeys() { throw Error("configuration was read before platform rejection"); },
  get() { throw Error("configuration was read before platform rejection"); },
});

test("CLI only dispatches explicit supported entrypoints", () => {
  assert.equal(parseArguments([]), "start");
  assert.equal(parseArguments(["start"]), "start");
  assert.equal(parseArguments(["start", "--windows-supervised"]), "supervised");
  assert.equal(parseArguments(["--windows-supervised"]), "supervised");
  assert.equal(parseArguments(["--help"]), "help");
  assert.equal(parseArguments(["--version"]), "version");
  assert.equal(parseArguments(["configure", "--file", "/absolute/team.json"]), "configure");
  for (const args of [["--windows-supervised-daemon"], ["--version", "start"], ["start", "--token", "secret"], ["pair"]])
    assert.throws(() => parseArguments(args), /Unknown arguments/);
});

test("help/version need no runtime, network or credentials", async () => {
  const directory = mkdtempSync(join(tmpdir(), "artoo-npm-cli-test-"));
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "artood", version: "0.1.0-test.1" }));
  let output = "";
  await runCli({ args: ["--version"], packageDirectory: directory, output: value => { output += value; } });
  assert.equal(output, "0.1.0-test.1\n");
  output = "";
  await runCli({ args: ["--help"], env: { ARTOO_NODE_URL: "ws://secret/?token=do-not-show" }, packageDirectory: directory, output: value => { output += value; } });
  assert.match(output, /artood \[start\]/); assert.doesNotMatch(output, /do-not-show/);
  assert.match(output, /Windows arm64 is not supported/);
  await withTuple("win32-arm64", () => runCli({ args: ["--version"], packageDirectory: directory, output: () => {} }));
});

function installedEntrypoints(t) {
  const parent = realpathSync(tmpdir()), root = mkdtempSync(join(parent, "artoo-npm-entry-test-"));
  t.after(() => {
    assert.ok(realpathSync(root).startsWith(`${parent}${sep}artoo-npm-entry-test-`));
    rmSync(root, { recursive: true });
  });
  const directory = join(root, "node_modules/@artoo/controlled-fixture"), bin = join(directory, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "@artoo/controlled-fixture", version: "0.1.0-test.1", type: "module" }));
  for (const [source, target] of [["cli.mjs", "artood.mjs"], ["verify.mjs", "verify.mjs"], ["platforms.mjs", "platforms.mjs"]])
    copyFileSync(fileURLToPath(new URL(source, import.meta.url)), join(bin, target));
  const direct = join(bin, "artood.mjs"), npmBin = join(root, "node_modules/.bin");
  let linked;
  if (process.platform === "win32") {
    // A real directory junction exercises path canonicalization without the
    // elevated privilege required to create a Windows file symlink.
    symlinkSync(bin, npmBin, "junction"); linked = join(npmBin, "artood.mjs");
  } else {
    mkdirSync(npmBin); chmodSync(direct, 0o755);
    linked = join(npmBin, "artood");
    symlinkSync("../@artoo/controlled-fixture/bin/artood.mjs", linked);
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:NODE_OPTIONS|NODE_PATH)$/i.test(key)));
  return { direct, linked, env };
}

function entryProcess(executable, args, env) {
  const result = spawnSync(executable, args, { env, encoding: "utf8", timeout: 10_000, windowsHide: true });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
  return result.stdout;
}

test("actual and npm-linked CLI entrypoints print version and help in real child processes", t => {
  const { direct, linked, env } = installedEntrypoints(t);
  for (const entry of [direct, linked]) {
    const launch = flag => entry === linked && process.platform !== "win32"
      ? entryProcess(entry, [flag], env) : entryProcess(process.execPath, [entry, flag], env);
    assert.equal(launch("--version"), "0.1.0-test.1\n", entry);
    const help = launch("--help");
    assert.match(help, /^@artoo\/controlled-fixture 0\.1\.0-test\.1 — Artoo agent daemon\n/);
    assert.match(help, /Usage: artood \[start\] \[--windows-supervised\]/);
  }
});

test("importing actual or linked CLI modules never launches the daemon or prints output", t => {
  const { direct, linked, env } = installedEntrypoints(t);
  for (const entry of [direct, linked]) {
    const source = `const cli = await import(${JSON.stringify(pathToFileURL(entry).href)}); if (typeof cli.runCli !== 'function') throw Error('missing CLI export');`;
    for (const argv of [[], ["nonexistent-importer-argument"]])
      assert.equal(entryProcess(process.execPath, ["--input-type=module", "-e", source, ...argv], env), "");
  }
});

test("ordinary CLI reaches its controlled runtime on all five supported tuples without enabling the Windows host", async () => {
  for (const tuple of supportedTuples) await withTuple(tuple, async () => {
    const fixture = controlledPackage(), originalArgv = process.argv;
    const env = { ARTOO_NODE_URL: "ws://controlled.invalid/?token=fixture", ARTOO_NODE_ID: "fixture-computer" };
    let output = "";
    const result = await runCli({ args: ["start"], env, packageDirectory: fixture.directory, output: value => { output += value; } });
    assert.equal(existsSync(fixture.marker), true, tuple);
    assert.equal(result.env.ARTOO_NODE_ID, "fixture-computer", tuple);
    assert.equal(result.env.ARTOO_WINDOWS_PROCESS_BUNDLE, undefined, tuple);
    assert.equal(result.env.ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256, undefined, tuple);
    assert.equal(result.env.ARTOO_SUPERVISED_BUNDLE_MANIFEST_SHA256, undefined, tuple);
    assert.deepEqual(result.argv, [process.execPath, join(fixture.runtime, "artood.mjs")], tuple);
    assert.equal(result.noBufferUtil, "1"); assert.equal(result.noUtf8Validate, "1");
    assert.equal(process.argv, originalArgv);
    assert.match(output, /Artoo daemon connected/); assert.doesNotMatch(output, /token=fixture/);
    assert.deepEqual(env, { ARTOO_NODE_URL: "ws://controlled.invalid/?token=fixture", ARTOO_NODE_ID: "fixture-computer" });
  });
});

test("ordinary CLI rejects unsupported tuples before release files, configuration or imports", async () => {
  for (const tuple of ["win32-arm64", "win32-ia32", "linux-ia32", "freebsd-x64", "darwin-ppc64"]) await withTuple(tuple, async () => {
    const fixture = controlledPackage({ omitManifest: true });
    await assert.rejects(runCli({ args: [], env: unreadableConfiguration(), packageDirectory: fixture.directory }), /Unsupported platform/);
    assert.equal(existsSync(fixture.marker), false, tuple);
  });
});

test("supervised CLI rejects every non-Windows-x64 tuple before configuration or runtime import", async () => {
  for (const tuple of [...supportedTuples.filter(tuple => tuple !== "win32-x64"), "win32-arm64", "win32-ia32", "freebsd-x64"])
    await withTuple(tuple, async () => {
      const fixture = controlledPackage({ omitManifest: true });
      for (const args of [["--windows-supervised"], ["start", "--windows-supervised"]])
        await assert.rejects(runCli({ args, env: unreadableConfiguration(), packageDirectory: fixture.directory }), /only on Windows x64/);
      assert.equal(existsSync(fixture.marker), false, tuple);
    });
});

test("Windows x64 supervised CLI keeps the pinned native configuration and explicit supervisor selector", async () => {
  await withTuple("win32-x64", async () => {
    const fixture = controlledPackage(), originalArgv = process.argv;
    const result = await runCli({ args: ["--windows-supervised"], env: {}, packageDirectory: fixture.directory, output: () => {} });
    assert.equal(result.env.ARTOO_WINDOWS_PROCESS_BUNDLE, join(fixture.runtime, fixture.native.directory));
    assert.equal(result.env.ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256, fixture.native.manifest_sha256);
    assert.equal(result.env.ARTOO_SUPERVISED_BUNDLE_MANIFEST_SHA256, fixture.metadata.artoo.runtimeManifestSha256);
    assert.deepEqual(result.argv, [process.execPath, join(fixture.runtime, "artood.mjs"), "--windows-supervised"]);
    assert.equal(process.argv, originalArgv);
  });
});

test("all supported ordinary platforms retain the pinned manifest check before importing runtime code", async () => {
  for (const tuple of supportedTuples) await withTuple(tuple, async () => {
    const fixture = controlledPackage();
    writeFileSync(join(fixture.runtime, "bundle-manifest.json"), "{}");
    await assert.rejects(runCli({ args: ["start"], env: unreadableConfiguration(), packageDirectory: fixture.directory }), /differs from the release pin/);
    assert.equal(existsSync(fixture.marker), false, tuple);
  });
});

test("release reader checks universal tuples while retaining verification of the earlier Windows-only manifest", () => {
  const fixture = controlledPackage();
  assert.deepEqual(readRelease(fixture.directory).metadata.artoo.platforms, supportedTuples);
  for (const platforms of [null, "linux-x64", [...supportedTuples, "win32-arm64"], ["win32-x64"], [...supportedTuples].reverse()]) {
    writeFileSync(join(fixture.directory, "package.json"), JSON.stringify({ ...fixture.metadata, artoo: { ...fixture.metadata.artoo, platforms } }));
    assert.throws(() => readRelease(fixture.directory), /unsupported package platform tuples/);
  }
  const artoo = { ...fixture.metadata.artoo }; delete artoo.platforms;
  writeFileSync(join(fixture.directory, "package.json"), JSON.stringify({ ...fixture.metadata, artoo }));
  assert.equal(readRelease(fixture.directory).metadata.artoo.platforms, undefined);
});

const release = { runtime: join(tmpdir(), "controlled-runtime"), metadata: { artoo: { runtimeManifestSha256: `sha256:${"a".repeat(64)}` } },
  manifest: { windows_process: { directory: "native/windows-process", manifest_sha256: `sha256:${"b".repeat(64)}` } } };

test("supervised defaults use release pins and preserve explicit local helper pairs", () => {
  const original = { ARTOO_NODE_URL: "ws://local", ARTOO_NODE_ID: "computer" };
  const ordinary = prepareEnvironment(original, release, "start");
  assert.equal(ordinary.ARTOO_WINDOWS_PROCESS_BUNDLE, undefined);
  const defaults = prepareEnvironment(original, release, "supervised");
  assert.equal(defaults.ARTOO_WINDOWS_PROCESS_BUNDLE, join(release.runtime, "native/windows-process"));
  assert.equal(defaults.ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256, release.manifest.windows_process.manifest_sha256);
  assert.equal(defaults.ARTOO_SUPERVISED_BUNDLE_MANIFEST_SHA256, release.metadata.artoo.runtimeManifestSha256);
  assert.deepEqual(original, { ARTOO_NODE_URL: "ws://local", ARTOO_NODE_ID: "computer" });
  const custom = prepareEnvironment({ ...original, ARTOO_WINDOWS_PROCESS_BUNDLE: "C:\\custom", ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256: "explicit-pin" }, release, "supervised");
  assert.equal(custom.ARTOO_WINDOWS_PROCESS_BUNDLE, "C:\\custom");
  assert.equal(custom.ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256, "explicit-pin");
  assert.throws(() => prepareEnvironment({ ARTOO_WINDOWS_PROCESS_BUNDLE: "C:\\custom" }, release, "supervised"), /supplied together/);
  assert.throws(() => prepareEnvironment({}, { ...release, manifest: {} }, "supervised"), /does not contain/);
});

test("startup error reporting redacts configured secrets and URL query values", () => {
  const env = { ARTOO_NODE_URL: "wss://host/node?token=credential", ARTOO_CODEX_PROVIDER_KEY: "model-key" };
  const result = safeError(Error(`failed ${env.ARTOO_NODE_URL}; provider ${env.ARTOO_CODEX_PROVIDER_KEY}; token=unconfigured`), env);
  assert.doesNotMatch(result, /credential|model-key|unconfigured/);
  assert.match(result, /redacted/);
});

test("startup diagnostics redact decoded forms of keys containing literal percent escapes", () => {
  for (const key of ["fixture%41private", 'fixture%41-"private"-\\key', "fixture%2541private"])
    for (const [message, expected] of [[`startup: ${key}`, "startup: [redacted]"],
      [`startup: ${JSON.stringify(key)}`, 'startup: "[redacted]"'], [`startup: ${encodeURIComponent(key)}`, "startup: [redacted]"]]) {
      assert.equal(safeError(Error(message), { ARTOO_CODEX_PROVIDER_KEY: key }), expected);
    }
});

test("release command requires a name/version/new absolute directory and native pin", () => {
  const args = ["--name", "@example/artood", "--version", "0.1.0-rc.1", "--output-directory", join(tmpdir(), "release"),
    "--windows-process-bundle", join(tmpdir(), "native"), "--windows-process-manifest-sha256", `sha256:${"a".repeat(64)}`];
  const parsed = parseBuildArguments(args);
  assert.equal(parsed.name, "@example/artood"); assert.equal(parsed.version, "0.1.0-rc.1");
  assert.throws(() => parseBuildArguments([...args, "--name", "duplicate"]), /duplicate/);
  assert.throws(() => parseBuildArguments(args.slice(0, -2)), /native host/);
  assert.throws(() => parseBuildArguments(["--name", "../escape", ...args.slice(2)]), /valid npm/);
  assert.throws(() => parseBuildArguments(["--name", "artood", "--version", "latest", ...args.slice(4)]), /valid npm/);
});

test("release reader rejects absent or mismatched runtime manifest pins", () => {
  const directory = mkdtempSync(join(tmpdir(), "artoo-npm-pin-test-"));
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "controlled-fixture" }));
  assert.throws(() => readRelease(directory), /missing release manifest pin/);
  mkdirSync(join(directory, "runtime"));
  writeFileSync(join(directory, "runtime/bundle-manifest.json"), "{}");
  writeFileSync(join(directory, "package.json"), JSON.stringify({ artoo: { format: "artoo.npm-daemon.v1", runtimeManifestSha256: `sha256:${"a".repeat(64)}` } }));
  assert.throws(() => readRelease(directory), /differs from the release pin/);
});

test("installed verification rejects altered runtime bytes before importing code", async () => {
  const directory = mkdtempSync(join(tmpdir(), "artoo-npm-integrity-test-")), runtime = join(directory, "runtime");
  mkdirSync(runtime);
  const original = "throw Error('must never import the controlled fixture');";
  const manifest = JSON.stringify({ format: "artoo.desktop-daemon.v1", node_target: "node24",
    tree: { directories: [], files: [{ path: "artood.mjs", size: Buffer.byteLength(original), sha256: sha(original) }] } });
  writeFileSync(join(runtime, "bundle-manifest.json"), manifest);
  writeFileSync(join(directory, "package.json"), JSON.stringify({ artoo: { format: "artoo.npm-daemon.v1", runtimeManifestSha256: sha(manifest) } }));
  writeFileSync(join(runtime, "artood.mjs"), original.replace("must", "MUST"));
  await assert.rejects(verifyPackage(directory), /runtime bytes changed/);
});
