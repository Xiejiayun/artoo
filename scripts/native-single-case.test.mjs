import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyNativeSingleCase, verifyNativePhotos } from "./native-single-case.mjs";
const configuration = { device: { deviceId: "owned" }, passedTests: 1, failedTests: 0, skippedTests: 0, expectedFailures: 0 };
function fixture() { return { summary: { result: "Passed", totalTestCount: 1, passedTests: 1, failedTests: 0, skippedTests: 0, expectedFailures: 0, devicesAndConfigurations: [structuredClone(configuration)], testFailures: [] },
  tests: { devices: [{ deviceId: "owned" }], testNodes: [{ nodeType: "Test Plan", children: [{ nodeType: "Test Case", nodeIdentifier: "Suite/testFlow()", result: "Passed", durationInSeconds: 15 }] }] } }; }
const options = { caseId: "Suite/testFlow()", deviceId: "owned" };
test("accepts exactly the requested passed case and owned device", () => { const { summary, tests } = fixture(); assert.equal(verifyNativeSingleCase(summary, tests, options).passed, true); });
for (const kind of ["zero", "wrong-case", "wrong-device", "failed", "skipped", "duplicate", "expected-failure"]) test(`refuses ${kind} qualification`, () => {
  const { summary, tests } = fixture();
  if (kind === "zero") { summary.totalTestCount = 0; summary.passedTests = 0; tests.testNodes = []; }
  if (kind === "wrong-case") tests.testNodes[0].children[0].nodeIdentifier = "Other/testFlow()";
  if (kind === "wrong-device") tests.devices[0].deviceId = "unrelated";
  if (kind === "failed") tests.testNodes[0].children[0].result = "Failed";
  if (kind === "skipped") summary.skippedTests = 1;
  if (kind === "expected-failure") summary.expectedFailures = 1;
  if (kind === "duplicate") tests.testNodes.push(structuredClone(tests.testNodes[0]));
  assert.throws(() => verifyNativeSingleCase(summary, tests, options));
});
test("requires every named capture once, not just a nonempty image list", () => {
  assert.equal(verifyNativePhotos([{ caption: "A_0_id" }, { caption: "B_0_id" }], ["A", "B"]).count, 2);
  assert.throws(() => verifyNativePhotos([{ caption: "A_0_id" }], ["A", "B"]));
  assert.throws(() => verifyNativePhotos([{ caption: "A_0_id" }, { caption: "A_1_id" }], ["A", "B"]));
});
