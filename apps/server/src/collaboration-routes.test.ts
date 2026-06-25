// @vitest-environment node
import { rooms } from "@artoo/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestServer, type TestServer } from "./test-support.js";

/**
 * V3 #114 slice 3 — collaboration REST routes. Thin handlers over
 * collaboration-service: create/list/patch for decisions/handoffs/blockers,
 * who-waits edges, validation (400) and not-found (404).
 */
describe("collaboration routes #114", () => {
  let srv: TestServer;
  const ROOM = "room_team";

  beforeEach(async () => {
    srv = await buildTestServer();
    await srv.db.db
      .insert(rooms)
      .values({ id: ROOM, organizationId: "org_default", type: "agent_team", name: "Team", createdAt: srv.ctx.clock.nowIso() });
  });
  afterEach(async () => {
    await srv.close();
  });

  it("POST/GET/PATCH a decision through its lifecycle", async () => {
    const create = await srv.app.inject({
      method: "POST",
      url: `/api/v1/rooms/${ROOM}/decisions`,
      payload: { actor_type: "agent", actor_id: "SkywalkerCodex", summary: "Adopt 0012 numbering", rationale: "avoid collision" },
    });
    expect(create.statusCode).toBe(201);
    const decision = create.json().decision;
    expect(decision.status).toBe("proposed");
    expect(decision.id).toMatch(/^dec_/);
    // Secret-safe / no leakage of internal columns in the envelope.
    expect(JSON.stringify(decision)).not.toMatch(/token|secret|hash/i);

    const list = await srv.app.inject({ method: "GET", url: `/api/v1/rooms/${ROOM}/decisions` });
    expect(list.statusCode).toBe(200);
    expect(list.json().decisions).toHaveLength(1);

    const patch = await srv.app.inject({
      method: "PATCH",
      url: `/api/v1/decisions/${decision.id}`,
      payload: { status: "accepted" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().decision.status).toBe("accepted");
  });

  it("rejects an invalid decision payload with 400", async () => {
    const res = await srv.app.inject({
      method: "POST",
      url: `/api/v1/rooms/${ROOM}/decisions`,
      payload: { actor_type: "agent", actor_id: "a" }, // missing summary
    });
    expect(res.statusCode).toBe(400);
  });

  it("PATCH unknown decision => 404", async () => {
    const res = await srv.app.inject({ method: "PATCH", url: "/api/v1/decisions/dec_nope", payload: { status: "accepted" } });
    expect(res.statusCode).toBe(404);
  });

  it("handoffs drive who-waits edges and clear on completion", async () => {
    const create = await srv.app.inject({
      method: "POST",
      url: `/api/v1/rooms/${ROOM}/handoffs`,
      payload: {
        sender_type: "agent",
        sender_id: "SkywalkerClaude",
        recipient_type: "agent",
        recipient_id: "SkywalkerCodex",
        expected_action: "review #114",
      },
    });
    expect(create.statusCode).toBe(201);
    const handoff = create.json().handoff;

    const roomEdges = await srv.app.inject({ method: "GET", url: `/api/v1/rooms/${ROOM}/who-waits` });
    expect(roomEdges.json().edges).toHaveLength(1);
    expect(roomEdges.json().edges[0]).toMatchObject({ waiter_id: "SkywalkerClaude", blocked_on_id: "SkywalkerCodex" });

    const orgEdges = await srv.app.inject({ method: "GET", url: "/api/v1/who-waits" });
    expect(orgEdges.json().edges).toHaveLength(1);

    const patch = await srv.app.inject({
      method: "PATCH",
      url: `/api/v1/handoffs/${handoff.id}`,
      payload: { status: "completed" },
    });
    expect(patch.statusCode).toBe(200);
    expect((await srv.app.inject({ method: "GET", url: `/api/v1/rooms/${ROOM}/who-waits` })).json().edges).toHaveLength(0);
  });

  it("blockers: create, list, patch to resolved", async () => {
    const create = await srv.app.inject({
      method: "POST",
      url: `/api/v1/rooms/${ROOM}/blockers`,
      payload: { type: "approval", owner_type: "agent", owner_id: "a", source_kind: "approval", source_id: "approval_1", summary: "needs approval" },
    });
    expect(create.statusCode).toBe(201);
    const blocker = create.json().blocker;
    expect(blocker.status).toBe("open");

    expect((await srv.app.inject({ method: "GET", url: `/api/v1/rooms/${ROOM}/blockers` })).json().blockers).toHaveLength(1);

    const patch = await srv.app.inject({
      method: "PATCH",
      url: `/api/v1/blockers/${blocker.id}`,
      payload: { status: "resolved" },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().blocker.status).toBe("resolved");
  });

  it("PATCH unknown blocker/handoff => 404", async () => {
    expect((await srv.app.inject({ method: "PATCH", url: "/api/v1/blockers/blk_nope", payload: { status: "resolved" } })).statusCode).toBe(404);
    expect((await srv.app.inject({ method: "PATCH", url: "/api/v1/handoffs/ho_nope", payload: { status: "completed" } })).statusCode).toBe(404);
  });
});
