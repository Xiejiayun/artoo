#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, expect } from "@playwright/test";
import { buildTestServer } from "../apps/server/dist/test-support.js";
import { createSession, provisionUser } from "../apps/server/dist/auth/auth-service.js";
import { getE2EReportContext, writeE2EReport } from "./e2e-report.mjs";
import { closeOwnedBrowser } from "./owned-browser.mjs";

const output = resolve("artifacts/content-moderation", `web-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(output, { recursive: true });
const report = { ...getE2EReportContext(), started_at: new Date().toISOString(), passed: false, checks: [], cleanup: {},
  scope: "Real Chrome UI, production authorization and migrated fixture database. Three disposable team identities; fixture sessions are minted directly. No real Google login, native UI, external AI or deployed service claim." };
const photos = [];
const save = () => { writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2)); writeE2EReport({ outputPath: join(output, "report.html"), title: "Artoo · team content moderation", report, screenshots: photos }); };
save();
let server, browserServer, browser;
const pages = [];
try {
  assert.ok(report.source.commit && report.source.tracked_diff_sha256 && report.source.untracked_source_complete
    && report.source.untracked_source_sha256, "A complete source fingerprint is required before E2E");
  server = await buildTestServer({ authConfig: { enforceApiAuth: true }, clientWsHooks: { revalidateIntervalMs: 50 },
    deviceAuth: { devNodeToken: null, devControlEscape: false, pairingPepper: "moderation-e2e-fixture" }, enableDevRoutes: false, webDistDir: resolve("apps/web/dist") });
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  const origin = `http://127.0.0.1:${server.app.server.address().port}`;
  const owner = { id: "user_owner", token: (await createSession(server.ctx, { ttlMs: 3600000 }, { userId: "user_owner" })).raw };
  async function person(name) {
    const id = (await provisionUser(server.ctx, { subject: name, email: `${name.toLowerCase()}@moderation.test`, emailVerified: true, displayName: name })).userId;
    return { id, token: (await createSession(server.ctx, { ttlMs: 3600000 }, { userId: id })).raw };
  }
  const reporter = await person("Reporter"), author = await person("Author");
  async function request(path, token = owner.token, body) {
    const response = await fetch(origin + path, { method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.ok(response.ok, `${path}: ${response.status}`); return response.json();
  }
  const { channel } = await request("/api/v1/channels", owner.token, { project_id: "proj_artoo", name: "content-review-fixture" });
  assert.equal((await fetch(origin + "/api/v1/moderation/reports")).status, 401);
  browserServer = await chromium.launchServer({ headless: true, ...(process.env.ARTOO_CHROMIUM_CHANNEL ? { channel: process.env.ARTOO_CHROMIUM_CHANNEL } : {}) });
  browser = await chromium.connect(browserServer.wsEndpoint());
  async function session(user, offlineSocket = false) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addCookies([{ name: "artoo_session", value: user.token, url: origin, httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage(); page.setDefaultTimeout(25000); pages.push(page);
    if (offlineSocket) await page.routeWebSocket("**/api/v1/ws", (socket) => socket.close({ code: 1013, reason: "Fixture WebSocket outage" }));
    await page.goto(`${origin}/channels?room=${encodeURIComponent(channel.id)}`);
    await expect(page.getByRole("heading", { name: "# content-review-fixture", exact: true })).toBeVisible();
    return { page, context };
  }
  const authorSession = await session(author), live = await session(reporter), polling = await session(reporter, true), staff = await session(owner);
  const text = "Content reported in this isolated acceptance fixture";
  async function send(page, body) {
    const form = page.getByRole("form", { name: "Send room message" });
    await form.getByLabel("Message", { exact: true }).fill(body);
    await form.getByRole("button", { name: "Send message", exact: true }).click();
  }
  async function photo(page, name, caption) {
    const path = join(output, name); await page.screenshot({ path, fullPage: true }); photos.push({ path, caption }); save();
  }
  await send(authorSession.page, text);
  await expect(live.page.getByText(text, { exact: true })).toBeVisible();
  await expect(polling.page.getByText(text, { exact: true })).toBeVisible();
  // Keep the target in both clients' loaded history, then move it beyond the latest page.
  for (let n = 0; n < 60; n++) await request(`/api/v1/rooms/${channel.id}/messages`, owner.token, { kind: "text", body: `Later fixture note ${n}` });
  await expect(live.page.getByText("Later fixture note 59", { exact: true })).toBeVisible();
  await expect(polling.page.getByText("Later fixture note 59", { exact: true })).toBeVisible();
  await live.page.getByLabel("Message", { exact: true }).fill("Keep my unsent report-adjacent draft");
  await live.page.getByText(text, { exact: true }).scrollIntoViewIfNeeded();
  await photo(live.page, "01-loaded-history.png", "Reporter retains the older message and an unsent draft before reporting");
  await live.page.locator("article.msg").filter({ hasText: text }).getByRole("button", { name: "Report message", exact: true }).click();
  const dialog = live.page.getByRole("dialog", { name: "Report message", exact: true });
  await dialog.getByLabel("Report reason").fill("Please review this fixture content");
  await dialog.getByRole("button", { name: "Send report", exact: true }).click();
  await expect(dialog.getByText("Report received. Your team administrators can now review it.")).toBeVisible();
  await photo(live.page, "02-report-received.png", "The selected message is privately reported through the real UI");
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  report.checks.push("A member reports an older real message without losing the unrelated unsent draft");
  await staff.page.goto(origin + "/settings");
  await staff.page.getByRole("button", { name: "Open content management", exact: true }).click();
  const review = staff.page.locator("article").filter({ hasText: "Please review this fixture content" });
  await expect(review.getByText(/author@moderation.test/)).toBeVisible();
  await review.getByText("View reported content", { exact: true }).click();
  await expect(review.getByText(text, { exact: true })).toBeVisible();
  await photo(staff.page, "03-private-staff-review.png", "Administrator sees the authoritative sender and original report evidence");
  await review.getByRole("button", { name: "Remove message", exact: true }).click();
  const confirmation = staff.page.getByRole("dialog", { name: "Remove this message?", exact: true });
  await confirmation.getByLabel("Private staff note").fill("STAFF_ONLY_E2E: reviewed and removed");
  await confirmation.getByRole("button", { name: "Confirm removal", exact: true }).click();
  await expect(confirmation).toHaveCount(0);
  const notice = "This message was removed by a team administrator.";
  for (const item of [live, polling]) {
    await expect(item.page.getByText(text, { exact: true })).toHaveCount(0, { timeout: 30000 });
    await item.page.getByText(notice, { exact: true }).scrollIntoViewIfNeeded();
    await expect(item.page.getByText(notice, { exact: true })).toBeVisible();
  }
  await expect(live.page.getByLabel("Message", { exact: true })).toHaveValue("Keep my unsent report-adjacent draft");
  await photo(live.page, "04-live-removal.png", "The open live conversation removes old content while preserving the draft");
  await photo(polling.page, "05-http-removal.png", "HTTP reconciliation removes the same old content while WebSocket access is unavailable");
  report.checks.push("Both live and HTTP-only clients redact a loaded message older than the latest50 rows");
  await live.page.goto(origin + "/settings");
  await live.page.getByRole("button", { name: "View my reports", exact: true }).click();
  await expect(live.page.getByRole("heading", { name: "Message removed", exact: true })).toBeVisible();
  await expect(live.page.getByText(/STAFF_ONLY_E2E/)).toHaveCount(0);
  await expect(live.page.getByRole("button", { name: "Open content management", exact: true })).toHaveCount(0);
  await photo(live.page, "06-private-result.png", "Reporter sees the result, without private staff notes or administrator controls");
  await staff.page.getByRole("button", { name: "Member access", exact: true }).click();
  const member = staff.page.locator("article").filter({ hasText: "author@moderation.test" });
  await member.getByRole("button", { name: "Suspend member", exact: true }).click();
  const access = staff.page.getByRole("dialog", { name: "Suspend Author?", exact: true });
  await access.getByLabel("Access change reason").fill("Reviewed repeated fixture misconduct");
  await access.getByRole("button", { name: "Confirm suspension", exact: true }).click();
  await expect(access).toHaveCount(0);
  await expect(authorSession.page.getByRole("form", { name: "Send room message" })).toHaveCount(0);
  assert.equal((await authorSession.context.request.get(origin + "/api/v1/bootstrap")).status(), 401);
  await photo(authorSession.page, "07-suspended-session.png", "Suspending the member removes their active workspace session");
  report.checks.push("Staff suspension closes the existing member session and blocks its authenticated API");
  await member.getByRole("button", { name: "Reinstate member", exact: true }).click();
  const reinstate = staff.page.getByRole("dialog", { name: "Reinstate Author?", exact: true });
  await reinstate.getByLabel("Access change reason").fill("Fixture appeal reviewed");
  await reinstate.getByRole("button", { name: "Confirm reinstatement", exact: true }).click();
  await expect(reinstate).toHaveCount(0);
  assert.equal((await authorSession.context.request.get(origin + "/api/v1/bootstrap")).status(), 401);
  const renewed = await createSession(server.ctx, { ttlMs: 3600000 }, { userId: author.id });
  await authorSession.context.clearCookies();
  await authorSession.context.addCookies([{ name: "artoo_session", value: renewed.raw, url: origin, httpOnly: true, sameSite: "Lax" }]);
  await authorSession.page.goto(`${origin}/channels?room=${channel.id}`);
  await staff.page.getByRole("button", { name: "Posting rules", exact: true }).click();
  await staff.page.getByLabel("Blocked phrases, one per line").fill("fixture prohibited phrase");
  await staff.page.getByRole("button", { name: "Save posting rules", exact: true }).click();
  await expect.poll(async () => (await request("/api/v1/moderation/rules")).blocked_phrases).toEqual(["fixture prohibited phrase"]);
  await send(authorSession.page, "FIXTURE prohibited phrase");
  await expect(authorSession.page.getByText("This content conflicts with your team's posting rules. Edit it or contact a team administrator.", { exact: true })).toBeVisible();
  await expect(authorSession.page.getByLabel("Message", { exact: true })).toHaveValue("FIXTURE prohibited phrase");
  await photo(authorSession.page, "08-filtered-draft.png", "Configured rules reject the new post and preserve text for editing");
  report.checks.push("Reinstatement requires a new session; configured filtering blocks posting and retains the rejected draft");
  report.passed = true;
} catch (error) {
  report.error = String(error);
  for (let i = 0; i < pages.length; i++) { try { const path = join(output, `failure-${i}.png`); await pages[i].screenshot({ path, fullPage: true }); photos.push({ path, caption: `Actual failure state in fixture client ${i}` }); } catch {} }
} finally {
  if (browserServer) { report.cleanup.browser = await closeOwnedBrowser(browserServer); if (!report.cleanup.browser.closed) report.passed = false; }
  if (server) { try { await server.close(); report.cleanup.server_closed = true; } catch { report.cleanup.server_closed = false; report.passed = false; } }
  report.source_at_finish = getE2EReportContext().source;
  report.source_stable = report.source_at_finish.untracked_source_complete === true && !!report.source_at_finish.untracked_source_sha256
    && JSON.stringify(report.source_at_finish) === JSON.stringify(report.source);
  if (!report.source_stable) report.passed = false;
  report.finished_at = new Date().toISOString(); save();
}
console.log(JSON.stringify({ passed: report.passed, report: join(output, "report.html"), error: report.error, checks: report.checks }));
if (!report.passed) process.exitCode = 1;
