import { contextPacks, eventLog, fileLeases, runs, schedulerDecisions, tasks } from "@artoo/db";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assignTask } from "./services/lifecycle-service.js";
import { buildTestServer, type TestServer } from "./test-support.js";

describe("assignment transaction and post-commit dispatch", () => {
  let server: TestServer | undefined;
  afterEach(async () => {
    vi.restoreAllMocks();
    await server?.close();
    server = undefined;
  });

  async function ready() {
    server = await buildTestServer();
    const created = await server.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: {
        project_id: "proj_artoo",
        title: "Atomic assignment",
        acceptance_criteria: ["Preserve assignment and dispatch ownership"],
        required_capabilities: ["code.modify"],
      },
    });
    expect(created.statusCode).toBe(201);
    const taskId = created.json().task.id as string;
    expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` })).statusCode).toBe(200);
    return { current: server, taskId };
  }

  it("rolls back every assignment write and never dispatches when the transaction fails after its work", async () => {
    const { current, taskId } = await ready();
    const dispatch = vi.fn();
    current.ctx.onRunQueued = dispatch;
    const before = {
      task: await current.db.db.select().from(tasks).where(eq(tasks.id, taskId)),
      events: await current.db.db.select().from(eventLog).where(eq(eventLog.taskId, taskId)),
    };
    const transaction = current.db.transaction.bind(current.db);
    const rollback = new Error("controlled failure before assignment commit");
    vi.spyOn(current.db, "transaction").mockImplementationOnce((work) =>
      transaction(async (tx) => {
        await work(tx);
        // Production SQL has run. The real database transaction must undo it,
        // including writes made at the very end of assignment.
        expect((await tx.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.status).toBe("assigned");
        expect(await tx.select().from(runs).where(eq(runs.taskId, taskId))).toHaveLength(1);
        expect(await tx.select().from(contextPacks).where(eq(contextPacks.taskId, taskId))).toHaveLength(1);
        expect(await tx.select().from(schedulerDecisions).where(eq(schedulerDecisions.taskId, taskId))).toHaveLength(1);
        expect(await tx.select().from(fileLeases).where(eq(fileLeases.taskId, taskId))).toHaveLength(1);
        expect(dispatch).not.toHaveBeenCalled();
        throw rollback;
      }),
    );
    await expect(assignTask(current.ctx, taskId, { mode: "auto", write_paths: ["src/atomic"] })).rejects.toBe(rollback);
    expect(dispatch).not.toHaveBeenCalled();
    expect(await current.db.db.select().from(tasks).where(eq(tasks.id, taskId))).toEqual(before.task);
    expect(await current.db.db.select().from(eventLog).where(eq(eventLog.taskId, taskId))).toEqual(before.events);
    expect(await current.db.db.select().from(runs).where(eq(runs.taskId, taskId))).toEqual([]);
    expect(await current.db.db.select().from(contextPacks).where(eq(contextPacks.taskId, taskId))).toEqual([]);
    expect(await current.db.db.select().from(schedulerDecisions).where(eq(schedulerDecisions.taskId, taskId))).toEqual(
      [],
    );
    expect(await current.db.db.select().from(fileLeases).where(eq(fileLeases.taskId, taskId))).toEqual([]);
  });

  it("dispatches once after the committed Task, Run, context, decision and reservations are readable", async () => {
    const { current, taskId } = await ready();
    const dispatch = vi.fn(async (runId: string) => {
      // These reads use the original client, outside the completed transaction.
      // Calling the hook while PGlite's transaction is open would not complete.
      const [run] = await current.db.db.select().from(runs).where(eq(runs.id, runId));
      expect(run).toMatchObject({ taskId, status: "queued", requestedByUserId: "user_owner" });
      expect((await current.db.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.status).toBe("assigned");
      expect(await current.db.db.select().from(contextPacks).where(eq(contextPacks.runId, runId))).toHaveLength(1);
      expect(
        await current.db.db.select().from(schedulerDecisions).where(eq(schedulerDecisions.taskId, taskId)),
      ).toHaveLength(1);
      expect(await current.db.db.select().from(fileLeases).where(eq(fileLeases.holderId, runId))).toHaveLength(1);
      expect(await current.db.db.select().from(eventLog).where(eq(eventLog.runId, runId))).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "task.assigned", actorType: "system", actorId: "scheduler" }),
        ]),
      );
    });
    current.ctx.onRunQueued = dispatch;
    const result = await assignTask(current.ctx, taskId, { mode: "auto", write_paths: ["src/atomic"] });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(result.run.id);
  });

  it("retains committed history when post-commit transport fails and refuses a duplicate assignment", async () => {
    const { current, taskId } = await ready();
    const disconnected = new Error("controlled transport loss after assignment commit");
    const dispatch = vi.fn(async () => {
      throw disconnected;
    });
    current.ctx.onRunQueued = dispatch;
    await expect(assignTask(current.ctx, taskId, { mode: "auto" })).rejects.toBe(disconnected);
    const saved = await current.db.db.select().from(runs).where(eq(runs.taskId, taskId));
    expect(saved).toHaveLength(1);
    expect(saved[0]?.status).toBe("queued");
    expect((await current.db.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.status).toBe("assigned");
    await expect(assignTask(current.ctx, taskId, { mode: "auto" })).rejects.toThrow("task must be 'ready'");
    expect(await current.db.db.select().from(runs).where(eq(runs.taskId, taskId))).toEqual(saved);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
