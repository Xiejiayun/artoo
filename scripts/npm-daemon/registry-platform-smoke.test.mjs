import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseSmokeArguments } from "./package-smoke.mjs";
import { fetchPinnedRelease, metadataUrl, parseRegistryArguments, releaseName, releaseVersion, tarballUrl } from "./registry-platform-smoke.mjs";

const bytes = Buffer.from("Controlled HTTP fixture only; not an actual npm package.");
const pins = { sha256: createHash("sha256").update(bytes).digest("hex"), integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
const source = "a".repeat(40), evidence = join(tmpdir(), "registry-fixture-evidence");
const args = ["--sha256", pins.sha256, "--integrity", pins.integrity, "--source-commit", source, "--platform", "linux-x64", "--evidence-directory", evidence];

test("published verification fixes rc.3 and rejects package overrides, unpinned sources and unsupported hosts", () => {
  assert.equal(releaseName, "@jiayunxie/artood"); assert.equal(releaseVersion, "0.1.0-rc.3");
  assert.equal(parseRegistryArguments(args).sourceCommit, source);
  for (const extra of [["--version", "latest"], ["--name", "other"], ["--registry", "https://mirror.invalid"], ["--sha256", pins.sha256]])
    assert.throws(() => parseRegistryArguments([...args, ...extra]));
  for (const [index, invalid] of [[1, "not-a-hash"], [3, "sha512-short"], [5, "main"], [7, "darwin-arm64"], [9, "relative"]]) {
    const changed = [...args]; changed[index] = invalid; assert.throws(() => parseRegistryArguments(changed));
  }
});

test("candidate smoke keeps local tarball installation by default and registry mode requires its explicit integrity pin", () => {
  const candidate = ["--tarball", join(tmpdir(), "fixture.tgz"), "--sha256", pins.sha256, "--name", releaseName,
    "--version", releaseVersion, "--platform", "linux-x64", "--source-commit", source, "--evidence-directory", evidence];
  assert.equal(parseSmokeArguments(candidate).installSource, "tarball");
  assert.throws(() => parseSmokeArguments([...candidate, "--install-source", "registry"]));
  assert.throws(() => parseSmokeArguments([...candidate, "--install-source", "mirror", "--integrity", pins.integrity]));
  assert.throws(() => parseSmokeArguments([...candidate, "--integrity", pins.integrity]));
  assert.equal(parseSmokeArguments([...candidate, "--install-source", "registry", "--integrity", pins.integrity]).integrity, pins.integrity);
});

function httpFixture({ published = {}, body = bytes } = {}) {
  const calls = [];
  const request = async (url, options) => {
    calls.push(url); assert.equal(options.redirect, "error"); assert.ok(options.signal instanceof AbortSignal);
    if (url === metadataUrl) return new Response(JSON.stringify({ name: releaseName, version: releaseVersion,
      dist: { tarball: tarballUrl, integrity: pins.integrity }, ...published }), { status: 200 });
    assert.equal(url, tarballUrl); return new Response(body, { status: 200 });
  };
  return { request, calls };
}

test("official metadata and independently downloaded bytes must match both validated hashes", async () => {
  const fixture = httpFixture();
  const release = await fetchPinnedRelease(pins, fixture.request);
  assert.deepEqual(fixture.calls, [metadataUrl, tarballUrl]); assert.deepEqual(release.bytes, bytes);
  assert.equal(release.registry.sha256, pins.sha256); assert.equal(release.registry.integrity, pins.integrity);
});

test("changed package identity, integrity or URL is rejected before fetching any tarball", async () => {
  for (const published of [{ name: "other" }, { version: "0.1.0-rc.1" },
    { dist: { tarball: "https://mirror.invalid/artood.tgz", integrity: pins.integrity } },
    { dist: { tarball: tarballUrl, integrity: "sha512-wrong" } }]) {
    const fixture = httpFixture({ published });
    await assert.rejects(fetchPinnedRelease(pins, fixture.request)); assert.deepEqual(fixture.calls, [metadataUrl]);
  }
});

test("modified downloaded bytes and a different SHA-256 pin never qualify", async () => {
  await assert.rejects(fetchPinnedRelease(pins, httpFixture({ body: Buffer.from("altered") }).request), /SHA-256 mismatch/);
  await assert.rejects(fetchPinnedRelease({ ...pins, sha256: "0".repeat(64) }, httpFixture().request), /SHA-256 mismatch/);
  const wrongIntegrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
  const fixture = httpFixture({ published: { dist: { tarball: tarballUrl, integrity: wrongIntegrity } } });
  await assert.rejects(fetchPinnedRelease({ ...pins, integrity: wrongIntegrity }, fixture.request), /SHA-512 mismatch/);
});

test("an unavailable exact version fails instead of resolving a tag or mirror", async () => {
  const calls = [];
  await assert.rejects(fetchPinnedRelease(pins, async url => { calls.push(url); return new Response("missing", { status: 404 }); }), /unavailable/);
  assert.deepEqual(calls, [metadataUrl]);
});
