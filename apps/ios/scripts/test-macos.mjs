#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expectedNativeScreenshots, getE2EReportContext, readXCTestScreenshots, writeE2EReport } from "../../../scripts/e2e-report.mjs";
import { selectIPhoneSimulator } from "./simulator-selection.mjs";
import { selectUISuites, verifyUISuiteResults } from "./ui-suite-contract.mjs";

const ios = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseOutput = resolve(ios, "../../artifacts/ios");
const ui = process.argv.includes("--ui");
const uiSuite = process.argv.find((arg) => arg.startsWith("--suite="))?.slice(8) ?? "core";
const output = ui ? resolve(process.env.ARTOO_IOS_UI_OUTPUT_DIR ?? resolve(baseOutput, "attempts", `${new Date().toISOString().replace(/[:.]/g, "-")}-${uiSuite}`)) : baseOutput;
const resultJSON = ui ? resolve(process.env.ARTOO_IOS_UI_RESULT_JSON ?? resolve(output, "xctest-result.json")) : null;
if (ui && (!output.startsWith(`${baseOutput}${sep}`) || !resultJSON.startsWith(`${output}${sep}`))) throw new Error("Native UI evidence must stay in its own artifacts/ios attempt directory");
const scheme = ui ? "ArtooUI" : "Artoo";
const configuration = ui ? "Release" : "Debug";
const report = { ...getE2EReportContext(), ...(ui ? { suite: uiSuite } : {}), scope: ui ? `Release iOS ${uiSuite} XCUITest subset on the selected simulator; deterministic local server fixtures` : "Debug simulator build and unit XCTest; no UI workflow or physical-device claim", started_at: new Date().toISOString(), checks: [], passed: false };
if (ui) report.diagnostics_scope = "Raw xcresult bundles and exported attachments are unredacted local or CI diagnostics and inherit their repository artifact access rules; they can contain disposable fixture credentials and are intended for trusted recipients. This HTML includes only approved workflow screenshots.";
const htmlPath = resolve(output, `${scheme}-${report.started_at.replace(/[:.]/g, "-")}.html`);
const title = ui ? "Artoo · native iOS UI tests" : "Artoo · iOS build and unit tests";
let resultBundle;
function verifySourceBoundary() {
  if (ui && JSON.stringify(getE2EReportContext().source) !== JSON.stringify(report.source)) {
    throw new Error("Native source changed after the original build/run boundary");
  }
}
writeE2EReport({ outputPath: htmlPath, title, report });
try {
if (ui) rmSync(resolve(output, "ui-attachments"), { recursive: true, force: true });
if (process.platform !== "darwin") throw new Error("Xcode/XCTest requires macOS; static checks are not a native test result.");
if (process.argv.filter((arg) => arg.startsWith("--suite=")).length > 1 || process.argv.slice(2).some((arg) => arg !== "--ui" && !(ui && /^--suite=(core|assistant)$/.test(arg)))) throw new Error("Usage: test-macos.mjs [--ui --suite=core|assistant]");
const selected = ui ? selectUISuites(uiSuite)[0] : null;
if (ui) report.expected_case_ids = selected.expected_case_ids;
let uiEnvironment;
if (ui) {
  if (!process.env.ARTOO_IOS_UI_FIXTURE) throw new Error("Start the real-server UI fixture before using --ui");
  const fixture = JSON.parse(readFileSync(process.env.ARTOO_IOS_UI_FIXTURE, "utf8"));
  const coreFields = { server_url: "SERVER_URL", pairing_code: "PAIRING_CODE", project_id: "PROJECT_ID", channel_id: "CHANNEL_ID",
    peer_control_token: "PEER_CONTROL_TOKEN", native_message: "NATIVE_MESSAGE", native_reply: "NATIVE_REPLY", browser_reply: "BROWSER_REPLY",
    member_user_id: "MEMBER_USER_ID", member_name: "MEMBER_NAME", member_peer_control_token: "MEMBER_PEER_CONTROL_TOKEN",
    member_native_device_name: "MEMBER_NATIVE_DEVICE_NAME", member_recovery_device_name: "MEMBER_RECOVERY_DEVICE_NAME",
    member_pending_mac_id: "MEMBER_PENDING_MAC_ID", member_pending_mac_name: "MEMBER_PENDING_MAC_NAME", owner_device_id: "OWNER_DEVICE_ID",
    member_revocation_ready_message: "MEMBER_REVOCATION_READY_MESSAGE", member_recovery_message: "MEMBER_RECOVERY_MESSAGE",
    computer_id: "COMPUTER_ID", computer_name: "COMPUTER_NAME", goal_id: "GOAL_ID", goal_title: "GOAL_TITLE",
    approval_id: "APPROVAL_ID", approval_summary: "APPROVAL_SUMMARY", approval_task_id: "APPROVAL_TASK_ID",
    cancellation_goal_id: "CANCELLATION_GOAL_ID", cancellation_goal_title: "CANCELLATION_GOAL_TITLE",
    executor_instance_id: "EXECUTOR_INSTANCE_ID", executor_name: "EXECUTOR_NAME", executor_runtime: "EXECUTOR_RUNTIME",
    executor_collision_instance_id: "EXECUTOR_COLLISION_INSTANCE_ID",
    execution_task_title: "EXECUTION_TASK_TITLE", execution_criterion_1: "EXECUTION_CRITERION_1", execution_criterion_2: "EXECUTION_CRITERION_2",
    execution_approval_summary: "EXECUTION_APPROVAL_SUMMARY", execution_artifact_filename: "EXECUTION_ARTIFACT_FILENAME",
    execution_artifact_marker: "EXECUTION_ARTIFACT_MARKER", execution_review_comment: "EXECUTION_REVIEW_COMMENT",
    planner_instance_id: "PLANNER_INSTANCE_ID", planner_name: "PLANNER_NAME", reviewer_instance_id: "REVIEWER_INSTANCE_ID", reviewer_name: "REVIEWER_NAME",
    task_1_title: "TASK_1_TITLE", task_2_title: "TASK_2_TITLE", task_1_criterion: "TASK_1_CRITERION", task_2_criterion: "TASK_2_CRITERION",
    fixture_control_url: "FIXTURE_CONTROL_URL", fixture_control_token: "FIXTURE_CONTROL_TOKEN" };
  const assistantFields = Object.fromEntries([
    "server_url", "peer_control_token", "project_id", "channel_id", "channel_name", "user_id",
    "assistant_device_name", "assistant_instance_id", "assistant_collision_instance_id", "assistant_name", "assistant_runtime",
    "assistant_first_request", "assistant_second_request", "assistant_hold_request", "assistant_draft",
    "computer_id", "computer_name", "fixture_control_url", "fixture_control_token",
  ].map((field) => [field, field.toUpperCase()]));
  const fields = uiSuite === "assistant" ? assistantFields : coreFields;
  uiEnvironment = {};
  for (const [field, variable] of Object.entries(fields)) {
    if (typeof fixture[field] !== "string" || fixture[field].length === 0) throw new Error(`UI fixture is missing ${field}`);
    uiEnvironment[`ARTOO_UI_${variable}`] = fixture[field];
  }
  for (const value of [fixture.server_url, fixture.fixture_control_url]) {
    const origin = new URL(value);
    if (!["http:", "https:"].includes(origin.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) || origin.username || origin.password) throw new Error("UI fixture and node controls must use isolated loopback servers");
  }
}
mkdirSync(output, { recursive: true });
function run(command, args, capture = false) {
  const started = Date.now();
  const result = spawnSync(command, args, { cwd: ios, stdio: capture ? "pipe" : "inherit", encoding: "utf8", timeout: 1_200_000 });
  if (["xcodebuild", "xcodegen", "codesign"].includes(command)) report.checks.push({ name: [command, ...args].join(" "), passed: !result.error && result.status === 0, duration_ms: Date.now() - started });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? `${command} failed (${result.status}): ${result.stderr ?? "see output"}`);
  return result.stdout;
}
report.environment.xcode = run("xcodebuild", ["-version"], true).trim().replaceAll("\n", " · ");
console.log(report.environment.xcode);
let sdkVersion;
try { sdkVersion = run("xcrun", ["--sdk", "iphonesimulator", "--show-sdk-version"], true).trim(); }
catch (error) { throw new Error(`Cannot read the selected Xcode's iPhoneSimulator SDK: ${error.message}`); }
report.environment.iphonesimulator_sdk = sdkVersion;
const deviceInventory = JSON.parse(run("xcrun", ["simctl", "list", "devices", "--json"], true));
const runtimeInventory = JSON.parse(run("xcrun", ["simctl", "list", "runtimes", "--json"], true));
const requested = process.env.ARTOO_IOS_SIMULATOR_UDID;
const selection = selectIPhoneSimulator({ sdkVersion, deviceInventory, runtimeInventory, requestedUDID: requested });
const { device, runtime } = selection;
report.simulator_selection = { mode: selection.mode, newer_than_sdk: selection.newerThanSdk, candidates: selection.diagnostics };
report.environment.simulator_runtime = `${runtime.name} (${runtime.version})`;
console.log(`iPhoneSimulator SDK ${sdkVersion}; selected ${device.name} on ${runtime.name} (${selection.mode})`);
if (selection.newerThanSdk) console.warn("Explicit ARTOO_IOS_SIMULATOR_UDID overrides the SDK ceiling; this toolchain/runtime combination is operator-selected, not default compatibility evidence.");
report.environment.simulator = device.name;
report.environment.simulator_udid = device.udid;
report.environment.configuration = configuration;
run("xcodegen", ["generate"]);
verifySourceBoundary();
// Simulator ad-hoc signing needs no developer certificate, but provides the
// application/keychain entitlements required by the real Keychain XCTest.
const common = ["-project", "Artoo.xcodeproj", "-scheme", scheme, "-configuration", configuration, "-derivedDataPath", resolve(baseOutput, "DerivedData"),
  "CODE_SIGNING_ALLOWED=YES", "CODE_SIGN_IDENTITY=-", "CODE_SIGNING_REQUIRED=YES"];
run("xcodebuild", [...common, "-destination", "generic/platform=iOS Simulator", "build-for-testing"]);
verifySourceBoundary();
run("codesign", ["--display", "--entitlements", ":-", resolve(baseOutput, `DerivedData/Build/Products/${configuration}-iphonesimulator/Artoo.app`)]);
console.log(`Testing on ${device.name} (${device.udid})`);
resultBundle = resolve(output, `${scheme}-${Date.now()}.xcresult`);
const destination = ["-destination", `platform=iOS Simulator,id=${device.udid}`, "-parallel-testing-enabled", "NO",
  "-resultBundlePath", resultBundle];
if (!ui) {
  run("xcodebuild", [...common, ...destination, "-only-testing:ArtooTests", "test-without-building"]);
} else {
  // Only the test runner receives disposable fixture credentials. The Release
  // app is launched normally and pairs through its existing UI. Keep this
  // modified manifest outside retained artifacts and erase it in all outcomes.
  const products = resolve(baseOutput, "DerivedData/Build/Products");
  const manifests = readdirSync(products).filter((name) => name.endsWith(".xctestrun"));
  let manifest;
  for (const name of manifests) {
    const candidate = JSON.parse(run("plutil", ["-convert", "json", "-o", "-", resolve(products, name)], true));
    if (JSON.stringify(candidate).includes('"ArtooUITests"')) { manifest = candidate; break; }
  }
  if (!manifest) throw new Error("Xcode did not generate an ArtooUITests test manifest");
  let configured = 0;
  function prepare(value) {
    if (typeof value === "string") return value.replaceAll("__TESTROOT__", products);
    if (Array.isArray(value)) return value.map(prepare);
    if (!value || typeof value !== "object") return value;
    const next = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, prepare(item)]));
    if (next.BlueprintName === "ArtooUITests" || (typeof next.TestBundlePath === "string" && next.TestBundlePath.includes("ArtooUITests.xctest"))) {
      next.EnvironmentVariables = { ...next.EnvironmentVariables, ...uiEnvironment }; configured += 1;
    }
    return next;
  }
  manifest = prepare(manifest);
  if (configured !== 1) throw new Error("Expected exactly one UI test target to receive the fixture");
  // Keep secrets under the parent fixture directory as well, so its cleanup
  // removes this manifest even if xcodebuild or this child is terminated.
  const privateDirectory = mkdtempSync(resolve(dirname(process.env.ARTOO_IOS_UI_FIXTURE), "test-run-"));
  try {
    const json = resolve(privateDirectory, "ui-test.json"), path = resolve(privateDirectory, "ui-test.xctestrun");
    writeFileSync(json, JSON.stringify(manifest), { mode: 0o600 });
    run("plutil", ["-convert", "xml1", "-o", path, json]);
    run("xcodebuild", ["-xctestrun", path, ...destination, ...selected.only_testing_arguments, "test-without-building"]);
  } finally {
    rmSync(privateDirectory, { recursive: true, force: true });
    const help = spawnSync("xcrun", ["xcresulttool", "export", "attachments", "--help"], { cwd: ios, encoding: "utf8", timeout: 30_000 });
    if (help.status === 0 && help.stdout?.includes("--output-path")) {
      try { run("xcrun", ["xcresulttool", "export", "attachments", "--path", resultBundle, "--output-path", resolve(output, "ui-attachments")]); }
      catch (error) { console.warn(`UI attachment export failed; the original xcresult remains available: ${error.message}`); }
    } else { console.warn("This Xcode cannot export UI attachments; inspect the retained xcresult bundle in Xcode."); }
  }
}
report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.error(report.error);
} finally {
  if (resultBundle) report.result_bundle = resultBundle;
  if (ui && resultBundle) {
    try {
      const diagnostics = resolve(output, "diagnostics"); mkdirSync(diagnostics, { recursive: true });
      const exports = {};
      for (const kind of ["tests", "summary"]) {
        const extracted = spawnSync("xcrun", ["xcresulttool", "get", "test-results", kind, "--path", resultBundle],
          { cwd: ios, encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
        if (extracted.error || extracted.status !== 0) throw new Error("xcresult export failed");
        exports[kind] = JSON.parse(extracted.stdout);
        const path = resolve(diagnostics, `xcresult-${kind}.json`);
        writeFileSync(path, `${JSON.stringify(exports[kind], null, 2)}\n`);
        report[`xcresult_${kind}`] = path;
      }
      report.contract = verifyUISuiteResults({ selection: uiSuite, results: [{ suite: uiSuite, source: report.source,
        result_bundle: resultBundle, tests: exports.tests, summary: exports.summary }] });
      if (!report.contract.passed) {
        report.passed = false; report.error = "The exact native UI suite contract failed; inspect its case counts and retained xcresult"; process.exitCode = 1;
      }
    } catch {
      report.passed = false; report.error = "Could not verify the native UI case inventory from xcresult"; process.exitCode = 1;
    }
  }
  if (ui) report.attachments_directory = resolve(output, "ui-attachments");
  const screenshots = ui ? readXCTestScreenshots(resolve(output, "ui-attachments")) : [];
  if (ui && report.passed) {
    const missing = expectedNativeScreenshots(uiSuite).filter((name) => !screenshots.some(({ caption }) =>
      caption === name || caption.startsWith(`${name}_`) || caption.startsWith(`${name}.`)));
    report.screenshots = { count: screenshots.length, expected: expectedNativeScreenshots(uiSuite), missing };
    report.checks.push({ name: "Export every approved screenshot for the selected native suite", passed: missing.length === 0 });
    if (missing.length) {
      report.passed = false;
      report.error = "XCUITest passed, but selected-suite screenshot export is incomplete. Inspect the retained xcresult.";
      process.exitCode = 1;
    }
  }
  if (ui) {
    report.source_at_finish = getE2EReportContext().source;
    report.source_stable = JSON.stringify(report.source_at_finish) === JSON.stringify(report.source);
    if (!report.source_stable) { report.passed = false; report.error ??= "Native source changed during build or verification"; process.exitCode = 1; }
  }
  report.finished_at = new Date().toISOString();
  report.html_report = htmlPath;
  writeE2EReport({ outputPath: htmlPath, title, report, screenshots });
  if (ui) { writeFileSync(resultJSON, `${JSON.stringify(report, null, 2)}\n`); }
  console.log(`HTML report: ${htmlPath}`);
}
