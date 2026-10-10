#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Apple requires Xcode 26+ and the iOS/iPadOS 26+ SDK for uploads since
// 2026-04-28: https://developer.apple.com/news/upcoming-requirements/
export function verifyReleaseToolchain({ xcode, iphoneos, iphonesimulator }) {
  const match = /^Xcode (\d+(?:\.\d+){0,2})\r?$/m.exec(xcode);
  assert.ok(match, "Cannot identify the selected Xcode version");
  assert.ok(Number(match[1].split(".")[0]) >= 26, "Release verification requires Xcode 26 or later");
  for (const [name, value] of Object.entries({ iphoneos, iphonesimulator })) {
    assert.match(value, /^\d+(?:\.\d+){0,2}$/, `Cannot identify the ${name} SDK version`);
    assert.ok(Number(value.split(".")[0]) >= 26, `Release verification requires ${name} SDK 26 or later`);
  }
  return { xcode: match[1], iphoneos, iphonesimulator };
}

export function readReleaseToolchain() {
  function read(command, args) {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });
    assert.ok(!result.error && result.status === 0, `Cannot inspect ${command} ${args.join(" ")}`);
    return result.stdout.trim();
  }
  return verifyReleaseToolchain({
    xcode: read("xcodebuild", ["-version"]),
    iphoneos: read("xcrun", ["--sdk", "iphoneos", "--show-sdk-version"]),
    iphonesimulator: read("xcrun", ["--sdk", "iphonesimulator", "--show-sdk-version"]),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify({ passed: true, scope: "Release toolchain minimum versions only", ...readReleaseToolchain() }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
