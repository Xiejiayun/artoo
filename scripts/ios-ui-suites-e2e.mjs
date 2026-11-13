#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  selectUISuites,
  verifyUISuiteResults,
  nativeUISuiteTimeouts,
  parseUISuiteArguments,
} from "../apps/ios/scripts/ui-suite-contract.mjs";
import { captureProjectPreparation, assertProjectPreparation } from "../apps/ios/scripts/project-preparation.mjs";
import { getE2EReportContext, readXCTestScreenshots, writeE2EReport } from "./e2e-report.mjs";
import { loadNativeSuiteEvidence, readMentionsPeerScreenshots } from "./ios-ui-suite-evidence.mjs";
import { closeOwnedProcessGroup } from "./owned-process-group.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const started = Date.now();
const ios = join(root, "apps/ios");
const output = join(root, "artifacts/ios");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const html = join(output, `native-suites-${stamp}.html`),
  json = join(output, `native-suites-${stamp}.json`);
const report = {
  ...getE2EReportContext(),
  started_at: new Date().toISOString(),
  passed: false,
  scope:
    "Selected native UI suites with separate real fixtures; deterministic subprocesses, no real-provider or physical-device claim",
  suites: [],
  timings_ms: {},
};
const screenshots = [],
  results = [];
let child, abortReason, killTimer;
const terminate = () => {
  abortReason ??= new Error("Native suite aggregation interrupted");
  if (!child?.pid) return;
  const signal = (name) => {
    try {
      process.kill(-child.pid, name);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  signal("SIGTERM");
  // Let the parent complete its own native-group and fixture cleanup first.
  killTimer = setTimeout(() => {
    if (child?.pid) signal("SIGKILL");
  }, 20_000);
};
process.once("SIGINT", terminate);
process.once("SIGTERM", terminate);
mkdirSync(output, { recursive: true });
writeE2EReport({ outputPath: html, title: "Artoo iOS · native suite verification", report });
try {
  const choice = parseUISuiteArguments(process.argv.slice(2));
  Object.assign(report, choice);
  const selected = selectUISuites(choice.selection, choice.selected_suites);
  if (process.platform !== "darwin") throw new Error("Native suite verification requires macOS and Xcode");
  // XcodeGen can update the tracked UI Info.plist. Establish that generated
  // input before recording the common source boundary, including standalone
  // UI invocations that did not run the unit build first.
  const generationStarted = Date.now();
  const generated = spawnSync("xcodegen", ["generate"], { cwd: ios, stdio: "inherit", timeout: 60_000 });
  report.timings_ms.xcodegen = Date.now() - generationStarted;
  assert.ok(!generated.error && generated.status === 0, "Common Xcode project generation must succeed");
  report.source = getE2EReportContext().source;
  report.source_boundary = "Recorded after common XcodeGen preparation and before any native suite starts";
  const preparation = captureProjectPreparation(ios, report.source);
  report.project_preparation = preparation;
  for (const { suite } of selected) {
    if (abortReason) throw abortReason;
    assert.deepEqual(getE2EReportContext().source, report.source, "Source changed between native suites");
    assertProjectPreparation(ios, report.source, preparation);
    const attempt = join(output, "attempts", `${stamp}-${suite}`);
    assert.ok(!existsSync(attempt), "Each selected suite needs a fresh evidence directory");
    mkdirSync(attempt, { recursive: true });
    const suiteStarted = Date.now();
    const entry = { suite, directory: attempt, passed: false, timings_ms: {} };
    report.suites.push(entry);
    let parentPID;
    const script = {
      core: "scripts/ios-ui-e2e.mjs",
      assistant: "scripts/ios-ui-assistant-e2e.mjs",
      mentions: "scripts/ios-ui-mentions-e2e.mjs",
      correction: "scripts/ios-ui-correction-e2e.mjs",
      retention: "scripts/ios-ui-retention-e2e.mjs",
    }[suite];
    try {
      const parentStarted = Date.now();
      entry.exit_code = await new Promise((done, reject) => {
        child = spawn(process.execPath, [join(root, script)], {
          cwd: root,
          stdio: "inherit",
          detached: true,
          env: {
            ...process.env,
            ARTOO_IOS_PROJECT_PREPARATION: JSON.stringify(preparation),
            ARTOO_IOS_UI_OUTPUT_DIR: attempt,
            ARTOO_IOS_UI_RESULT_JSON: join(attempt, "xctest-result.json"),
          },
        });
        parentPID = child.pid;
        const limit = nativeUISuiteTimeouts(suite).aggregate;
        const timeout = setTimeout(() => {
          abortReason = new Error(`Native ${suite} parent exceeded ${limit / 60_000} minutes`);
          terminate();
        }, limit);
        child.once("error", (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once("exit", (code) => {
          clearTimeout(timeout);
          clearTimeout(killTimer);
          child = null;
          done(code);
        });
      });
      entry.timings_ms.parent = Date.now() - parentStarted;
      if (abortReason) throw abortReason;
      assert.equal(entry.exit_code, 0, "The native parent process must exit successfully");
      const evidence = loadNativeSuiteEvidence(attempt, suite);
      assert.deepEqual(getE2EReportContext().source, report.source, "Source changed during the selected native suite");
      assert.deepEqual(
        evidence.native.source,
        report.source,
        "Native build source differs from the original aggregate boundary",
      );
      assertProjectPreparation(ios, report.source, preparation);
      results.push(evidence.input);
      Object.assign(entry, {
        passed: true,
        parent_html: evidence.parent.html_report,
        native_html: evidence.native.html_report,
        result_bundle: evidence.native.result_bundle,
        counts: evidence.contract.counts,
        expected_case_ids: evidence.contract.expected_case_ids,
        actual_case_ids: evidence.contract.actual_case_ids,
        cleanup: evidence.parent.cleanup,
        native_timings_ms: evidence.native.timings_ms,
      });
    } finally {
      const cleanupStarted = Date.now();
      entry.parent_process_cleanup = parentPID
        ? await closeOwnedProcessGroup(parentPID)
        : { closed: true, not_started: true };
      entry.timings_ms.process_cleanup = Date.now() - cleanupStarted;
      // Retain approved screenshots even when fixture assertions or native
      // execution fail. Pairing/input failure attachments are not admitted.
      screenshots.push(
        ...readXCTestScreenshots(join(attempt, "ui-attachments")).map((item) => ({
          ...item,
          caption: `${suite} · ${item.caption}`,
        })),
      );
      if (suite === "core")
        for (const name of [
          "native-browser-sync.png",
          "native-owner-revoked-member-device.png",
          "native-browser-failure.png",
        ]) {
          const path = join(attempt, name);
          if (existsSync(path)) screenshots.push({ path, caption: `core · authenticated browser · ${name}` });
        }
      const parentPath = join(attempt, "suite-result.json");
      if (existsSync(parentPath)) {
        try {
          const parent = JSON.parse(readFileSync(parentPath, "utf8"));
          entry.parent_html = parent.html_report;
          entry.cleanup = parent.cleanup;
          if (suite === "mentions") screenshots.push(...readMentionsPeerScreenshots(attempt, parent.peer_screenshots));
        } catch {
          entry.evidence_error = "Parent report could not be read";
        }
      }
      entry.timings_ms.total = Date.now() - suiteStarted;
      if (!entry.parent_process_cleanup.closed) {
        entry.passed = false;
        entry.cleanup_error = "Native parent process-group cleanup failed";
      }
    }
    assert.ok(entry.parent_process_cleanup.closed, "Native parent process-group cleanup failed");
  }
  // Signals can arrive while the final suite's asynchronous cleanup runs,
  // after its child has already exited. That interruption is still a failure.
  if (abortReason) throw abortReason;
  report.contract = verifyUISuiteResults({ ...choice, results });
  assert.ok(report.contract.passed, "All selected native suites must pass with matching original source fingerprints");
  assert.deepEqual(getE2EReportContext().source, report.source, "Source changed before native aggregation finished");
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : "Native suite verification failed";
  process.exitCode = 1;
} finally {
  clearTimeout(killTimer);
  process.removeListener("SIGINT", terminate);
  process.removeListener("SIGTERM", terminate);
  report.finished_at = new Date().toISOString();
  report.html_report = html;
  report.timings_ms.total = Date.now() - started;
  writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
  writeE2EReport({
    outputPath: html,
    title: `Artoo iOS · ${report.selection ?? "invalid"} native UI suites`,
    report,
    screenshots,
  });
  console.log(`Native suite HTML report: ${html}`);
  console.log(`Native suite JSON report: ${json}`);
}
