import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { expectedNativeScreenshots } from "./e2e-report.mjs";
import { loadNativeSuiteEvidence } from "./ios-ui-suite-evidence.mjs";

// Reduced xcresult shape; these files are evidence-validator unit fixtures,
// never native execution or actual client screenshots.
function attempt(suite = "assistant") {
  const directory = mkdtempSync(join(tmpdir(), "artoo-suite-evidence-"));
  const source = { commit: "a".repeat(40), tracked_diff_sha256: "b".repeat(64),
    untracked_source_sha256: "c".repeat(64), untracked_source_files: 0,
    untracked_source_complete: true, working_tree_dirty: false };
  const parent = { suite, source, passed: true, finished_at: new Date().toISOString(),
    cleanup: { resources_closed: true, temporary_directory_removed: true }, html_report: join(directory, "parent.html") };
  const native = { suite, source: { ...source }, source_at_finish: { ...source }, source_stable: true, passed: true, finished_at: parent.finished_at,
    contract: { selection: suite, passed: true }, screenshots: { count: expectedNativeScreenshots(suite).length, missing: [] },
    result_bundle: join(directory, "result.xcresult"), html_report: join(directory, "native.html"),
    attachments_directory: join(directory, "ui-attachments"),
    xcresult_tests: join(directory, "diagnostics/xcresult-tests.json"), xcresult_summary: join(directory, "diagnostics/xcresult-summary.json") };
  const device = { deviceId: "unit-fixture" }, configuration = { configurationId: "1" };
  const counts = { passedTests: 1, failedTests: 0, skippedTests: 0, expectedFailures: 0 };
  const method = suite === "mentions" ? "testCrossProjectHistoricalMentionReadRetryAndDraftIsolation" : "testDirectAgentConversationAndRecovery";
  const className = suite === "mentions" ? "MentionsUITests" : "AssistantConversationUITests";
  const testCase = { nodeType: "Test Case", name: `${method}()`, result: "Passed",
    nodeIdentifier: `${className}/${method}()`,
    nodeIdentifierURL: `test://com.apple.xcode/Artoo/ArtooUITests/${className}/${method}` };
  const tests = { devices: [device], testPlanConfigurations: [configuration], testNodes: [
    { name: "ArtooUI", nodeType: "Test Plan", result: "Passed", children: [
      { name: "ArtooUITests", nodeType: "UI test bundle", result: "Passed", children: [
        { name: className, nodeType: "Test Suite", result: "Passed", children: [testCase] },
      ] },
    ] },
  ] };
  const summary = { result: "Passed", totalTestCount: 1, ...counts, testFailures: [],
    devicesAndConfigurations: [{ device, testPlanConfiguration: configuration, ...counts }] };
  mkdirSync(join(directory, "diagnostics")); mkdirSync(native.result_bundle);
  mkdirSync(native.attachments_directory);
  const images = expectedNativeScreenshots(suite).map((name, i) => ({ name, exportedFileName: `${i}.png` }));
  writeFileSync(join(native.attachments_directory, "manifest.json"), JSON.stringify(images));
  for (const image of images) writeFileSync(join(native.attachments_directory, image.exportedFileName),
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8KuTxn4GBgYGJAQoAI8UCUpBcPuMAAAAASUVORK5CYII=", "base64"));
  for (const path of [parent.html_report, native.html_report]) writeFileSync(path, "Unit fixture only");
  if (suite === "mentions") {
    parent.mentions = { passed: true };
    parent.peer_screenshots = ["mentions-peer-first.png", "mentions-peer-second.png"].map((name) => ({ path: join(directory, name), caption: `Independent sender browser: ${name}` }));
    for (const image of parent.peer_screenshots) writeFileSync(image.path,
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8KuTxn4GBgYGJAQoAI8UCUpBcPuMAAAAASUVORK5CYII=", "base64"));
  }
  const save = () => {
    for (const [name, value] of [["suite-result.json", parent], ["xctest-result.json", native],
      ["diagnostics/xcresult-tests.json", tests], ["diagnostics/xcresult-summary.json", summary]]) {
      writeFileSync(join(directory, name), JSON.stringify(value));
    }
  };
  return { directory, parent, native, tests, testCase, summary, save, close: () => rmSync(directory, { recursive: true, force: true }) };
}

test("one finalized matching assistant attempt retains its exact subset identity", () => {
  const fixture = attempt();
  try { fixture.save(); const result = loadNativeSuiteEvidence(fixture.directory, "assistant");
    assert.equal(result.contract.passed, true); assert.equal(result.contract.counts.total, 1);
    assert.equal(result.input.source.commit, fixture.parent.source.commit);
  } finally { fixture.close(); }
});

test("mentions retains its exact subset with nine native and two complete independent peer images", () => {
  const fixture = attempt("mentions");
  try { fixture.save(); assert.equal(loadNativeSuiteEvidence(fixture.directory, "mentions").contract.passed, true); }
  finally { fixture.close(); }
});

for (const [name, mutate] of [
  ["missing peer declaration", (f) => { delete f.parent.peer_screenshots; }],
  ["duplicate peer image", (f) => { f.parent.peer_screenshots[1] = f.parent.peer_screenshots[0]; }],
  ["missing peer file", (f) => rmSync(f.parent.peer_screenshots[0].path)],
  ["empty peer file", (f) => writeFileSync(f.parent.peer_screenshots[0].path, Buffer.alloc(0))],
  ["unreviewed peer caption", (f) => { f.parent.peer_screenshots[0].caption = "Pairing credentials"; }],
  ["failed production verifier", (f) => { f.parent.mentions.passed = false; }],
]) test(`mentions refuses ${name}`, () => {
  const f = attempt("mentions");
  try { mutate(f); f.save(); assert.throws(() => loadNativeSuiteEvidence(f.directory, "mentions")); }
  finally { f.close(); }
});

for (const [name, mutate] of [
  ["unfinished parent", (f) => { delete f.parent.finished_at; }],
  ["failed parent despite green XCTest", (f) => { f.parent.passed = false; }],
  ["failed XCTest despite green parent", (f) => { f.native.passed = false; }],
  ["failed resource cleanup", (f) => { f.parent.cleanup.resources_closed = false; }],
  ["failed temporary credential cleanup", (f) => { f.parent.cleanup.temporary_directory_removed = false; }],
  ["another failed cleanup field", (f) => { f.parent.cleanup.child_closed = false; }],
  ["removed screenshot manifest", (f) => { rmSync(join(f.native.attachments_directory, "manifest.json")); }],
  ["removed selected screenshot", (f) => { rmSync(join(f.native.attachments_directory, "0.png")); }],
  ["empty selected screenshot", (f) => { writeFileSync(join(f.native.attachments_directory, "0.png"), Buffer.alloc(0)); }],
  ["truncated selected screenshot", (f) => { writeFileSync(join(f.native.attachments_directory, "0.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])); }],
  ["directory masquerading as selected screenshot", (f) => { const path = join(f.native.attachments_directory, "0.png"); rmSync(path); mkdirSync(path); }],
  ["partial screenshot export", (f) => { f.native.screenshots.missing = ["required workflow"]; }],
  ["missing end-of-run source check", (f) => { delete f.native.source_stable; }],
  ["changed end-of-run source", (f) => { f.native.source_at_finish.commit = "e".repeat(40); }],
  ["source drift after parent start", (f) => { f.native.source.commit = "d".repeat(40); }],
  ["stale bundle from another attempt", (f) => { f.native.result_bundle = join(tmpdir(), "old.xcresult"); }],
  ["stale raw export path", (f) => { f.native.xcresult_tests = join(tmpdir(), "old-tests.json"); }],
  ["wrong selected suite", (f) => { f.native.suite = "core"; }],
  ["summary contradicts a green child contract", (f) => { f.summary.passedTests = 0; }],
  ["skipped case behind a green child contract", (f) => { f.testCase.result = "Skipped"; }],
]) {
  test(`refuses ${name}`, () => {
    const fixture = attempt();
    try { mutate(fixture); fixture.save(); assert.throws(() => loadNativeSuiteEvidence(fixture.directory, "assistant")); }
    finally { fixture.close(); }
  });
}
