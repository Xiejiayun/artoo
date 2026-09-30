import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readXCTestScreenshots, writeE2EReport } from "./e2e-report.mjs";

test("failure reports retain provenance, escape markup, redact credentials and embed immutable evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "artoo-report-test-"));
  try {
    const screenshot = join(directory, "screen.png");
    const pixels = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
    writeFileSync(screenshot, pixels);
    const output = writeE2EReport({ outputPath: join(directory, "report.html"), title: "A <script>alert(1)</script>",
      report: { passed: false, source: { commit: "abc123", branch: "main", working_tree_dirty: true }, environment: { platform: "test-platform" },
        started_at: "2026-01-01T00:00:00Z", finished_at: "2026-01-01T00:01:00Z", scope: "Fixture workflow only",
        error: "Request failed with Bearer PRIVATE_TOKEN at https://user:password@localhost/?access_token=PRIVATE_QUERY",
        control_token: "PRIVATE_CONTROL", nested: { pairing_code: "PRIVATE_CODE", cookie: "PRIVATE_COOKIE", input_tokens: 55 },
        checks: [{ name: "A&B \"failure\"", passed: false, duration_ms: 500 }] },
      screenshots: [{ path: screenshot, caption: "<img onerror=alert(1)>" }, { path: join(directory, "missing.png"), caption: "Missing evidence" }] });
    const html = readFileSync(output, "utf8");
    assert.match(html, />Failed</);
    for (const value of ["abc123", "main", "test-platform", "2026-01-01T00:01:00Z", "Fixture workflow only", "working tree changes", "Screenshot unavailable: Missing evidence"]) assert.ok(html.includes(value));
    assert.ok(html.includes(`data:image/png;base64,${pixels.toString("base64")}`));
    assert.ok(!html.includes(screenshot), "Report must not depend on a mutable external screenshot path");
    assert.ok(!html.includes("<script>"));
    assert.ok(!html.includes("<img onerror="));
    assert.match(html, /A&amp;B &quot;failure&quot;/);
    for (const secret of ["PRIVATE_TOKEN", "PRIVATE_QUERY", "PRIVATE_CONTROL", "PRIVATE_CODE", "PRIVATE_COOKIE", "user:password"]) assert.ok(!html.includes(secret), `${secret} leaked`);
    assert.match(html, /input_tokens.*55/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("XCTest reports only explicit workflow images from the current export manifest", () => {
  const directory = mkdtempSync(join(tmpdir(), "artoo-xcresult-report-test-"));
  try {
    writeFileSync(join(directory, "workflow.png"), "workflow evidence");
    writeFileSync(join(directory, "named.png"), "workflow evidence");
    writeFileSync(join(directory, "manifest.json"), JSON.stringify([{ attachments: [
      { exportedFileName: "workflow.png", suggestedHumanReadableName: "Native accepted plan with dependent tasks" },
      { exportedFileName: "named.png", name: "Native daemon online after real reconnect" },
      { exportedFileName: "named.png", name: "Native goal cancelled after explicit confirmation_0_fixture.png" },
      { exportedFileName: "failure.png", suggestedHumanReadableName: "Screenshot at failure" },
      { exportedFileName: "named.png", suggestedHumanReadableName: "Native UI failure" },
      { exportedFileName: "named.png", suggestedHumanReadableName: "Native future unreviewed screenshot" },
      { exportedFileName: "../escaped.png", suggestedHumanReadableName: "Native outside export" },
      { exportedFileName: "private.json", suggestedHumanReadableName: "Native UI tree" },
    ] }]));
    assert.deepEqual(readXCTestScreenshots(directory), [{ path: join(directory, "workflow.png"), caption: "Native accepted plan with dependent tasks" }, { path: join(directory, "named.png"), caption: "Native daemon online after real reconnect" }, { path: join(directory, "named.png"), caption: "Native goal cancelled after explicit confirmation_0_fixture.png" }]);
    rmSync(join(directory, "manifest.json"));
    assert.deepEqual(readXCTestScreenshots(directory), [], "A missing manifest must never reuse old screenshots");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Playwright attaches deliberate images once and excludes private failure context", async () => {
  const { default: Reporter } = await import("../apps/web/playwright.reporting.ts");
  const directory = mkdtempSync(join(tmpdir(), "artoo-web-report-test-"));
  try {
    writeFileSync(join(directory, "channels-390.png"), "workflow image");
    writeFileSync(join(directory, "automatic-failure.png"), "possibly sensitive onboarding image");
    const reporter = new Reporter();
    const result = { attachments: [{ name: "error-context", contentType: "text/markdown", body: Buffer.from("private pairing code") }] };
    const testCase = { parent: { project: () => ({ outputDir: directory }) } };
    reporter.onTestEnd(testCase, result);
    assert.deepEqual(result.attachments, [{ name: "Workflow · channels-390.png", contentType: "image/png", path: join(directory, "channels-390.png") }]);
    const later = { attachments: [] };
    reporter.onTestEnd(testCase, later);
    assert.deepEqual(later.attachments, [], "A later result must not inherit earlier screenshot evidence");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
