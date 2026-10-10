import assert from "node:assert/strict";

/** A successful xcodebuild invocation may still select zero tests. */
export function verifyNativeSingleCase(summary, tests, { caseId, deviceId }) {
  assert.equal(summary?.result, "Passed", "Native summary must pass");
  assert.equal(summary.totalTestCount, 1, "Exactly one requested native case must run");
  assert.equal(summary.passedTests, 1);
  for (const key of ["failedTests", "skippedTests", "expectedFailures"]) assert.equal(summary[key], 0, `Native ${key} must be zero`);
  assert.deepEqual(summary.testFailures ?? [], []);
  assert.equal(summary.devicesAndConfigurations?.length, 1);
  const configuration = summary.devicesAndConfigurations[0];
  assert.equal(configuration.device?.deviceId, deviceId, "Summary must identify the owned simulator");
  assert.equal(configuration.passedTests, 1);
  for (const key of ["failedTests", "skippedTests", "expectedFailures"]) assert.equal(configuration[key], 0);
  assert.equal(tests?.devices?.length, 1); assert.equal(tests.devices[0].deviceId, deviceId);
  const cases = [];
  function visit(node) {
    assert.ok(node && typeof node === "object");
    if (node.nodeType === "Test Case") cases.push(node);
    if (node.children !== undefined) { assert.ok(Array.isArray(node.children)); node.children.forEach(visit); }
  }
  assert.ok(Array.isArray(tests.testNodes)); tests.testNodes.forEach(visit);
  assert.equal(cases.length, 1); assert.equal(cases[0].nodeIdentifier, caseId);
  assert.equal(cases[0].result, "Passed");
  assert.ok(Number.isFinite(cases[0].durationInSeconds) && cases[0].durationInSeconds > 0);
  return { passed: true, case_id: caseId, device_id: deviceId, duration_seconds: cases[0].durationInSeconds };
}

export function verifyNativePhotos(photos, expectedNames) {
  assert.equal(photos.length, expectedNames.length, "All required native workflow photographs must be exported");
  for (const name of expectedNames) assert.equal(photos.filter((photo) => photo.caption === name || photo.caption.startsWith(name + "_")).length, 1, `Missing or duplicate native photograph: ${name}`);
  return { passed: true, count: photos.length, expected: expectedNames };
}
