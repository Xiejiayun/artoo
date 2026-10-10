import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyReleaseUIResult } from "./release-ui.mjs";
import { nativeReleaseImages } from "../../../scripts/e2e-report.mjs";

const summary = { result: "Passed", totalTestCount: 1, passedTests: 1, failedTests: 0,
  skippedTests: 0, expectedFailures: 0, testFailures: [] };
const node = { nodeType: "Test Case", nodeIdentifier: "ReleaseReadinessUITests/testPublisherPolicyAndSupportBeforePairing()", result: "Passed" };
const tests = { testNodes: [{ nodeType: "Test Plan", children: [node] }] };
const photos = nativeReleaseImages.map((caption) => ({ caption }));

test("requires the exact release case and all four original screenshots", () => {
  assert.doesNotThrow(() => verifyReleaseUIResult(summary, tests, photos));
  for (const missing of nativeReleaseImages) assert.throws(() => verifyReleaseUIResult(summary, tests, photos.filter((p) => p.caption !== missing)));
  assert.throws(() => verifyReleaseUIResult(summary, tests, [...photos, photos[0]]));
});

test("cannot accept skipped, failed, unexpected or repeated native cases", () => {
  for (const patch of [{ result: "Failed" }, { passedTests: 0 }, { skippedTests: 1 }, { expectedFailures: 1 }, { testFailures: [{}] }]) {
    assert.throws(() => verifyReleaseUIResult({ ...summary, ...patch }, tests, photos));
  }
  for (const children of [[{ ...node, nodeIdentifier: "Other/testOther()" }], [node, node], [node, { nodeType: "Failure Message" }]]) {
    assert.throws(() => verifyReleaseUIResult(summary, { testNodes: children }, photos));
  }
});
