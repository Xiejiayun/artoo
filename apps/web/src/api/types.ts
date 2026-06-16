/**
 * Response snapshot shapes the web consumes from the server (task #5).
 *
 * Entity types come from `@artoo/domain` (single source of truth). The wrapper
 * shapes here are intentionally thin and centralized so they are easy to swap if
 * #5 names/routes differ (codex Phase 1 guardrail). The web NEVER derives
 * business state from these — it only renders the snapshot + WS patches.
 */
import type {
  Agent,
  AgentInstance,
  AgentRuntime,
  Approval,
  Artifact,
  Memory,
  Message,
  Computer,
  EffortProfile,
  ModelProfile,
  Room,
  Run,
  SkillInstall,
  Task,
  AuditBundleExport,
  TaskAuditBundle,
} from "@artoo/domain";

export interface BootstrapResponse {
  organization: { id: string; name: string };
  user: { id: string; email: string; display_name: string; role: string };
  projects: Array<{ id: string; name: string; default_workspace: string | null }>;
  computers: Computer[];
  agents: Agent[];
  agent_instances: AgentInstance[];
  model_profiles: ModelProfile[];
  effort_profiles: EffortProfile[];
  actor: { type: string; id: string };
}

export interface ComputerRuntimesResponse {
  runtimes: AgentRuntime[];
}

export interface SkillInstallsResponse {
  skills: SkillInstall[];
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

export interface TasksResponse {
  tasks: Task[];
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

export interface MemoriesResponse {
  memories: Memory[];
}

export interface MemoryResponse {
  memory: Memory;
}

/** `POST /memories/:id/supersede` returns the replacement + the de-listed old memory. */
export interface SupersedeMemoryResponse {
  memory: Memory;
  superseded: Memory;
}

/** `GET /memories/context` — the accepted memories that would inject + the audit ids. */
export interface MemoryContextResponse {
  memories: Memory[];
  source_memory_ids: string[];
}

/** `GET /tasks/:id/audit-bundle` — deterministic read-only task evidence. */
export interface AuditBundleResponse {
  bundle: TaskAuditBundle;
}

/** `GET /tasks/:id/audit-bundle/export` — shareable unsigned v1alpha1 evidence proof. */
export interface AuditBundleExportResponse {
  export: AuditBundleExport;
}

/** The authenticated user. Fields align with the bootstrap user (#34 server locks the exact shape). */
export interface SessionUser {
  id: string;
  email: string;
  name?: string;
  display_name?: string;
  role?: string;
}

/** `GET /auth/session` — current user when authenticated; the endpoint 401s otherwise. */
export interface SessionResponse {
  user: SessionUser;
}
