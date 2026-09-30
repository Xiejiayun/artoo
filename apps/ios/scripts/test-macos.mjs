#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getE2EReportContext, readXCTestScreenshots, writeE2EReport } from "../../../scripts/e2e-report.mjs";

const ios = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(ios, "../../artifacts/ios");
const ui = process.argv.includes("--ui");
const scheme = ui ? "ArtooUI" : "Artoo";
const configuration = ui ? "Release" : "Debug";
const report = { ...getE2EReportContext(), scope: ui ? "Release iOS XCUITest on the selected simulator; deterministic local server fixtures" : "Debug simulator build and unit XCTest; no UI workflow or physical-device claim", started_at: new Date().toISOString(), checks: [], passed: false };
if (ui) report.diagnostics_scope = "Raw xcresult bundles and exported attachments are unredacted local or CI diagnostics and inherit their repository artifact access rules; they can contain disposable fixture credentials and are intended for trusted recipients. This HTML includes only approved workflow screenshots.";
const htmlPath = resolve(output, `${scheme}-${report.started_at.replace(/[:.]/g, "-")}.html`);
const title = ui ? "Artoo · native iOS UI tests" : "Artoo · iOS build and unit tests";
let resultBundle;
writeE2EReport({ outputPath: htmlPath, title, report });
try {
if (ui) rmSync(resolve(output, "ui-attachments"), { recursive: true, force: true });
if (process.platform !== "darwin") throw new Error("Xcode/XCTest requires macOS; static checks are not a native test result.");
if (process.argv.slice(2).some((arg) => arg !== "--ui")) throw new Error("Usage: test-macos.mjs [--ui]");
let uiEnvironment;
if (ui) {
  if (!process.env.ARTOO_IOS_UI_FIXTURE) throw new Error("Start the real-server UI fixture before using --ui");
  const fixture = JSON.parse(readFileSync(process.env.ARTOO_IOS_UI_FIXTURE, "utf8"));
  const fields = { server_url: "SERVER_URL", pairing_code: "PAIRING_CODE", project_id: "PROJECT_ID", channel_id: "CHANNEL_ID",
    peer_control_token: "PEER_CONTROL_TOKEN", native_message: "NATIVE_MESSAGE", native_reply: "NATIVE_REPLY", browser_reply: "BROWSER_REPLY",
    computer_id: "COMPUTER_ID", computer_name: "COMPUTER_NAME", goal_id: "GOAL_ID", goal_title: "GOAL_TITLE",
    planner_instance_id: "PLANNER_INSTANCE_ID", planner_name: "PLANNER_NAME", reviewer_instance_id: "REVIEWER_INSTANCE_ID", reviewer_name: "REVIEWER_NAME",
    task_1_title: "TASK_1_TITLE", task_2_title: "TASK_2_TITLE", task_1_criterion: "TASK_1_CRITERION", task_2_criterion: "TASK_2_CRITERION",
    fixture_control_url: "FIXTURE_CONTROL_URL", fixture_control_token: "FIXTURE_CONTROL_TOKEN" };
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
run("xcodegen", ["generate"]);
const inventory = JSON.parse(run("xcrun", ["simctl", "list", "devices", "available", "--json"], true));
const candidates = Object.entries(inventory.devices).sort(([a], [b]) => b.localeCompare(a, undefined, { numeric: true }))
  .flatMap(([, devices]) => devices).filter((device) => device.isAvailable && device.name.startsWith("iPhone"));
const requested = process.env.ARTOO_IOS_SIMULATOR_UDID;
const device = requested ? candidates.find((item) => item.udid === requested) : candidates[0];
if (!device) throw new Error(requested ? "ARTOO_IOS_SIMULATOR_UDID must identify an available iPhone simulator" : "Install an iOS simulator runtime in Xcode before running this gate");
report.environment.simulator = device.name;
report.environment.simulator_udid = device.udid;
report.environment.configuration = configuration;
// Simulator ad-hoc signing needs no developer certificate, but provides the
// application/keychain entitlements required by the real Keychain XCTest.
const common = ["-project", "Artoo.xcodeproj", "-scheme", scheme, "-configuration", configuration, "-derivedDataPath", resolve(output, "DerivedData"),
  "CODE_SIGNING_ALLOWED=YES", "CODE_SIGN_IDENTITY=-", "CODE_SIGNING_REQUIRED=YES"];
run("xcodebuild", [...common, "-destination", "generic/platform=iOS Simulator", "build-for-testing"]);
run("codesign", ["--display", "--entitlements", ":-", resolve(output, `DerivedData/Build/Products/${configuration}-iphonesimulator/Artoo.app`)]);
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
  const products = resolve(output, "DerivedData/Build/Products");
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
    run("xcodebuild", ["-xctestrun", path, ...destination, "-only-testing:ArtooUITests", "test-without-building"]);
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
  report.finished_at = new Date().toISOString();
  if (resultBundle) report.result_bundle = resultBundle;
  const screenshots = ui ? readXCTestScreenshots(resolve(output, "ui-attachments")) : [];
  if (ui && report.passed) {
    report.checks.push({ name: "Export named native workflow screenshots", passed: screenshots.length > 0 });
    if (!screenshots.length) {
      report.passed = false;
      report.error = "XCUITest passed, but native screenshot export is missing. Inspect the xcresult; visual evidence is not complete.";
      process.exitCode = 1;
    }
  }
  writeE2EReport({ outputPath: htmlPath, title, report, screenshots });
  console.log(`HTML report: ${htmlPath}`);
}
