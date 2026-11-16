import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const registry = "https://registry.npmjs.org/";
const repository = "Xiejiayun/artoo";
const name = "@jiayunxie/artood";

export function connectVersion(source) {
  const matches = [...source.matchAll(/export const DAEMON_CONNECT_VERSION = "([0-9A-Za-z.-]+)";/g)];
  assert.equal(matches.length, 1, "Expected exactly one pinned Web connection version.");
  const version = matches[0][1];
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  return version;
}

/** Read public distribution only; never install code or accept an alternate registry. */
export async function verifyDaemonRegistry(version, request = fetch) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  const read = async (url) => {
    const response = await request(url, {
      signal: AbortSignal.timeout(60000),
      headers: { Accept: "application/json", "User-Agent": "artoo-release-preflight" },
    });
    assert.ok(response.ok, `Public daemon prerequisite unavailable (${response.status}): ${url}`);
    return response;
  };
  const release = await (
    await read(`https://api.github.com/repos/${repository}/releases/tags/artood-v${version}`)
  ).json();
  assert.equal(release.draft, false, "The daemon GitHub release is still a draft.");
  assert.equal(release.tag_name, `artood-v${version}`);
  const assets = release.assets.filter((asset) => asset.name === "release-metadata.json");
  assert.equal(assets.length, 1, "Expected one published daemon metadata receipt.");
  const metadataUrl = `https://github.com/${repository}/releases/download/artood-v${version}/release-metadata.json`;
  assert.equal(assets[0].browser_download_url, metadataUrl);
  const metadata = await (await read(metadataUrl)).json();
  assert.equal(metadata.format, "artoo.npm-candidate.v1");
  assert.equal(metadata.name, name);
  assert.equal(metadata.version, version);
  assert.match(metadata.sha256, /^[a-f0-9]{64}$/);
  assert.match(metadata.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
  assert.ok(Number.isSafeInteger(metadata.size) && metadata.size > 0 && metadata.size <= 128 * 1024 ** 2);
  const published = await (await read(`${registry}@jiayunxie%2fartood/${version}`)).json();
  assert.equal(published.name, name);
  assert.equal(published.version, version);
  const tarball = `${registry}@jiayunxie/artood/-/artood-${version}.tgz`;
  assert.equal(published.dist?.tarball, tarball, "Refusing a foreign registry tarball.");
  assert.equal(published.dist?.integrity, metadata.integrity, "npm bytes differ from the qualified GitHub candidate.");
  const response = await read(tarball);
  // Bound the streamed download even if the server omits Content-Length.
  const hashes = { sha256: createHash("sha256"), sha512: createHash("sha512") };
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    assert.ok(size <= metadata.size, "Published daemon exceeds the qualified byte length.");
    hashes.sha256.update(chunk);
    hashes.sha512.update(chunk);
  }
  assert.equal(size, metadata.size);
  assert.equal(hashes.sha256.digest("hex"), metadata.sha256);
  assert.equal(`sha512-${hashes.sha512.digest("base64")}`, metadata.integrity);
  return {
    version,
    registry,
    sha256: metadata.sha256,
    integrity: metadata.integrity,
    size,
    verified_at: new Date().toISOString(),
    scope: "Public exact-version bytes; no installation or live-provider acceptance.",
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const source = readFileSync(
      new URL("../../apps/web/src/components/ConnectNodeDialog.tsx", import.meta.url),
      "utf8",
    );
    const receipt = await verifyDaemonRegistry(connectVersion(source));
    if (process.env.DAEMON_REGISTRY_EVIDENCE) {
      const path = resolve(process.env.DAEMON_REGISTRY_EVIDENCE);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
    }
    console.log(`Official npm bytes match the qualified daemon ${receipt.version} (${receipt.sha256}).`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
