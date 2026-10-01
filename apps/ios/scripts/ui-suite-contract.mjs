const TARGETS = { core: "ArtooUITests/SharedServerChatUITests", assistant: "ArtooUITests/AssistantConversationUITests", mentions: "ArtooUITests/MentionsUITests", correction: "ArtooUITests/ExecutionCorrectionUITests" };
const METHODS = Object.freeze({
  core: Object.freeze([
    "testApprovalNeedsMoreInfoSurvivesRelaunchAndCanBeApproved",
    "testDaemonPresenceFollowsRealNodeConnection",
    "testGoalCancellationRequiresConfirmationAndKeepGoalDoesNotMutateServer",
    "testGoalDiscussionRequiresHumanAcceptanceToCreateDependentTasks",
    "testMemberDeviceRevocationRequiresFreshPairingAfterRelaunch",
    "testPairSendThreadAndCatchUpWithAnotherClient",
    "testTaskExecutionApprovalArtifactPreviewAndAcceptance",
  ]),
  assistant: Object.freeze(["testDirectAgentConversationAndRecovery"]),
  mentions: Object.freeze(["testCrossProjectHistoricalMentionReadRetryAndDraftIsolation"]),
  correction: Object.freeze(["testTaskCorrectionRetainsWorkAndConfirmsExactStop"]),
});
const STATUS = { Passed: "passed", Failed: "failed", Skipped: "skipped", "Expected Failure": "expected_failures" };
const SUMMARY_COUNTS = { total: "totalTestCount", passed: "passedTests", failed: "failedTests", skipped: "skippedTests", expected_failures: "expectedFailures" };
const emptyCounts = () => ({ total: 0, passed: 0, failed: 0, skipped: 0, expected_failures: 0, unknown: 0 });

/** Exact selections only. `all` produces separate invocations, not one
 * longer Xcode run. Callers must also isolate fixtures, xcresults and reports. */
export function selectUISuites(selection) {
  if (!["core", "assistant", "mentions", "correction", "all"].includes(selection)) throw new Error("UI suite must be exactly core, assistant, mentions, correction or all");
  return (selection === "all" ? ["core", "assistant", "mentions", "correction"] : [selection]).map((suite) => {
    const expected_case_ids = METHODS[suite].map((method) => `${TARGETS[suite]}/${method}`);
    return { suite, expected_case_ids, only_testing_arguments: expected_case_ids.map((id) => `-only-testing:${id}`) };
  });
}

function sourceIdentity(source, issues) {
  if (typeof source?.commit !== "string" || !/^[a-f0-9]{40}$/.test(source.commit)
      || typeof source?.tracked_diff_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.tracked_diff_sha256)
      || typeof source?.untracked_source_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.untracked_source_sha256)
      || source?.untracked_source_complete !== true
      || !Number.isSafeInteger(source?.untracked_source_files) || source.untracked_source_files < 0
      || typeof source?.working_tree_dirty !== "boolean") {
    issues.push("Complete source commit, tracked diff and untracked source fingerprints are required");
    return null;
  }
  // Branch names and artifact-only dirtiness do not change source content.
  return { commit: source.commit, tracked_diff_sha256: source.tracked_diff_sha256,
    untracked_source_sha256: source.untracked_source_sha256,
    untracked_source_complete: true, untracked_source_files: source.untracked_source_files };
}

function inspectSuite(input) {
  if (!["core", "assistant", "mentions", "correction"].includes(input?.suite)) throw new Error("Each xcresult must identify its core, assistant, mentions or correction suite");
  const { suite, tests, summary } = input;
  const { expected_case_ids } = selectUISuites(suite)[0];
  const issues = [], cases = [], counts = emptyCounts();
  const source = sourceIdentity(input.source, issues);
  if (typeof input.result_bundle !== "string" || !input.result_bundle.endsWith(".xcresult")) issues.push("A retained xcresult bundle path is required");
  function visit(nodes, bundle) {
    if (!Array.isArray(nodes)) { issues.push("xcresult testNodes/children must be arrays"); return; }
    for (const node of nodes) {
      if (!node || typeof node.name !== "string") { issues.push("Malformed xcresult test node"); continue; }
      const kind = node.nodeType;
      const target = ["UI test bundle", "Unit test bundle"].includes(kind) ? node.name : bundle;
      if (kind === "Test Case") {
        const match = /^([A-Za-z_]\w*)\/(test\w+)\(\)$/.exec(node.nodeIdentifier ?? "");
        const url = /^test:\/\/com\.apple\.xcode\/[^/]+\/([^/]+)\/([^/]+)\/([^/?#]+)$/.exec(node.nodeIdentifierURL ?? "");
        if (!match || !url || !target || url[1] !== target || url[2] !== match[1]
            || url[3] !== match[2] || node.name !== `${match[2]}()`) {
          issues.push("Test case ID, URL, name and enclosing target must agree");
        } else {
          const status = Object.hasOwn(STATUS, node.result) ? STATUS[node.result] : "unknown";
          cases.push({ id: `${target}/${match[1]}/${match[2]}`, status });
          counts.total += 1; counts[status] += 1;
        }
      } else if (kind === "Failure Message") {
        issues.push("xcresult contains a failure message");
      } else if (!["Test Plan", "UI test bundle", "Test Suite", "Runtime Warning", "Source Code Reference", "Attachment", "Expression", "Test Value"].includes(kind)) {
        // Repetitions and Test Case Run nodes need explicit attempt accounting;
        // do not collapse a failed attempt into a final Passed case.
        issues.push("Unsupported xcresult node type or repeated execution");
      }
      if (["Test Plan", "UI test bundle", "Test Suite"].includes(kind) && node.result !== "Passed") issues.push("An enclosing test plan, bundle or suite is not Passed");
      if (node.children !== undefined) visit(node.children, target);
    }
  }
  visit(tests?.testNodes);
  const actual_case_ids = cases.map(({ id }) => id).sort();
  const missing_case_ids = expected_case_ids.filter((id) => !actual_case_ids.includes(id));
  const unexpected_case_ids = [...new Set(actual_case_ids.filter((id) => !expected_case_ids.includes(id)))];
  const duplicate_case_ids = [...new Set(actual_case_ids.filter((id, index) => actual_case_ids.indexOf(id) !== index))];
  if (missing_case_ids.length) issues.push("Expected test cases are missing");
  if (unexpected_case_ids.length) issues.push("Unexpected test cases ran");
  if (duplicate_case_ids.length) issues.push("Test cases ran more than once");
  if (counts.passed !== counts.total) issues.push("Every selected test case must pass without skips or expected failures");
  if (summary?.result !== "Passed") issues.push("xcresult summary is not Passed");
  for (const [key, field] of Object.entries(SUMMARY_COUNTS)) {
    if (!Number.isSafeInteger(summary?.[field]) || summary[field] < 0 || summary[field] !== counts[key]) issues.push(`xcresult summary ${field} disagrees with test cases`);
  }
  if (!Array.isArray(summary?.testFailures) || summary.testFailures.length) issues.push("xcresult summary must contain no test failures");
  const configuration = summary?.devicesAndConfigurations?.[0];
  if (!Array.isArray(tests?.devices) || tests.devices.length !== 1 || !tests.devices[0]?.deviceId
      || !Array.isArray(tests?.testPlanConfigurations) || tests.testPlanConfigurations.length !== 1 || !tests.testPlanConfigurations[0]?.configurationId
      || !Array.isArray(summary?.devicesAndConfigurations) || summary.devicesAndConfigurations.length !== 1
      || configuration?.device?.deviceId !== tests.devices[0].deviceId
      || configuration?.testPlanConfiguration?.configurationId !== tests.testPlanConfigurations[0].configurationId) {
    issues.push("Tests and summary must describe the same single device and configuration");
  } else {
    for (const [key, field] of Object.entries(SUMMARY_COUNTS).filter(([key]) => key !== "total")) {
      if (configuration[field] !== counts[key]) issues.push(`Device/configuration ${field} disagrees with test cases`);
    }
  }
  return { suite, source, result_bundle: input.result_bundle, expected_case_ids, actual_case_ids, cases, counts,
    missing_case_ids, unexpected_case_ids, duplicate_case_ids, issues, passed: issues.length === 0 };
}

/** Pure verification of `xcresulttool get test-results tests/summary` JSON
 * (schema 0.1.0). Retrieve both exports from the same retained bundle. xcresult
 * has no Git identity: the caller must supply getE2EReportContext().source
 * captured for the actual build/run. This helper does not discover provenance,
 * launch tests, certify screenshots/cleanup, or implement the assistant case.
 * Pass every attempt; duplicates fail rather than silently selecting a pass. */
export function verifyUISuiteResults({ selection, results }) {
  const selected = selectUISuites(selection);
  if (!Array.isArray(results)) throw new Error("UI suite results must be an array");
  const suites = results.map(inspectSuite), issues = [], counts = emptyCounts();
  const expected_suites = selected.map(({ suite }) => suite);
  const actual_suites = suites.map(({ suite }) => suite);
  for (const suite of expected_suites) {
    if (actual_suites.filter((value) => value === suite).length !== 1) issues.push(`Exactly one ${suite} result is required`);
  }
  if (actual_suites.some((suite) => !expected_suites.includes(suite))) issues.push("Results contain an unselected suite");
  if (suites.some(({ passed }) => !passed)) issues.push("One or more suite contracts failed");
  const source = suites[0]?.source ?? null;
  if (!source || suites.some((suite) => JSON.stringify(suite.source) !== JSON.stringify(source))) issues.push("All suite results must have matching complete source fingerprints");
  if (new Set(suites.map(({ result_bundle }) => result_bundle)).size !== suites.length) issues.push("Each suite attempt must retain its own xcresult bundle");
  for (const suite of suites) for (const key of Object.keys(counts)) counts[key] += suite.counts[key];
  return { selection, expected_suites, actual_suites, source,
    expected_case_ids: selected.flatMap(({ expected_case_ids }) => expected_case_ids),
    actual_case_ids: suites.flatMap(({ actual_case_ids }) => actual_case_ids), counts, suites, issues, passed: issues.length === 0 };
}
