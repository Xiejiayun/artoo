import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { connectVersion, verifyDaemonRegistry } from "./daemon-registry.mjs";

const version = "0.1.0-rc.9",
  bytes = Buffer.from("qualified public package bytes");
const metadataUrl = `https://github.com/Xiejiayun/artoo/releases/download/artood-v${version}/release-metadata.json`;
const tarball = `https://registry.npmjs.org/@jiayunxie/artood/-/artood-${version}.tgz`;
function fixture(patch = {}) {
  const metadata = {
    format: "artoo.npm-candidate.v1",
    name: "@jiayunxie/artood",
    version,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    ...patch.metadata,
  };
  const entries = {
    [`https://api.github.com/repos/Xiejiayun/artoo/releases/tags/artood-v${version}`]: {
      draft: false,
      tag_name: `artood-v${version}`,
      assets: [{ name: "release-metadata.json", browser_download_url: metadataUrl }],
      ...patch.release,
    },
    [metadataUrl]: metadata,
    [`https://registry.npmjs.org/@jiayunxie%2fartood/${version}`]: {
      name: metadata.name,
      version,
      dist: { tarball, integrity: metadata.integrity },
      ...patch.published,
    },
    [tarball]: patch.bytes ?? bytes,
  };
  const calls = [];
  return {
    calls,
    request: async (url) => {
      calls.push(url);
      assert.ok(Object.hasOwn(entries, url), `Unexpected public URL ${url}`);
      const value = entries[url];
      return new Response(Buffer.isBuffer(value) ? value : JSON.stringify(value), {
        status: patch.unavailable === url ? 404 : 200,
      });
    },
  };
}

test("reads the one exact connection version and verifies official bytes without executing them", async () => {
  assert.equal(connectVersion(`export const DAEMON_CONNECT_VERSION = "${version}";`), version);
  assert.throws(() => connectVersion(""), /exactly one/);
  assert.throws(() => connectVersion(`export const DAEMON_CONNECT_VERSION = "latest";`));
  const f = fixture(),
    result = await verifyDaemonRegistry(version, f.request);
  assert.equal(result.size, bytes.length);
  assert.equal(result.version, version);
  assert.equal(f.calls.length, 4);
});

test("rejects unpublished, foreign, mismatched and corrupt distribution before release", async () => {
  for (const patch of [
    { release: { draft: true } },
    { metadata: { version: "0.1.0-rc.8" } },
    { unavailable: `https://registry.npmjs.org/@jiayunxie%2fartood/${version}` },
    { published: { name: "@someone/artood" } },
    { published: { version: "0.1.0-rc.8" } },
    { published: { dist: { tarball: "https://other.invalid/package.tgz" } } },
    { published: { dist: { tarball, integrity: "sha512-wrong" } } },
    { bytes: Buffer.from("corrupt") },
    { bytes: Buffer.alloc(bytes.length + 1) },
  ])
    await assert.rejects(verifyDaemonRegistry(version, fixture(patch).request));
});
