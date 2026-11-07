import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseUIPhaseDiagnostic, verifyReleaseUIResult } from "./release-ui.mjs";
import { nativeReleaseImages } from "../../../scripts/e2e-report.mjs";

const summary = { result: "Passed", totalTestCount: 1, passedTests: 1, failedTests: 0,
  skippedTests: 0, expectedFailures: 0, testFailures: [] };
const node = { nodeType: "Test Case", nodeIdentifier: "ReleaseReadinessUITests/testPublisherPolicyAndSupportBeforePairing()", result: "Passed" };
const tests = { testNodes: [{ nodeType: "Test Plan", children: [node] }] };
const photos = nativeReleaseImages.map((caption) => ({ caption }));

test("a zero command exit cannot hide the cleanup failure stage and retry evidence in phase logs", () => {
  const query = { budgetMs: 5000, maxAttempts: 2, attempts: 2, timeouts: 2, elapsedMs: 2000, budgetExhausted: false };
  const entry = { name: "ipad-boot-ready", passed: false, exit_code: 0, process_cleanup: {
    closed: false, elapsedMs: 2001, error: { stage: "self-group", code: "ETIMEDOUT", message: "Retained detailed error" }, selfGroupQuery: query } };
  assert.deepEqual(JSON.parse(JSON.stringify(releaseUIPhaseDiagnostic(entry))), { phase: "ipad-boot-ready", passed: false, exit: 0,
    process_cleanup: { closed: false, elapsedMs: 2001, stage: "self-group", code: "ETIMEDOUT", selfGroupQuery: query } });
  assert.equal(entry.passed, false, "Diagnostic projection cannot alter the gate outcome");
});

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
