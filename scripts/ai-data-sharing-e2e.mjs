#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import { buildTestServer } from "../apps/server/dist/test-support.js";
import { buildAiDataSharingPolicy } from "../apps/server/dist/config/ai-data-sharing.js";
import { createSession } from "../apps/server/dist/auth/auth-service.js";
import { getE2EReportContext, writeE2EReport } from "./e2e-report.mjs";
import { closeOwnedBrowser } from "./owned-browser.mjs";

const started = new Date().toISOString();
const output = resolve("artifacts/ai-data-sharing", `web-${started.replace(/[:.]/g, "-")}`);
mkdirSync(output, { recursive: true });
const report = { ...getE2EReportContext(), started_at: started, passed: false, checks: [], cleanup: {},
  scope: "Real Web UI and authenticated HTTP against migrated fixture database. Explicit fictional external recipient; no external AI request or Google login. Enqueue and offline stop boundaries only; no native UI acceptance." };
const screenshots = [];
const save = () => {
  writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2));
  writeE2EReport({ outputPath: join(output, "report.html"), title: "Artoo · AI data sharing permission", report, screenshots });
};
save();
let server, browserServer, browser, page;
try {
  const policy = buildAiDataSharingPolicy({ mode: "external", providers: [{ id: "fixture", name: "Fixture AI recipient (test only)", privacy_url: "https://provider.example.com/privacy" }] });
  server = await buildTestServer({ aiDataSharingPolicy: policy, authConfig: { enforceApiAuth: true },
    deviceAuth: { devNodeToken: null, devControlEscape: false, pairingPepper: "isolated-consent-fixture" }, enableDevRoutes: false,
    webDistDir: resolve("apps/web/dist") });
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${server.app.server.address().port}`;
  const owner = await createSession(server.ctx, { ttlMs: 3600000 }, { userId: "user_owner" });
  const request = async (path, body) => {
    const response = await fetch(`${origin}${path}`, { method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${owner.raw}`, ...(body === undefined ? {} : { "Content-Type": "application/json", "Idempotency-Key": randomUUID() }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.ok, true, `${path}: ${response.status}`); return response.json();
  };
  assert.equal((await fetch(`${origin}/api/v1/privacy/ai-sharing`)).status, 401);
  const { task } = await request("/api/v1/tasks", { project_id: "proj_artoo", title: "Consent acceptance task", acceptance_criteria: ["Share only after permission"], required_capabilities: ["code.modify"] });
  await request(`/api/v1/tasks/${task.id}/ready`, {});
  browserServer = await chromium.launchServer({ headless: true, ...(process.env.ARTOO_CHROMIUM_CHANNEL ? { channel: process.env.ARTOO_CHROMIUM_CHANNEL } : {}) });
  browser = await chromium.connect(browserServer.wsEndpoint());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: "artoo_session", value: owner.raw, url: origin, httpOnly: true, sameSite: "Lax" }]);
  page = await context.newPage(); page.setDefaultTimeout(20000);
  const photo = async (name, caption) => { const path = join(output, name); await page.screenshot({ path, fullPage: true }); screenshots.push({ path, caption }); save(); };
  await page.goto(origin);
  await page.getByText("Consent acceptance task", { exact: true }).first().click();
  await page.getByRole("button", { name: "Assign", exact: true }).click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog.getByRole("heading", { name: "AI data sharing", exact: true })).toBeVisible();
  await expect(dialog.getByText("Fixture AI recipient (test only)", { exact: true })).toBeVisible();
  await photo("01-before-permission.png", "Actual recipient and data categories before permission; no run exists");
  assert.equal((await request(`/api/v1/tasks/${task.id}`)).runs.length, 0);
  await dialog.getByRole("button", { name: "Not now", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  assert.equal((await request(`/api/v1/tasks/${task.id}`)).runs.length, 0);
  await expect(page.getByRole("button", { name: "Assign", exact: true })).toBeEnabled();
  report.checks.push("Declining permission leaves the task ready with zero runs");
  await photo("02-declined.png", "Declined sharing; task remains ready and can be retried explicitly");
  await page.getByRole("button", { name: "Assign", exact: true }).click();
  await dialog.getByRole("button", { name: "Allow AI data sharing", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await request(`/api/v1/tasks/${task.id}`)).runs.length).toBe(1);
  assert.ok((await request("/api/v1/privacy/ai-sharing")).consent);
  report.checks.push("Explicit permission retries assignment exactly once and records one run");
  await page.goto(`${origin}/settings`);
  await page.getByRole("button", { name: "Review AI data sharing", exact: true }).click();
  await expect(page.getByText("You have allowed this team's current disclosure.", { exact: true })).toBeVisible();
  await photo("03-allowed-settings.png", "Recorded permission and withdrawal entry in Settings");
  await page.getByRole("button", { name: "Withdraw permission…", exact: true }).click();
  await page.getByRole("button", { name: "Withdraw and stop my agent work", exact: true }).click();
  await expect(page.getByText("Permission withdrawn.", { exact: true })).toBeVisible();
  await expect(page.getByText(/Stopping 1 work items could not be confirmed/)).toBeVisible();
  assert.equal((await request("/api/v1/privacy/ai-sharing")).consent, null);
  report.checks.push("Withdrawal is durable; offline process stop is explicitly unconfirmed");
  await photo("04-withdrawn-offline.png", "Withdrawal persisted; the disconnected computer's stop is not falsely reported as complete");
  await page.reload();
  await page.getByRole("button", { name: "Review AI data sharing", exact: true }).click();
  await expect(page.getByRole("button", { name: "Allow AI data sharing", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Withdraw permission…", exact: true }).click();
  await page.getByRole("button", { name: "Withdraw and stop my agent work", exact: true }).click();
  await expect(page.getByText(/Stopping 1 work items could not be confirmed/)).toBeVisible();
  report.checks.push("Reload preserves withdrawn permission and offers retry of unconfirmed stops");
  report.passed = true;
} catch (error) {
  report.error = String(error);
  if (page) { try { const path = join(output, "failure.png"); await page.screenshot({ path, fullPage: true }); screenshots.push({ path, caption: "Actual failure state" }); } catch {} }
} finally {
  if (browserServer) { report.cleanup.browser = await closeOwnedBrowser(browserServer); if (!report.cleanup.browser.closed) report.passed = false; }
  if (server) { try { await server.close(); report.cleanup.server = true; } catch (error) { report.cleanup.server = String(error); report.passed = false; } }
  report.finished_at = new Date().toISOString(); save();
}
console.log(JSON.stringify({ passed: report.passed, report: join(output, "report.html"), checks: report.checks, error: report.error }));
if (!report.passed) process.exitCode = 1;
