import { createHash } from "node:crypto";
import { eventLog, goals, goalAutomations, idempotencyKeys, users } from "@artoo/db";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./test-support.js";
import { loadGoalEntryConfig } from "./config/goal-entry.js";

const request = { project_id: "proj_artoo", objective: "Build a personal task tracker", execution_mode: "agent_team" as const,
  verification_profile_id: "native-web", release_profile_id: "native-publish", max_retries: 3,
  source_handoff: { version: 1 as const, mode: "automatic" as const } };
const defaults = { execution_mode: request.execution_mode, verification_profile_id: request.verification_profile_id,
  release_profile_id: request.release_profile_id, max_retries: request.max_retries, source_handoff: request.source_handoff };
const config = (owner: "console" | "browser") => loadGoalEntryConfig({ ARTOO_GOAL_ENTRY: JSON.stringify({
  version: 1, session_id: "session-one", project_id: "proj_artoo", actor_user_id: "user_owner", request_key: "request-one",
  submission_owner: owner, request: defaults, ...(owner === "console" ? { objective: request.objective } : {}),
}) });

describe("prepared product request and atomic autonomous submission", () => {
  let server: TestServer;
  beforeEach(async () => { server = await buildTestServer(); });
  afterEach(async () => { await server.close(); });
  const post = (body: Record<string, unknown> = request, key = "request-one", url = "/api/v1/autonomous-goals") => server.app.inject({
    method: "POST", url, headers: { "idempotency-key": key }, payload: body,
  });

  it("commits one goal and one authorization event for concurrent requests and a lost response replay", async () => {
    const responses = await Promise.all([post(), post()]);
    expect(responses.map(value => value.statusCode)).toEqual([201, 201]);
    const id = responses[0]!.json().goal.id;
    expect(responses[1]!.json().goal.id).toBe(id);
    // A caller that lost its response sends the original key and the complete original body.
    const replay = await post();
    expect(replay.statusCode).toBe(201); expect(replay.json().goal.id).toBe(id);
    expect(await server.db.db.select().from(goals)).toHaveLength(1);
    expect(await server.db.db.select().from(goalAutomations)).toHaveLength(1);
    expect((await server.db.db.select().from(eventLog)).filter(row => row.type === "goal.product-handoff.authorized")).toHaveLength(1);
    expect((await server.db.db.select().from(idempotencyKeys)).every(row => row.responseJson !== null)).toBe(true);
    expect((await post({ ...request, objective: "A different requirement" })).statusCode).toBe(409);
    expect((await post({ ...request, source_handoff: undefined })).statusCode).toBe(409);
    expect((await post({ ...request, ignored_extra: true })).statusCode).toBe(409);
    const { objective: originalObjective, ...sameRequest } = request;
    expect((await post({ ...sameRequest, objective: originalObjective })).statusCode).toBe(409);
    expect((await post({ ...request, objective: ` ${request.objective} ` })).statusCode).toBe(409);
  });

  it("rolls back the reservation with failed creation and keeps ordinary project multi-goal behavior", async () => {
    const policy = server.ctx.aiDataSharingPolicy; server.ctx.aiDataSharingPolicy = null;
    expect((await post()).statusCode).toBe(503);
    expect(await server.db.db.select().from(idempotencyKeys)).toHaveLength(0);
    expect(await server.db.db.select().from(goals)).toHaveLength(0);
    server.ctx.aiDataSharingPolicy = policy;
    expect((await post()).statusCode).toBe(201);
    expect((await post({ ...request, objective: "Another product" }, "request-two")).statusCode).toBe(201);
    expect((await server.app.inject({ method: "POST", url: "/api/v1/goals", payload: { project_id: "proj_artoo", title: "Manual goal" } })).statusCode).toBe(201);
    expect(await server.db.db.select().from(goals)).toHaveLength(3);
    expect((await server.app.inject("/api/v1/bootstrap")).json()).not.toHaveProperty("goal_entry");
  });

  it("retains legacy raw-body responses and fails closed on legacy unknown outcomes", async () => {
    const created = await server.app.inject({ method: "POST", url: "/api/v1/autonomous-goals", payload: request });
    expect(created.statusCode).toBe(201);
    const scope = "org_default:user_owner:POST:/api/v1/autonomous-goals";
    const requestHash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    await server.db.db.insert(idempotencyKeys).values([{ scope, key: "legacy", requestHash,
      responseJson: { status: 201, body: created.json() }, eventIds: [], createdAt: server.ctx.clock.nowIso() },
    { scope, key: "unknown", requestHash, responseJson: null, eventIds: [], createdAt: server.ctx.clock.nowIso() }]);
    expect((await post(request, "legacy")).json().goal.id).toBe(created.json().goal.id);
    expect((await post(request, "unknown")).statusCode).toBe(409);
    expect(await server.db.db.select().from(goals)).toHaveLength(1);
    expect((await server.db.db.select().from(idempotencyKeys)).find(row => row.key === "unknown")?.responseJson).toBeNull();
  });

  it("scopes the same key to the actual actor and URL without weakening API authentication", async () => {
    const first = await post(); expect(first.statusCode).toBe(201);
    const [owner] = await server.db.db.select().from(users);
    await server.db.db.insert(users).values({ ...owner!, id: "user_other", email: "other@example.test" });
    server.ctx.actorUserId = "user_other";
    const other = await post(); expect(other.statusCode).toBe(201); expect(other.json().goal.id).not.toBe(first.json().goal.id);
    expect((await post(request, "request-one", "/api/v1/autonomous-goals?attempt=separate")).statusCode).toBe(201);
    server.ctx.authConfig.enforceApiAuth = true;
    expect((await post(request, "not-authenticated")).statusCode).toBe(401);
    expect((await server.app.inject("/api/v1/bootstrap")).statusCode).toBe(401);
    expect(await server.db.db.select().from(goals)).toHaveLength(3);
  });

  it("makes console sessions monitor-only while accepting only the authorized original request", async () => {
    server.ctx.goalEntry = config("console");
    const snapshot = (await server.app.inject("/api/v1/bootstrap")).json().goal_entry;
    expect(snapshot).toEqual({ version: 1, session_id: "session-one", project_id: "proj_artoo", submission_owner: "console", goal_id: null });
    expect(snapshot).not.toHaveProperty("request_key"); expect(snapshot).not.toHaveProperty("objective");
    expect((await server.app.inject({ method: "POST", url: "/api/v1/goals", payload: { project_id: "proj_artoo", title: "Bypass" } })).statusCode).toBe(409);
    expect((await post(request, "another-key")).statusCode).toBe(409);
    expect((await post({ ...request, objective: "Changed in browser" })).statusCode).toBe(409);
    expect((await post(request, "request-one", "/api/v1/autonomous-goals?extra=scope")).statusCode).toBe(409);
    const created = await post(); expect(created.statusCode).toBe(201);
    expect((await post()).json().goal.id).toBe(created.json().goal.id);
    expect((await server.app.inject("/api/v1/bootstrap")).json().goal_entry.goal_id).toBe(created.json().goal.id);
    expect(await server.db.db.select().from(goals)).toHaveLength(1);
  });

  it("accepts one browser objective per session and permits a later session on the same project", async () => {
    server.ctx.goalEntry = config("browser");
    expect((await server.app.inject("/api/v1/bootstrap")).json().goal_entry).toMatchObject({
      submission_owner: "browser", request_key: "request-one", request: defaults,
    });
    expect((await post({ ...request, verification_profile_id: "default" })).statusCode).toBe(409);
    const created = await post(); expect(created.statusCode).toBe(201);
    expect((await post({ ...request, objective: "Replacement" })).statusCode).toBe(409);
    server.ctx.goalEntry = { ...server.ctx.goalEntry!, session_id: "session-two", request_key: "request-two" };
    expect((await post({ ...request, objective: "Next product" }, "request-two")).statusCode).toBe(201);
    expect(await server.db.db.select().from(goals)).toHaveLength(2);
    const project = await server.app.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "Ordinary project" } });
    expect(project.statusCode).toBe(201);
    expect((await server.app.inject({ method: "POST", url: "/api/v1/goals", payload: { project_id: project.json().project.id, title: "Unaffected" } })).statusCode).toBe(201);
  });

  it("rejects the prepared project request from another actor without exposing the session configuration", async () => {
    server.ctx.goalEntry = config("browser");
    const [owner] = await server.db.db.select().from(users);
    await server.db.db.insert(users).values({ ...owner!, id: "user_other", email: "other@example.test" });
    server.ctx.actorUserId = "user_other";
    expect((await server.app.inject("/api/v1/bootstrap")).json()).not.toHaveProperty("goal_entry");
    expect((await post()).statusCode).toBe(403);
    expect(await server.db.db.select().from(goals)).toHaveLength(0);
  });
});

describe("local prepared session configuration", () => {
  it("only declares polling for the explicit loopback development mode with real node auth retained", () => {
    const value = { ...config("browser")!, progress_updates: "polling" };
    const env = { ARTOO_GOAL_ENTRY: JSON.stringify(value), NODE_ENV: "development", AUTH_ENFORCE_API: "0",
      ARTOO_HOST: "127.0.0.1", ARTOO_ALLOW_DEV_NODE_TOKEN: "0" };
    expect(loadGoalEntryConfig(env)?.progress_updates).toBe("polling");
    for (const change of [{ NODE_ENV: "production" }, { AUTH_ENFORCE_API: "1" }, { ARTOO_HOST: "0.0.0.0" }, { ARTOO_ALLOW_DEV_NODE_TOKEN: "1" }]) {
      expect(() => loadGoalEntryConfig({ ...env, ...change })).toThrow(/loopback development/);
    }
  });
  it("is absent by default and rejects unknown versions, keys and mixed input ownership", () => {
    expect(loadGoalEntryConfig({})).toBeUndefined();
    const valid = config("browser")!;
    for (const change of [{ version: 2 }, { objective: "CLI input in browser mode" }, { request_key: "" }, { extra: true }]) {
      expect(() => loadGoalEntryConfig({ ARTOO_GOAL_ENTRY: JSON.stringify({ ...valid, ...change }) })).toThrow();
    }
    expect(Object.isFrozen(valid)).toBe(true); expect(Object.isFrozen(valid.request.source_handoff)).toBe(true);
  });
});
