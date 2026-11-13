import assert from "node:assert/strict";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { chromium } from "playwright";

import { laneNames } from "../ci-vitest-coverage.mjs";

// Observe the effective Playwright cache without creating, deleting or replacing it.
// These records supplement actual Vitest results; an empty cache is not a test pass.
const [phase, output, ...extra] = process.argv.slice(2);
assert.ok(
  ["before", "after"].includes(phase) && output && !extra.length,
  "Usage: ci-vitest-browser-cache.mjs before|after <lane-output-directory>",
);
assert.equal(process.platform, "win32", "Browserless Vitest evidence requires Windows");
const metadata = JSON.parse(readFileSync(resolve(output, "metadata.json"), "utf8"));
assert.equal(metadata.version, 1);
assert.ok(laneNames.includes(metadata.lane));
assert.equal(metadata.platform, process.platform);
assert.equal(metadata.root, process.cwd());
assert.match(process.env.GITHUB_SHA ?? "", /^[a-f0-9]{40}$/);
assert.equal(metadata.commit, process.env.GITHUB_SHA);
const configured = process.env.PLAYWRIGHT_BROWSERS_PATH;
assert.ok(configured && isAbsolute(configured), "An explicit absolute browser cache path is required");
const cache = resolve(configured),
  executable = chromium.executablePath();
const within = relative(cache, executable);
assert.ok(
  within && !isAbsolute(within) && within !== ".." && !within.startsWith(`..${sep}`),
  "Playwright must resolve Chromium inside the isolated cache",
);
function assertAbsent(path) {
  try {
    lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Browser path must remain absent: ${path}`);
}
assertAbsent(cache);
assertAbsent(executable);
const record = {
  version: 1,
  phase,
  lane: metadata.lane,
  commit: metadata.commit,
  platform: process.platform,
  node: process.version,
  cache,
  chromium: executable,
  cache_absent: true,
  executable_absent: true,
};
if (phase === "after") {
  const before = JSON.parse(readFileSync(resolve(output, "browser-cache-before.json"), "utf8"));
  assert.deepEqual(before, { ...record, phase: "before" }, "Browser cache evidence changed during the lane");
}
writeFileSync(resolve(output, `browser-cache-${phase}.json`), JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify(record, null, 2));
