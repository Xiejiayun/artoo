import { isRemovedMessage, removedMessage } from "./messageModeration.js";
import type { ContentReport, ContentRules, ModerationMember } from "./contentModeration.js";
/**
 * Typed REST client for the artoo v0.1-core API (design.md §10.6; codex Round
 * 12/15). Request/response types come from `@artoo/domain`; mutating calls take
 * a caller-provided idempotency key and set the `Idempotency-Key` header. Error
 * responses use the fixed `{ error: { code, message, details } }` envelope and
 * are surfaced as {@link ApiClientError}.
 */
import type { AiDataSharingState } from "./aiDataSharing.js";
import type {
  ApiErrorCode,
  AssignRequest,
  CreateTaskRequest,
  ProposeMemoryRequest,
  ResolveApprovalRequest,
  RetryRequest,
  ReviewRequest,
  SendMessageRequest,
  SendAssistantTurnRequest,
  Channel, CreateChannelRequest, Member, Notification, Room,
  Discussion, StartDiscussionRequest,
  Task,
  Message,
  Approval,
  Goal, Plan, Checkpoint, TaskDependency, FileLease, Device, DevicePlatform,
  CreateGoalRequest, ProposePlanRequest, CreateDependencyRequest, InstallSkillRequest, SkillInstall,
  DecisionRecord, HandoffRecord, BlockerRecord, CreateDecisionRequest, CreateHandoffRequest, CreateBlockerRequest,
  UpdateDecisionRequest, UpdateHandoffRequest, UpdateBlockerRequest,
  AgentInstance, WorktreeBaseConfiguration,
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
  MessagePageOptions,
  NotificationPageOptions,
  NotificationsResponse,
  AssistantTurn,
  DaemonPresence,
  RetryResponse,
  RunResponse,
  RunUsage,
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
  private consentScope?: { request: () => Promise<boolean>; cancel: () => void; userId?: string };
  private consentEpoch = 0;

  setAIConsentHandler(request: () => Promise<boolean>, cancel: () => void, userId?: string): () => void {
    this.invalidateAIConsent();
    const scope = { request, cancel, userId };
    this.consentScope = scope;
    return () => {
      if (this.consentScope === scope) { this.invalidateAIConsent(); this.consentScope = undefined; }
    };
  }
  invalidateAIConsent(): void { this.consentEpoch++; this.consentScope?.cancel(); }
  async aiDataSharing(): Promise<AiDataSharingState> {
    const userId = this.consentScope?.userId;
    const state = await this.request<AiDataSharingState>("GET", "/privacy/ai-sharing");
    if (userId && state.user_id !== userId) throw new ApiClientError("conflict", "Your account changed. Reload this workspace before managing AI permission.", 409);
    return state;
  }
  allowAIDataSharing(version: string, expectedUserId: string): Promise<AiDataSharingState> {
    return this.request("POST", "/privacy/ai-sharing/consent", { body: { policy_version: version, expected_user_id: expectedUserId } });
  }
  withdrawAIDataSharing(expectedUserId: string): Promise<AiDataSharingState> {
    return this.request("DELETE", "/privacy/ai-sharing/consent", { body: { stop_my_agent_work: true, expected_user_id: expectedUserId } });
  }

  private readonly removedMessages = new Map<string, Set<string>>();
  noteMessageRemoved(roomId: string, messageId: string): void {
    const ids = this.removedMessages.get(roomId) ?? new Set<string>(); ids.add(messageId); this.removedMessages.set(roomId, ids);
  }
  messageForDisplay(message: Message): Message {
    if (isRemovedMessage(message)) this.noteMessageRemoved(message.room_id, message.id);
    return this.removedMessages.get(message.room_id)?.has(message.id) ? removedMessage(message) : message;
  }
  async messageVisibility(roomId: string, messageIds: string[]): Promise<string[]> {
    const result = await this.request<{ removed_message_ids: string[] }>("POST", `/rooms/${encodeURIComponent(roomId)}/messages/visibility`, { body: { message_ids: messageIds } });
    for (const id of result.removed_message_ids) this.noteMessageRemoved(roomId, id);
    return result.removed_message_ids;
  }

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
    const scope = this.consentScope;
    const epoch = this.consentEpoch;
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
    const init: RequestInit = {
      method, headers, credentials: this.credentials, redirect: "error",
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    };
    const execute = async (allowConsent: boolean): Promise<T> => {
      let response: Response;
      try { response = await fetchImpl(`${this.baseUrl}${path}`, init); }
      catch (cause) { throw new ApiClientError("network_error", `Network request failed: ${String(cause)}`, 0); }
      const json: unknown = parseResponse(await response.text());
      if (!response.ok) {
        const envelope = (json as { error?: { code?: ApiErrorCode; message?: string; details?: Record<string, unknown> } } | undefined)?.error;
        if (response.status === 401) this.invalidateAIConsent();
        if (allowConsent && response.status === 428 && envelope?.code === "ai_consent_required"
          && scope && scope === this.consentScope && epoch === this.consentEpoch) {
          const identity = scope.userId ?? (await this.getSession()).user.id;
          if (await scope.request()) {
            // Cookies and native connection tokens may change while a dialog is open.
            const current = await this.getSession();
            if (scope !== this.consentScope || epoch !== this.consentEpoch || current.user.id !== identity
              || token !== await this.tokenProvider?.()) {
              throw new ApiClientError("conflict", "Your account changed. Start this action again in your current workspace.", 409);
            }
            return execute(false);
          }
        }
        throw new ApiClientError(envelope?.code ?? "unknown", envelope?.message ?? response.statusText,
          response.status, envelope?.details ?? {});
      }
      return json as T;
    };
    return execute(!path.startsWith("/privacy/"));
  }

  reportMessage(messageId: string, reason: string, key: string): Promise<ContentReport> {
    return this.request("POST", `/messages/${encodeURIComponent(messageId)}/report`, { body: { reason }, idempotencyKey: key });
  }
  myContentReports(before?: string): Promise<{ reports: ContentReport[]; next_before?: string | null }> { return this.request("GET", `/moderation/my-reports${before ? `?before=${encodeURIComponent(before)}` : ""}`); }
  contentReports(before?: string): Promise<{ reports: ContentReport[]; next_before: string | null }> {
    return this.request("GET", `/moderation/reports${before ? `?before=${encodeURIComponent(before)}` : ""}`);
  }
  resolveContentReport(id: string, action: "remove" | "dismiss", note: string, key: string): Promise<ContentReport> {
    return this.request("POST", `/moderation/reports/${encodeURIComponent(id)}/resolve`, { body: { action, note }, idempotencyKey: key });
  }
  contentRules(): Promise<ContentRules> { return this.request("GET", "/moderation/rules"); }
  saveContentRules(blocked_phrases: string[], version: string, key: string): Promise<ContentRules> {
    return this.request("PUT", "/moderation/rules", { body: { blocked_phrases, version }, idempotencyKey: key });
  }
  moderationMembers(): Promise<{ members: ModerationMember[] }> { return this.request("GET", "/moderation/members"); }
  suspendMember(id: string, suspended: boolean, reason: string, key: string): Promise<{ user_id: string; suspended: boolean; execution_notice: string }> {
    return this.request("POST", `/moderation/members/${encodeURIComponent(id)}/suspension`, { body: { suspended, reason }, idempotencyKey: key });
  }

  bootstrap(): Promise<BootstrapResponse> {
    return this.request<BootstrapResponse>("GET", "/bootstrap");
  }

  /** Non-secret identity for scoping local drafts to this server. */
  getStorageScope(): string {
    return new URL(this.baseUrl, globalThis.location?.href ?? "http://localhost/").href;
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
  setAgentWorktreeBase(id: string, body: WorktreeBaseConfiguration): Promise<{ agent_instance: AgentInstance }> { return this.request("PATCH", `/agent-instances/${encodeURIComponent(id)}/worktree-workspace-base`, { body }); }
  clearAgentWorktreeBase(id: string): Promise<{ agent_instance: AgentInstance }> { return this.request("DELETE", `/agent-instances/${encodeURIComponent(id)}/worktree-workspace-base`); }
  createPairing(platform: DevicePlatform, key: string): Promise<{ code: string; pairing: { expires_at: string } }> { return this.request("POST", "/devices/pairings", { body: { intended_platform: platform }, idempotencyKey: key }); }
  revokeDevice(id: string, key: string): Promise<unknown> { return this.request("POST", `/devices/${encodeURIComponent(id)}/revoke`, { idempotencyKey: key }); }
  enrollDevice(id: string, key: string): Promise<{ device_id: string; computer_id: string; created: boolean }> { return this.request("POST", `/devices/${encodeURIComponent(id)}/enroll`, { body: {}, idempotencyKey: key }); }
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

  async listMessages(roomId: string, options: MessagePageOptions = {}): Promise<MessagesResponse> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.before !== undefined) params.set("before", options.before);
    if (options.after !== undefined) params.set("after", options.after);
    if (options.thread_root_id !== undefined) params.set("thread_root_id", options.thread_root_id);
    const query = params.toString();
    const response = await this.request<MessagesResponse>("GET", `/rooms/${encodeURIComponent(roomId)}/messages${query ? `?${query}` : ""}`);
    return { ...response, messages: response.messages.map((message) => this.messageForDisplay(message)) };
  }

  listChannels(projectId: string): Promise<{ channels: Channel[] }> { return this.request("GET", `/channels?project_id=${encodeURIComponent(projectId)}`); }
  listDiscussions(goalId: string): Promise<{ discussions: Discussion[] }> { return this.request("GET", `/goals/${encodeURIComponent(goalId)}/discussions`); }
  startDiscussion(goalId: string, body: StartDiscussionRequest, key: string): Promise<{ discussion: Discussion }> { return this.request("POST", `/goals/${encodeURIComponent(goalId)}/discussions`, { body, idempotencyKey: key }); }
  cancelDiscussion(id: string, key: string): Promise<{ discussion: Discussion }> { return this.request("POST", `/discussions/${encodeURIComponent(id)}/cancel`, { idempotencyKey: key }); }
  proposeDiscussionPlan(id: string, key: string): Promise<{ discussion: Discussion; plan: Plan }> { return this.request("POST", `/discussions/${encodeURIComponent(id)}/propose-plan`, { idempotencyKey: key }); }
  createChannel(body: CreateChannelRequest, key: string): Promise<{ channel: Channel }> { return this.request("POST", "/channels", { body, idempotencyKey: key }); }
  listMembers(): Promise<{ members: Member[] }> { return this.request("GET", "/members"); }
  listNotifications(options: NotificationPageOptions = {}): Promise<NotificationsResponse> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.before !== undefined) params.set("before", options.before);
    return this.request("GET", `/notifications${params.size ? `?${params}` : ""}`);
  }
  readNotification(id: string, key: string): Promise<{ notification: Notification; unread_count?: number }> { return this.request("POST", `/notifications/${encodeURIComponent(id)}/read`, { idempotencyKey: key }); }
  getRoom(roomId: string): Promise<{ room: Room }> { return this.request("GET", `/rooms/${encodeURIComponent(roomId)}`); }
  async getMessage(roomId: string, messageId: string): Promise<{ message: Message }> {
    const result = await this.request<{ message: Message }>("GET", `/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}`);
    return { message: this.messageForDisplay(result.message) };
  }
  listDaemons(): Promise<{ daemons: DaemonPresence[] }> { return this.request("GET", "/daemons"); }

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

  listAssistantTurns(roomId: string, threadRootId?: string): Promise<{ turns: AssistantTurn[] }> {
    const query = threadRootId ? `?thread_root_id=${encodeURIComponent(threadRootId)}` : "";
    return this.request("GET", `/rooms/${encodeURIComponent(roomId)}/assistant-turns${query}`);
  }

  sendToAssistant(roomId: string, body: SendAssistantTurnRequest, key: string): Promise<{ turn: AssistantTurn; message: Message }> {
    return this.request("POST", `/rooms/${encodeURIComponent(roomId)}/assistant-turns`, { body, idempotencyKey: key });
  }

  assistantTurnAction(id: string, action: "cancel" | "retry", key: string): Promise<{ turn: AssistantTurn }> {
    return this.request("POST", `/assistant-turns/${encodeURIComponent(id)}/${action}`, { idempotencyKey: key });
  }

  getRun(runId: string): Promise<RunResponse> {
    return this.request<RunResponse>("GET", `/runs/${encodeURIComponent(runId)}`);
  }

  getRunUsage(runId: string): Promise<{ usage: RunUsage | null }> {
    return this.request("GET", `/runs/${encodeURIComponent(runId)}/usage`);
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
    this.invalidateAIConsent();
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
      if (response.status === 401) this.invalidateAIConsent();
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
