import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { finalizeInstalledLiveProviderEvidence, installedLiveProviderEvidence, installedLiveProviderPlan, runOptionalInstalledLiveProvider } from "./installed-live-provider-gate.mjs";
import { runInstalledLiveProvider } from "./installed-live-provider.mjs";
import { runWindowsLiveCopilot } from "./windows-live-copilot.mjs";
import { writeE2EReport } from "../../../scripts/e2e-report.mjs";

// Routing/evidence unit tests only. No CLI, browser, provider or credentials are
// used; deliberately injected runner responses never create a passing live report.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
function temporary(t) {
  const directory = mkdtempSync(join(tmpdir(), "artoo-live-gate-unit-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("without exact opt-in the runner is never loaded and provider settings are never accessed", async () => {
  for (const value of [undefined, "", "0", "true", "1 "]) {
    for (const platform of ["darwin", "win32"]) {
      const env = new Proxy({}, { get(_target, key) {
        assert.equal(key, "ARTOO_DESKTOP_LIVE_CODEX", "Disabled gate inspected provider settings"); return value;
      } });
      let calls = 0;
      const result = await runOptionalInstalledLiveProvider({ platform, artifactDir: "/unused", onStart: () => { calls++; } }, {
        env, loadRunner: () => { calls++; throw new Error("The provider runner must not load"); },
      });
      assert.equal(result, null); assert.equal(calls, 0);
    }
  }
});

test("direct and legacy runner entrypoints also refuse missing opt-in before any filesystem or UI operation", async (t) => {
  const root = temporary(t), artifactDir = join(root, "must-not-exist");
  const page = new Proxy({}, { get() { throw new Error("No UI access permitted in this unit test"); } });
  for (const runner of [runInstalledLiveProvider, runWindowsLiveCopilot]) {
    await assert.rejects(runner({ artifactDir, page, env: {} }), /requires ARTOO_DESKTOP_LIVE_CODEX=1/);
    assert.equal(existsSync(artifactDir), false);
  }
});

test("Mac defaults to three discussion turns while Windows retains five-turn scope and filenames", () => {
  const env = { ARTOO_DESKTOP_LIVE_CODEX: "1" };
  const mac = installedLiveProviderPlan("darwin", "/evidence", env);
  assert.equal(mac.scope, "discussion"); assert.equal(mac.expectedTurns, 3); assert.equal(mac.platformName, "macOS");
  assert.equal(mac.reportPath, join("/evidence", "macos-live-provider.json"));
  const windows = installedLiveProviderPlan("win32", "/evidence", env);
  assert.equal(windows.scope, "all"); assert.equal(windows.expectedTurns, 5); assert.equal(windows.platformName, "Windows");
  assert.equal(windows.reportPath, join("/evidence", "windows-live-copilot.json"));
  assert.equal(windows.planScreenshotPath, join("/evidence", "windows-live-copilot-plan.png"));
  assert.equal(installedLiveProviderPlan("win32", "/evidence", { ...env, ARTOO_DESKTOP_LIVE_SCOPE: "discussion" }).expectedTurns, 3);
});

test("unknown live scope is rejected before activating or importing the runner", async () => {
  let calls = 0;
  await assert.rejects(runOptionalInstalledLiveProvider({ platform: "darwin", artifactDir: "/unused", onStart: () => { calls++; } }, {
    env: { ARTOO_DESKTOP_LIVE_CODEX: "1", ARTOO_DESKTOP_LIVE_SCOPE: "chat" }, loadRunner: () => { calls++; },
  }), /must be all or discussion/);
  assert.equal(calls, 0);
});

test("opt-in dispatch forwards platform and evidence images to the same HTML writer used by the enclosing smoke", async (t) => {
  const artifactDir = temporary(t), events = [], screenshots = [];
  const env = { ARTOO_DESKTOP_LIVE_CODEX: "1", ARTOO_DESKTOP_LIVE_SCOPE: "discussion" };
  const expected = installedLiveProviderEvidence("darwin", artifactDir);
  writeFileSync(expected.planScreenshotPath, png);
  const image = { path: expected.planScreenshotPath, caption: "Unit-test image plumbing; no live provider was invoked" };
  const live = await runOptionalInstalledLiveProvider({ platform: "darwin", artifactDir,
    onStart: (plan) => { events.push("start"); assert.equal(plan.reportPath, expected.reportPath); },
    onScreenshot: (screenshot) => screenshots.push(screenshot) }, {
    env,
    loadRunner: async () => { events.push("load"); return { runInstalledLiveProvider: async (options) => {
      events.push("run"); assert.equal(options.env, env); assert.equal(options.platform, "darwin");
      options.onScreenshot(image);
      return { page: "unit page marker", reportPath: expected.reportPath, screenshots: [image] };
    } }; },
  });
  assert.deepEqual(events, ["start", "load", "run"]); assert.deepEqual(live.screenshots, [image]);
  assert.deepEqual(screenshots, [image], "The immediate capture and successful return must register one image");
  const report = writeE2EReport({ outputPath: join(artifactDir, "unit-evidence.html"), title: "Unit evidence integration, not live validation",
    report: { passed: false, finished_at: new Date().toISOString(), scope: "Unit test; no real model execution" }, screenshots });
  const html = readFileSync(report, "utf8");
  assert.ok(html.includes(`data:image/png;base64,${png.toString("base64")}`)); assert.ok(html.includes(image.caption));
  assert.ok(!existsSync(expected.reportPath), "An injected unit runner must not leave a live success report");
});

test("a returning runner without its actual screenshot or with another platform's report path is not accepted", async (t) => {
  const artifactDir = temporary(t), plan = installedLiveProviderPlan("darwin", artifactDir, { ARTOO_DESKTOP_LIVE_CODEX: "1" });
  for (const result of [
    { reportPath: join(artifactDir, "windows-live-copilot.json"), screenshots: [] },
    { reportPath: plan.reportPath, screenshots: [] },
    { reportPath: plan.reportPath, screenshots: [{ path: plan.planScreenshotPath, caption: "Missing unit fixture" }] },
  ]) {
    await assert.rejects(runOptionalInstalledLiveProvider({ platform: "darwin", artifactDir }, {
      env: { ARTOO_DESKTOP_LIVE_CODEX: "1" }, loadRunner: async () => ({ runInstalledLiveProvider: async () => result }),
    }), /evidence path|captured workflow image/);
  }
});

test("all scope requires chat evidence as well as the discussion image", async (t) => {
  const artifactDir = temporary(t), env = { ARTOO_DESKTOP_LIVE_CODEX: "1", ARTOO_DESKTOP_LIVE_SCOPE: "all" };
  const plan = installedLiveProviderPlan("win32", artifactDir, env);
  writeFileSync(plan.planScreenshotPath, png);
  await assert.rejects(runOptionalInstalledLiveProvider({ platform: "win32", artifactDir }, {
    env, loadRunner: async () => ({ runInstalledLiveProvider: async () => ({ reportPath: plan.reportPath,
      screenshots: [{ path: plan.planScreenshotPath, caption: "Unit-test discussion image" }] }) }),
  }), /captured workflow image/);
});

test("a later live failure preserves completed captures in the enclosing failed HTML", async (t) => {
  const artifactDir = temporary(t), screenshots = [];
  const expected = installedLiveProviderEvidence("darwin", artifactDir);
  const caption = "Unit-test image captured before a synthetic failure; no live provider was invoked";
  const report = { passed: false, liveVerified: false, scope: "Unit test; no real model execution" };
  await assert.rejects(runOptionalInstalledLiveProvider({ platform: "darwin", artifactDir,
    onScreenshot: (screenshot) => screenshots.push(screenshot) }, {
    env: { ARTOO_DESKTOP_LIVE_CODEX: "1" },
    loadRunner: async () => ({ runInstalledLiveProvider: async (options) => {
      writeFileSync(expected.planScreenshotPath, png);
      options.onScreenshot({ path: expected.planScreenshotPath, caption });
      throw new Error("Synthetic failure after capture");
    } }),
  }), /Synthetic failure after capture/);
  const htmlPath = writeE2EReport({ outputPath: join(artifactDir, "unit-failure.html"), title: "Unit failure evidence", report, screenshots });
  const html = readFileSync(htmlPath, "utf8");
  assert.ok(html.includes(caption)); assert.ok(html.includes(`data:image/png;base64,${png.toString("base64")}`));
  assert.equal(report.passed, false); assert.equal(report.liveVerified, false);
  assert.equal(existsSync(expected.reportPath), false);
});

test("saved HTML and JSON retain sanitized live measurements after companion removal or replacement", (t) => {
  const artifactDir = temporary(t);
  for (const platform of ["darwin", "win32"]) {
    const { reportPath, planScreenshotPath } = installedLiveProviderEvidence(platform, artifactDir);
    const liveReport = { result: "fail", scope: "Unit fixture; no live provider was invoked",
      checks: ["Synthetic contribution recorded before failure"], measurements: [{ run_id: "unit-only-run", input_tokens: 17, output_tokens: 9 }],
      provider_session_count: 1, error: "Synthetic later-stage failure",
      failure_state: { status: "failed", error: { present: true, category: "timeout" } },
      api_key: "unit-key-sentinel", authorization: "Bearer unit-auth-sentinel" };
    writeFileSync(reportPath, JSON.stringify(liveReport));
    writeFileSync(planScreenshotPath, png);
    const report = { result: "fail", passed: false, liveVerified: false, finished_at: new Date().toISOString(),
      scope: "Unit fixture; no live provider was invoked", liveEvidence: reportPath,
      cleanup_complete: true, cleanup: { app_closed: true, temporary_directory_removed: true } };
    report.liveEvidenceSnapshot = finalizeInstalledLiveProviderEvidence(reportPath, report);
    const expected = { ...liveReport, api_key: "[redacted]", authorization: "[redacted]",
      cleanup_complete: true, cleanup: { ...report.cleanup } };
    assert.deepEqual(report.liveEvidenceSnapshot, expected);
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), expected);
    const jsonPath = join(artifactDir, `${platform}-unit-history.json`);
    const htmlPath = join(artifactDir, `${platform}-unit-history.html`);
    writeFileSync(jsonPath, JSON.stringify(report));
    writeE2EReport({ outputPath: htmlPath, title: "Unit retention evidence", report,
      screenshots: [{ path: planScreenshotPath, caption: "Synthetic unit image; no live provider was invoked" }] });
    const originalHtml = readFileSync(htmlPath, "utf8");
    assert.ok(originalHtml.includes("unit-only-run") && originalHtml.includes("Synthetic later-stage failure"));
    assert.ok(originalHtml.includes(`data:image/png;base64,${png.toString("base64")}`));
    for (const path of [jsonPath, htmlPath]) {
      const text = readFileSync(path, "utf8");
      assert.ok(!text.includes("unit-key-sentinel") && !text.includes("unit-auth-sentinel"));
    }
    rmSync(reportPath); rmSync(planScreenshotPath);
    const retained = () => {
      assert.deepEqual(JSON.parse(readFileSync(jsonPath, "utf8")).liveEvidenceSnapshot, expected);
      assert.equal(readFileSync(htmlPath, "utf8"), originalHtml);
    };
    retained();
    writeFileSync(reportPath, JSON.stringify({ result: "fail", measurements: [], scope: "Later synthetic attempt" }));
    retained();
    report.cleanup.app_closed = false;
    assert.equal(report.liveEvidenceSnapshot.cleanup.app_closed, true, "The snapshot must not share mutable cleanup state");
  }
});

test("finalizing a failed enclosing run preserves live failure detail and propagates cleanup failure", (t) => {
  const { reportPath } = installedLiveProviderEvidence("darwin", temporary(t));
  const enclosing = { result: "fail", cleanup_complete: false, cleanup: { app_closed: false }, error: "Enclosing cleanup failed" };
  for (const error of [undefined, "Synthetic provider timeout stage"]) {
    writeFileSync(reportPath, JSON.stringify({ result: "fail", scope: "Unit fixture; no live provider was invoked", error }));
    const snapshot = finalizeInstalledLiveProviderEvidence(reportPath, enclosing);
    assert.equal(snapshot.result, "fail"); assert.equal(snapshot.cleanup_complete, false);
    assert.deepEqual(snapshot.cleanup, { app_closed: false });
    assert.equal(snapshot.error, error ?? enclosing.error);
  }
});

test("missing or malformed companion evidence fails finalization instead of silently omitting the snapshot", (t) => {
  const { reportPath } = installedLiveProviderEvidence("darwin", temporary(t));
  const report = { result: "fail", cleanup_complete: true, cleanup: {} };
  assert.throws(() => finalizeInstalledLiveProviderEvidence(reportPath, report), { code: "ENOENT" });
  writeFileSync(reportPath, "{invalid unit fixture");
  assert.throws(() => finalizeInstalledLiveProviderEvidence(reportPath, report), SyntaxError);
});
