import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyReleaseToolchain } from "./release-toolchain.mjs";

const current = { xcode: "Xcode 26.5\nBuild version 17F42", iphoneos: "26.5", iphonesimulator: "26.5" };

test("accepts the upload minimum and newer SDKs independently of deployment target", () => {
  assert.equal(verifyReleaseToolchain(current).xcode, "26.5");
  assert.equal(verifyReleaseToolchain({ xcode: "Xcode 26.0\nBuild version 17A324", iphoneos: "26.0", iphonesimulator: "26.0" }).iphoneos, "26.0");
});

test("rejects the old hosted Xcode even when a newer runtime is installed", () => {
  assert.throws(() => verifyReleaseToolchain({ ...current, xcode: "Xcode 16.4\nBuild version 16F6" }), /Xcode 26/);
});

test("requires both the device and simulator SDK, not just the Xcode label", () => {
  for (const key of ["iphoneos", "iphonesimulator"]) {
    assert.throws(() => verifyReleaseToolchain({ ...current, [key]: "18.5" }), /SDK 26/);
    assert.throws(() => verifyReleaseToolchain({ ...current, [key]: "26.invalid" }), /Cannot identify/);
  }
  assert.throws(() => verifyReleaseToolchain({ ...current, xcode: "unknown" }), /Cannot identify/);
});
