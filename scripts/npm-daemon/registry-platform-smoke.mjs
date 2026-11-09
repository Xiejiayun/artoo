// Post-publication verification only. Fixed public rc.2 package, no publication
// credential, alternate registry, local corporate-network workaround or model.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packageSmoke } from "./package-smoke.mjs";

export const releaseName = "@jiayunxie/artood", releaseVersion = "0.1.0-rc.2";
export const registry = "https://registry.npmjs.org/";
export const metadataUrl = `${registry}@jiayunxie%2fartood/${releaseVersion}`;
export const tarballUrl = `${registry}@jiayunxie/artood/-/artood-${releaseVersion}.tgz`;
const platforms = ["win32-x64", "linux-x64", "linux-arm64"];
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const safe = value => String(value).replace(/((?:token|key|secret|password)=)[^\s&]+/gi, "$1[redacted]")
  .replace(/\b(?:npm_[A-Za-z0-9]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g, "[redacted]");

export function parseRegistryArguments(args) {
  const keys = { "--sha256": "sha256", "--integrity": "integrity", "--source-commit": "sourceCommit",
    "--platform": "platform", "--evidence-directory": "evidenceDirectory" };
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = keys[args[index]], value = args[index + 1];
    assert.ok(key && !Object.hasOwn(values, key) && value && !value.startsWith("--"), "Unknown, duplicate or missing registry verification argument");
    values[key] = value;
  }
  assert.match(values.sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.match(values.integrity ?? "", /^sha512-[A-Za-z0-9+/]{86}==$/);
  const sha512 = Buffer.from(values.integrity.slice(7), "base64");
  assert.equal(sha512.length, 64); assert.equal(`sha512-${sha512.toString("base64")}`, values.integrity);
  assert.match(values.sourceCommit ?? "", /^[a-f0-9]{40}$/);
  assert.ok(platforms.includes(values.platform), "Use a real Windows x64 or Linux x64/arm64 runner");
  assert.ok(isAbsolute(values.evidenceDirectory ?? ""), "Evidence directory must be a new absolute path");
  return values;
}

/** Injectable HTTP is used only by offline pin-rejection tests. */
export async function fetchPinnedRelease(options, request = fetch) {
  const metadataResponse = await request(metadataUrl, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  assert.equal(metadataResponse.status, 200, "Exact published version is unavailable from the official registry");
  const published = await metadataResponse.json();
  assert.equal(published.name, releaseName); assert.equal(published.version, releaseVersion);
  assert.equal(published.dist?.tarball, tarballUrl, "Unexpected registry tarball URL");
  assert.equal(published.dist?.integrity, options.integrity, "Published SHA-512 differs from validated candidate");
  const response = await request(tarballUrl, { redirect: "error", signal: AbortSignal.timeout(60_000) });
  assert.equal(response.status, 200, "Published tarball is unavailable");
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.ok(bytes.length > 0 && bytes.length <= 128 * 1024 * 1024, "Unexpected tarball size");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), options.sha256, "Published tarball SHA-256 mismatch");
  assert.equal(`sha512-${createHash("sha512").update(bytes).digest("base64")}`, options.integrity, "Published tarball SHA-512 mismatch");
  return { bytes, registry: { url: registry, metadataUrl, tarballUrl, name: releaseName, version: releaseVersion,
    sha256: options.sha256, integrity: options.integrity, bytes: bytes.length } };
}

export async function registryPlatformSmoke(options) {
  options = parseRegistryArguments(["--sha256", options.sha256, "--integrity", options.integrity,
    "--source-commit", options.sourceCommit, "--platform", options.platform, "--evidence-directory", options.evidenceDirectory]);
  assert.equal(process.env.GITHUB_ACTIONS, "true", "Use the authorized hosted workflow; do not bypass local registry restrictions");
  assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(process.env.GITHUB_REF, "refs/heads/main");
  assert.equal(`${process.platform}-${process.arch}`, options.platform);
  assert.equal(Number(process.versions.node.split(".")[0]), 24);
  const evidence = resolve(options.evidenceDirectory); mkdirSync(evidence);
  const report = { scope: "post-publication-official-registry-install-and-controlled-cli-tasks", status: "running",
    name: releaseName, version: releaseVersion, sourceCommit: options.sourceCommit, platform: options.platform,
    workflowMainCommit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    expected: { sha256: options.sha256, integrity: options.integrity }, localCorporateMirrorVerified: false,
    liveProviderInvoked: false, nativeSupervisorQualified: false };
  try {
    const git = args => {
      const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", timeout: 30_000, windowsHide: true });
      assert.ifError(result.error); assert.equal(result.status, 0, "Source checkout/main ancestry validation failed");
      return result.stdout.trim();
    };
    assert.equal(git(["rev-parse", "HEAD"]), options.sourceCommit, "Checkout is not the validated candidate source");
    git(["merge-base", "--is-ancestor", options.sourceCommit, "refs/remotes/origin/main"]);
    report.checkoutCommit = options.sourceCommit;
    const release = await fetchPinnedRelease(options);
    report.registry = release.registry;
    writeFileSync(join(evidence, "registry.json"), `${JSON.stringify(release.registry, null, 2)}\n`, { flag: "wx" });
    const downloaded = mkdtempSync(join(realpathSync(process.env.RUNNER_TEMP), "artoo-public-registry-"));
    const tarball = join(downloaded, `artood-${releaseVersion}.tgz`);
    writeFileSync(tarball, release.bytes, { flag: "wx" });
    // The local bytes are the independently checked reference. npm itself must
    // fetch the exact registry spec into its own fresh cache and installation.
    report.packageSmoke = await packageSmoke({ tarball, sha256: options.sha256, integrity: options.integrity,
      name: releaseName, version: releaseVersion, sourceCommit: options.sourceCommit, platform: options.platform,
      evidenceDirectory: join(evidence, "package"), installSource: "registry" });
    assert.equal(report.packageSmoke.status, "passed", "Published package smoke failed; inspect package/result.json");
    report.status = "passed";
  } catch (error) {
    report.status = "failed"; report.error = safe(error.message); process.exitCode = 1; console.error(report.error);
  } finally {
    writeFileSync(join(evidence, "result.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    console.log(JSON.stringify({ status: report.status, platform: options.platform, evidence }));
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => registryPlatformSmoke(parseRegistryArguments(process.argv.slice(2))))
    .catch(error => { console.error(safe(error.message)); process.exitCode = 1; });
}
