import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { after, before, mock, test } from "node:test";
import { buildDaemon, publishStagingDirectory, verifyBundledModules } from "./bundle-daemon.mjs";

const repoRoot = fs.realpathSync.native(process.env.ARTOO_BUNDLE_TEST_REPO_ROOT ?? process.cwd());
const temporaryParent = fs.realpathSync.native(process.env.ARTOO_BUNDLE_TEST_PARENT_DIRECTORY ?? tmpdir());
const root = fs.realpathSync.native(fs.mkdtempSync(join(temporaryParent, "artoo-daemon-package-test-")));
const outputDirectory = join(root, "actual-daemon"), require = createRequire(join(repoRoot, "apps/artood/package.json"));
const version = require("playwright/package.json").version;
let result, retainRoot = false;
function safeEnvironment() { const env = { ...process.env }; for (const key of Object.keys(env)) if (key.startsWith("ARTOO_")) delete env[key]; return env; }
function node(args, input) {
  const child = spawnSync(process.execPath, args, { cwd: root, env: safeEnvironment(), input, encoding: "utf8", timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  assert.ifError(child.error); assert.equal(child.signal, null); return child;
}
const digest = path => `sha256:${createHash("sha256").update(fs.readFileSync(path)).digest("hex")}`;

before(async () => { result = await buildDaemon({ repoRoot, outputDirectory }); });
after(() => {
  // Only this test's newly created directory is removed, never the source tree,
  // an operator-provided helper bundle or an existing daemon build directory.
  assert.equal(dirname(root), temporaryParent); assert.ok(basename(root).startsWith("artoo-daemon-package-test-"));
  assert.equal(fs.realpathSync.native(root), root);
  if (retainRoot || process.env.ARTOO_BUNDLE_TEST_KEEP === "1") { console.log(`Retained packaging fixture: ${root}`); return; }
  fs.rmSync(root, { recursive: true, force: true });
});

test("real package copies resolve locally and retain the complete runtime asset trees", () => {
  assert.equal(result.outputDirectory, outputDirectory); assert.equal(result.playwrightVersion, version);
  assert.equal(result.manifestSha256, digest(join(outputDirectory, "bundle-manifest.json")));
  verifyBundledModules(outputDirectory, version);
  const manifest = JSON.parse(fs.readFileSync(join(outputDirectory, "bundle-manifest.json"), "utf8"));
  for (const file of manifest.tree.files) {
    assert.equal(digest(join(outputDirectory, file.path)), file.sha256, file.path);
    assert.equal(fs.statSync(join(outputDirectory, file.path)).size, file.size, file.path);
  }
  for (const name of ["playwright", "playwright-core"]) {
    const source = dirname(require.resolve(`${name}/package.json`));
    const files = fs.readdirSync(source, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile());
    for (const entry of files) {
      const path = relative(source, join(entry.parentPath, entry.name));
      assert.equal(digest(join(outputDirectory, "node_modules", name, path)), digest(join(source, path)));
    }
  }
});

test("both packaged MCP entrypoints actually handle initialize over stdio", () => {
  const config = join(root, "mcp-session.json");
  fs.writeFileSync(config, JSON.stringify({ version: 1, url: "http://127.0.0.1:1/", token: "a".repeat(64) }));
  for (const [entry, name] of [["workspace-tools-mcp.js", "artoo-workspace"], ["research-mcp.js", "artoo-research"]]) {
    const child = node([join(outputDirectory, entry), config], JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n");
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout.trim()).result.serverInfo.name, name);
  }
});

test("packaged verification resolves its real sibling CLI and the CLI executes its context gate", () => {
  const workspace = join(root, "product-workspace"), evidence = join(root, "browser-evidence"); fs.mkdirSync(workspace); fs.mkdirSync(evidence);
  const config = join(root, "browser.json"), profiles = join(root, "profiles.json"), cli = join(outputDirectory, "web-acceptance-cli.js");
  fs.writeFileSync(config, JSON.stringify({ evidence_root: evidence, viewports: [768, 320], design_capture_cases: true }));
  fs.writeFileSync(profiles, JSON.stringify([{ id: "browser", project_id: "project", workspace_root: workspace,
    commands: [{ id: "browser", argv: [process.execPath, cli, config], timeout_ms: 1000,
      observation: { format: "static-web-acceptance.v1", evidence_root: evidence, capabilities: { version: 1 } } }],
    required_files: [], subject_paths: ["product", ".artoo/product"] }]));
  const probe = String.raw`
    const assert = require('node:assert/strict'), {pathToFileURL} = require('node:url');
    const [entry, workspace, profiles, cli] = process.argv.slice(1);
    // Import the public configuration builder without matching the daemon's
    // direct-entry argv guard. No node connection or provider may start here.
    process.argv[1] = 'packaged-verifier-probe';
    import(pathToFileURL(entry).href).then(module => {
      const config = module.loadConfigFromEnv({ ARTOO_NODE_URL:'ws://127.0.0.1:1/api/v1/node', ARTOO_NODE_ID:'packaged-probe',
        ARTOO_ALLOWED_ROOTS:workspace, ARTOO_VERIFICATION_PROFILES_FILE:profiles });
      assert.equal(config.verificationProfiles[0].commands[0].argv[1], cli);
      process.stdout.write('verified-sibling-cli\n');
    }).catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const loaded = node(["--input-type=commonjs", "-e", probe, join(outputDirectory, "artood.mjs"), workspace, profiles, cli]);
  assert.equal(loaded.status, 0, loaded.stderr); assert.equal(loaded.stdout.trim(), "verified-sibling-cli");
  const executed = node([cli]);
  assert.equal(executed.status, 1); assert.match(executed.stderr, /Missing node verification context/);
  assert.doesNotMatch(executed.stderr, /require is not defined|Cannot find module|ERR_MODULE_NOT_FOUND/);
});

test("journal-worker.js remains an executable CommonJS worker and rejects an invalid boot without provisioning", () => {
  const probe = String.raw`
    const assert = require('node:assert/strict'), {Worker} = require('node:worker_threads');
    const worker = new Worker(process.argv[1], {workerData:{action:'open', expectedNamespace:''}}); const messages = [];
    worker.on('message', value => messages.push(value));
    worker.on('error', error => { console.error(error); process.exitCode = 1; });
    worker.on('exit', code => {
      assert.equal(code, 1); assert.ok(messages.some(value => value.kind === 'failed'));
      process.stdout.write('commonjs-worker-loaded\n');
    });
  `;
  const child = node(["--input-type=commonjs", "-e", probe, join(outputDirectory, "journal-worker.js")]);
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout.trim(), "commonjs-worker-loaded");
});

test("an existing custom directory and its unknown file are never replaced", async () => {
  const existing = join(root, "existing-user-output"); fs.mkdirSync(existing); fs.writeFileSync(join(existing, "keep.txt"), "user-owned");
  await assert.rejects(buildDaemon({ repoRoot, outputDirectory: existing }), /custom output directory must not already exist/);
  assert.equal(fs.readFileSync(join(existing, "keep.txt"), "utf8"), "user-owned");
});

function controlledRepository(name = "controlled-repo") {
  // This small source fixture only tests transactional build replacement. The
  // real repository/entrypoint/runtime tests above are separate assertions.
  const directory = join(root, name); fs.mkdirSync(directory);
  const source = join(directory, "apps/artood/src"), desktop = join(directory, "apps/desktop"), modules = join(directory, "node_modules");
  fs.mkdirSync(join(source, "managed"), { recursive: true }); fs.mkdirSync(desktop, { recursive: true }); fs.mkdirSync(modules);
  fs.writeFileSync(join(directory, "apps/artood/package.json"), JSON.stringify({ dependencies: { playwright: version } }));
  fs.writeFileSync(join(desktop, "package.json"), JSON.stringify({ private: true }));
  fs.writeFileSync(join(directory, "package-lock.json"), JSON.stringify({ packages: {
    "node_modules/playwright": { version }, "node_modules/playwright-core": { version },
  } }));
  for (const name of ["playwright", "playwright-core"]) fs.cpSync(dirname(require.resolve(`${name}/package.json`)), join(modules, name), { recursive: true });
  fs.symlinkSync(dirname(require.resolve("esbuild/package.json")), join(modules, "esbuild"), process.platform === "win32" ? "junction" : "dir");
  fs.writeFileSync(join(source, "main.ts"), "export function loadConfigFromEnv() { return {}; }\n");
  for (const name of ["managed/journal-worker.ts", "workspace-tools-mcp.ts", "research-mcp.ts", "web-acceptance-cli.ts"]) fs.writeFileSync(join(source, name), "export const fixture = true;\n");
  const output = join(desktop, "daemon"); fs.mkdirSync(output); fs.writeFileSync(join(output, "artood.mjs"), "legacy-build-to-preserve\n");
  return { directory, output, source };
}

test("controlled commit failure restores the old default; success preserves a recoverable backup; unknown later files block replacement", async () => {
  const fixture = controlledRepository(), originalRename = fs.renameSync; let injected = false;
  const failure = mock.method(fs, "renameSync", (from, to) => {
    if (!injected && basename(String(from)).startsWith(".daemon.build-") && String(to) === fixture.output) {
      injected = true; throw Object.assign(new Error("controlled commit rename failure"), { code: "EACCES" });
    }
    return originalRename(from, to);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(buildDaemon({ repoRoot: fixture.directory }), /controlled commit rename failure/); }
  finally { failure.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(injected, true); assert.equal(fs.readFileSync(join(fixture.output, "artood.mjs"), "utf8"), "legacy-build-to-preserve\n");
  const rebuilt = await buildDaemon({ repoRoot: fixture.directory });
  assert.ok(rebuilt.backupDirectory); assert.equal(fs.readFileSync(join(rebuilt.backupDirectory, "artood.mjs"), "utf8"), "legacy-build-to-preserve\n");
  fs.writeFileSync(join(fixture.output, "unknown-user-file.txt"), "preserve this too");
  await assert.rejects(buildDaemon({ repoRoot: fixture.directory }), /existing daemon output is changed/);
  assert.equal(fs.readFileSync(join(fixture.output, "unknown-user-file.txt"), "utf8"), "preserve this too");
  const packagePath = join(fixture.directory, "apps/artood/package.json"), saved = fs.readFileSync(packagePath);
  fs.writeFileSync(packagePath, JSON.stringify({ dependencies: { playwright: "0.0.0" } }));
  try { await assert.rejects(buildDaemon({ repoRoot: fixture.directory, outputDirectory: join(root, "wrong-version") }), /version mismatch/); }
  finally { fs.writeFileSync(packagePath, saved); }
});


test("controlled Windows fresh commit retries transient EPERM on the same verified stage", { skip: process.platform !== "win32" }, async () => {
  const fixture = controlledRepository("controlled-transient-eperm"), output = join(root, "transient-eperm-output");
  const originalRename = fs.renameSync, stages = []; let attempts = 0;
  const failure = mock.method(fs, "renameSync", (from, to) => {
    if (String(to) === output) {
      stages.push(String(from)); attempts += 1;
      if (attempts <= 2) throw Object.assign(new Error("controlled transient EPERM"), { code: "EPERM" });
    }
    return originalRename(from, to);
  });
  syncBuiltinESMExports();
  let built;
  try { built = await buildDaemon({ repoRoot: fixture.directory, outputDirectory: output }); }
  finally { failure.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(attempts, 3); assert.equal(new Set(stages).size, 1); assert.equal(fs.existsSync(stages[0]), false);
  assert.equal(built.outputDirectory, output); assert.equal(built.backupDirectory, undefined);
  assert.equal(built.manifestSha256, digest(join(output, "bundle-manifest.json")));
  assert.equal(fs.readFileSync(join(fixture.output, "artood.mjs"), "utf8"), "legacy-build-to-preserve\n");
});

test("controlled Windows persistent EPERM retains fresh staging and restores a previous default", { skip: process.platform !== "win32" }, async () => {
  for (const previous of [false, true]) {
    const fixture = controlledRepository("controlled-persistent-eperm-" + previous);
    const output = previous ? fixture.output : join(root, "persistent-eperm-output");
    const originalRename = fs.renameSync, first = Object.assign(new Error("controlled persistent EPERM"), { code: "EPERM" });
    let stage, attempts = 0, rejected;
    const failure = mock.method(fs, "renameSync", (from, to) => {
      if (String(to) === output && basename(String(from)).includes(".build-")) {
        assert.ok(stage === undefined || stage === String(from)); stage = String(from); attempts += 1; throw first;
      }
      return originalRename(from, to);
    });
    syncBuiltinESMExports();
    try { await assert.rejects(buildDaemon({ repoRoot: fixture.directory, outputDirectory: output }), error => { rejected = error; return true; }); }
    finally { failure.mock.restore(); syncBuiltinESMExports(); }
    assert.ok(attempts >= 1 && attempts <= 5, `Commit attempts: ${attempts}; actual rejection: ${rejected?.stack}`);
    assert.match(rejected.message, /Windows bundle publish rename failed/);
    assert.equal(rejected.cause.cause, first); assert.ok(fs.existsSync(join(stage, "bundle-manifest.json")));
    if (previous) assert.equal(fs.readFileSync(join(output, "artood.mjs"), "utf8"), "legacy-build-to-preserve\n");
    else assert.equal(fs.existsSync(output), false);
  }
});


test("controlled Windows retry keeps the original monotonic deadline across commit rejections", { skip: process.platform !== "win32" }, async () => {
  const fixture = controlledRepository("controlled-eperm-deadline"), output = join(root, "deadline-output"), originalRename = fs.renameSync;
  const first = Object.assign(new Error("controlled fixed-deadline EPERM"), { code: "EPERM" });
  let stage, attempts = 0, clock, now = 1000, rejected;
  const failure = mock.method(fs, "renameSync", (from, to) => {
    if (String(to) === output) {
      stage = String(from); attempts += 1;
      if (attempts === 1) clock = mock.method(performance, "now", () => now);
      else now = 3001; // Beyond the first 1000 + 2000 deadline; never renew it.
      throw first;
    }
    return originalRename(from, to);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(buildDaemon({ repoRoot: fixture.directory, outputDirectory: output }), error => { rejected = error; return true; }); }
  finally { clock?.mock.restore(); failure.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(attempts, 2); assert.match(rejected.message, /Windows publish retry deadline expired/);
  assert.equal(rejected.cause.cause, first); assert.equal(fs.existsSync(output), false);
  assert.ok(fs.existsSync(join(stage, "bundle-manifest.json")));
});

test("controlled Windows retry refuses an output created during the wait and preserves both trees", { skip: process.platform !== "win32" }, async () => {
  const fixture = controlledRepository("controlled-eperm-target-race"), output = join(root, "raced-output"), originalRename = fs.renameSync;
  let stage, attempts = 0;
  const failure = mock.method(fs, "renameSync", (from, to) => {
    if (String(to) === output) {
      stage = String(from); attempts += 1;
      if (attempts === 1) {
        queueMicrotask(() => { fs.mkdirSync(output); fs.writeFileSync(join(output, "keep.txt"), "other actor"); });
        throw Object.assign(new Error("controlled target-race EPERM"), { code: "EPERM" });
      }
    }
    return originalRename(from, to);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(buildDaemon({ repoRoot: fixture.directory, outputDirectory: output }), /output appeared before publish retry/); }
  finally { failure.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(attempts, 1); assert.equal(fs.readFileSync(join(output, "keep.txt"), "utf8"), "other actor");
  assert.ok(fs.existsSync(join(stage, "bundle-manifest.json")));
});

test("controlled Windows retry rejects changed staging contents or directory identity", { skip: process.platform !== "win32" }, async () => {
  for (const change of ["contents", "identity"]) {
    const fixture = controlledRepository("controlled-stage-" + change), output = join(root, "stage-change-" + change);
    const originalRename = fs.renameSync; let stage, retained, attempts = 0;
    const failure = mock.method(fs, "renameSync", (from, to) => {
      if (String(to) === output) {
        stage = String(from); attempts += 1;
        if (attempts === 1) {
          queueMicrotask(() => {
            if (change === "contents") fs.appendFileSync(join(stage, "artood.mjs"), "// changed while waiting\n");
            else { retained = stage + ".retained"; originalRename(stage, retained); fs.mkdirSync(stage); }
          });
          throw Object.assign(new Error("controlled changed-stage EPERM"), { code: "EPERM" });
        }
      }
      return originalRename(from, to);
    });
    syncBuiltinESMExports();
    try { await assert.rejects(buildDaemon({ repoRoot: fixture.directory, outputDirectory: output }),
      change === "contents" ? /staging contents changed/ : /staging directory identity changed/); }
    finally { failure.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(attempts, 1); assert.equal(fs.existsSync(output), false); assert.ok(fs.existsSync(stage));
    assert.ok(fs.existsSync(join(retained ?? stage, "bundle-manifest.json")));
  }
});

test("controlled EBUSY commit remains an immediate failure without retry", async () => {
  const fixture = controlledRepository("controlled-ebusy"), output = join(root, "ebusy-output"), originalRename = fs.renameSync;
  let attempts = 0, stage;
  const failure = mock.method(fs, "renameSync", (from, to) => {
    if (String(to) === output) {
      attempts += 1; stage = String(from); throw Object.assign(new Error("controlled EBUSY"), { code: "EBUSY" });
    }
    return originalRename(from, to);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(buildDaemon({ repoRoot: fixture.directory, outputDirectory: output }), /controlled EBUSY/); }
  finally { failure.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(attempts, 1); assert.equal(fs.existsSync(output), false); assert.ok(fs.existsSync(join(stage, "bundle-manifest.json")));
});


test("controlled Windows commit and rollback failures retain both original errors, backup data, and stage", { skip: process.platform !== "win32" }, async () => {
  const fixture = controlledRepository("controlled-double-failure"), originalRename = fs.renameSync;
  const commitFailure = Object.assign(new Error("controlled commit EPERM before failed rollback"), { code: "EPERM" });
  const rollbackFailure = Object.assign(new Error("controlled rollback EACCES"), { code: "EACCES" });
  let stage, backup, attempts = 0, rejected;
  const failure = mock.method(fs, "renameSync", (from, to) => {
    if (String(to) === fixture.output) {
      if (basename(String(from)).startsWith(".daemon.build-")) { stage = String(from); attempts += 1; throw commitFailure; }
      if (basename(String(from)).startsWith(".daemon.previous-")) { backup = String(from); throw rollbackFailure; }
    }
    return originalRename(from, to);
  });
  syncBuiltinESMExports();
  try { await assert.rejects(buildDaemon({ repoRoot: fixture.directory }), error => { rejected = error; return true; }); }
  finally { failure.mock.restore(); syncBuiltinESMExports(); }
  assert.ok(attempts >= 1 && attempts <= 5, `Commit attempts: ${attempts}; actual rejection: ${rejected?.stack}`);
  assert.match(rejected.message, /publish and rollback failed/);
  assert.equal(rejected.cause.errors[0].cause, commitFailure); assert.equal(rejected.cause.errors[1], rollbackFailure);
  assert.equal(rejected.cause.cause, rejected.cause.errors[0]);
  assert.equal(fs.existsSync(fixture.output), false); assert.ok(fs.existsSync(join(stage, "bundle-manifest.json")));
  assert.equal(fs.readFileSync(join(backup, "artood.mjs"), "utf8"), "legacy-build-to-preserve\n");
});

test("real Windows no-delete-share file lock yields EPERM then the same commit succeeds and its original owner closes", {
  skip: process.platform !== "win32", timeout: 20_000,
}, async () => {
  // This isolated filesystem fixture uses no fabricated rename failure and does
  // not identify which process held the original candidate's staging directory.
  const source = join(root, "actual-locked-source"), output = join(root, "actual-unlocked-output");
  fs.mkdirSync(source); const member = join(source, "owned.txt"), contents = Buffer.from("owned Windows file-lock fixture\n");
  fs.writeFileSync(member, contents);
  const expected = { directories: [], files: [{ path: "owned.txt", size: contents.length, sha256: digest(member) }] };
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
  assert.equal(fs.statSync(powershell).isFile(), true);
  const script = [
    "$ErrorActionPreference='Stop'",
    "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
    "$held=[IO.File]::Open($env:ARTOO_BUNDLE_TEST_LOCK_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)",
    "try { [Console]::Write('ready'+[char]10); $null=[Console]::ReadLine() } finally { $held.Dispose() }",
  ].join("\n");
  // Mark the owner unsettled before spawn: node:test can run after hooks when
  // its timeout cancels this callback, before the async finally has completed.
  retainRoot = true;
  const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { cwd: root, env: { ...safeEnvironment(), ARTOO_BUNDLE_TEST_LOCK_FILE: member }, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  const observed = { spawn: false, exit: null, close: null, stdoutEof: false, stderrEof: false, forced: false };
  let stdout = "", stderr = "", failures = 0, failure, readyReject, primaryFailure; const errors = [];
  child.once("spawn", () => { observed.spawn = true; });
  child.once("exit", (code, signal) => { observed.exit = { code, signal }; });
  child.stdout.once("end", () => { observed.stdoutEof = true; }); child.stderr.once("end", () => { observed.stderrEof = true; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const closed = new Promise(resolve => child.once("close", (code, signal) => { observed.close = { code, signal }; resolve(); }));
  const waitForClose = async milliseconds => {
    let timeout;
    try { return await Promise.race([closed.then(() => true), new Promise(resolve => { timeout = setTimeout(() => resolve(false), milliseconds); })]); }
    finally { clearTimeout(timeout); }
  };
  const ready = new Promise((resolve, reject) => {
    readyReject = reject;
    child.stdout.on("data", chunk => { stdout += chunk; if (stdout === "ready\n") resolve(); });
    child.once("close", () => { if (stdout !== "ready\n") reject(new Error("File-lock child closed before readiness: " + stderr)); });
  });
  const childError = error => { errors.push(error); readyReject(error); };
  child.on("error", childError); child.stdin.on("error", childError);
  child.stdout.on("error", childError); child.stderr.on("error", childError);
  const timer = setTimeout(() => {
    observed.forced = true; readyReject(new Error("File-lock child deadline expired"));
    try { child.kill(); } catch (error) { errors.push(error); }
  }, 10_000);
  try {
    await ready;
    const originalRename = fs.renameSync;
    failure = mock.method(fs, "renameSync", (from, to) => {
      try { return originalRename(from, to); }
      catch (error) {
        if (String(from) === source && String(to) === output) {
          assert.equal(error.code, "EPERM"); failures += 1;
          if (!child.stdin.writableEnded) child.stdin.end();
        }
        throw error;
      }
    });
    syncBuiltinESMExports();
    await publishStagingDirectory(source, output, expected);
    assert.equal(await waitForClose(2000), true, "Original file-lock child did not close normally");
    assert.ok(failures >= 1 && failures <= 4); assert.deepEqual(errors, []);
    assert.equal(observed.forced, false); assert.equal(observed.spawn, true);
    assert.deepEqual(observed.exit, { code: 0, signal: null }); assert.deepEqual(observed.close, { code: 0, signal: null });
    assert.equal(observed.stdoutEof, true); assert.equal(observed.stderrEof, true); assert.equal(stderr, "");
    assert.equal(fs.existsSync(source), false); assert.deepEqual(fs.readFileSync(join(output, "owned.txt")), contents);
  } catch (error) {
    primaryFailure = error; throw error;
  } finally {
    failure?.mock.restore(); syncBuiltinESMExports();
    if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
    let confirmed = await waitForClose(2000);
    if (!confirmed) {
      observed.forced = true;
      try { child.kill(); } catch (error) { errors.push(error); }
      confirmed = await waitForClose(3000);
    }
    clearTimeout(timer);
    if (!confirmed) {
      const closureError = new Error("Original file-lock child closure unconfirmed; fixture retained");
      throw primaryFailure ? new AggregateError([primaryFailure, closureError], closureError.message, { cause: primaryFailure }) : closureError;
    }
    retainRoot = false;
  }
});

test("a non-Windows host cannot manufacture a native Windows helper capability", { skip: process.platform === "win32" }, async () => {
  await assert.rejects(buildDaemon({ repoRoot, outputDirectory: join(root, "unsupported-native"),
    windowsProcessBundle: { directory: root, manifestSha256: `sha256:${"a".repeat(64)}` } }), /actual Windows x64 host/);
});

const nativeDirectory = process.env.ARTOO_BUNDLE_TEST_WINDOWS_PROCESS_DIR;
const nativeManifestSha256 = process.env.ARTOO_BUNDLE_TEST_WINDOWS_PROCESS_MANIFEST_SHA256;
test("optional genuine prevalidated Windows helper is copied exactly, and unlisted members are rejected", {
  skip: process.platform !== "win32" || process.arch !== "x64" || !nativeDirectory || !nativeManifestSha256,
}, async () => {
  const withNative = join(root, "native-daemon");
  await buildDaemon({ repoRoot, outputDirectory: withNative, windowsProcessBundle: { directory: nativeDirectory, manifestSha256: nativeManifestSha256 } });
  const copied = join(withNative, "native/windows-process");
  assert.equal(digest(join(copied, "manifest.json")), nativeManifestSha256);
  const manifest = JSON.parse(fs.readFileSync(join(copied, "manifest.json"), "utf8"));
  for (const file of manifest.files) assert.equal(digest(join(copied, file.path)), file.sha256);
  const altered = join(root, "altered-native-input"); fs.cpSync(nativeDirectory, altered, { recursive: true });
  fs.writeFileSync(join(altered, "unlisted.txt"), "unexpected member");
  await assert.rejects(buildDaemon({ repoRoot, outputDirectory: join(root, "reject-altered-native"),
    windowsProcessBundle: { directory: altered, manifestSha256: nativeManifestSha256 } }), /member set or contents differ/);
});
