import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { verifyUISuiteResults } from "../apps/ios/scripts/ui-suite-contract.mjs";
import { expectedNativeScreenshots, readXCTestScreenshots } from "./e2e-report.mjs";
import { hasCompletePNGPixelStream, MAX_PNG_BYTES } from "./png-evidence.mjs";

const peerNames = ["mentions-peer-first.png", "mentions-peer-second.png"];
export function readMentionsPeerScreenshots(directory, declared) {
  if (!Array.isArray(declared)) return [];
  const found = [], seen = new Set(), attempt = resolve(directory);
  for (const image of declared) {
    try {
      assert.ok(peerNames.some((name) => image.path === resolve(attempt, name)) && !seen.has(image.path));
      assert.ok(typeof image.caption === "string" && image.caption.startsWith("Independent sender browser"));
      const stat = lstatSync(image.path);
      assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_PNG_BYTES
        && dirname(realpathSync(image.path)) === realpathSync(attempt) && hasCompletePNGPixelStream(readFileSync(image.path)));
      seen.add(image.path); found.push({ path: image.path, caption: image.caption });
    } catch { /* Invalid images remain missing evidence; never break failure HTML. */ }
  }
  return found;
}

/** Read only the finalized parent, XCTest report and exports from one attempt.
 * A green XCTest cannot substitute for failed fixture checks or cleanup. */
export function loadNativeSuiteEvidence(directory, suite) {
  const attempt = resolve(directory);
  const read = (name) => JSON.parse(readFileSync(resolve(attempt, name), "utf8"));
  const parent = read("suite-result.json"), native = read("xctest-result.json");
  assert.ok(parent.suite === suite && native.suite === suite, "Parent and XCTest must identify the selected suite");
  assert.ok(parent.passed === true && native.passed === true, "Parent fixture and XCTest must both pass");
  assert.ok(Number.isFinite(Date.parse(parent.finished_at)) && Number.isFinite(Date.parse(native.finished_at)), "Both reports must be finalized");
  assert.ok(parent.cleanup?.resources_closed === true && parent.cleanup?.temporary_directory_removed === true
    && Object.values(parent.cleanup).every((value) => value === true), "All native fixture cleanup must complete");
  assert.ok(JSON.stringify(parent.source) === JSON.stringify(native.source), "Parent and XCTest must preserve the same original source");
  assert.ok(native.source_stable === true && JSON.stringify(native.source_at_finish) === JSON.stringify(native.source),
    "The original native source must remain unchanged through final verification");
  assert.ok(native.contract?.passed === true && native.contract.selection === suite, "The child must retain its successful selected-suite contract");
  assert.ok(native.screenshots?.count > 0 && Array.isArray(native.screenshots.missing) && native.screenshots.missing.length === 0,
    "The child must export every selected-suite screenshot");
  const retainedHTML = [parent.html_report, native.html_report];
  assert.ok(retainedHTML.every((path) => typeof path === "string" && dirname(path) === attempt && path.endsWith(".html") && existsSync(path)),
    "Both standalone HTML reports must belong to this attempt");
  assert.ok(typeof native.result_bundle === "string" && native.result_bundle.startsWith(`${attempt}${sep}`)
    && native.result_bundle.endsWith(".xcresult") && existsSync(native.result_bundle), "The retained xcresult must belong to this attempt");
  assert.ok(native.attachments_directory === resolve(attempt, "ui-attachments"), "Attachments must belong to this attempt");
  const screenshots = readXCTestScreenshots(native.attachments_directory);
  assert.ok(screenshots.length === native.screenshots.count && expectedNativeScreenshots(suite).every((name) => screenshots.some(({ caption }) =>
    caption === name || caption.startsWith(`${name}_`) || caption.startsWith(`${name}.`))), "Every declared and expected native screenshot must still be retained");
  if (suite === "mentions") {
    assert.equal(parent.mentions?.passed, true, "Mention production-record verification must pass");
    const peerImages = readMentionsPeerScreenshots(attempt, parent.peer_screenshots);
    assert.ok(parent.peer_screenshots?.length === 2 && peerImages.length === 2
      && peerNames.every((name) => peerImages.some(({ path }) => path === resolve(attempt, name))), "Both independent sender captures must remain complete");
  }
  assert.ok(native.xcresult_tests === resolve(attempt, "diagnostics/xcresult-tests.json")
    && native.xcresult_summary === resolve(attempt, "diagnostics/xcresult-summary.json"), "Raw exports must belong to this attempt");
  const input = { suite, source: native.source, result_bundle: native.result_bundle,
    tests: read("diagnostics/xcresult-tests.json"), summary: read("diagnostics/xcresult-summary.json") };
  const contract = verifyUISuiteResults({ selection: suite, results: [input] });
  assert.ok(contract.passed, "The original xcresult exports must independently satisfy the exact suite contract");
  return { parent, native, input, contract };
}
