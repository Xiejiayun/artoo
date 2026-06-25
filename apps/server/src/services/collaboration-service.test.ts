import { eventLog, messages, rooms } from "@artoo/db";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "../test-support.js";
import {
  createBlocker,
  createDecision,
  createHandoff,
  getDecision,
  listDecisions,
  resolveBlockersForSource,
  setBlockerStatus,
  setDecisionStatus,
  setHandoffStatus,
  whoWaitsOnWhom,
} from "./collaboration-service.js";

const ROOM = "room_team";
const OTHER_ROOM = "room_other";

describe("collaboration-service", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await buildTestServer();
    const now = server.ctx.clock.nowIso();
    await server.db.db.insert(rooms).values([
      { id: ROOM, organizationId: "org_default", type: "agent_team", name: "Team", createdAt: now },
      { id: OTHER_ROOM, organizationId: "org_default", type: "agent_team", name: "Other", createdAt: now },
    ]);
  });

  afterEach(async () => {
    await server.close();
  });

  async function eventsOfType(type: string): Promise<Array<Record<string, unknown>>> {
    const rows = await server.db.db
      .select()
      .from(eventLog)
      .where(and(eq(eventLog.organizationId, "org_default"), eq(eventLog.type, type)));
    return rows.map((r) => r.payload as Record<string, unknown>);
  }

  it("creates a decision in 'proposed' state and emits a metadata-only event", async () => {
    const { ctx } = server;
    const dec = await createDecision(ctx, {
      room_id: ROOM,
      actor_type: "agent",
      actor_id: "SkywalkerCodex",
      summary: "Adopt migration 0012 numbering",
      rationale: "Avoids collision with #115",
      alternatives: ["renumber later"],
      evidence_refs: ["msg_abc"],
    });
    expect(dec.status).toBe("proposed");
    expect(dec.id).toMatch(/^dec_/);
    expect(await getDecision(ctx, dec.id)).toEqual(dec);

    const payloads = await eventsOfType("decision.proposed");
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ decision_id: dec.id, actor_id: "SkywalkerCodex" });
    // Secret-safe: the summary/rationale text is NOT copied into the event payload.
    expect(JSON.stringify(payloads[0])).not.toContain("migration 0012");
  });

  it("promotes a message into a decision idempotently (no duplicate per source message)", async () => {
    const { ctx, db } = server;
    const now = ctx.clock.nowIso();
    await db.db.insert(messages).values({
      id: "msg_src",
      organizationId: "org_default",
      roomId: ROOM,
      actorType: "agent",
      actorId: "SkywalkerClaude",
      kind: "decision",
      body: "Let's ship it",
      createdAt: now,
    });
    const first = await createDecision(ctx, {
      room_id: ROOM,
      source_message_id: "msg_src",
      actor_type: "agent",
      actor_id: "SkywalkerClaude",
      summary: "Ship it",
    });
    const second = await createDecision(ctx, {
      room_id: ROOM,
      source_message_id: "msg_src",
      actor_type: "agent",
      actor_id: "SkywalkerClaude",
      summary: "Ship it (dup attempt)",
    });
    expect(second.id).toBe(first.id);
    expect(await listDecisions(ctx, ROOM)).toHaveLength(1);
    // Only the first creation emitted an event.
    expect(await eventsOfType("decision.proposed")).toHaveLength(1);
  });

  it("rejects collaboration records for a room outside the org scope", async () => {
    await expect(
      createDecision(server.ctx, {
        room_id: "room_missing",
        actor_type: "agent",
        actor_id: "SkywalkerClaude",
        summary: "wrong room",
      }),
    ).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("rejects decision promotion when source_message_id belongs to another room", async () => {
    const { ctx, db } = server;
    const now = ctx.clock.nowIso();
    await db.db.insert(messages).values({
      id: "msg_other_room",
      organizationId: "org_default",
      roomId: OTHER_ROOM,
      actorType: "agent",
      actorId: "SkywalkerClaude",
      kind: "decision",
      body: "wrong room",
      createdAt: now,
    });

    await expect(
      createDecision(ctx, {
        room_id: ROOM,
        source_message_id: "msg_other_room",
        actor_type: "agent",
        actor_id: "SkywalkerClaude",
        summary: "Promote from wrong room",
      }),
    ).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("transitions a decision to accepted and emits decision.accepted", async () => {
    const { ctx } = server;
    const dec = await createDecision(ctx, {
      room_id: ROOM,
      actor_type: "agent",
      actor_id: "a",
      summary: "x",
    });
    const updated = await setDecisionStatus(ctx, dec.id, "accepted");
    expect(updated?.status).toBe("accepted");
    const payloads = await eventsOfType("decision.accepted");
    expect(payloads[0]).toMatchObject({ decision_id: dec.id, from: "proposed", to: "accepted" });
  });

  it("tracks who-waits-on-whom from open handoff records and clears it on completion", async () => {
    const { ctx } = server;
    const ho = await createHandoff(ctx, {
      room_id: ROOM,
      sender_type: "agent",
      sender_id: "SkywalkerClaude",
      recipient_type: "agent",
      recipient_id: "SkywalkerCodex",
      expected_action: "review #114",
    });
    let edges = await whoWaitsOnWhom(ctx, ROOM);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ waiter_id: "SkywalkerClaude", blocked_on_id: "SkywalkerCodex" });

    await setHandoffStatus(ctx, ho.id, "completed");
    edges = await whoWaitsOnWhom(ctx, ROOM);
    expect(edges).toHaveLength(0);
  });

  it("auto-resolves a blocker when its linked source resolves", async () => {
    const { ctx } = server;
    const blk = await createBlocker(ctx, {
      room_id: ROOM,
      type: "approval",
      owner_type: "agent",
      owner_id: "SkywalkerClaude",
      source_kind: "approval",
      source_id: "approval_42",
      summary: "needs human approval",
    });
    expect(blk.status).toBe("open");

    const resolved = await resolveBlockersForSource(ctx, "approval", "approval_42");
    expect(resolved).toEqual([blk.id]);
    const payloads = await eventsOfType("blocker.resolved");
    expect(payloads[0]).toMatchObject({ blocker_id: blk.id, to: "resolved" });

    // Idempotent: re-resolving an already-resolved source is a no-op.
    expect(await resolveBlockersForSource(ctx, "approval", "approval_42")).toEqual([]);
  });

  it("scopes list queries to the requested room", async () => {
    const { ctx } = server;
    await createDecision(ctx, { room_id: ROOM, actor_type: "agent", actor_id: "a", summary: "in team room" });
    await createDecision(ctx, { room_id: OTHER_ROOM, actor_type: "agent", actor_id: "a", summary: "in other room" });
    expect(await listDecisions(ctx, ROOM)).toHaveLength(1);
    expect(await listDecisions(ctx, OTHER_ROOM)).toHaveLength(1);
  });

  it("supports manual blocker mitigation then resolution", async () => {
    const { ctx } = server;
    const blk = await createBlocker(ctx, {
      room_id: ROOM,
      type: "dependency",
      owner_type: "agent",
      owner_id: "a",
      summary: "waiting on #115",
    });
    const mitigated = await setBlockerStatus(ctx, blk.id, "mitigated", { mitigation: "stubbed goal_id" });
    expect(mitigated?.status).toBe("mitigated");
    expect(mitigated?.mitigation).toBe("stubbed goal_id");
    const resolved = await setBlockerStatus(ctx, blk.id, "resolved");
    expect(resolved?.status).toBe("resolved");
    expect((await eventsOfType("blocker.mitigated"))[0]).toMatchObject({ to: "mitigated" });
    expect((await eventsOfType("blocker.resolved"))[0]).toMatchObject({ to: "resolved" });
  });

  it("emits blocker.accepted_risk when a blocker is accepted as risk", async () => {
    const { ctx } = server;
    const blk = await createBlocker(ctx, {
      room_id: ROOM,
      type: "policy",
      owner_type: "user",
      owner_id: "user_owner",
      summary: "dogfood-only risk",
    });
    const accepted = await setBlockerStatus(ctx, blk.id, "accepted_risk", { mitigation: "documented dogfood boundary" });
    expect(accepted?.status).toBe("accepted_risk");
    expect((await eventsOfType("blocker.accepted_risk"))[0]).toMatchObject({ from: "open", to: "accepted_risk" });
  });
});
