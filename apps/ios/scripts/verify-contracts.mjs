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
const files = (await readdir(join(ios, "Sources"), { recursive: true })).filter((name) => name.endsWith(".swift"));
const source = (await Promise.all(files.map((name) => readFile(join(ios, "Sources", name), "utf8")))).join("\n");
const routeFiles = ["app.ts", "auth/auth-routes.ts", "project-routes.ts", "resource-routes.ts", "artifact-routes.ts"];
const server = (await Promise.all(routeFiles.map((name) => readFile(resolve(root, "apps/server/src", name), "utf8")))).join("\n");
const routes = ["/auth/session", "/auth/logout", "/api/v1/devices/claim", "/api/v1/devices/pairings", "/api/v1/devices/:id/revoke",
  "/api/v1/bootstrap", "/api/v1/tasks", "/api/v1/tasks/:id/dependencies", executionApproval.route, "/api/v1/rooms/:id/messages", "/api/v1/runs/:id/cancel",
  "/api/v1/tasks/:id", "/api/v1/tasks/:id/ready", "/api/v1/tasks/:id/assign", "/api/v1/tasks/:id/retry", "/api/v1/tasks/:id/review", "/api/v1/runs/:id",
  "/api/v1/approvals/:id/resolve", "/api/v1/goals", "/api/v1/goals/:id/plans", "/api/v1/plans/:id/accept", "/api/v1/plans/:id/reject",
  "/api/v1/goals/:id/audit-bundle", "/api/v1/goals/:id/audit-bundle/export", "/api/v1/goals/:id/reconcile",
  "/api/v1/rooms/:roomId/decisions", "/api/v1/rooms/:roomId/handoffs", "/api/v1/rooms/:roomId/blockers",
  "/api/v1/memories", "/api/v1/memories/:id/supersede", "/api/v1/skills/install", "/api/v1/computers/presence",
  "/api/v1/computers/:id/runtimes", "/api/v1/computers/:id/instances", "/api/v1/agent-instances/:id", "/api/v1/artifacts/:id/content"];
for (const route of routes) assert.ok(server.includes(`"${route}"`), `Native contract requires a missing server route: ${route}`);
assert.ok(source.includes('"depends_on_task_id"'), "Native dependency writes require depends_on_task_id");
assert.ok(source.includes('"type": .string("blocks")'), "Plan dependencies must use a server-supported type");
assert.ok(source.includes("useMock: Bool = false"), "App must start in live onboarding, not a mock");
assert.ok(source.includes("kSecAttrAccessibleWhenUnlockedThisDeviceOnly"), "Control credential requires device-bound Keychain protection");
assert.ok(!/UserDefaults[^\n]*(?:token|Token)/.test(source), "Do not persist control tokens in UserDefaults");
const iconDir = join(ios, "Resources/Assets.xcassets/AppIcon.appiconset");
const catalog = JSON.parse(await readFile(join(iconDir, "Contents.json"), "utf8"));
for (const image of catalog.images) {
  const png = await readFile(join(iconDir, image.filename));
  assert.equal(png.toString("ascii", 1, 4), "PNG");
  assert.equal(png.readUInt32BE(16), 1024); assert.equal(png.readUInt32BE(20), 1024);
}
console.log(`iOS static contracts: ${samples.length} request specimens match server schemas; execution approval and assignment response fixtures match domain fields; ${routes.length} required routes exist; live onboarding, Keychain policy and icon dimensions checked.`);
console.log("This is a Windows static check. Xcode type checking, XCTest, device pairing and UI execution still require the Mac verification gate.");
