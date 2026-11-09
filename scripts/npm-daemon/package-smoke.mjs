// Install the exact Windows-built tarball on its real target platform.
// Controlled CLI fixtures exercise execution; they are not live-model evidence.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const platforms = ["win32-x64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"];
const namePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseSmokeArguments(args) {
  const keys = { "--tarball": "tarball", "--sha256": "sha256", "--name": "name", "--version": "version",
    "--platform": "platform", "--source-commit": "sourceCommit", "--evidence-directory": "evidenceDirectory" };
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = keys[args[index]], value = args[index + 1];
    if (!key || Object.hasOwn(values, key) || !value || value.startsWith("--")) throw Error("Invalid or duplicate package smoke argument");
    values[key] = value;
  }
  assert.ok(isAbsolute(values.tarball ?? ""), "--tarball must be absolute");
  assert.ok(isAbsolute(values.evidenceDirectory ?? ""), "--evidence-directory must be a new absolute directory");
  assert.match(values.sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.match(values.name ?? "", namePattern); assert.ok(values.name.length <= 214);
  assert.match(values.version ?? "", versionPattern);
  assert.ok(platforms.includes(values.platform), "An explicit supported --platform tuple is required");
  assert.match(values.sourceCommit ?? "", /^[a-f0-9]{40}$/);
  return values;
}

const safe = value => String(value)
  .replace(/\b(?:npm_[A-Za-z0-9]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g, "[redacted]")
  .replace(/((?:authorization|cookie|set-cookie|_authToken|password)\s*[:=]\s*)[^\r\n]+/gi, "$1[redacted]")
  .replace(/((?:token|key|secret|password)=)[^\s&]+/gi, "$1[redacted]");

function npmEntrypoint(env) {
  const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1];
  assert.ok(pathValue, "PATH is required to resolve the runner's installed npm");
  const filename = process.platform === "win32" ? "npm.cmd" : "npm";
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, filename);
    if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
    const entry = process.platform === "win32"
      ? join(dirname(candidate), "node_modules/npm/bin/npm-cli.js") : realpathSync(candidate);
    assert.ok(existsSync(entry) && statSync(entry).isFile() && entry.endsWith("npm-cli.js"),
      "The selected npm executable must resolve to its standard JavaScript entrypoint");
    return realpathSync(entry);
  }
  throw Error("npm was not found on the runner PATH");
}

function validateMetadata(metadata, options) {
  assert.equal(metadata.name, options.name); assert.equal(metadata.version, options.version);
  assert.notEqual(metadata.private, true); assert.equal(metadata.type, "module");
  assert.deepEqual(metadata.bin, { artood: "bin/artood.mjs" });
  assert.deepEqual(metadata.engines, { node: ">=24.0.0" });
  assert.deepEqual(metadata.os, ["win32", "darwin", "linux"]);
  assert.deepEqual(metadata.cpu, ["x64", "arm64"]);
  assert.deepEqual(metadata.publishConfig, { access: "public", registry: "https://registry.npmjs.org/" });
  assert.equal(metadata.artoo?.format, "artoo.npm-daemon.v1");
  assert.match(metadata.artoo?.runtimeManifestSha256 ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(metadata.artoo.platforms, platforms);
  // A normal npm install is safe here because this checked candidate contains no
  // lifecycle scripts or external dependency resolution. Do not mask OS errors.
  for (const key of ["scripts", "dependencies", "devDependencies", "optionalDependencies", "peerDependencies",
    "bundledDependencies", "bundleDependencies", "workspaces"]) assert.equal(metadata[key], undefined, "Unexpected " + key);
}

function validateConnection(result, options) {
  assert.equal(result.version, 2);
  assert.equal(result.platform, process.platform); assert.equal(result.arch, process.arch);
  assert.equal(result.devicePlatform, { win32: "windows", darwin: "macos", linux: "linux" }[process.platform]);
  assert.equal(result.shutdownMethod, process.platform === "win32" ? "ipc" : "sigint");
  assert.equal(result.package.name, options.name); assert.equal(result.package.version, options.version);
  assert.equal(result.fixture_owner_authentication, true); assert.equal(result.dev_node_token_enabled, false);
  assert.equal(result.model_invoked, false); assert.equal(result.native_supervisor_qualified, false);
  for (const key of ["paired", "enrolled", "registered", "heartbeatPersisted", "stdoutEof", "stderrEof", "serverDisconnected"])
    assert.equal(result[key], true, "Connection result did not confirm " + key);
  assert.deepEqual(result.exit, { code: 0, signal: null });
  assert.deepEqual(result.close, { code: 0, signal: null });
  assert.equal(result.dependencyIsolation.optionalAddonResolutionAttempts, 0);
  assert.equal(result.dependencyIsolation.emptyConfigRejected, true);
  assert.ok(Array.isArray(result.controlledCliTasks)); assert.equal(result.controlledCliTasks.length, 4);
  const combinations = new Set(), tasks = new Set(), runs = new Set();
  for (const task of result.controlledCliTasks) {
    assert.ok(["codex", "claude-code"].includes(task.runtime));
    assert.ok(["success", "failure"].includes(task.outcome));
    const key = task.runtime + ":" + task.outcome;
    assert.equal(combinations.has(key), false); combinations.add(key);
    for (const [value, ids] of [[task.taskId, tasks], [task.runId, runs]]) {
      assert.equal(typeof value, "string"); assert.ok(value.length > 0);
      assert.equal(ids.has(value), false); ids.add(value);
    }
    const successful = task.outcome === "success";
    assert.equal(task.runStatus, successful ? "completed" : "failed");
    assert.ok(Number.isSafeInteger(task.fixturePid) && task.fixturePid > 0);
    // This exit code is the fixture's own exit-handler record, not an
    // independent parent-handle observation. PID absence is checked separately.
    assert.equal(task.fixtureExitCode, successful ? 0 : 23);
    assert.equal(task.fixtureExitCodeSource, "fixture-process-exit-handler");
    assert.equal(task.fixtureProcessAbsent, true);
    assert.equal(task.structuredAnswerPersisted, successful);
    assert.ok(Number.isSafeInteger(task.artifactCount) && (successful ? task.artifactCount > 0 : task.artifactCount === 0));
    assert.equal(task.leasesReleased, true); assert.equal(task.modelInvoked, false);
  }
  assert.deepEqual([...combinations].sort(), ["claude-code:failure", "claude-code:success", "codex:failure", "codex:success"]);
}

export async function packageSmoke(options) {
  options = parseSmokeArguments(["--tarball", options.tarball, "--sha256", options.sha256, "--name", options.name,
    "--version", options.version, "--platform", options.platform, "--source-commit", options.sourceCommit,
    "--evidence-directory", options.evidenceDirectory]);
  const actualPlatform = process.platform + "-" + process.arch;
  assert.equal(actualPlatform, options.platform, "Use a real runner for the expected platform; never simulate process.platform");
  assert.equal(Number(process.versions.node.split(".")[0]), 24, "This qualification uses Node.js 24");
  const evidence = resolve(options.evidenceDirectory);
  mkdirSync(evidence); // Exclusive fresh output: never overwrite prior evidence.
  const root = mkdtempSync(join(realpathSync(tmpdir()), "artoo-package-smoke-"));
  const prefix = join(root, "installed"), connection = join(root, "connection");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:NPM_CONFIG_|ARTOO_)/i.test(key) && !/^(?:NODE_OPTIONS|NODE_PATH)$/i.test(key)
    && !/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)));
  for (const [key, file] of [["NPM_CONFIG_USERCONFIG", "user.npmrc"], ["NPM_CONFIG_GLOBALCONFIG", "global.npmrc"]]) {
    env[key] = join(root, file); writeFileSync(env[key], "", { flag: "wx" });
  }
  Object.assign(env, { NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/", NPM_CONFIG_LOGS_MAX: "0",
    NPM_CONFIG_CACHE: join(root, "package-cache") });
  const report = { scope: "same-tarball-platform-install-and-controlled-cli-tasks", status: "running",
    platform: actualPlatform, node: process.version, sourceCommit: options.sourceCommit,
    runId: process.env.GITHUB_RUN_ID ?? null, runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    package: { name: options.name, version: options.version, sha256: options.sha256 },
    installation: { force: false, ignoreScripts: false }, liveProviderInvoked: false,
    nativeSupervisorQualified: false, commands: [] };
  const save = (file, value) => writeFileSync(join(evidence, file), safe(JSON.stringify(value, null, 2)) + "\n");
  function run(label, executable, args, { cwd = root, timeout = 60_000, verbatim = false } = {}) {
    const start = Date.now();
    const result = spawnSync(executable, args, { cwd, env, encoding: "utf8", timeout,
      maxBuffer: 8 * 1024 * 1024, windowsHide: true, windowsVerbatimArguments: verbatim });
    writeFileSync(join(evidence, label + ".stdout.log"), safe(result.stdout ?? ""));
    writeFileSync(join(evidence, label + ".stderr.log"), safe(result.stderr ?? ""));
    report.commands.push({ label, status: result.status, signal: result.signal, elapsedMs: Date.now() - start,
      error: result.error ? { code: result.error.code, message: safe(result.error.message) } : null });
    save("process-results.json", report.commands);
    assert.ifError(result.error);
    assert.equal(result.status, 0, label + " failed; see captured output");
    assert.equal(result.signal, null, label + " was terminated");
    return result.stdout;
  }

  try {
    const checkout = run("checkout-commit", "git", ["rev-parse", "HEAD"], { cwd: repo }).trim();
    assert.equal(checkout, options.sourceCommit, "Validation checkout differs from the candidate build");
    report.checkoutCommit = checkout;
    const tarball = resolve(options.tarball), stat = lstatSync(tarball);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
    const bytes = readFileSync(tarball);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), options.sha256, "Downloaded tarball hash mismatch");
    const integrity = "sha512-" + createHash("sha512").update(bytes).digest("base64");
    Object.assign(report.package, { integrity, bytes: bytes.length });
    const members = run("tar-members", "tar", ["-tzf", tarball]).trim().split(/\r?\n/);
    assert.equal(members.filter(member => member === "package/package.json").length, 1);
    assert.ok(members.length < 30_000);
    for (const member of members) {
      assert.ok(member.startsWith("package/") && !/[\\\u0000-\u001f]/.test(member));
      assert.ok(!member.split("/").some(part => part === "." || part === ".."));
    }
    const metadata = JSON.parse(run("package-metadata", "tar", ["-xOzf", tarball, "package/package.json"]));
    validateMetadata(metadata, options);
    save("candidate-metadata.json", metadata);

    const npmCli = npmEntrypoint(env);
    const npm = (label, args, runOptions) => run(label, process.execPath, [npmCli, ...args], runOptions);
    report.npm = npm("npm-version", ["--version"]).trim();
    assert.ok(Number(report.npm.split(".")[0]) >= 11);
    assert.equal(npm("npm-ignore-scripts", ["config", "get", "ignore-scripts"]).trim(), "false");
    assert.equal(npm("npm-force", ["config", "get", "force"]).trim(), "false");
    npm("package-install", ["install", "--prefix", prefix, "--save-exact", "--no-audit", "--no-fund", tarball], { timeout: 180_000 });
    const lock = JSON.parse(readFileSync(join(prefix, "package-lock.json"), "utf8"));
    const locked = lock.packages["node_modules/" + options.name];
    assert.equal(locked?.version, options.version); assert.equal(locked.integrity, integrity);
    save("installed-lock-entry.json", { version: locked.version, integrity: locked.integrity });
    const installed = join(prefix, "node_modules", options.name);
    assert.deepEqual(JSON.parse(readFileSync(join(installed, "package.json"), "utf8")), metadata);
    report.verification = JSON.parse(run("installed-verify", process.execPath,
      [join(installed, "bin/verify.mjs"), "--package-directory", installed]));
    assert.equal(report.verification.name, options.name); assert.equal(report.verification.version, options.version);
    assert.equal(report.verification.runtimeManifestSha256, metadata.artoo.runtimeManifestSha256);
    assert.ok(report.verification.files > 0 && report.verification.bytes > 0);
    assert.equal(report.verification.native, true, "The same tarball must retain the Windows x64 helper on all platforms");

    const shim = join(prefix, "node_modules/.bin", process.platform === "win32" ? "artood.cmd" : "artood");
    assert.ok(existsSync(shim), "npm did not create its platform CLI shim");
    const cli = flag => {
      if (process.platform !== "win32") {
        assert.equal(realpathSync(shim), realpathSync(join(installed, "bin/artood.mjs")));
        assert.ok((statSync(shim).mode & 0o111) !== 0, "The installed POSIX shim is not executable");
        return run("cli-" + flag.slice(2), shim, [flag]);
      }
      // Only a generated absolute path and fixed flags enter cmd.exe.
      assert.doesNotMatch(shim, /["%!&|<>^\r\n]/);
      return run("cli-" + flag.slice(2), process.env.ComSpec ?? "cmd.exe",
        ["/d", "/v:off", "/s", "/c", '""' + shim + '" "' + flag + '""'], { verbatim: true });
    };
    assert.equal(cli("--version").trim(), options.version);
    const help = cli("--help");
    assert.ok(help.includes(options.name + " " + options.version) && help.includes("Usage: artood"));
    run("connection-smoke", process.execPath, [join(repo, "scripts/npm-daemon/connection-smoke.mjs"),
      "--package-directory", installed, "--evidence-directory", connection], { timeout: 300_000 });
    report.connection = JSON.parse(readFileSync(join(connection, "result.json"), "utf8"));
    validateConnection(report.connection, options);
    report.status = "passed";
  } catch (error) {
    report.status = "failed"; report.error = safe(error.message); process.exitCode = 1;
    console.error(report.error);
  } finally {
    // The smoke's context packs, database, workspaces and caches are not artifacts.
    for (const file of ["result.json", "failure.json", "stdout.log", "stderr.log"])
      if (existsSync(join(connection, file)))
        writeFileSync(join(evidence, "daemon-" + file), safe(readFileSync(join(connection, file), "utf8")));
    save("result.json", report);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      "Universal npm package verification: **" + report.status + "** on **" + actualPlatform + "**.\n\n"
      + "Package: " + options.name + "@" + options.version + "; SHA-256: " + options.sha256
      + "; source checkout: " + options.sourceCommit + ".\n\n"
      + "Scope: same-tarball normal npm installation, installed CLI/manifest and fixture-authenticated "
      + "pairing/enrollment/WebSocket, controlled Codex/Claude success/failure tasks, and normal daemon stop. "
      + "No real provider, native-supervisor admission or deployed-product health claim.\n");
    console.log(JSON.stringify({ status: report.status, platform: actualPlatform, evidence }));
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => packageSmoke(parseSmokeArguments(process.argv.slice(2))))
    .catch(error => { console.error(safe(error.message)); process.exitCode = 1; });
}
