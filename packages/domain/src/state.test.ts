import { describe, expect, it } from "vitest";

import {
  InvalidTransitionError,
  TASK_TRANSITIONS,
  applyApprovalTransition,
  applyRunTransition,
  applyTaskTransition,
  canTransitionApproval,
  canTransitionRun,
  canTransitionTask,
  isApprovalTerminal,
  isRunTerminal,
  isTaskTerminal,
  requiresAttemptScopedIdempotency,
  type TaskStatus,
  type TaskTrigger,
} from "./state.js";

const NON_TERMINAL_TASK: TaskStatus[] = [
  "backlog",
  "ready",
  "assigned",
  "running",
  "awaiting_approval",
  "blocked",
  "review",
];

describe("task state machine", () => {
  it("happy path: backlog -> ready -> assigned -> running -> awaiting_approval -> running -> review -> done", () => {
    const path: Array<[TaskStatus, TaskTrigger, TaskStatus]> = [
      ["backlog", "triage", "ready"],
      ["ready", "assign", "assigned"],
      ["assigned", "run_started", "running"],
      ["running", "approval_requested", "awaiting_approval"],
      ["awaiting_approval", "approval_granted", "running"],
      ["running", "run_completed", "review"],
      ["review", "accept", "done"],
    ];
    for (const [from, trigger, to] of path) {
      expect(applyTaskTransition(from, trigger)).toBe(to);
    }
  });

  it("change-request path: review -> ready -> assigned -> running -> review -> done", () => {
    expect(applyTaskTransition("review", "request_changes")).toBe("ready");
    expect(applyTaskTransition("ready", "assign")).toBe("assigned");
    expect(applyTaskTransition("assigned", "run_started")).toBe("running");
    expect(applyTaskTransition("running", "run_completed")).toBe("review");
    expect(applyTaskTransition("review", "accept")).toBe("done");
  });

  it("assigned failure recovery: retryable -> ready, permission -> blocked (gap3)", () => {
    expect(applyTaskTransition("assigned", "assign_failed_retryable")).toBe("ready");
    expect(applyTaskTransition("assigned", "assign_failed_permission")).toBe("blocked");
  });

  it("blocked retry: blocked -> ready", () => {
    expect(applyTaskTransition("blocked", "retry")).toBe("ready");
  });

  it("invalid terminal: done/cancelled cannot transition", () => {
    expect(isTaskTerminal("done")).toBe(true);
    expect(isTaskTerminal("cancelled")).toBe(true);
    expect(canTransitionTask("done", "triage")).toBe(false);
    expect(canTransitionTask("cancelled", "cancel")).toBe(false);
    expect(() => applyTaskTransition("done", "accept")).toThrow(InvalidTransitionError);
  });

  it("cancel is legal from every non-terminal state", () => {
    for (const s of NON_TERMINAL_TASK) {
      expect(applyTaskTransition(s, "cancel")).toBe("cancelled");
    }
  });

  it("requiresAttemptScopedIdempotency covers assign/retry/request_changes/retryable-recovery (Round 18)", () => {
    expect(requiresAttemptScopedIdempotency("assign")).toBe(true);
    expect(requiresAttemptScopedIdempotency("retry")).toBe(true);
    expect(requiresAttemptScopedIdempotency("request_changes")).toBe(true);
    expect(requiresAttemptScopedIdempotency("assign_failed_retryable")).toBe(true);
    expect(requiresAttemptScopedIdempotency("triage")).toBe(false);
    expect(requiresAttemptScopedIdempotency("run_started")).toBe(false);
    expect(requiresAttemptScopedIdempotency("accept")).toBe(false);
  });

  it("never permanently stuck: every non-terminal status has an outgoing edge", () => {
    for (const s of NON_TERMINAL_TASK) {
      expect(TASK_TRANSITIONS.some((t) => t.from === s)).toBe(true);
    }
  });
});

describe("run state machine", () => {
  it("happy path: queued -> starting -> running -> completed", () => {
    expect(applyRunTransition("queued", "start")).toBe("starting");
    expect(applyRunTransition("starting", "process_started")).toBe("running");
    expect(applyRunTransition("running", "run_completed")).toBe("completed");
  });

  it("start failure: starting -> failed", () => {
    expect(applyRunTransition("starting", "start_failed")).toBe("failed");
  });

  it("retry is a NEW run: no failed -> queued edge; terminals are terminal", () => {
    expect(canTransitionRun("failed", "start")).toBe(false);
    expect(isRunTerminal("failed")).toBe(true);
    expect(isRunTerminal("completed")).toBe(true);
    expect(isRunTerminal("cancelled")).toBe(true);
  });

  it("throws on illegal transition", () => {
    expect(() => applyRunTransition("completed", "start")).toThrow(InvalidTransitionError);
  });
});

describe("approval state machine", () => {
  it("pending resolves to each outcome", () => {
    expect(applyApprovalTransition("pending", "approve")).toBe("approved");
    expect(applyApprovalTransition("pending", "reject")).toBe("rejected");
    expect(applyApprovalTransition("pending", "need_more_info")).toBe("needs_more_info");
    expect(applyApprovalTransition("pending", "expire")).toBe("expired");
  });

  it("needs_more_info can still be resolved", () => {
    expect(applyApprovalTransition("needs_more_info", "approve")).toBe("approved");
  });

  it("approved is terminal", () => {
    expect(isApprovalTerminal("approved")).toBe(true);
    expect(canTransitionApproval("approved", "reject")).toBe(false);
  });
});
