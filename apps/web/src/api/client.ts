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
  ResolveApprovalRequest,
  RetryRequest,
  ReviewRequest,
  SendMessageRequest,
  Task,
  Message,
  Approval,
} from "@artoo/domain";

import type {
  ApprovalsResponse,
  AssignResponse,
  BootstrapResponse,
  CreateTaskResponse,
  MessagesResponse,
  RetryResponse,
  RunResponse,
  TaskSnapshot,
  TasksResponse,
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
  /** Defaults to `/api/v1` (served via the Vite dev proxy / same origin). */
  baseUrl?: string;
  /** Override for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

interface RequestOptions {
  body?: unknown;
  idempotencyKey?: string;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchOverride?: typeof fetch;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "/api/v1").replace(/\/$/, "");
    this.fetchOverride = options.fetch;
  }

  private async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json" };
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
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
    } catch (cause) {
      throw new ApiClientError("network_error", `Network request failed: ${String(cause)}`, 0);
    }

    const text = await response.text();
    const json: unknown = text.length > 0 ? JSON.parse(text) : undefined;

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

  reviewTask(taskId: string, body: ReviewRequest, idempotencyKey: string): Promise<{ task: Task }> {
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

  cancelRun(runId: string, idempotencyKey: string): Promise<RunResponse> {
    return this.request<RunResponse>("POST", `/runs/${encodeURIComponent(runId)}/cancel`, {
      idempotencyKey,
    });
  }

  listApprovals(status = "pending"): Promise<ApprovalsResponse> {
    return this.request<ApprovalsResponse>("GET", `/approvals?status=${encodeURIComponent(status)}`);
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
}
