import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { test } from "node:test";
import { buildMacDistribution, distributionConfig, fileSha256, releaseSettings, runMacCommand } from "./mac-distribution.mjs";
import { mountPreviewDmg } from "./mac-dmg-install.mjs";

const signing = { ARTOO_MAC_SIGN_IDENTITY: "Developer ID Application: Example Team (ABCDE12345)", ARTOO_APPLE_TEAM_ID: "ABCDE12345", ARTOO_NOTARY_KEYCHAIN_PROFILE: "test-profile" };

test("stdout-only failures retain bounded diagnostics and redact known secrets in errors and build logs", () => {
  const directory = mkdtempSync(join(tmpdir(), "artoo-build-log-")), logFile = join(directory, "build.log");
  const secret = "fixture-private-diagnostic-value";
  try {
    let message;
    try {
      runMacCommand(process.execPath, ["-e", 'process.stdout.write("EARLY_OUTPUT" + "x".repeat(10000) + "\\ndownload failed: " + process.env.ARTOO_DIAGNOSTIC_TOKEN); process.exit(7)'], {
        logFile, env: { ...process.env, ARTOO_DIAGNOSTIC_TOKEN: secret, UNRELATED_CONFIG: "DO_NOT_DUMP_THE_ENVIRONMENT" },
      });
    } catch (error) { message = error.message; }
    assert.match(message, /failed \(7\)/); assert.match(message, /stdout.*4096/); assert.match(message, /download failed: \[redacted\]/);
    assert.ok(!message.includes("EARLY_OUTPUT")); assert.ok(message.length < 5000);
    const log = readFileSync(logFile, "utf8");
    assert.match(log, /exit=7/); assert.match(log, /download failed/);
    for (const value of [secret, "DO_NOT_DUMP_THE_ENVIRONMENT"]) { assert.ok(!message.includes(value)); assert.ok(!log.includes(value)); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("failed commands preserve both output streams using the shared report redaction", () => {
  assert.throws(() => runMacCommand(process.execPath, ["-e", 'process.stdout.write("download step failed\\n"); process.stderr.write("Bearer PRIVATE_HEADER at https://user:password@example.test/?access_token=PRIVATE_QUERY"); process.exit(1)']), (error) => {
    assert.match(error.message, /stdout.*4096/); assert.match(error.message, /download step failed/); assert.match(error.message, /stderr.*4096/);
    for (const secret of ["PRIVATE_HEADER", "PRIVATE_QUERY", "user:password"]) assert.ok(!error.message.includes(secret));
    return true;
  });
});

test("release refuses missing credentials, mismatched teams and implicit uploads before running any command", () => {
  for (const env of [{}, { ...signing, ARTOO_MAC_SIGN_IDENTITY: "-" }, { ...signing, ARTOO_APPLE_TEAM_ID: "OTHER12345" }, { ...signing, ARTOO_NOTARY_KEYCHAIN_PROFILE: "" }]) {
    let calls = 0;
    assert.throws(() => buildMacDistribution({ mode: "release", submitNotarization: true, env, execute: () => { calls++; } }));
    assert.equal(calls, 0);
  }
  assert.throws(() => releaseSettings("release", false, signing), /explicit --submit-notarization/);
  assert.throws(() => releaseSettings("preview", true, signing), /never submits/);
  assert.equal(releaseSettings("release", true, signing).identity, signing.ARTOO_MAC_SIGN_IDENTITY);
});

test("preview cannot inherit release signing, notarization or publishing behavior", () => {
  const base = { publish: [{ provider: "github" }], forceCodeSigning: true, mac: { identity: signing.ARTOO_MAC_SIGN_IDENTITY, notarize: { teamId: "ABCDE12345" } }, dmg: { sign: true } };
  const config = distributionConfig(base, releaseSettings("preview", false, signing), "/isolated/output", "arm64", "1.2.3");
  assert.equal(config.publish, null); assert.equal(config.forceCodeSigning, false);
  assert.equal(config.mac.identity, null); assert.equal(config.mac.notarize, false); assert.equal(config.dmg.sign, false);
  assert.equal(config.artifactName, "Artoo-1.2.3-arm64-preview.${ext}");
  const release = distributionConfig(base, releaseSettings("release", true, signing), "/isolated/output", "x64", "1.2.3");
  assert.equal(release.forceCodeSigning, true); assert.equal(release.mac.hardenedRuntime, true); assert.equal(release.mac.notarize, false); assert.equal(release.publish, null);
  assert.equal(release.mac.identity, "Example Team (ABCDE12345)");
});

test("both generated configurations satisfy the installed electron-builder schema", async () => {
  const { validateConfiguration } = await import("app-builder-lib/out/util/config/config.js");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  for (const mode of ["preview", "release"]) {
    await validateConfiguration(distributionConfig(pkg.build, releaseSettings(mode, mode === "release", signing), "/isolated/output", "x64", pkg.version), { isEnabled: false });
  }
});

function fixture(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "artoo-dmg-unit-")), path = join(directory, "current.dmg");
  writeFileSync(path, "current build fixture");
  const artifact = { kind: "dmg", path, sha256: fileSha256(path) }, commands = [];
  let mountpoint, mounted = false, detachFailures = options.detachFailures ?? 0;
  const execute = (command, args, extra = {}) => {
    commands.push([command, ...args]);
    if (command === "plutil") return { stdout: extra.input };
    if (args[0] === "attach") {
      assert.ok(args.includes("-readonly")); assert.ok(args.includes("-nobrowse"));
      assert.equal(args[1], path);
      mountpoint = args[args.indexOf("-mountpoint") + 1]; mounted = true;
      if (!options.missingApp) { mkdirSync(join(mountpoint, "Artoo.app/Contents/MacOS"), { recursive: true }); writeFileSync(join(mountpoint, "Artoo.app/Contents/MacOS/Artoo"), "fixture"); }
      return { stdout: "" };
    }
    if (args[0] === "info") return { stdout: JSON.stringify({ images: mounted ? [{ "image-path": path, writeable: options.writeable ?? false, "system-entities": [{ "mount-point": mountpoint }] }] : [] }) };
    assert.equal(args[0], "detach"); assert.equal(args[1], mountpoint);
    if (detachFailures-- > 0) throw new Error("fixture mount is busy");
    mounted = false; return { stdout: "" };
  };
  return { artifact, execute, commands, directory };
}

test("installs only the hashed current DMG, verifies read-only mount and detaches idempotently", () => {
  const f = fixture(); let mount;
  try {
    mount = mountPreviewDmg(f.artifact, { execute: f.execute });
    assert.ok(existsSync(mount.app)); const mountDirectory = dirname(mount.mountpoint);
    mount.detach(); mount.detach(); assert.equal(mount.detached, true); assert.equal(existsSync(mountDirectory), false);
    assert.equal(f.commands.filter((args) => args[1] === "detach").length, 1);
    writeFileSync(f.artifact.path, "different build");
    assert.throws(() => mountPreviewDmg(f.artifact, { execute: f.execute }), /bytes changed/);
    assert.equal(f.commands.filter((args) => args[1] === "attach").length, 1);
  } finally { mount?.detach(); rmSync(f.directory, { recursive: true, force: true }); }
});

test("validation failures detach; callers retain a handle when detach needs a second attempt", () => {
  for (const options of [{ missingApp: true }, { writeable: true }, { missingApp: true, detachFailures: 1 }]) {
    const f = fixture(options); let handle;
    try {
      assert.throws(() => mountPreviewDmg(f.artifact, { execute: f.execute, onCreated: (value) => { handle = value; } }));
      assert.ok(handle);
      if (options.detachFailures) assert.equal(handle.detached, false);
      handle.detach(); assert.equal(handle.detached, true); assert.equal(existsSync(dirname(handle.mountpoint)), false);
    } finally { handle?.detach(); rmSync(f.directory, { recursive: true, force: true }); }
  }
});

test("the DMG smoke rejects package reuse before building or launching and writes a failed HTML report", { skip: process.platform !== "darwin" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "artoo-dmg-preflight-"));
  try {
    const result = spawnSync(process.execPath, [new URL("macos-dmg-e2e-smoke.mjs", import.meta.url).pathname], {
      env: { ...process.env, ARTOO_DESKTOP_REPORT_DIR: directory, ARTOO_SMOKE_SKIP_BUILD: "1" }, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(result.status, 1);
    const report = JSON.parse(readFileSync(join(directory, "macos-dmg-desktop-smoke.json"), "utf8"));
    assert.equal(report.passed, false); assert.match(report.error, /fresh distribution/);
    assert.equal(report.cleanup_complete, true); assert.equal(report.cleanup.dmg_detached, true);
    assert.deepEqual(report.checks, []); assert.equal(report.package_reused, false);
    assert.match(readFileSync(join(directory, "macos-dmg-desktop-smoke.html"), "utf8"), />Failed</);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("a small real macOS fixture DMG is mounted read-only and detached without launching an app", { skip: process.platform !== "darwin" || process.env.ARTOO_TEST_REAL_DMG !== "1" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "artoo-dmg-system-")); let mount;
  try {
    const source = join(directory, "source"), app = join(source, "Artoo.app/Contents/MacOS"), dmg = join(directory, "fixture.dmg");
    mkdirSync(app, { recursive: true }); writeFileSync(join(app, "Artoo"), "This is a filesystem fixture, not a product executable.");
    runMacCommand("hdiutil", ["create", "-srcfolder", source, "-volname", "Artoo mount fixture", "-format", "UDZO", dmg]);
    mount = mountPreviewDmg({ kind: "dmg", path: dmg, sha256: fileSha256(dmg) });
    assert.ok(existsSync(mount.app)); mount.detach(); assert.equal(mount.detached, true);
  } finally { mount?.detach(); rmSync(directory, { recursive: true, force: true }); }
});
