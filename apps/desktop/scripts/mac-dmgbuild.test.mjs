import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertDmgbuildCompatibility, configureDmgbuild, installedDownloader, resolveDmgbuild } from "./mac-dmgbuild.mjs";
import { buildMacDistribution } from "./mac-distribution.mjs";

const require = createRequire(import.meta.url);
const launcher = new URL("mac-dmgbuild.mjs", import.meta.url);
const posix = { skip: process.platform === "win32" };
const checksums = {
  "dmgbuild-bundle-arm64-75c8a6c.tar.gz": "793404d0c96687e27d5ee40a668d498c92e36a64d6c2906df511031adb33cbeb",
  "dmgbuild-bundle-x86_64-75c8a6c.tar.gz": "1664972f9cc2d6e8fce3b63e42cd30078aff602669c5856939c4519921200433",
};

function currentVendorRequire() {
  const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
  const appBuilderRequire = createRequire(builderRequire.resolve("app-builder-lib/package.json"));
  return createRequire(appBuilderRequire.resolve("dmg-builder/package.json"));
}

function fixture() {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-dmgbuild-fixture-")));
  const executable = join(directory, "dmgbuild");
  const capture = join(directory, "argv.json");
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.ARTOO_TEST_CAPTURE, JSON.stringify({ args: process.argv.slice(2), pid: process.pid, wrapperPid: Number(process.env.ARTOO_TEST_WRAPPER_PID), cwd: process.cwd(), marker: process.env.ARTOO_TEST_MARKER }));
if (process.env.ARTOO_TEST_SIGNAL) process.kill(process.pid, process.env.ARTOO_TEST_SIGNAL);
else {
  fs.writeSync(1, Buffer.from([0, 255, 65, 10]));
  fs.writeSync(2, Buffer.from([66, 0, 254, 10]));
  process.exit(Number(process.env.ARTOO_TEST_EXIT));
}
`, { mode: 0o755 });
  return { directory, executable, capture, remove: () => rmSync(directory, { recursive: true, force: true }) };
}

function invoke(f, args, extraEnv = {}) {
  const code = `import { runDmgbuild } from ${JSON.stringify(launcher.href)};
process.env.ARTOO_TEST_WRAPPER_PID = String(process.pid);
await runDmgbuild(process.argv.slice(1), { download: async () => process.env.ARTOO_TEST_VENDOR_DIR });`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", code, "--", ...args], {
    cwd: f.directory, timeout: 10_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
      ARTOO_TEST_VENDOR_DIR: f.directory, ARTOO_TEST_CAPTURE: f.capture,
      ARTOO_TEST_MARKER: "literal environment value 中文", ARTOO_TEST_EXIT: "0", ...extraEnv },
  });
}

test("default and blank overrides select the repository executable with a declared ten-attempt policy", () => {
  for (const value of [undefined, "", "   "]) {
    const env = { PATH: "original-path", KEPT: "literal", ...(value === undefined ? {} : { CUSTOM_DMGBUILD_PATH: value }) };
    const original = { ...env };
    const selected = configureDmgbuild(env, tmpdir());
    assert.deepEqual(env, original);
    assert.equal(selected.env.CUSTOM_DMGBUILD_PATH, fileURLToPath(launcher));
    assert.equal(selected.env.KEPT, "literal");
    assert.equal(selected.env.PATH, `${dirname(process.execPath)}${delimiter}original-path`);
    assert.equal(selected.policy.source, "repository_default");
    assert.equal(selected.policy.clean_detach_attempts, 10);
    assert.equal(selected.policy.toolset, "dmg-builder@1.2.5");
  }
});

test("an explicit executable override resolves relative to builder cwd and retains its own policy", posix, () => {
  const f = fixture();
  try {
    const selected = configureDmgbuild({ CUSTOM_DMGBUILD_PATH: " ./dmgbuild ", PATH: "unchanged" }, f.directory);
    assert.equal(selected.env.CUSTOM_DMGBUILD_PATH, f.executable);
    assert.equal(selected.env.PATH, "unchanged");
    assert.equal(selected.policy.source, "caller_override");
    assert.equal(selected.policy.clean_detach_attempts, null);
    assert.equal(selected.policy.toolset, null);
  } finally { f.remove(); }
});

test("invalid overrides fail without replacing them with the default launcher", posix, () => {
  const f = fixture();
  try {
    for (const path of [join(f.directory, "missing"), f.directory]) {
      assert.throws(() => configureDmgbuild({ CUSTOM_DMGBUILD_PATH: path }, f.directory));
    }
    chmodSync(f.executable, 0o644);
    assert.throws(() => configureDmgbuild({ CUSTOM_DMGBUILD_PATH: f.executable }, f.directory), /execut/);
  } finally { f.remove(); }
});

test("both host architectures resolve the current vendor's checksum-pinned archive without guessed cache paths", async () => {
  const f = fixture();
  try {
    for (const [arch, vendorArch] of [["arm64", "arm64"], ["x64", "x86_64"]]) {
      const calls = [];
      const executable = await resolveDmgbuild({ arch, download: async (options) => { calls.push(options); return f.directory; } });
      assert.equal(executable, f.executable);
      assert.deepEqual(calls, [{ releaseName: "dmg-builder@1.2.5", filenameWithExt: `dmgbuild-bundle-${vendorArch}-75c8a6c.tar.gz`, checksums }]);
    }
    let downloads = 0;
    await assert.rejects(resolveDmgbuild({ arch: "ia32", download: async () => { downloads++; return f.directory; } }), /architecture/);
    assert.equal(downloads, 0);
  } finally { f.remove(); }
});

test("installed vendor version and toolset constants match; a dependency or checksum change requires review", () => {
  const vendorRequire = currentVendorRequire();
  const { version } = vendorRequire("./package.json");
  const source = readFileSync(vendorRequire.resolve("./out/dmgUtil.js"), "utf8");
  assert.doesNotThrow(() => assertDmgbuildCompatibility(version, source));
  assert.throws(() => assertDmgbuildCompatibility("26.16.0", source), /review/i);
  assert.throws(() => assertDmgbuildCompatibility(version, source.replace("dmg-builder@1.2.5", "dmg-builder@9.9.9")), /review/i);
  assert.throws(() => assertDmgbuildCompatibility(version, source.replace(checksums["dmgbuild-bundle-arm64-75c8a6c.tar.gz"], "0".repeat(64))), /review/i);
  assert.throws(() => assertDmgbuildCompatibility(version, source.replace("dmgbuild-bundle-${arch}-75c8a6c.tar.gz", "dmgbuild-bundle-${arch}-changed.tar.gz")), /review/i);
});

test("real Node resolution follows nested build dependencies and uses that vendor's downloader", async () => {
  const f = fixture();
  try {
    const packageAt = (directory, version = "26.15.3") => {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "package.json"), JSON.stringify({ version }));
      return directory;
    };
    // These are disposable module-resolution fixtures, not installed packages.
    packageAt(join(f.directory, "node_modules/dmg-builder"), "unrelated-hoisted-version");
    const builder = packageAt(join(f.directory, "node_modules/electron-builder"));
    const appBuilder = packageAt(join(builder, "node_modules/app-builder-lib"));
    const vendor = packageAt(join(appBuilder, "node_modules/dmg-builder"));
    mkdirSync(join(vendor, "out"));
    writeFileSync(join(vendor, "out/dmgUtil.js"), readFileSync(currentVendorRequire().resolve("./out/dmgUtil.js")));
    const downloader = packageAt(join(vendor, "node_modules/app-builder-lib"));
    mkdirSync(join(downloader, "out/util"), { recursive: true });
    writeFileSync(join(downloader, "out/util/electronGet.js"), `exports.downloadBuilderToolset = async (options) => {
      require("node:fs").writeFileSync(${JSON.stringify(f.capture)}, JSON.stringify({ source: __filename, options }));
      return ${JSON.stringify(f.directory)};
    };`);
    const download = installedDownloader(createRequire(join(f.directory, "entry.cjs")));
    assert.equal(await resolveDmgbuild({ arch: "arm64", download }), f.executable);
    const captured = JSON.parse(readFileSync(f.capture, "utf8"));
    assert.equal(captured.source, join(downloader, "out/util/electronGet.js"));
    assert.deepEqual(captured.options, { releaseName: "dmg-builder@1.2.5", filenameWithExt: "dmgbuild-bundle-arm64-75c8a6c.tar.gz", checksums });
  } finally { f.remove(); }
});

for (const status of [0, 7]) test(`launcher preserves exact argv, cwd, environment, output bytes and exit ${status}`, posix, () => {
  const f = fixture();
  try {
    const args = ["-s", "/a folder/配置 '$`().json", "Artoo $HOME; literal", "/out/包 image.dmg"];
    const result = invoke(f, args, { ARTOO_TEST_EXIT: String(status) });
    assert.equal(result.error, undefined);
    assert.equal(result.status, status);
    assert.deepEqual(result.stdout, Buffer.from([0, 255, 65, 10]));
    assert.deepEqual(result.stderr, Buffer.from([66, 0, 254, 10]));
    const captured = JSON.parse(readFileSync(f.capture, "utf8"));
    assert.deepEqual(captured.args, ["--detach-retries", "10", ...args]);
    assert.equal(captured.cwd, f.directory);
    assert.equal(captured.marker, "literal environment value 中文");
    assert.equal(captured.pid, captured.wrapperPid);
  } finally { f.remove(); }
});

test("vendor signal termination remains signal termination with no intermediary child", posix, () => {
  const f = fixture();
  try {
    const result = invoke(f, ["-s", "settings.json", "Artoo", "out.dmg"], { ARTOO_TEST_SIGNAL: "SIGTERM" });
    assert.equal(result.error, undefined);
    assert.equal(result.status, null);
    assert.equal(result.signal, "SIGTERM");
    assert.equal(result.stdout.length, 0); assert.equal(result.stderr.length, 0);
  } finally { f.remove(); }
});

test("duplicate or abbreviated retry flags cannot override the recorded ten attempts", posix, () => {
  const f = fixture();
  try {
    for (const args of [["--detach-retries", "30"], ["--detach-retries=30"], ["--detach-r=30"], ["--detach", "30"]]) {
      const result = invoke(f, args);
      assert.equal(result.status, 1);
      assert.match(result.stderr.toString(), /retry policy/i);
      assert.equal(existsSync(f.capture), false);
    }
    const result = invoke(f, ["--", "--detach-retries", "output.dmg"]);
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(readFileSync(f.capture, "utf8")).args, ["--detach-retries", "10", "--", "--detach-retries", "output.dmg"]);
  } finally { f.remove(); }
});

test("a missing resolved vendor fails before any substitute executable is launched", posix, () => {
  const f = fixture();
  try {
    rmSync(f.executable);
    const result = invoke(f, ["-s", "settings.json", "Artoo", "out.dmg"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr.toString(), /dmgbuild/);
    assert.equal(existsSync(f.capture), false);
  } finally { f.remove(); }
});

test("builder receives the selected default or explicit override, and failed builds remain failed manifests", { skip: process.platform !== "darwin" }, () => {
  const f = fixture();
  try {
    for (const override of [undefined, f.executable]) {
      let output, builderEnv;
      const env = { PATH: process.env.PATH, npm_execpath: process.execPath, ...(override ? { CUSTOM_DMGBUILD_PATH: override } : {}) };
      try {
        assert.throws(() => buildMacDistribution({ architecture: "x64", env, execute(command, args, options) {
          if (command === "lipo") return { stdout: "x86_64 arm64\n" };
          if (args.includes("--config")) {
            output = dirname(args[args.indexOf("--config") + 1]); builderEnv = options.env;
            throw new Error("fixture vendor failed with exit 7");
          }
          return { stdout: "", stderr: "" };
        } }), /fixture vendor failed with exit 7/);
        assert.equal(builderEnv.CUSTOM_DMGBUILD_PATH, override ?? fileURLToPath(launcher));
        const report = JSON.parse(readFileSync(join(output, "distribution.json"), "utf8"));
        assert.equal(report.passed, false); assert.deepEqual(report.files, []);
        assert.equal(report.dmgbuild.source, override ? "caller_override" : "repository_default");
        assert.equal(report.dmgbuild.clean_detach_attempts, override ? null : 10);
        assert.match(report.dmgbuild.sha256, /^[a-f0-9]{64}$/);
        const config = JSON.parse(readFileSync(join(output, "builder-config.json"), "utf8"));
        assert.equal(config.publish, null); assert.equal(config.forceCodeSigning, false);
        assert.equal(config.mac.identity, null); assert.equal(config.mac.notarize, false);
        assert.equal(config.dmg.detachRetries, undefined);
      } finally { if (output) rmSync(output, { recursive: true, force: true }); }
    }
  } finally { f.remove(); }
});
