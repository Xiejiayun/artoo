import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "../../../scripts/e2e-report.mjs";

export function installedLiveProviderEvidence(platform, artifactDir) {
  assert.ok(["darwin", "win32"].includes(platform), "Installed live verification supports macOS and Windows");
  // Retain existing Windows evidence paths for operator scripts and old reports.
  const prefix = platform === "win32" ? "windows-live-copilot" : "macos-live-provider";
  return { platform, platformName: platform === "darwin" ? "macOS" : "Windows",
    reportPath: join(artifactDir, `${prefix}.json`),
    planScreenshotPath: join(artifactDir, `${prefix}-plan.png`),
    chatScreenshotPath: join(artifactDir, `${prefix}-chat.png`) };
}

export function installedLiveProviderPlan(platform, artifactDir, env = process.env) {
  // Do not inspect provider settings or load the runner without explicit opt-in.
  if (env.ARTOO_DESKTOP_LIVE_CODEX !== "1") return null;
  const scope = env.ARTOO_DESKTOP_LIVE_SCOPE ?? (platform === "darwin" ? "discussion" : "all");
  assert.ok(["all", "discussion"].includes(scope), "ARTOO_DESKTOP_LIVE_SCOPE must be all or discussion");
  return { ...installedLiveProviderEvidence(platform, artifactDir), scope, expectedTurns: scope === "all" ? 5 : 3 };
}

// Embed the finalized result in the enclosing report, whose history copy must
// remain reviewable after the next run replaces the companion JSON and images.
export function finalizeInstalledLiveProviderEvidence(reportPath, enclosingReport) {
  const liveReport = JSON.parse(readFileSync(reportPath, "utf8"));
  liveReport.cleanup_complete = enclosingReport.cleanup_complete;
  liveReport.cleanup = enclosingReport.cleanup;
  if (enclosingReport.result !== "pass") {
    liveReport.result = "fail";
    liveReport.error ??= enclosingReport.error;
  }
  const snapshot = redact(liveReport);
  writeFileSync(reportPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  return snapshot;
}

/** The real runner is imported only after opt-in. The injectable module loader
 * is a unit-test seam; the packaged smoke always uses the real implementation.
 */
export async function runOptionalInstalledLiveProvider(options, { env = process.env, loadRunner = () => import("./installed-live-provider.mjs") } = {}) {
  const plan = installedLiveProviderPlan(options.platform, options.artifactDir, env);
  if (plan === null) return null;
  options.onStart?.(plan);
  const { runInstalledLiveProvider } = await loadRunner();
  const expectedPaths = [plan.planScreenshotPath, ...(plan.scope === "all" ? [plan.chatScreenshotPath] : [])];
  const registered = new Set();
  const registerScreenshot = (screenshot) => {
    assert.ok(expectedPaths.includes(screenshot.path) && existsSync(screenshot.path), "Live verification is missing its captured workflow image");
    if (registered.has(screenshot.path)) return;
    registered.add(screenshot.path);
    options.onScreenshot?.(screenshot);
  };
  // Register each capture immediately so a later runner failure cannot drop
  // completed workflow images from the enclosing failure report.
  const live = await runInstalledLiveProvider({ ...options, env, onScreenshot: registerScreenshot });
  assert.equal(live.reportPath, plan.reportPath, "Live report must use the selected platform's evidence path");
  for (const path of expectedPaths) {
    assert.ok(live.screenshots?.some((item) => item.path === path) && existsSync(path), "Live verification is missing its captured workflow image");
  }
  for (const screenshot of live.screenshots) registerScreenshot(screenshot);
  return { ...live, plan };
}
