// This validates a public npm installation on a hosted Windows runner. It does
// not establish local corporate-mirror access, native qualification or live AI.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const name = "@jiayunxie/artood", version = "0.1.0-rc.1", registry = "https://registry.npmjs.org/";
const integrity = "sha512-xdJjxbzz4oAy6MDf80mzKQQv1zg0/CLubPryd0GpYbiZsdaeQUzTthurOyiTPjt8NX9p0MRi4Dqg6Xcmej7TRw==";
const sha256 = "65c4c81189b80465cd9c4072c80aa3fc28cdbf2bf511529548b5bd45c11f179d";
const manifestSha256 = "sha256:2d7adcbd6dc4cd854dccd5bc55bf3c6d41149d77a0aa833d8ef2b43d3a0b01bc";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
assert.equal(process.platform, "win32");
assert.equal(process.arch, "x64");
assert.equal(process.env.GITHUB_ACTIONS, "true", "Run this check on the hosted validation runner");
assert.equal(Number(process.versions.node.split(".")[0]), 24);

const root = mkdtempSync(join(realpathSync(process.env.RUNNER_TEMP), "artoo-registry-verify-"));
const evidence = join(root, "evidence"), prefix = join(root, "installed"), connection = join(root, "connection");
mkdirSync(evidence);
appendFileSync(process.env.GITHUB_ENV, `REGISTRY_VERIFY_EVIDENCE=${evidence}\n`);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(?:NPM_CONFIG_|ARTOO_)/i.test(key) && !/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)));
for (const [key, file] of [["NPM_CONFIG_USERCONFIG", "user.npmrc"], ["NPM_CONFIG_GLOBALCONFIG", "global.npmrc"]]) {
  env[key] = join(root, file); writeFileSync(env[key], "", { flag: "wx" });
}
Object.assign(env, { NPM_CONFIG_REGISTRY: registry, NPM_CONFIG_LOGS_MAX: "0", NPM_CONFIG_IGNORE_SCRIPTS: "true",
  NPM_CONFIG_CACHE: join(root, "workspace-cache") });
const report = { scope: "hosted-windows-public-registry-install-and-loopback-connection", status: "running",
  checkoutCommit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, node: process.version,
  package: { name, version, integrity, sha256 }, localCorporateMirrorVerified: false,
  nativeSupervisorQualified: false, liveProviderInvoked: false, commands: [] };
const safe = value => String(value)
  .replace(/\b(?:npm_[A-Za-z0-9]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g, "[redacted]")
  .replace(/((?:authorization|cookie|set-cookie|_authToken|password)\s*[:=]\s*)[^\r\n]+/gi, "$1[redacted]")
  .replace(/((?:token|key|secret|password)=)[^\s&]+/gi, "$1[redacted]");
const save = (file, value) => writeFileSync(join(evidence, file), `${JSON.stringify(value, null, 2)}\n`);

function run(label, executable, args, { cwd = root, timeout = 60_000, commandEnv = env, verbatim = false } = {}) {
  const started = Date.now();
  const result = spawnSync(executable, args, { cwd, env: commandEnv, encoding: "utf8", timeout,
    maxBuffer: 8 * 1024 * 1024, windowsHide: true, windowsVerbatimArguments: verbatim });
  writeFileSync(join(evidence, `${label}.stdout.log`), safe(result.stdout ?? ""));
  writeFileSync(join(evidence, `${label}.stderr.log`), safe(result.stderr ?? ""));
  report.commands.push({ label, status: result.status, signal: result.signal, elapsedMs: Date.now() - started,
    error: result.error ? { code: result.error.code, message: safe(result.error.message) } : null });
  save("process-results.json", report.commands);
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${label} failed; see its captured output`);
  assert.equal(result.signal, null, `${label} was terminated`);
  return result.stdout;
}

try {
  // Resolve the installed npm.cmd, then invoke its adjacent JS entrypoint with
  // node. Direct spawn of a .cmd fails on Windows; no shell command is composed.
  const npmCmd = run("resolve-npm", "where.exe", ["npm.cmd"]).trim().split(/\r?\n/)[0];
  const npmCli = join(dirname(npmCmd), "node_modules/npm/bin/npm-cli.js");
  assert.ok(existsSync(npmCli), "The selected npm.cmd must have its standard npm CLI entrypoint");
  const npm = (label, args, options) => run(label, process.execPath, [npmCli, ...args], options);
  report.npm = npm("npm-version", ["--version"]).trim();
  assert.match(report.npm, /^11\./);
  npm("workspace-ci", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: repo, timeout: 480_000 });
  npm("workspace-build", ["run", "build"], { cwd: repo, timeout: 480_000 });

  const response = await fetch(`${registry}@jiayunxie%2fartood`, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  assert.equal(response.status, 200, "Published package metadata must be available from the official registry");
  const metadata = await response.json(), published = metadata.versions?.[version];
  assert.equal(metadata.name, name); assert.equal(metadata["dist-tags"]?.next, version);
  assert.equal(published?.name, name); assert.equal(published.version, version);
  assert.equal(published.dist?.integrity, integrity);
  const tarballUrl = `${registry}@jiayunxie/artood/-/artood-${version}.tgz`;
  assert.equal(published.dist.tarball, tarballUrl);
  const tarball = await fetch(tarballUrl, { redirect: "error", signal: AbortSignal.timeout(60_000) });
  assert.equal(tarball.status, 200);
  const bytes = Buffer.from(await tarball.arrayBuffer());
  assert.equal(bytes.length, 38_002_512);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256);
  assert.equal(`sha512-${createHash("sha512").update(bytes).digest("base64")}`, integrity);
  report.registry = { url: registry, name, version, next: metadata["dist-tags"].next, integrity, sha256, bytes: bytes.length };
  save("registry.json", report.registry);

  const packageEnv = { ...env, NPM_CONFIG_CACHE: join(root, "package-cache") };
  npm("registry-install", ["install", "--prefix", prefix, "--save-exact", "--ignore-scripts", "--no-audit", "--no-fund",
    `${name}@${version}`], { timeout: 180_000, commandEnv: packageEnv });
  const lock = JSON.parse(readFileSync(join(prefix, "package-lock.json"), "utf8"));
  const locked = lock.packages["node_modules/@jiayunxie/artood"];
  assert.equal(locked.version, version); assert.equal(locked.integrity, integrity); assert.equal(locked.resolved, tarballUrl);
  save("installed-lock-entry.json", { version: locked.version, integrity: locked.integrity, resolved: locked.resolved });
  const installed = join(prefix, "node_modules/@jiayunxie/artood");
  report.verification = JSON.parse(run("installed-verify", process.execPath,
    [join(installed, "bin/verify.mjs"), "--package-directory", installed], { commandEnv: packageEnv }));
  assert.deepEqual(report.verification, { name, version, files: 177, bytes: 99_035_866,
    runtimeManifestSha256: manifestSha256, native: true });
  const shim = join(prefix, "node_modules/.bin/artood.cmd");
  assert.ok(existsSync(shim));
  // Only a generated absolute path and two fixed flags enter cmd.exe. Reject
  // every cmd metacharacter before testing the actual npm-installed shim.
  assert.doesNotMatch(shim, /["%!&|<>^\r\n]/);
  const cli = flag => run(`cli-${flag.slice(2)}`, process.env.ComSpec ?? "cmd.exe",
    ["/d", "/s", "/c", `""${shim}" "${flag}""`], { verbatim: true, commandEnv: packageEnv });
  assert.equal(cli("--version").trim(), version);
  const help = cli("--help"); assert.ok(help.includes(`${name} ${version}`)); assert.ok(help.includes("Usage: artood"));
  run("connection-smoke", process.execPath, [join(repo, "scripts/npm-daemon/connection-smoke.mjs"),
    "--package-directory", installed, "--evidence-directory", connection], { timeout: 120_000, commandEnv: packageEnv });
  report.connection = JSON.parse(readFileSync(join(connection, "result.json"), "utf8"));
  // Copy only the existing smoke's safe outputs, never its database/workspace,
  // the downloaded package, caches, npm configuration, or node_modules.
  for (const file of ["result.json", "stdout.log", "stderr.log"])
    writeFileSync(join(evidence, `daemon-${file}`), safe(readFileSync(join(connection, file), "utf8")));
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.error = safe(error.message); process.exitCode = 1;
  console.error(report.error);
} finally {
  save("result.json", report);
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Published Windows npm verification: **${report.status}**.\n\n`
    + `Package: \`${name}@${version}\`; expected SHA-256: \`${sha256}\`.\n\n`
    + "Scope: official registry installation on this hosted Windows runner and fixture-authenticated loopback pairing/enrollment/WebSocket/normal-stop checks. "
    + "This does not verify the local Microsoft mirror, production OAuth, a live model, or native-supervisor qualification.\n");
  console.log(JSON.stringify({ status: report.status, name, version, evidence }));
}
