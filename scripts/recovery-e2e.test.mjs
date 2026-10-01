import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("recovery CLI exits unsuccessfully after a real workflow failure and successful cleanup", () => {
  // Fail only after the production server has persisted a task, message and
  // subprocess artifact. Closing that embedded database can reset exitCode.
  const result = spawnSync(process.execPath, [join(root, "scripts/recovery-e2e.mjs")], {
    cwd: root, encoding: "utf8", timeout: 90_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    env: { ...process.env, ARTOO_CHROMIUM_CHANNEL: "artoo-intentionally-invalid-recovery-test" },
  });
  assert.equal(result.error, undefined);
  const reportPath = result.stdout.match(/^\[recovery\] HTML report: (.+)\r?$/m)?.[1].trim();
  assert.ok(reportPath, `Recovery must finish its report: ${result.stdout}\n${result.stderr}`);
  const directory = resolve(dirname(reportPath));
  const expectedParent = resolve(root, "artifacts/recovery");
  assert.equal(dirname(directory), expectedParent, "Only this drill's report directory may be removed");
  assert.ok(directory.startsWith(`${expectedParent}${sep}`));
  try {
    const report = JSON.parse(readFileSync(join(directory, "report.json"), "utf8"));
    assert.equal(report.passed, false);
    assert.match(report.error, /Unsupported chromium channel.*artoo-intentionally-invalid-recovery-test/);
    assert.equal(report.checks.length, 2, "The fault must follow real production execution, not fail during setup");
    assert.ok(report.checks.every((check) => check.passed));
    assert.equal(report.cleanup_complete, true, "Actual embedded-server and temporary-data cleanup must finish");
    assert.match(result.stdout, /\[recovery\] FAIL; cleanup=true/);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1, "A failed recovery report must fail CI even after successful cleanup");
  } finally {
    // This is deliberate fault-injection evidence, not a failed recovery run
    // to include among the normal before/after recovery artifacts.
    rmSync(directory, { recursive: true, force: true });
  }
});
