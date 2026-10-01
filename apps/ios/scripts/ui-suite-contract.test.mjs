import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { selectUISuites, verifyUISuiteResults } from "./ui-suite-contract.mjs";

// Reduced tests/summary shape observed with xcresulttool schema 0.1.0 in the
// completed ArtooUI-1790799985524.xcresult. These are parser fixtures, not a new
// native run or evidence that a client workflow passed.
const core = [
  "testApprovalNeedsMoreInfoSurvivesRelaunchAndCanBeApproved",
  "testDaemonPresenceFollowsRealNodeConnection",
  "testGoalCancellationRequiresConfirmationAndKeepGoalDoesNotMutateServer",
  "testGoalDiscussionRequiresHumanAcceptanceToCreateDependentTasks",
  "testMemberDeviceRevocationRequiresFreshPairingAfterRelaunch",
  "testPairSendThreadAndCatchUpWithAnotherClient",
  "testTaskExecutionApprovalArtifactPreviewAndAcceptance",
];
const assistant = ["testDirectAgentConversationAndRecovery"];
const mentions = ["testCrossProjectHistoricalMentionReadRetryAndDraftIsolation"];
const correction = ["testTaskCorrectionRetainsWorkAndConfirmsExactStop"];
const id = (method) => `ArtooUITests/${correction.includes(method) ? "ExecutionCorrectionUITests" : mentions.includes(method) ? "MentionsUITests" : assistant.includes(method) ? "AssistantConversationUITests" : "SharedServerChatUITests"}/${method}`;
const source = { commit: "a".repeat(40), branch: "main", working_tree_dirty: true,
  tracked_diff_sha256: "b".repeat(64), untracked_source_sha256: "c".repeat(64),
  untracked_source_complete: true, untracked_source_files: 2 };
function sample(suite = "core", methods = { core, assistant, mentions, correction }[suite], statuses = {}) {
  const className = { core: "SharedServerChatUITests", assistant: "AssistantConversationUITests", mentions: "MentionsUITests", correction: "ExecutionCorrectionUITests" }[suite];
  const children = methods.map((method) => ({ name: `${method}()`, nodeType: "Test Case",
    nodeIdentifier: `${className}/${method}()`,
    nodeIdentifierURL: `test://com.apple.xcode/Artoo/ArtooUITests/${className}/${method}`,
    result: statuses[method] ?? "Passed" }));
  const count = (status) => children.filter((node) => node.result === status).length;
  const counts = { passedTests: count("Passed"), failedTests: count("Failed"), skippedTests: count("Skipped"), expectedFailures: count("Expected Failure") };
  const device = { deviceId: "fixture-simulator" }, configuration = { configurationId: "1" };
  return { suite, source: { ...source }, result_bundle: `/retained/${suite}-attempt-1.xcresult`,
    tests: { devices: [device], testPlanConfigurations: [configuration], testNodes: [{ name: "ArtooUI", nodeType: "Test Plan", result: "Passed", children: [
      { name: "ArtooUITests", nodeType: "UI test bundle", result: "Passed", children: [
        { name: className, nodeType: "Test Suite", result: "Passed", children },
      ] },
    ] }] },
    summary: { result: counts.failedTests ? "Failed" : "Passed", totalTestCount: children.length, ...counts, testFailures: [],
      devicesAndConfigurations: [{ device, testPlanConfiguration: configuration, ...counts }] } };
}
const caseNodes = (input) => input.tests.testNodes[0].children[0].children[0].children;
const verify = (input) => verifyUISuiteResults({ selection: input.suite, results: [input] });

test("exact core/assistant/mentions/correction/all selections generate separate method-level invocations", () => {
  assert.deepEqual(selectUISuites("core")[0].expected_case_ids, core.map(id));
  assert.deepEqual(selectUISuites("assistant")[0].only_testing_arguments, [`-only-testing:${id(assistant[0])}`]);
  assert.deepEqual(selectUISuites("mentions")[0].only_testing_arguments, [`-only-testing:${id(mentions[0])}`]);
  assert.deepEqual(selectUISuites("all").map(({ suite }) => suite), ["core", "assistant", "mentions", "correction"]);
  assert.ok(selectUISuites("all").every((suite) => suite.only_testing_arguments.every((arg) => /^-only-testing:ArtooUITests\/(?:SharedServerChatUITests|AssistantConversationUITests|MentionsUITests|ExecutionCorrectionUITests)\/test\w+$/.test(arg))));
  for (const selection of [undefined, null, "", " core", "CORE", "core,assistant", "--suite=core", "constructor", ["core"]]) {
    assert.throws(() => selectUISuites(selection), /exactly core, assistant, mentions, correction or all/);
  }
  selectUISuites("core")[0].expected_case_ids.pop();
  assert.equal(selectUISuites("core")[0].expected_case_ids.length, 7);
});

test("the core contract names every current core XCTest method exactly", () => {
  const swift = readFileSync(new URL("../UITests/SharedServerChatUITests.swift", import.meta.url), "utf8");
  const methods = [...swift.matchAll(/^\s+func (test\w+)\(/gm)].map((match) => match[1]).filter((method) => !assistant.includes(method)).sort();
  assert.deepEqual(methods, core);
});

test("the assistant contract names its independent XCTest class exactly", () => {
  const swift = readFileSync(new URL("../UITests/AssistantConversationUITests.swift", import.meta.url), "utf8");
  assert.match(swift, /final class AssistantConversationUITests: XCTestCase/);
  const methods = [...swift.matchAll(/^\s+func (test\w+)\(/gm)].map((match) => match[1]).sort();
  assert.deepEqual(methods, assistant);
});

test("the mentions contract names its independent XCTest class exactly", () => {
  const swift = readFileSync(new URL("../UITests/MentionsUITests.swift", import.meta.url), "utf8");
  assert.match(swift, /final class MentionsUITests: XCTestCase/);
  assert.deepEqual([...swift.matchAll(/^\s+func (test\w+)\(/gm)].map((match) => match[1]).sort(), mentions);
});

test("correction requires its own exact case and cannot disappear from the full gate", () => {
  const swift = readFileSync(new URL("../UITests/ExecutionCorrectionUITests.swift", import.meta.url), "utf8");
  assert.match(swift, /final class ExecutionCorrectionUITests: XCTestCase/);
  assert.deepEqual([...swift.matchAll(/^\s+func (test\w+)\(/gm)].map((match) => match[1]).sort(), correction);
  assert.deepEqual(selectUISuites("correction")[0].only_testing_arguments, [`-only-testing:${id(correction[0])}`]);
  assert.equal(verify(sample("correction")).passed, true);
  assert.equal(verifyUISuiteResults({ selection: "all", results: [sample("core"), sample("assistant"), sample("mentions")] }).passed, false);
});

test("the observed seven-case export passes without counting diagnostic children", () => {
  const input = sample(), before = structuredClone(input);
  caseNodes(input)[4].children = [{ nodeType: "Runtime Warning", name: "Invalid frame dimension (negative or non-finite)." }];
  before.tests = structuredClone(input.tests);
  const result = verify(input);
  assert.equal(result.passed, true); assert.equal(result.selection, "core");
  assert.deepEqual(result.counts, { total: 7, passed: 7, failed: 0, skipped: 0, expected_failures: 0, unknown: 0 });
  assert.deepEqual(result.expected_case_ids, result.actual_case_ids);
  assert.deepEqual(input, before, "Verification must not rewrite evidence");
});

test("a historical six-case Passed summary cannot satisfy the seven-case contract", () => {
  const result = verify(sample("core", core.filter((method) => !method.includes("MemberDevice"))));
  assert.equal(result.passed, false);
  assert.deepEqual(result.suites[0].missing_case_ids, [id(core[4])]);
  assert.equal(result.counts.passed, 6);
});

test("extra and duplicate testcase identities fail even when every result is Passed", () => {
  const extra = verify(sample("core", [...core, "testUnexpectedScenario"]));
  assert.equal(extra.passed, false); assert.deepEqual(extra.suites[0].unexpected_case_ids, [id("testUnexpectedScenario")]);
  const duplicate = verify(sample("core", [...core, core[0]]));
  assert.equal(duplicate.passed, false); assert.deepEqual(duplicate.suites[0].duplicate_case_ids, [id(core[0])]);
});

test("failed, skipped, expected-failure and unknown results never count as all passed", () => {
  for (const [status, key] of [["Failed", "failed"], ["Skipped", "skipped"], ["Expected Failure", "expected_failures"], ["unknown", "unknown"], ["constructor", "unknown"]]) {
    const result = verify(sample("core", core, { [core[0]]: status }));
    assert.equal(result.passed, false, status); assert.equal(result.counts[key], 1, status);
  }
});

test("summary counts, summary status and hidden suite failures must agree with cases", () => {
  const mutations = [
    (input) => { input.summary.passedTests = 6; },
    (input) => { input.summary.totalTestCount = "7"; },
    (input) => { input.summary.skippedTests = -1; },
    (input) => { input.summary.result = "Failed"; },
    (input) => { input.summary.testFailures = [{ failureText: "PRIVATE_DIAGNOSTIC" }]; },
    (input) => { input.tests.testNodes[0].result = "Failed"; },
    (input) => { caseNodes(input)[0].children = [{ nodeType: "Failure Message", name: "PRIVATE_DIAGNOSTIC" }]; },
    (input) => { input.summary.devicesAndConfigurations[0].passedTests = 6; },
  ];
  for (const mutate of mutations) {
    const input = sample(); mutate(input); const result = verify(input);
    assert.equal(result.passed, false); assert.equal(JSON.stringify(result).includes("PRIVATE_DIAGNOSTIC"), false);
  }
});

test("test ID, URL, method name and actual target are all checked", () => {
  for (const [field, value] of [["nodeIdentifier", undefined], ["nodeIdentifier", `${id(core[0])}()`], ["nodeIdentifierURL", `test://com.apple.xcode/Artoo/AnotherTarget/SharedServerChatUITests/${core[0]}`], ["name", `${core[1]}()`]]) {
    const input = sample(); caseNodes(input)[0][field] = value;
    assert.equal(verify(input).passed, false, field);
  }
  const input = sample();
  input.tests.testNodes[0].children[0].name = "AnotherTarget";
  for (const node of caseNodes(input)) node.nodeIdentifierURL = node.nodeIdentifierURL.replace("/ArtooUITests/", "/AnotherTarget/");
  const result = verify(input);
  assert.equal(result.passed, false); assert.equal(result.suites[0].unexpected_case_ids.length, 7);
});

test("unsupported, repeated, malformed or mismatched execution metadata fails closed", () => {
  const mutations = [
    (input) => { input.tests.testNodes = undefined; },
    (input) => { input.tests.testNodes = []; },
    (input) => { caseNodes(input).push(null); },
    (input) => { caseNodes(input)[0].children = {}; },
    (input) => { caseNodes(input)[0].children = [{ nodeType: "Test Case Run", name: "Attempt 2", result: "Passed" }]; },
    (input) => { caseNodes(input)[0].children = [{ nodeType: "Repetition", name: "1", result: "Passed" }]; },
    (input) => { caseNodes(input).push({ nodeType: "Future Test Type", name: "Unexpected", result: "Passed" }); },
    (input) => { input.tests.devices = []; },
    (input) => { input.tests.devices.push({ deviceId: "another" }); },
    (input) => { input.summary.devicesAndConfigurations[0].device = { deviceId: "another" }; },
    (input) => { input.summary.devicesAndConfigurations[0].testPlanConfiguration = { configurationId: "another" }; },
    (input) => { input.summary.devicesAndConfigurations = []; },
    (input) => { input.result_bundle = undefined; },
  ];
  for (const mutate of mutations) { const input = sample(); mutate(input); assert.equal(verify(input).passed, false); }
});

test("complete source fingerprints are required even for a successful subset", () => {
  for (const patch of [{ commit: null }, { tracked_diff_sha256: "missing" }, { untracked_source_sha256: null }, { untracked_source_complete: false }, { untracked_source_files: -1 }, { working_tree_dirty: null }]) {
    const input = sample(); Object.assign(input.source, patch); assert.equal(verify(input).passed, false);
  }
});

test("assistant and mentions stay named subsets and all requires every independent suite", () => {
  const subset = verify(sample("assistant"));
  assert.equal(subset.passed, true); assert.equal(subset.selection, "assistant"); assert.equal(subset.counts.total, 1);
  assert.equal(verifyUISuiteResults({ selection: "all", results: [sample("assistant")] }).passed, false);
  assert.equal(verifyUISuiteResults({ selection: "core", results: [sample("core"), sample("assistant")] }).passed, false);
  assert.equal(verifyUISuiteResults({ selection: "all", results: [] }).passed, false);
  assert.equal(verify(sample("mentions")).passed, true);
  assert.equal(verifyUISuiteResults({ selection: "all", results: [sample("core"), sample("assistant")] }).passed, false);
  const result = verifyUISuiteResults({ selection: "all", results: [sample("core"), sample("assistant"), sample("mentions"), sample("correction")] });
  assert.equal(result.passed, true); assert.equal(result.counts.total, 10); assert.equal(result.suites.length, 4);
});

test("aggregation rejects source drift, reused bundles and duplicate attempts", () => {
  for (const field of ["commit", "tracked_diff_sha256", "untracked_source_sha256", "untracked_source_files"]) {
    const second = sample("assistant"); second.source[field] = field === "untracked_source_files" ? 3 : "d".repeat(field === "commit" ? 40 : 64);
    assert.equal(verifyUISuiteResults({ selection: "all", results: [sample(), second, sample("mentions"), sample("correction")] }).passed, false, field);
  }
  const second = sample("assistant"); second.result_bundle = sample().result_bundle;
  assert.equal(verifyUISuiteResults({ selection: "all", results: [sample(), second, sample("mentions"), sample("correction")] }).passed, false);
  const failedAttempt = sample("core", core, { [core[0]]: "Failed" }); failedAttempt.result_bundle = "/retained/core-attempt-0.xcresult";
  const attempts = verifyUISuiteResults({ selection: "all", results: [failedAttempt, sample(), sample("assistant"), sample("mentions"), sample("correction")] });
  assert.equal(attempts.passed, false); assert.equal(attempts.suites.length, 5, "A failed attempt must not disappear");
  const otherBranch = sample("assistant"); otherBranch.source.branch = "another-checkout"; otherBranch.source.working_tree_dirty = false;
  assert.equal(verifyUISuiteResults({ selection: "all", results: [sample(), otherBranch, sample("mentions"), sample("correction")] }).passed, true);
});

test("invalid API selections cannot silently fall back to core", () => {
  assert.throws(() => verifyUISuiteResults({ selection: "all", results: null }), /must be an array/);
  assert.throws(() => verifyUISuiteResults({ selection: "core", results: [{ suite: "all" }] }), /Each xcresult/);
  assert.throws(() => verifyUISuiteResults({ results: [] }), /exactly core, assistant, mentions, correction or all/);
});
