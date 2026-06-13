/**
 * Response snapshot shapes the web consumes from the server (task #5).
 *
 * Entity types come from `@artoo/domain` (single source of truth). The wrapper
 * shapes here are intentionally thin and centralized so they are easy to swap if
 * #5 names/routes differ (codex Phase 1 guardrail). The web NEVER derives
 * business state from these — it only renders the snapshot + WS patches.
 */
import type { Approval, Artifact, Message, Room, Run, Task } from "@artoo/domain";

export interface BootstrapResponse {
  organization: { id: string; name: string };
  user: { id: string; email: string; display_name: string; role: string };
  projects: Array<{ id: string; name: string; default_workspace: string | null }>;
  actor: { type: string; id: string };
}

/** Aggregated read model for a single task detail view. */
export interface TaskSnapshot {
  task: Task;
  room: Room | null;
  runs: Run[];
  approvals: Approval[];
  artifacts: Artifact[];
}

export interface CreateTaskResponse {
  task: Task;
  room: Room;
}

export interface AssignResponse {
  run: Run;
  scheduler_decision: { reason: string; score: number };
}

export interface RetryResponse {
  /** present when a new run was scheduled; absent when the task only re-entered ready. */
  run?: Run;
  task: Task;
}

export interface MessagesResponse {
  messages: Message[];
}

export interface RunResponse {
  run: Run;
}

export interface ApprovalsResponse {
  approvals: Approval[];
}
