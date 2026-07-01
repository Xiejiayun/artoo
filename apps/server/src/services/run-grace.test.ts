import { eventLog, runs, tasks } from "@artoo/db";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { activeRunIdsForComputer, activeSnapshotRunIdsForComputer, failRunDaemonDisconnect } from "./run-service.js";
import { ingestRunEvent } from "./run-service.js";
import { buildTestServer, type TestServer } from "../test-support.js";

const COMPUTER = "computer_local_mock";

describe("run daemon-disconnect grace failure (#115 P2-S3)", () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await buildTestServer();
  });
  afterEach(async () => {
    await server.close();
  });

  /** Drive a task to a running run on the mock computer. */
  async function runningRun(): Promise<{ taskId: string; runId: string }> {
    const created = await server.app.inject({
      method: "POST",
      url: "/api/v1/tasks",
      payload: { project_id: "proj_artoo", title: "grace", acceptance_criteria: ["ok"], required_capabilities: ["code.modify"] },
    });
    const taskId = created.json().task.id as string;
    await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` });
    const assigned = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/assign`, payload: { mode: "auto" } });
    const runId = assigned.json().run.id as string;
    await ingestRunEvent(server.ctx, { runId, nodeId: COMPUTER, sequence: 0, event: { kind: "lifecycle", phase: "started" } });
    return { taskId, runId };
  }

  async function runStatus(runId: string): Promise<string> {
    return (await server.db.db.select({ s: runs.status }).from(runs).where(eq(runs.id, runId)))[0]!.s;
  }
  async function failedEvents(runId: string) {
    return server.db.db
      .select()
      .from(eventLog)
      .where(and(eq(eventLog.organizationId, "org_default"), eq(eventLog.type, "run.failed"), eq(eventLog.runId, runId)));
  }

  it("activeRunIdsForComputer returns non-terminal runs on the computer", async () => {
    const { runId } = await runningRun();
    expect(await activeRunIdsForComputer(server.ctx, COMPUTER)).toEqual([runId]);
    expect(await activeRunIdsForComputer(server.ctx, "computer_other")).toEqual([]);
  });

  it("activeSnapshotRunIdsForComputer filters a disconnect snapshot by current run state", async () => {
    const terminal = await runningRun();
    await ingestRunEvent(server.ctx, {
      runId: terminal.runId,
      nodeId: COMPUTER,
      sequence: 1,
      event: { kind: "lifecycle", phase: "completed" },
    });
    const active = await runningRun();

    await expect(
      activeSnapshotRunIdsForComputer(server.ctx, COMPUTER, [terminal.runId, active.runId, "run_missing"]),
    ).resolves.toEqual([active.runId]);
  });

  it("fails a running run with daemon_disconnect and blocks the task", async () => {
    const { taskId, runId } = await runningRun();
    const res = await failRunDaemonDisconnect(server.ctx, runId, COMPUTER);
    expect(res.failed).toBe(true);
    expect(await runStatus(runId)).toBe("failed");

    const run = (await server.db.db.select().from(runs).where(eq(runs.id, runId)))[0]!;
    expect(run.failureReason).toBe("daemon_disconnect");
    const evts = await failedEvents(runId);
    expect(evts).toHaveLength(1);
    expect((evts[0]!.payload as { failure_reason: string }).failure_reason).toBe("daemon_disconnect");

    const task = (await server.db.db.select({ s: tasks.status }).from(tasks).where(eq(tasks.id, taskId)))[0]!;
    expect(task.s).toBe("blocked");
  });

  it("is idempotent: repeated calls do not re-fail or duplicate the event", async () => {
    const { runId } = await runningRun();
    await failRunDaemonDisconnect(server.ctx, runId, COMPUTER);
    const again = await failRunDaemonDisconnect(server.ctx, runId, COMPUTER);
    expect(again.failed).toBe(false);
    expect(await failedEvents(runId)).toHaveLength(1); // exactly one run.failed
  });

  it("no-ops when the run is on a different computer", async () => {
    const { runId } = await runningRun();
    const res = await failRunDaemonDisconnect(server.ctx, runId, "computer_other");
    expect(res.failed).toBe(false);
    expect(await runStatus(runId)).toBe("running"); // untouched
  });

  it("no-ops for an unknown run", async () => {
    expect((await failRunDaemonDisconnect(server.ctx, "run_nope", COMPUTER)).failed).toBe(false);
  });
});
