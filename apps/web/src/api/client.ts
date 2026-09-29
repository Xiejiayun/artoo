/**
 * Typed REST client for the artoo v0.1-core API (design.md §10.6; codex Round
 * 12/15). Request/response types come from `@artoo/domain`; mutating calls take
 * a caller-provided idempotency key and set the `Idempotency-Key` header. Error
 * responses use the fixed `{ error: { code, message, details } }` envelope and
 * are surfaced as {@link ApiClientError}.
 */
import type {
  ApiErrorCode,
  AssignRequest,
  CreateTaskRequest,
  ProposeMemoryRequest,
  ResolveApprovalRequest,
  RetryRequest,
  ReviewRequest,
  SendMessageRequest,
  Task,
  Message,
  Approval,
  Goal, Plan, Checkpoint, TaskDependency, FileLease, Device, DevicePlatform,
  CreateGoalRequest, ProposePlanRequest, CreateDependencyRequest, InstallSkillRequest, SkillInstall,
  DecisionRecord, HandoffRecord, BlockerRecord, CreateDecisionRequest, CreateHandoffRequest, CreateBlockerRequest,
  UpdateDecisionRequest, UpdateHandoffRequest, UpdateBlockerRequest,
} from "@artoo/domain";

import type {
  AuditBundleExportResponse,
  ApprovalsResponse,
  AssignResponse,
  AuditBundleResponse,
  BootstrapResponse,
  ComputerRuntimesResponse,
  CreateTaskResponse,
  MemoriesResponse,
  MemoryContextResponse,
  MemoryResponse,
  MessagesResponse,
  RetryResponse,
  RunResponse,
  SessionResponse,
  SkillInstallsResponse,
  SupersedeMemoryResponse,
  TasksResponse,
  TaskSnapshot,
} from "./types.js";

export type ApiClientErrorCode = ApiErrorCode | "network_error" | "unknown";

export class ApiClientError extends Error {
  constructor(
    public readonly code: ApiClientErrorCode,
    message: string,
    public readonly status: number,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export interface ApiClientOptions {
  /** Native shells provide credentials from their secure store; never localStorage. */
  tokenProvider?: () => string | null | undefined | Promise<string | null | undefined>;
  /** Defaults to `/api/v1` (served via the Vite dev proxy / same origin). */
  baseUrl?: string;
  /** Fetch credential mode. Browser web uses cookies; desktop device smoke does not. */
  credentials?: RequestCredentials;
  /** Override for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

interface RequestOptions {
  body?: unknown;
  idempotencyKey?: string;
}

export class ApiClient {
  private readonly baseUrl: string;
  /** Origin root for auth endpoints (`/auth/*`), i.e. baseUrl without `/api/v1`. */
  private readonly authBaseUrl: string;
  private readonly credentials: RequestCredentials;
  private readonly fetchOverride?: typeof fetch;
  private readonly tokenProvider?: ApiClientOptions["tokenProvider"];

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "/api/v1").replace(/\/$/, "");
    this.authBaseUrl = this.baseUrl.replace(/\/api\/v1$/, "");
    this.credentials = options.credentials ?? "include";
    this.fetchOverride = options.fetch;
    this.tokenProvider = options.tokenProvider;
  }

  private async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    const token = await this.tokenProvider?.();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (options.idempotencyKey !== undefined) {
      headers["Idempotency-Key"] = options.idempotencyKey;
    }

    // Resolve the global fetch lazily so test interceptors (MSW) that replace
    // globalThis.fetch after construction are honored.
    const fetchImpl = this.fetchOverride ?? globalThis.fetch;
    let response: Response;
    try {
      response = await fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        // Send the session cookie (#34 web auth) so the server's protected guard
        // can authenticate the request.
        credentials: this.credentials,
        redirect: "error",
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
    } catch (cause) {
      throw new ApiClientError("network_error", `Network request failed: ${String(cause)}`, 0);
    }

    const text = await response.text();
    const json: unknown = parseResponse(text);

    if (!response.ok) {
      const envelope = (json as { error?: { code?: ApiErrorCode; message?: string; details?: Record<string, unknown> } } | undefined)?.error;
      throw new ApiClientError(
        envelope?.code ?? "unknown",
        envelope?.message ?? response.statusText,
        response.status,
        envelope?.details ?? {},
      );
    }

    return json as T;
  }

  bootstrap(): Promise<BootstrapResponse> {
    return this.request<BootstrapResponse>("GET", "/bootstrap");
  }

  createProject(body: { name: string; default_workspace?: string | null }, key: string): Promise<{ project: BootstrapResponse["projects"][number] }> {
    return this.request("POST", "/projects", { body, idempotencyKey: key });
  }
  updateProject(id: string, body: { name?: string; default_workspace?: string | null }, key: string): Promise<{ project: BootstrapResponse["projects"][number] }> {
    return this.request("PATCH", `/projects/${encodeURIComponent(id)}`, { body, idempotencyKey: key });
  }
  listGoals(projectId: string): Promise<{ goals: Goal[] }> { return this.request("GET", `/goals?project_id=${encodeURIComponent(projectId)}`); }
  createGoal(body: CreateGoalRequest, key: string): Promise<{ goal: Goal }> { return this.request("POST", "/goals", { body, idempotencyKey: key }); }
  goalAction(id: string, action: "pause" | "resume" | "cancel" | "reconcile", key: string): Promise<unknown> { return this.request("POST", `/goals/${encodeURIComponent(id)}/${action}`, { idempotencyKey: key }); }
  listPlans(id: string): Promise<{ plans: Plan[] }> { return this.request("GET", `/goals/${encodeURIComponent(id)}/plans`); }
  proposePlan(id: string, body: ProposePlanRequest, key: string): Promise<{ plan: Plan }> { return this.request("POST", `/goals/${encodeURIComponent(id)}/plans`, { body, idempotencyKey: key }); }
  planAction(id: string, action: "accept" | "reject", key: string): Promise<{ plan: Plan; task_ids?: string[] }> { return this.request("POST", `/plans/${encodeURIComponent(id)}/${action}`, { idempotencyKey: key }); }
  listCheckpoints(id: string): Promise<{ checkpoints: Checkpoint[] }> { return this.request("GET", `/goals/${encodeURIComponent(id)}/checkpoints`); }
  goalAuditExport(id: string): Promise<{ export: unknown }> { return this.request("GET", `/goals/${encodeURIComponent(id)}/audit-bundle/export`); }
  listDecisions(roomId: string): Promise<{ decisions: DecisionRecord[] }> { return this.request("GET", `/rooms/${encodeURIComponent(roomId)}/decisions`); }
  listHandoffs(roomId: string): Promise<{ handoffs: HandoffRecord[] }> { return this.request("GET", `/rooms/${encodeURIComponent(roomId)}/handoffs`); }
  listBlockers(roomId: string): Promise<{ blockers: BlockerRecord[] }> { return this.request("GET", `/rooms/${encodeURIComponent(roomId)}/blockers`); }
  createDecision(roomId: string, body: CreateDecisionRequest, key: string): Promise<{ decision: DecisionRecord }> { return this.request("POST", `/rooms/${encodeURIComponent(roomId)}/decisions`, { body, idempotencyKey: key }); }
  createHandoff(roomId: string, body: CreateHandoffRequest, key: string): Promise<{ handoff: HandoffRecord }> { return this.request("POST", `/rooms/${encodeURIComponent(roomId)}/handoffs`, { body, idempotencyKey: key }); }
  createBlocker(roomId: string, body: CreateBlockerRequest, key: string): Promise<{ blocker: BlockerRecord }> { return this.request("POST", `/rooms/${encodeURIComponent(roomId)}/blockers`, { body, idempotencyKey: key }); }
  updateDecision(id: string, body: UpdateDecisionRequest, key: string): Promise<unknown> { return this.request("PATCH", `/decisions/${encodeURIComponent(id)}`, { body, idempotencyKey: key }); }
  updateHandoff(id: string, body: UpdateHandoffRequest, key: string): Promise<unknown> { return this.request("PATCH", `/handoffs/${encodeURIComponent(id)}`, { body, idempotencyKey: key }); }
  updateBlocker(id: string, body: UpdateBlockerRequest, key: string): Promise<unknown> { return this.request("PATCH", `/blockers/${encodeURIComponent(id)}`, { body, idempotencyKey: key }); }
  listDependencies(id: string): Promise<{ dependencies: TaskDependency[] }> { return this.request("GET", `/tasks/${encodeURIComponent(id)}/dependencies`); }
  createDependency(id: string, body: CreateDependencyRequest, key: string): Promise<unknown> { return this.request("POST", `/tasks/${encodeURIComponent(id)}/dependencies`, { body, idempotencyKey: key }); }
  deleteDependency(id: string, dependencyId: string, key: string): Promise<unknown> { return this.request("DELETE", `/tasks/${encodeURIComponent(id)}/dependencies/${encodeURIComponent(dependencyId)}`, { idempotencyKey: key }); }
  listLeases(projectId: string): Promise<{ leases: FileLease[] }> { return this.request("GET", `/projects/${encodeURIComponent(projectId)}/leases`); }
  installSkill(body: InstallSkillRequest, key: string): Promise<{ skill: SkillInstall }> { return this.request("POST", "/skills/install", { body, idempotencyKey: key }); }
  listDevices(): Promise<{ devices: Device[] }> { return this.request("GET", "/devices"); }
  registerAgent(computerId: string, body: { runtime: string; workspace_root: string; display_name?: string; capabilities?: string[] }, key: string): Promise<unknown> { return this.request("POST", `/computers/${encodeURIComponent(computerId)}/instances`, { body, idempotencyKey: key }); }
  setAgentEnabled(id: string, enabled: boolean, key: string): Promise<unknown> { return this.request("PATCH", `/agent-instances/${encodeURIComponent(id)}`, { body: { enabled }, idempotencyKey: key }); }
  createPairing(platform: DevicePlatform, key: string): Promise<{ code: string; pairing: { expires_at: string } }> { return this.request("POST", "/devices/pairings", { body: { intended_platform: platform }, idempotencyKey: key }); }
  revokeDevice(id: string, key: string): Promise<unknown> { return this.request("POST", `/devices/${encodeURIComponent(id)}/revoke`, { idempotencyKey: key }); }
  async downloadArtifact(id: string): Promise<Blob> {
    const headers: Record<string, string> = {};
    const token = await this.tokenProvider?.();
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await (this.fetchOverride ?? globalThis.fetch)(`${this.baseUrl}/artifacts/${encodeURIComponent(id)}/content`, { headers, credentials: this.credentials, redirect: "error" });
    if (!response.ok) throw new ApiClientError("unknown", "Unable to download artifact. It may be unavailable or your session may have expired.", response.status);
    return response.blob();
  }

  listTasks(projectId: string): Promise<TasksResponse> {
    return this.request<TasksResponse>("GET", `/tasks?project_id=${encodeURIComponent(projectId)}`);
  }

  getTask(taskId: string): Promise<TaskSnapshot> {
    return this.request<TaskSnapshot>("GET", `/tasks/${encodeURIComponent(taskId)}`);
  }

  createTask(body: CreateTaskRequest, idempotencyKey: string): Promise<CreateTaskResponse> {
    return this.request<CreateTaskResponse>("POST", "/tasks", { body, idempotencyKey });
  }

  markReady(taskId: string, idempotencyKey: string): Promise<{ task: Task }> {
    return this.request<{ task: Task }>("POST", `/tasks/${encodeURIComponent(taskId)}/ready`, {
      idempotencyKey,
    });
  }

  assignTask(taskId: string, body: AssignRequest, idempotencyKey: string): Promise<AssignResponse> {
    return this.request<AssignResponse>("POST", `/tasks/${encodeURIComponent(taskId)}/assign`, {
      body,
      idempotencyKey,
    });
  }

  retryTask(taskId: string, body: RetryRequest, idempotencyKey: string): Promise<RetryResponse> {
    return this.request<RetryResponse>("POST", `/tasks/${encodeURIComponent(taskId)}/retry`, {
      body,
      idempotencyKey,
    });
  }

  reviewTask(taskId: string, body: ReviewRequest & { base_version?: number }, idempotencyKey: string): Promise<{ task: Task }> {
    return this.request<{ task: Task }>("POST", `/tasks/${encodeURIComponent(taskId)}/review`, {
      body,
      idempotencyKey,
    });
  }

  listMessages(roomId: string): Promise<MessagesResponse> {
    return this.request<MessagesResponse>("GET", `/rooms/${encodeURIComponent(roomId)}/messages`);
  }

  sendMessage(
    roomId: string,
    body: SendMessageRequest,
    idempotencyKey: string,
  ): Promise<{ message: Message }> {
    return this.request<{ message: Message }>(
      "POST",
      `/rooms/${encodeURIComponent(roomId)}/messages`,
      { body, idempotencyKey },
    );
  }

  getRun(runId: string): Promise<RunResponse> {
    return this.request<RunResponse>("GET", `/runs/${encodeURIComponent(runId)}`);
  }

  listComputerRuntimes(computerId: string): Promise<ComputerRuntimesResponse> {
    return this.request<ComputerRuntimesResponse>(
      "GET",
      `/computers/${encodeURIComponent(computerId)}/runtimes`,
    );
  }

  listSkillInstalls(): Promise<SkillInstallsResponse> {
    return this.request<SkillInstallsResponse>("GET", "/skills");
  }

  cancelRun(runId: string, idempotencyKey: string): Promise<RunResponse> {
    return this.request<RunResponse>("POST", `/runs/${encodeURIComponent(runId)}/cancel`, {
      idempotencyKey,
    });
  }

  listApprovals(status = "pending"): Promise<ApprovalsResponse> {
    return this.request<ApprovalsResponse>("GET", `/approvals?status=${encodeURIComponent(status)}`);
  }

  requestExecutionApproval(taskId: string, body: { summary: string; risk: "low" | "medium" | "high" }, key: string): Promise<{ approval: Approval }> {
    return this.request("POST", `/tasks/${encodeURIComponent(taskId)}/execution-approval`, { body, idempotencyKey: key });
  }

  resolveApproval(
    approvalId: string,
    body: ResolveApprovalRequest,
    idempotencyKey: string,
  ): Promise<{ approval: Approval }> {
    return this.request<{ approval: Approval }>(
      "POST",
      `/approvals/${encodeURIComponent(approvalId)}/resolve`,
      { body, idempotencyKey },
    );
  }

  // Memory (#22): list/filter, detail, curation actions, and the accepted-only
  // context preview that surfaces ContextPack source-memory evidence.
  listMemories(filters: MemoryFilters = {}): Promise<MemoriesResponse> {
    const params = new URLSearchParams();
    if (filters.status) params.set("status", filters.status);
    if (filters.scope) params.set("scope", filters.scope);
    if (filters.tag) params.set("tag", filters.tag);
    if (filters.projectId) params.set("project_id", filters.projectId);
    if (filters.taskId) params.set("task_id", filters.taskId);
    const qs = params.toString();
    return this.request<MemoriesResponse>("GET", `/memories${qs ? `?${qs}` : ""}`);
  }

  getMemory(memoryId: string): Promise<MemoryResponse> {
    return this.request<MemoryResponse>("GET", `/memories/${encodeURIComponent(memoryId)}`);
  }

  acceptMemory(memoryId: string, idempotencyKey: string): Promise<MemoryResponse> {
    return this.request<MemoryResponse>("POST", `/memories/${encodeURIComponent(memoryId)}/accept`, {
      idempotencyKey,
    });
  }

  rejectMemory(memoryId: string, idempotencyKey: string): Promise<MemoryResponse> {
    return this.request<MemoryResponse>("POST", `/memories/${encodeURIComponent(memoryId)}/reject`, {
      idempotencyKey,
    });
  }

  supersedeMemory(
    memoryId: string,
    body: ProposeMemoryRequest,
    idempotencyKey: string,
  ): Promise<SupersedeMemoryResponse> {
    return this.request<SupersedeMemoryResponse>(
      "POST",
      `/memories/${encodeURIComponent(memoryId)}/supersede`,
      { body, idempotencyKey },
    );
  }

  getMemoryContext(projectId: string, taskId?: string): Promise<MemoryContextResponse> {
    const params = new URLSearchParams({ project_id: projectId });
    if (taskId) params.set("task_id", taskId);
    return this.request<MemoryContextResponse>("GET", `/memories/context?${params.toString()}`);
  }

  // Runs & Audit (#16): deterministic read-only task evidence bundle.
  getTaskAuditBundle(taskId: string): Promise<AuditBundleResponse> {
    return this.request<AuditBundleResponse>(
      "GET",
      `/tasks/${encodeURIComponent(taskId)}/audit-bundle`,
    );
  }

  getTaskAuditBundleExport(taskId: string): Promise<AuditBundleExportResponse> {
    return this.request<AuditBundleExportResponse>(
      "GET",
      `/tasks/${encodeURIComponent(taskId)}/audit-bundle/export`,
    );
  }

  // Auth (#34): session + logout hit `/auth/*` at the server origin root (NOT
  // `/api/v1`). The OAuth start/callback are browser navigations, not fetches
  // (see LoginPage). getSession throws ApiClientError(401) when unauthenticated.
  getSession(): Promise<SessionResponse> {
    return this.authRequest<SessionResponse>("GET", "/auth/session");
  }

  async logout(): Promise<void> {
    await this.authRequest<unknown>("POST", "/auth/logout");
  }

  private async authRequest<T>(method: string, path: string): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
    const token = await this.tokenProvider?.();
    if (token) headers.Authorization = `Bearer ${token}`;
    const fetchImpl = this.fetchOverride ?? globalThis.fetch;
    let response: Response;
    try {
      response = await fetchImpl(`${this.authBaseUrl}${path}`, {
        method,
        headers,
        credentials: this.credentials,
        redirect: "error",
      });
    } catch (cause) {
      throw new ApiClientError("network_error", `Network request failed: ${String(cause)}`, 0);
    }
    const text = await response.text();
    const json: unknown = parseResponse(text);
    if (!response.ok) {
      const envelope = (json as { error?: { code?: ApiErrorCode; message?: string } } | undefined)
        ?.error;
      throw new ApiClientError(
        envelope?.code ?? "unknown",
        envelope?.message ?? response.statusText,
        response.status,
      );
    }
    return json as T;
  }
}

function parseResponse(text: string): unknown {
  if (!text) return undefined;
  try { return JSON.parse(text); }
  catch { throw new ApiClientError("unknown", "The server returned an invalid response. Check the server address and try again.", 0); }
}

/** Filters for {@link ApiClient.listMemories}. */
export interface MemoryFilters {
  status?: string;
  scope?: string;
  tag?: string;
  projectId?: string;
  taskId?: string;
}
