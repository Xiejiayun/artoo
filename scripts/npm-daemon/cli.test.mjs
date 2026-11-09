import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseArguments, prepareEnvironment, runCli, safeError } from "./cli.mjs";
import { parseBuildArguments } from "./build.mjs";
import { readRelease, verifyPackage } from "./verify.mjs";

test("CLI only dispatches explicit supported entrypoints", () => {
  assert.equal(parseArguments([]), "start");
  assert.equal(parseArguments(["start"]), "start");
  assert.equal(parseArguments(["start", "--windows-supervised"]), "supervised");
  assert.equal(parseArguments(["--windows-supervised"]), "supervised");
  assert.equal(parseArguments(["--help"]), "help");
  assert.equal(parseArguments(["--version"]), "version");
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
  const sha = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const original = "throw Error('must never import the controlled fixture');";
  const manifest = JSON.stringify({ format: "artoo.desktop-daemon.v1", node_target: "node24",
    tree: { directories: [], files: [{ path: "artood.mjs", size: Buffer.byteLength(original), sha256: sha(original) }] } });
  writeFileSync(join(runtime, "bundle-manifest.json"), manifest);
  writeFileSync(join(directory, "package.json"), JSON.stringify({ artoo: { format: "artoo.npm-daemon.v1", runtimeManifestSha256: sha(manifest) } }));
  writeFileSync(join(runtime, "artood.mjs"), original.replace("must", "MUST"));
  await assert.rejects(verifyPackage(directory), /runtime bytes changed/);
});
