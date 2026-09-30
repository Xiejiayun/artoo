import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReporterDescription } from "@playwright/test";
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import { getE2EReportContext } from "../../scripts/e2e-report.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export function htmlEvidence(suite: string, scope: string) {
  const run = `${suite}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const context = getE2EReportContext();
  return {
    globalSetup: join(here, "playwright.browser-metadata.ts"),
    outputDir: join(here, "test-results", run),
    metadata: { ...context.environment, source_commit: context.source.commit ?? "unavailable", source_branch: context.source.branch ?? "unavailable", working_tree_dirty: context.source.working_tree_dirty,
      tracked_diff_sha256: context.source.tracked_diff_sha256, untracked_source_sha256: context.source.untracked_source_sha256, untracked_source_files: context.source.untracked_source_files, untracked_source_complete: context.source.untracked_source_complete,
      browser_channel: process.env.ARTOO_CHROMIUM_CHANNEL?.trim() || "playwright-bundled-chromium", scope },
    reporter: [
      ["list"],
      [fileURLToPath(import.meta.url)],
      ["html", { outputFolder: join(here, "playwright-report", run), open: "never" }],
    ] as ReporterDescription[],
  };
}

// Existing E2Es deliberately capture workflow screens after sensitive pairing
// forms have closed. Attach those images to HTML without enabling unmasked
// automatic screenshots or network traces for the device-management tests.
export default class WorkflowScreenshotReporter implements Reporter {
  private seen = new Set<string>();
  onTestEnd(test: TestCase, result: TestResult) {
    // Playwright's automatic accessibility dump can include the visible
    // one-time code even when screenshots and traces are disabled.
    result.attachments = result.attachments.filter((attachment) => attachment.name !== "error-context" && attachment.name !== "trace");
    // These suites use one worker. New files at this boundary belong to this
    // completed result; each suite has a fresh timestamped output directory.
    const directory = test.parent.project()?.outputDir;
    if (!directory) return;
    let files;
    try { files = readdirSync(directory, { withFileTypes: true, recursive: true }); } catch { return; }
    for (const file of files.filter((item) => item.isFile() && /^(?:historical-mention|suggested-plan-\d+|workspace(?:-review)?-\d+|channels-\d+)\.png$/.test(item.name))) {
      const path = join(file.parentPath, file.name);
      if (this.seen.has(path)) continue;
      this.seen.add(path);
      if (!result.attachments.some((attachment) => attachment.path === path)) result.attachments.push({ name: `Workflow · ${file.name}`, contentType: "image/png", path });
    }
  }
  printsToStdio() { return false; }
}
