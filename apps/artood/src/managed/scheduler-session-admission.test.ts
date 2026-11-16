import { createHash, randomUUID } from "node:crypto";
import { canonicalSchedulerStartProposalV1, type SchedulerStartProposalV1 } from "@artoo/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FreshLaunchPermit, Journal, JournalRun } from "./journal-types.js";
import { admitSchedulerStartFromSession } from "./scheduler-session-admission.js";
import { createSchedulerStartClientChannel } from "./scheduler-start-channel.js";
import { createSchedulerStartWindows } from "./scheduler-start-window.js";

// Controlled storage replies, real exchange/window state machines. No genuine
// FreshLaunchPermit or physical producer is constructed by these unit cases.
function fixture() {
  const session = {
    namespace: randomUUID(),
    nodeId: "computer",
    sessionId: randomUUID(),
    generation: 1,
    helloNonce: randomUUID(),
  };
  const digest = `sha256:${"a".repeat(64)}`;
  const proposal: SchedulerStartProposalV1 = {
    version: 1,
    prepared_start: {
      version: 1,
      request_id: "request",
      request_snapshot_digest: digest,
      organization_id: "org",
      project_id: "project",
      task_id: "task",
      actor_user_id: "user",
      run_id: "run",
      agent_instance_id: "instance",
      computer_id: session.nodeId,
      device_id: "device",
      session_id: session.sessionId,
      assigned: {
        task_input_version: 1,
        task_input_digest: digest,
        queue_revision: null,
        policy_revisions: { project: 1, agent: 1, computers: { computer: 1 } },
        configuration_digest: digest,
      },
      prepared_run_digest: digest,
      execution_authorized: false,
    },
    run_start: {
      run_id: "run",
      task_id: "task",
      agent_instance_id: "instance",
      runtime: "codex",
      workspace: { root: "/fixture/run", branch: "fixture/run" },
      workspace_allocation: { version: 1, strategy: "per-run", base_path: "/fixture" },
      context_pack: {
        id: "context",
        payload: {
          task: { id: "task", title: "Task", description: "", acceptance_criteria: ["ok"] },
          project: { id: "project", name: "Project", default_workspace: null },
          workspace: { root: "/fixture/run", file_scope: [] },
          policy: { filesystem_write_scope: [], requires_approval: [] },
          memory: { task_summary: null, project_notes: [] },
          artifacts: { expected: [] },
        },
      },
      policy_snapshot: { filesystem_write_scope: ["/fixture/run"], requires_approval: [] },
      artifact_rules: { paths: [] },
    },
  };
  const proposalDigest = `sha256:${createHash("sha256").update(canonicalSchedulerStartProposalV1(proposal)).digest("hex")}`;
  const record = {
    version: 1 as const,
    namespace: session.namespace,
    nodeId: session.nodeId,
    runId: "run",
    requestId: "request",
    sessionId: session.sessionId,
    nodeAttemptId: randomUUID(),
    proposalDigest,
    executionAuthorized: false as const,
  };
  const run: JournalRun = {
    namespace: session.namespace,
    runId: "run",
    mode: "per-run",
    launchKey: null,
    revision: 1,
    phase: "admitted",
    stopRequested: false,
    ownership: "unknown",
    receipt: null,
    finalOutcomeJson: null,
    liveAbort: null,
    schedulerPreparation: record,
  };
  const windows = createSchedulerStartWindows(() => {});
  const order: string[] = [];
  const lane = createSchedulerStartClientChannel({
    session,
    assertCurrent() {},
    send(message) {
      order.push(message.kind);
      lane.receive({
        kind: "command",
        type: "scheduler.start.response.v1",
        id: randomUUID(),
        idempotency_key: randomUUID(),
        payload: {
          version: 1,
          node_id: session.nodeId,
          session_id: session.sessionId,
          exchange_id: message.exchange_id,
          ...(message.kind === "scheduler.start.propose.v1"
            ? {
                status: "proposal" as const,
                result: {
                  version: 1 as const,
                  proposal,
                  proposal_digest: proposalDigest,
                  execution_authorized: false as const,
                },
              }
            : {
                status: "grant" as const,
                result: {
                  version: 1 as const,
                  remaining_ms: 5000,
                  grant: {
                    ...message.ready,
                    scope: "scheduler-start.once.v1" as const,
                    grant_id: randomUUID(),
                    organization_id: "org",
                    project_id: "project",
                    task_id: "task",
                    actor_user_id: "user",
                    agent_instance_id: "instance",
                    computer_id: session.nodeId,
                    device_id: "device",
                    session_id: session.sessionId,
                    issued_at: "2026-11-16T00:00:00.000Z",
                    expires_at: "2026-11-16T00:00:05.000Z",
                  },
                },
              }),
        },
      });
    },
  });
  const channel = { ...lane.open() };
  const permit = Object.freeze({}) as FreshLaunchPermit;
  const fresh = { kind: "fresh" as const, permit, run, payload: proposal.run_start };
  let prepared = false;
  const methods = {
    prepareSchedulerStart: vi.fn(async () => {
      order.push("prepare");
      if (prepared) return { kind: "pending" as const, run };
      prepared = true;
      return { kind: "prepared" as const, run, preparation: windows.prepare(proposal, record) };
    }),
    beginSchedulerReady: vi.fn(windows.begin),
    acceptSchedulerStartGrant: vi.fn(windows.accept),
    assertSchedulerStartWindow: vi.fn(windows.assertCurrent),
    admitSchedulerStart: vi.fn(async (window) => {
      order.push("admit");
      windows.consume(window);
      return fresh;
    }),
    admitStart: vi.fn(),
    requestStop: vi.fn(),
  };
  const journal = {
    namespace: session.namespace,
    schedulerPreparationVersion: 1,
    schedulerStartGrantStorageVersion: 1,
    schedulerStartGrantAdmissionVersion: 1,
    ...methods,
  } as unknown as Journal;
  const input = { journal, channel, taskId: "task", requestId: "request", runId: "run" };
  return { input, journal, methods, lane, channel, run, order, permit, fresh };
}
afterEach(() => {
  vi.useRealTimers();
});

describe("generation-bound scheduler exchange to durable admission", () => {
  it("joins dependency input preparation before opening the original short ready window", async () => {
    const f = fixture();
    await admitSchedulerStartFromSession({
      ...f.input,
      prepareInputs: async (payload) => {
        expect(payload.run_id).toBe("run");
        expect(f.methods.beginSchedulerReady).not.toHaveBeenCalled();
        f.order.push("dependency-inputs");
      },
    });
    expect(f.order).toEqual([
      "scheduler.start.propose.v1",
      "dependency-inputs",
      "prepare",
      "scheduler.start.ready.v1",
      "admit",
    ]);
  });

  it("joins fresh preparation and grant in order and carries the original guard", async () => {
    const f = fixture(),
      result = await admitSchedulerStartFromSession(f.input);
    expect(f.order).toEqual(["scheduler.start.propose.v1", "prepare", "scheduler.start.ready.v1", "admit"]);
    expect(f.methods.prepareSchedulerStart).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedNamespace: f.journal.namespace,
        runId: "run",
        idempotencyKey: "run:scheduler-prepare:v1",
      }),
    );
    expect(result.kind).toBe("fresh");
    if (result.kind !== "fresh") throw new Error("Expected controlled fresh reply");
    expect(result.permit).toBe(f.permit);
    expect(Object.isFrozen(result)).toBe(true);
    result.assertStartCurrent();
    f.lane.close(new Error("Original generation lost"));
    expect(() => result.assertStartCurrent()).toThrow("Original generation lost");
    expect(f.methods.admitStart).not.toHaveBeenCalled();
    expect(f.methods.requestStop).not.toHaveBeenCalled();
  });
  it("cannot regain a fresh preparation or send another ready on replay", async () => {
    const f = fixture();
    await admitSchedulerStartFromSession(f.input);
    expect(await admitSchedulerStartFromSession(f.input)).toEqual({
      kind: "retained",
      stage: "preparation",
      status: "pending",
      run: f.run,
    });
    expect(f.order.filter((item) => item === "scheduler.start.ready.v1")).toHaveLength(1);
    expect(f.methods.admitSchedulerStart).toHaveBeenCalledTimes(1);
  });
  it("checks journal versions, required methods and namespace before network or storage", async () => {
    for (const change of [
      { schedulerPreparationVersion: undefined },
      { schedulerStartGrantStorageVersion: undefined },
      { schedulerStartGrantAdmissionVersion: undefined },
      { prepareSchedulerStart: undefined },
      { beginSchedulerReady: undefined },
      { acceptSchedulerStartGrant: undefined },
      { assertSchedulerStartWindow: undefined },
      { admitSchedulerStart: undefined },
      { namespace: randomUUID() },
    ]) {
      const f = fixture();
      Object.assign(f.journal, change);
      await expect(admitSchedulerStartFromSession(f.input)).rejects.toThrow("matching explicitly upgraded v6");
      expect(f.order).toEqual([]);
    }
  });
  it.each(["taskId", "requestId", "runId"] as const)(
    "rejects changed consumed %s before journal writes",
    async (key) => {
      const f = fixture();
      await expect(admitSchedulerStartFromSession({ ...f.input, [key]: "changed" })).rejects.toThrow(/original/);
      expect(f.methods.prepareSchedulerStart).not.toHaveBeenCalled();
    },
  );
  it("does not start any exchange after caller cancellation", async () => {
    const f = fixture(),
      controller = new AbortController();
    controller.abort(new Error("Local stop"));
    await expect(admitSchedulerStartFromSession({ ...f.input, signal: controller.signal })).rejects.toThrow(
      "Local stop",
    );
    expect(f.order).toEqual([]);
  });
  it("joins interrupted preparation storage, withholding ready and retaining its result", async () => {
    const f = fixture();
    const original = f.journal.prepareSchedulerStart!;
    let resume!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      resume = resolve;
    });
    f.journal.prepareSchedulerStart = async (request) => {
      const result = await original(request);
      entered();
      await wait;
      return result;
    };
    const pending = admitSchedulerStartFromSession(f.input);
    await started;
    f.lane.close(new Error("Lost during preparation"));
    let finished = false;
    void pending.catch(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    resume();
    await expect(pending).rejects.toThrow("Lost during preparation");
    expect(f.methods.beginSchedulerReady).not.toHaveBeenCalled();
    expect(f.methods.admitSchedulerStart).not.toHaveBeenCalled();
    expect(f.methods.requestStop).not.toHaveBeenCalled();
  });
  it("withholds a returned grant when cancellation wins its awaited continuation", async () => {
    const f = fixture(),
      grant = f.channel.grant;
    f.channel.grant = async (value) => {
      const reply = await grant(value);
      f.lane.close(new Error("Lost after grant"));
      return reply;
    };
    await expect(admitSchedulerStartFromSession(f.input)).rejects.toThrow("Lost after grant");
    expect(f.methods.acceptSchedulerStartGrant).not.toHaveBeenCalled();
    expect(f.methods.admitSchedulerStart).not.toHaveBeenCalled();
    expect(f.methods.requestStop).not.toHaveBeenCalled();
  });
  it("joins a possibly committed admission before rejecting cancellation, without release or fallback", async () => {
    const f = fixture(),
      original = f.journal.admitSchedulerStart!;
    let resume!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      resume = resolve;
    });
    f.journal.admitSchedulerStart = async (window) => {
      const result = await original(window);
      entered();
      await wait;
      return result;
    };
    const pending = admitSchedulerStartFromSession(f.input);
    await started;
    f.lane.close(new Error("Committed reply lost"));
    let finished = false;
    void pending.catch(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    resume();
    await expect(pending).rejects.toThrow("Committed reply lost");
    expect(f.methods.admitStart).not.toHaveBeenCalled();
    expect(f.methods.requestStop).not.toHaveBeenCalled();
  });
  it("keeps caller cancellation bound to a returned window", async () => {
    const f = fixture(),
      controller = new AbortController();
    const result = await admitSchedulerStartFromSession({ ...f.input, signal: controller.signal });
    expect(result.kind).toBe("fresh");
    if (result.kind !== "fresh") throw new Error("Expected controlled fresh reply");
    controller.abort(new Error("Original local stop"));
    expect(() => result.assertStartCurrent()).toThrow("Original local stop");
    expect(f.channel.signal.aborted).toBe(false);
  });
  it("counts awaited admission latency against the original start window", async () => {
    vi.useFakeTimers();
    const f = fixture(),
      original = f.journal.admitSchedulerStart!;
    f.journal.admitSchedulerStart = async (window) => {
      const result = await original(window);
      vi.advanceTimersByTime(5000);
      return result;
    };
    await expect(admitSchedulerStartFromSession(f.input)).rejects.toThrow("deadline");
    expect(f.methods.requestStop).not.toHaveBeenCalled();
  });
  it("returns an explicit retained outcome when durable admission cannot issue a permit", async () => {
    const f = fixture();
    f.journal.admitSchedulerStart = async () => ({ kind: "unknown", run: f.run });
    expect(await admitSchedulerStartFromSession(f.input)).toEqual({
      kind: "retained",
      stage: "admission",
      status: "unknown",
      run: f.run,
    });
    expect(f.methods.admitStart).not.toHaveBeenCalled();
    expect(f.methods.requestStop).not.toHaveBeenCalled();
  });
  it("captures original local identities and methods before awaiting a proposal", async () => {
    const f = fixture(),
      propose = f.channel.propose;
    let resume!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      resume = resolve;
    });
    f.channel.propose = async (value) => {
      const reply = await propose(value);
      entered();
      await wait;
      return reply;
    };
    const pending = admitSchedulerStartFromSession(f.input);
    await started;
    Object.assign(f.input, { runId: "changed", taskId: "changed", requestId: "changed" });
    f.journal.admitSchedulerStart = vi.fn(() => {
      throw new Error("Replacement cannot gain authority");
    });
    f.channel.grant = vi.fn(() => {
      throw new Error("Replacement cannot gain authority");
    });
    resume();
    expect((await pending).kind).toBe("fresh");
    expect(f.methods.prepareSchedulerStart).toHaveBeenCalledWith(expect.objectContaining({ runId: "run" }));
    expect(f.methods.admitSchedulerStart).toHaveBeenCalledTimes(1);
  });
});
