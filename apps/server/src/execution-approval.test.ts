import { approvals, eventLog } from "@artoo/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { buildTestServer } from "./test-support.js";

describe("production pre-run team approval", () => {
  it("blocks actual assignment for pending/info/rejected gates, preserves history and starts only after approval", async () => {
    const server = await buildTestServer();
    try {
      const created = await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
        project_id: "proj_artoo", title: "Review before starting", acceptance_criteria: ["Reviewed"], required_capabilities: ["code.modify"],
      } });
      const task = created.json().task;
      const request = async (summary: string) => server.app.inject({ method: "POST", url: `/api/v1/tasks/${task.id}/execution-approval`, payload: { summary, risk: "high" } });
      expect((await request("Too early")).statusCode).toBe(409);
      await server.app.inject({ method: "POST", url: `/api/v1/tasks/${task.id}/ready`, payload: {} });
      const pending = await request("Review the planned file changes");
      expect(pending.statusCode, pending.body).toBe(201);
      let id = pending.json().approval.id;
      expect(pending.json().approval).toMatchObject({ requested_by_type: "user", requested_by_id: server.ctx.actorUserId,
        payload_ref: "execution-gate/current" });
      const assign = () => server.app.inject({ method: "POST", url: `/api/v1/tasks/${task.id}/assign`, payload: { mode: "auto" } });
      const decide = (decision: string) => server.app.inject({ method: "POST", url: `/api/v1/approvals/${id}/resolve`, payload: { decision } });
      for (const decision of [null, "needs_more_info", "rejected"]) {
        if (decision) expect((await decide(decision)).statusCode).toBe(200);
        const blocked = await assign(); expect(blocked.statusCode).toBe(409); expect(blocked.json().error.message).toContain("Execution approval");
      }
      const rejectedId = id;
      id = (await request("Updated plan after rejection")).json().approval.id;
      expect(id).not.toBe(rejectedId);
      expect((await decide("approved")).statusCode).toBe(200);
      expect((await assign()).statusCode).toBe(200);
      expect((await request("Cannot retroactively gate a live process")).statusCode).toBe(409);
      const snapshot = (await server.app.inject({ url: `/api/v1/tasks/${task.id}` })).json();
      const runId = snapshot.runs[0].id;
      expect(snapshot.approvals.find((approval: { id: string }) => approval.id === id)).toMatchObject({ status: "approved", run_id: runId });
      await server.app.inject({ method: "POST", url: `/api/v1/dev/runs/${runId}/mock-execute` });
      await server.app.inject({ method: "POST", url: `/api/v1/tasks/${task.id}/review`, payload: { outcome: "changes_requested" } });
      expect((await assign()).statusCode).toBe(409);
      const priorApprovedId = id;
      const next = await request("Approve changed work for another execution");
      expect(next.statusCode).toBe(201); id = next.json().approval.id;
      expect(id).not.toBe(priorApprovedId);
      const history = (await server.app.inject({ url: `/api/v1/tasks/${task.id}` })).json().approvals;
      expect(history.find((approval: { id: string }) => approval.id === priorApprovedId)).toMatchObject({
        status: "approved", run_id: runId, payload_ref: "execution-gate/superseded", summary: "Updated plan after rejection",
      });
      expect((await decide("approved")).statusCode).toBe(200);
      expect((await assign()).statusCode).toBe(200);
    } finally { await server.close(); }
  });

  it("rejects an old approval page after a new request and fails closed on an unknown gate marker", async () => {
    const server = await buildTestServer();
    try {
      const task = (await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
        project_id: "proj_artoo", title: "Immutable approval", acceptance_criteria: ["Reviewed"], required_capabilities: ["code.modify"],
      } })).json().task;
      await server.app.inject({ method: "POST", url: `/api/v1/tasks/${task.id}/ready`, payload: {} });
      const request = async (summary: string) => (await server.app.inject({ method: "POST", url: `/api/v1/tasks/${task.id}/execution-approval`, payload: { summary, risk: "high" } })).json().approval;
      const first = await request("Previously reviewed work");
      const current = await request("Different work requiring a fresh review");
      const stale = await server.app.inject({ method: "POST", url: `/api/v1/approvals/${first.id}/resolve`, payload: { decision: "approved" } });
      expect(stale.statusCode).toBe(409); expect(stale.json().error.message).toContain("superseded");
      const snapshot = (await server.app.inject({ url: `/api/v1/tasks/${task.id}` })).json();
      expect(snapshot.runs).toHaveLength(0);
      expect(snapshot.approvals.find((approval: { id: string }) => approval.id === first.id)).toMatchObject({ status: "expired", summary: first.summary });
      expect(snapshot.approvals.find((approval: { id: string }) => approval.id === current.id)).toMatchObject({ status: "pending" });
      expect((await server.app.inject({ method: "POST", url: `/api/v1/approvals/${current.id}/resolve`, payload: { decision: "approved" } })).statusCode).toBe(200);
      await server.db.db.update(approvals).set({ payloadRef: null }).where(eq(approvals.id, current.id));
      const assign = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${task.id}/assign`, payload: { mode: "auto" } });
      expect(assign.statusCode).toBe(409); expect(assign.json().error.message).toContain("Execution approval");
    } finally { await server.close(); }
  });

  it("serializes replacement, resolution and assignment without reusing approval or execution", async () => {
    const server = await buildTestServer();
    try {
      const task = (await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
        project_id: "proj_artoo", title: "Concurrent review", acceptance_criteria: ["Reviewed"], required_capabilities: ["code.modify"],
      } })).json().task;
      await server.app.inject({ method: "POST", url: `/api/v1/tasks/${task.id}/ready`, payload: {} });
      const request = (summary: string) => server.app.inject({ method: "POST", url: `/api/v1/tasks/${task.id}/execution-approval`, payload: { summary, risk: "medium" } });
      const decide = (id: string, decision: string) => server.app.inject({ method: "POST", url: `/api/v1/approvals/${id}/resolve`, payload: { decision } });
      const first = (await request("First review")).json().approval;
      const [replacement, oldDecision] = await Promise.all([request("Fresh review"), decide(first.id, "approved")]);
      expect(replacement.statusCode).toBe(201);
      expect([200, 409]).toContain(oldDecision.statusCode);
      let currentId = replacement.json().approval.id;
      let snapshot = (await server.app.inject({ url: `/api/v1/tasks/${task.id}` })).json();
      expect(snapshot.approvals.filter((approval: { payload_ref: string }) => approval.payload_ref === "execution-gate/current")).toEqual([
        expect.objectContaining({ id: currentId, status: "pending", run_id: null }),
      ]);
      const replacements = await Promise.all([request("Concurrent request A"), request("Concurrent request B")]);
      expect(replacements.map((response) => response.statusCode)).toEqual([201, 201]);
      expect(new Set(replacements.map((response) => response.json().approval.id)).size).toBe(2);
      snapshot = (await server.app.inject({ url: `/api/v1/tasks/${task.id}` })).json();
      const current = snapshot.approvals.filter((approval: { payload_ref: string }) => approval.payload_ref === "execution-gate/current");
      expect(current).toHaveLength(1);
      currentId = current[0].id;
      const decisions = await Promise.all([decide(currentId, "approved"), decide(currentId, "approved")]);
      expect(decisions.map((response) => response.statusCode).sort()).toEqual([200, 409]);
      const assign = () => server.app.inject({ method: "POST", url: `/api/v1/tasks/${task.id}/assign`, payload: { mode: "auto" } });
      const assigned = await Promise.all([assign(), assign()]);
      expect(assigned.map((response) => response.statusCode).sort()).toEqual([200, 409]);
      snapshot = (await server.app.inject({ url: `/api/v1/tasks/${task.id}` })).json();
      expect(snapshot.runs).toHaveLength(1);
      expect(snapshot.approvals.find((approval: { id: string }) => approval.id === currentId).run_id).toBe(snapshot.runs[0].id);
    } finally { await server.close(); }
  });

  it("moves unresolved approval blockers to a replacement and settles them only with the current decision", async () => {
    const server = await buildTestServer();
    try {
      for (const decision of ["approved", "rejected"]) {
        const created = (await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
          project_id: "proj_artoo", title: `Replace linked ${decision} gate`, acceptance_criteria: ["Reviewed"],
        } })).json();
        const taskId = created.task.id;
        const roomId = created.room.id;
        await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready`, payload: {} });
        const request = async (summary: string) => (await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/execution-approval`, payload: { summary, risk: "medium" } })).json().approval;
        const first = await request("Original request");
        const ids: Record<string, string> = {};
        for (const state of ["open", "mitigated", "accepted_risk", "resolved"]) {
          const response = await server.app.inject({ method: "POST", url: `/api/v1/rooms/${roomId}/blockers`, payload: {
            task_id: taskId, type: "approval", owner_type: "user", owner_id: server.ctx.actorUserId,
            source_kind: "approval", source_id: first.id, summary: `Waiting review (${state})`,
          } });
          expect(response.statusCode).toBe(201); ids[state] = response.json().blocker.id;
          if (state !== "open") expect((await server.app.inject({ method: "PATCH", url: `/api/v1/blockers/${ids[state]}`, payload: { status: state } })).statusCode).toBe(200);
        }
        const current = await request("Replacement review");
        const read = async () => (await server.app.inject({ url: `/api/v1/rooms/${roomId}/blockers` })).json().blockers as { id: string; status: string; source_id: string }[];
        let linked = await read();
        for (const state of ["open", "mitigated", "accepted_risk"]) {
          expect(linked.find((blocker) => blocker.id === ids[state])).toMatchObject({ source_id: current.id, status: state });
        }
        expect(linked.find((blocker) => blocker.id === ids.resolved)).toMatchObject({ source_id: first.id, status: "resolved" });
        const events = await server.db.db.select().from(eventLog).where(eq(eventLog.taskId, taskId));
        const replacement = events.find((event) => event.type === "approval.requested" && (event.payload as Record<string, unknown>).approval_id === current.id);
        expect((replacement?.payload as Record<string, unknown> | undefined)?.relinked_blockers).toEqual(expect.arrayContaining(
          ["open", "mitigated", "accepted_risk"].map((state) => ({ blocker_id: ids[state], previous_source_id: first.id, source_id: current.id })),
        ));
        expect((await server.app.inject({ method: "POST", url: `/api/v1/approvals/${first.id}/resolve`, payload: { decision: "approved" } })).statusCode).toBe(409);
        expect((await server.app.inject({ method: "POST", url: `/api/v1/approvals/${current.id}/resolve`, payload: { decision: "needs_more_info" } })).statusCode).toBe(200);
        linked = await read();
        expect(linked.find((blocker) => blocker.id === ids.open)?.status).toBe("open");
        expect((await server.app.inject({ method: "POST", url: `/api/v1/approvals/${current.id}/resolve`, payload: { decision } })).statusCode).toBe(200);
        linked = await read();
        for (const state of ["open", "mitigated"]) expect(linked.find((blocker) => blocker.id === ids[state])).toMatchObject({ source_id: current.id, status: "resolved" });
        expect(linked.find((blocker) => blocker.id === ids.accepted_risk)).toMatchObject({ source_id: current.id, status: "accepted_risk" });
      }
    } finally { await server.close(); }
  });
});
