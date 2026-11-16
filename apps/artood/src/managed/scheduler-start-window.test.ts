import { createHash, randomUUID } from "node:crypto";
import { canonicalSchedulerStartProposalV1, type SchedulerStartProposalV1 } from "@artoo/domain";
import { describe, expect, it, vi } from "vitest";
import { createSchedulerStartWindows } from "./scheduler-start-window.js";
import type { SchedulerPreparationPermit, SchedulerReadyExchange, SchedulerStartWindow } from "./journal-types.js";

function fixture() {
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
      computer_id: "computer",
      device_id: "device",
      session_id: "session",
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
      workspace: { root: "/fixture/run", branch: "artoo/run-run" },
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
  let time = 100;
  const available = vi.fn();
  const manager = createSchedulerStartWindows(available, () => time);
  const record = {
    version: 1 as const,
    namespace: randomUUID(),
    nodeId: "computer",
    runId: "run",
    requestId: "request",
    sessionId: "session",
    nodeAttemptId: randomUUID(),
    proposalDigest: `sha256:${createHash("sha256").update(canonicalSchedulerStartProposalV1(proposal)).digest("hex")}`,
    executionAuthorized: false as const,
  };
  const permit = manager.prepare(proposal, record);
  const controller = new AbortController();
  const begin = () => manager.begin(permit, controller.signal);
  const response = (ready: ReturnType<typeof begin>["ready"]) => ({
    version: 1,
    remaining_ms: 1000,
    grant: {
      ...ready,
      scope: "scheduler-start.once.v1",
      grant_id: randomUUID(),
      organization_id: "org",
      project_id: "project",
      task_id: "task",
      actor_user_id: "user",
      agent_instance_id: "instance",
      computer_id: "computer",
      device_id: "device",
      session_id: "session",
      issued_at: "2026-11-16T00:00:00.000Z",
      expires_at: "2026-11-16T00:00:01.000Z",
    },
  });
  return {
    manager,
    proposal,
    record,
    permit,
    controller,
    available,
    begin,
    response,
    tick: (value: number) => {
      time = value;
    },
  };
}

describe("private scheduler ready exchange and conservative start window (no launch authority)", () => {
  it("includes the entire round trip and never recreates authority from copies, another manager or replay", () => {
    const f = fixture(),
      request = f.begin();
    expect(() => f.manager.begin({} as SchedulerPreparationPermit, f.controller.signal)).toThrow("fresh local");
    expect(() => f.manager.begin(f.permit, f.controller.signal)).toThrow("fresh local");
    f.tick(1099);
    const window = f.manager.accept(request.exchange, f.response(request.ready));
    expect(Object.isFrozen(request.ready)).toBe(true);
    expect(Object.isFrozen(window)).toBe(true);
    expect(JSON.stringify(window)).toBe("{}");
    f.manager.assertCurrent(window);
    expect(() => f.manager.assertCurrent(structuredClone(window))).toThrow("private");
    expect(() => fixture().manager.assertCurrent(window)).toThrow("private");
    expect(() => f.manager.accept(request.exchange, f.response(request.ready))).toThrow("original local");
    f.tick(1100);
    expect(() => f.manager.assertCurrent(window)).toThrow("deadline");
    f.tick(101);
    expect(() => f.manager.assertCurrent(window)).toThrow("permanently invalid");
  });

  it.each(["late", "backwards", "nan", "channel", "worker"] as const)(
    "invalidates on %s and never revives",
    (cause) => {
      const f = fixture(),
        request = f.begin();
      f.tick(200);
      const window = f.manager.accept(request.exchange, f.response(request.ready));
      if (cause === "late") f.tick(1100);
      else if (cause === "backwards") f.tick(199);
      else if (cause === "nan") f.tick(NaN);
      else if (cause === "channel") f.controller.abort(new Error("Original channel ended"));
      else
        f.available.mockImplementation(() => {
          throw new Error("Original worker ended");
        });
      expect(() => f.manager.assertCurrent(window)).toThrow();
      f.tick(300);
      f.available.mockReset();
      expect(() => f.manager.assertCurrent(window)).toThrow("permanently invalid");
    },
  );

  it("rejects already expired replies even when server wall clock fields look current", () => {
    const f = fixture(),
      request = f.begin();
    f.tick(1100);
    expect(() => f.manager.accept(request.exchange, f.response(request.ready))).toThrow("deadline");
    expect(() => f.manager.accept(structuredClone(request.exchange), f.response(request.ready))).toThrow(
      "original local",
    );
  });

  it.each([
    "request_id",
    "run_id",
    "journal_namespace",
    "node_attempt_id",
    "ready_id",
    "proposal_digest",
    "organization_id",
    "project_id",
    "task_id",
    "actor_user_id",
    "agent_instance_id",
    "computer_id",
    "device_id",
    "session_id",
  ] as const)("refuses changed %s and cannot retry it into authority", (key) => {
    const f = fixture(),
      request = f.begin(),
      response = f.response(request.ready);
    const valid = structuredClone(response);
    response.grant[key] =
      key === "proposal_digest"
        ? `sha256:${"b".repeat(64)}`
        : ["journal_namespace", "node_attempt_id", "ready_id"].includes(key)
          ? randomUUID()
          : "other";
    expect(() => f.manager.accept(request.exchange, response)).toThrow();
    expect(() => f.manager.accept(request.exchange, valid)).toThrow("original local");
  });

  it("rejects mode stripping, extended lifetime, unsupported versions and unknown private fields", () => {
    const changes = [
      (value: ReturnType<ReturnType<typeof fixture>["response"]>) => {
        value.remaining_ms = 1001;
      },
      (value: object) => Object.assign(value, { version: 2 }),
      (value: object) => Object.assign(value, { execution_authorized: true }),
      (value: ReturnType<ReturnType<typeof fixture>["response"]>) =>
        Object.assign(value.grant, { owner_nonce: "foreign" }),
      (value: ReturnType<ReturnType<typeof fixture>["response"]>) => {
        value.grant.expires_at = "2026-11-16T00:00:06.000Z";
      },
    ];
    for (const change of changes) {
      const f = fixture(),
        request = f.begin(),
        response = f.response(request.ready);
      change(response);
      expect(() => f.manager.accept(request.exchange, response)).toThrow();
    }
    const f = fixture();
    expect(() => f.manager.accept({} as SchedulerReadyExchange, {})).toThrow("original local");
    expect(() => f.manager.assertCurrent({} as SchedulerStartWindow)).toThrow("private");
  });
});
