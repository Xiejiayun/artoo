import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import * as domain from "@artoo/domain";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const ios = resolve(root, "apps/ios");
const samples = JSON.parse(await readFile(join(ios, "Tests/Fixtures/requests.json"), "utf8"));
for (const { schema, body } of samples) {
  assert.ok(domain[schema], `Server schema missing: ${schema}`);
  assert.equal(domain[schema].safeParse(body).success, true, `Native request fixture no longer matches ${schema}`);
  if (body.thread_root_id) assert.equal(domain[schema].parse(body).thread_root_id, body.thread_root_id, `${schema} must preserve the native thread scope`);
}
const executionApproval = JSON.parse(await readFile(join(ios, "Tests/Fixtures/execution-approval.json"), "utf8"));
assert.equal(domain.ApprovalSchema.pick({ summary: true, risk: true }).safeParse(executionApproval.body).success, true);
assert.ok(executionApproval.body.summary.trim().length > 0 && executionApproval.body.summary.trim().length <= 4000);
assert.equal(domain.ApprovalSchema.safeParse(executionApproval.approval).success, true);
assert.equal(executionApproval.approval.action, "execution.start");
const assignment = JSON.parse(await readFile(join(ios, "Tests/Fixtures/assignment-response.json"), "utf8"));
assert.equal(domain.RunSchema.safeParse(assignment.run).success, true);
assert.equal(domain.SchedulerDecisionSchema.pick({ id: true, reason: true, score: true }).safeParse(assignment.scheduler_decision).success, true);
assert.equal("task" in assignment, false, "Assignment responds with run/scheduler_decision, not a task envelope");
const turnFixture = JSON.parse(await readFile(join(ios, "Tests/Fixtures/assistant-turns.json"), "utf8"));
for (const turn of turnFixture.turns) assert.equal(domain.AssistantTurnSchema.safeParse(turn).success, true, "Native assistant response drifted");
const discussionFixture = JSON.parse(await readFile(join(ios, "Tests/Fixtures/discussion.json"), "utf8"));
assert.equal(domain.DiscussionSchema.safeParse(discussionFixture).success, true, "Native discussion response drifted");
// The same complete reply is decoded by DiscussionPlanDraftTests on macOS.
const planMessage = JSON.parse(await readFile(join(ios, "Tests/Fixtures/discussion-plan-message.json"), "utf8"));
assert.equal(domain.MessageSchema.safeParse(planMessage).success, true, "Native suggested-plan message response drifted");
const planPreview = domain.DiscussionPlanPreviewSchema.parse(planMessage.payload.discussion_plan);
assert.deepEqual(planPreview, planMessage.payload.discussion_plan, "Native metadata fixture must include normalized TaskSpec defaults");
const originalPlan = JSON.parse(planMessage.body.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1"));
assert.equal(planPreview.rationale, originalPlan.rationale);
assert.deepEqual(planPreview.task_specs, originalPlan.task_specs.map((spec) => domain.TaskSpecSchema.parse(spec)), "The exact original reply and suggested-plan metadata must describe the same tasks");
const messagePage = JSON.parse(await readFile(join(ios, "Tests/Fixtures/message-page.json"), "utf8"));
for (const message of messagePage.messages) assert.equal(domain.MessageSchema.safeParse(message).success, true, "Native message response drifted");
for (const key of ["next_before", "next_after"]) assert.equal(typeof messagePage[key], "string");
assert.equal(typeof messagePage.has_more, "boolean");
const notificationPage = JSON.parse(await readFile(join(ios, "Tests/Fixtures/notification-page.json"), "utf8"));
assert.equal(domain.NotificationPageSchema.safeParse(notificationPage).success, true, "Native notification pagination response drifted");
assert.ok(notificationPage.unread_count > notificationPage.notifications.length, "Unread count must cover the whole inbox, not the loaded page");
const files = (await readdir(join(ios, "Sources"), { recursive: true })).filter((name) => name.endsWith(".swift"));
const source = (await Promise.all(files.map((name) => readFile(join(ios, "Sources", name), "utf8")))).join("\n");
const routeFiles = ["app.ts", "auth/auth-routes.ts", "project-routes.ts", "resource-routes.ts", "artifact-routes.ts", "ws/client-ws.ts", "assistant-routes.ts", "channel-routes.ts", "discussion-routes.ts"];
const server = (await Promise.all(routeFiles.map((name) => readFile(resolve(root, "apps/server/src", name), "utf8")))).join("\n");
const routes = ["/auth/session", "/auth/logout", "/api/v1/devices/claim", "/api/v1/devices/pairings", "/api/v1/devices/:id/revoke",
  "/api/v1/bootstrap", "/api/v1/tasks", "/api/v1/tasks/:id/dependencies", executionApproval.route, "/api/v1/rooms/:id/messages", "/api/v1/runs/:id/cancel",
  "/api/v1/tasks/:id", "/api/v1/tasks/:id/ready", "/api/v1/tasks/:id/assign", "/api/v1/tasks/:id/retry", "/api/v1/tasks/:id/review", "/api/v1/runs/:id",
  "/api/v1/approvals/:id/resolve", "/api/v1/goals", "/api/v1/goals/:id/plans", "/api/v1/plans/:id/accept", "/api/v1/plans/:id/reject",
  "/api/v1/goals/:id/audit-bundle", "/api/v1/goals/:id/audit-bundle/export", "/api/v1/goals/:id/reconcile",
  "/api/v1/rooms/:roomId/decisions", "/api/v1/rooms/:roomId/handoffs", "/api/v1/rooms/:roomId/blockers",
  "/api/v1/memories", "/api/v1/memories/:id/supersede", "/api/v1/skills/install", "/api/v1/computers/presence",
  "/api/v1/computers/:id/runtimes", "/api/v1/computers/:id/instances", "/api/v1/agent-instances/:id", "/api/v1/artifacts/:id/content",
  "/api/v1/ws", "/api/v1/rooms/:id/assistant-turns", "/api/v1/assistant-turns/:id/cancel", "/api/v1/assistant-turns/:id/retry",
  "/api/v1/channels", "/api/v1/members", "/api/v1/notifications", "/api/v1/notifications/:id/read", "/api/v1/rooms/:id/messages/:messageId", "/api/v1/daemons",
  "/api/v1/goals/:id/discussions", "/api/v1/discussions/:id", "/api/v1/discussions/:id/cancel", "/api/v1/discussions/:id/propose-plan", "/api/v1/runs/:id/usage"];
for (const route of routes) assert.ok(server.includes(`"${route}"`), `Native contract requires a missing server route: ${route}`);
assert.ok(source.includes('"depends_on_task_id"'), "Native dependency writes require depends_on_task_id");
assert.ok(source.includes('"type": .string("blocks")'), "Plan dependencies must use a server-supported type");
assert.ok(source.includes("useMock: Bool = false"), "App must start in live onboarding, not a mock");
assert.ok(source.includes("kSecAttrAccessibleWhenUnlockedThisDeviceOnly"), "Control credential requires device-bound Keychain protection");
assert.ok(!/UserDefaults[^\n]*(?:token|Token)/.test(source), "Do not persist control tokens in UserDefaults");
assert.ok(source.includes('"since_cursor"'), "Native realtime must resume with event cursors");
assert.ok(source.includes("idempotencyKey: pending.key"), "Unconfirmed room sends must reuse their logical identifier");
assert.ok(source.includes("[origin, user, room]"), "Room drafts must be isolated by origin, user and room");
assert.ok(source.includes("task.cancel(with: .goingAway"), "Native realtime must close discarded sessions");
const iconDir = join(ios, "Resources/Assets.xcassets/AppIcon.appiconset");
const catalog = JSON.parse(await readFile(join(iconDir, "Contents.json"), "utf8"));
for (const image of catalog.images) {
  const png = await readFile(join(iconDir, image.filename));
  assert.equal(png.toString("ascii", 1, 4), "PNG");
  assert.equal(png.readUInt32BE(16), 1024); assert.equal(png.readUInt32BE(20), 1024);
}
console.log(`iOS static contracts: ${samples.length} request specimens match server schemas; execution approval, assignment, assistant turns, discussions, suggested plans, paginated messages and notifications match domain fields; ${routes.length} required routes exist; native realtime, scoped drafts, stable sends, live onboarding, Keychain policy and icon dimensions checked.`);
console.log("This is a Windows static check. Xcode type checking, XCTest, device pairing and UI execution still require the Mac verification gate.");
