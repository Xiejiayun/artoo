import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach } from "vitest";

import type {
  Approval,
  Artifact,
  AuditEvent,
  Memory,
  Message,
  Room,
  Run,
  SchedulerDecision,
  Task,
  TaskAuditBundle,
} from "@artoo/domain";

import { ApiClient } from "../api/client.js";
import type { BootstrapResponse } from "../api/types.js";
import { ApiProvider } from "../app/ApiContext.js";
import { SelectionProvider } from "../app/SelectionContext.js";

// globals:false means @testing-library's automatic afterEach cleanup is not
// registered; do it explicitly so each test starts with a fresh DOM.
afterEach(() => {
  cleanup();
});

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

/**
 * An ApiClient with networking disabled and selected methods overridden for the
 * component under test. Component tests assert behavior against the client
 * interface; HTTP-layer realism is covered by api/client.test.ts (MSW).
 */
export function fakeApi(overrides: Partial<ApiClient>): ApiClient {
  const base = new ApiClient({
    baseUrl: "http://test.local/api/v1",
    fetch: () => Promise.reject(new Error("network disabled in component test")),
  });
  return Object.assign(base, overrides);
}

export function bootstrapFixture(partial: Partial<BootstrapResponse> = {}): BootstrapResponse {
  const base: BootstrapResponse = {
    organization: { id: "org_default", name: "Org" },
    user: { id: "user_1", email: "j@x.com", display_name: "J", role: "owner" },
    projects: [{ id: "proj_artoo", name: "artoo", default_workspace: "C:/workspace/artoo" }],
    computers: [
      {
        id: "computer_local_mock",
        organization_id: "org_default",
        display_name: "Local Mock",
        hostname: "localhost",
        os: "windows",
        arch: "x64",
        status: "online",
        last_heartbeat_at: "2026-06-13T00:00:00Z",
        resources: {},
        capabilities: ["code.modify", "test.run"],
        created_at: "2026-06-13T00:00:00Z",
      },
    ],
    agents: [
      {
        id: "agent_mock_coder",
        organization_id: "org_default",
        display_name: "Mock Coder",
        kind: "mock",
        status: "idle",
        capabilities: ["code.modify", "test.run"],
        created_at: "2026-06-13T00:00:00Z",
      },
    ],
    agent_instances: [
      {
        id: "instance_mock_coder",
        organization_id: "org_default",
        computer_id: "computer_local_mock",
        agent_id: "agent_mock_coder",
        runtime: "mock",
        model_profile_id: "model_standard_coding",
        effort_profile_id: "effort_standard_coding",
        status: "idle",
        workspace_root: "C:/workspace/artoo",
        config: {},
        created_at: "2026-06-13T00:00:00Z",
      },
    ],
    model_profiles: [
      {
        id: "model_standard_coding",
        organization_id: "org_default",
        name: "standard_coding",
        provider: "mock",
        model: "mock-standard_coding",
        context_window: null,
        cost_tier: "medium",
        latency_tier: "normal",
        capability_tags: ["code.modify", "test.run"],
        config: {},
        enabled: true,
        created_at: "2026-06-13T00:00:00Z",
      },
    ],
    effort_profiles: [
      {
        id: "effort_standard_coding",
        organization_id: "org_default",
        name: "standard_coding",
        effort: "medium",
        max_runtime_minutes: 60,
        max_cost_usd: null,
        max_tool_calls: null,
        retry_budget: 1,
        description: "standard coding effort profile",
        config: {},
        enabled: true,
        created_at: "2026-06-13T00:00:00Z",
      },
    ],
    actor: { type: "user", id: "user_1" },
  };
  return { ...base, ...partial };
}

/** Build a complete Task snapshot row for fixtures. */
export function taskFixture(
  partial: Partial<Task> & Pick<Task, "id" | "title" | "status">,
): Task {
  return {
    organization_id: "org_default",
    project_id: "proj_artoo",
    description: "",
    priority: "p2",
    required_capabilities: [],
    acceptance_criteria: [],
    created_by_type: "user",
    created_by_id: "user_1",
    created_at: "2026-06-13T00:00:00Z",
    updated_at: "2026-06-13T00:00:00Z",
    ...partial,
  };
}

export function roomFixture(partial: Partial<Room> & Pick<Room, "id">): Room {
  return {
    organization_id: "org_default",
    type: "task",
    name: "task room",
    created_at: "2026-06-13T00:00:00Z",
    ...partial,
  };
}

export function runFixture(partial: Partial<Run> & Pick<Run, "id" | "status">): Run {
  return {
    organization_id: "org_default",
    task_id: "task_1",
    computer_id: "computer_1",
    agent_instance_id: "ai_1",
    runtime_id: "mock",
    sequence: 0,
    created_at: "2026-06-13T00:00:00Z",
    ...partial,
  };
}

export function messageFixture(partial: Partial<Message> & Pick<Message, "id" | "kind">): Message {
  return {
    organization_id: "org_default",
    room_id: "room_1",
    actor_type: "user",
    actor_id: "user_1",
    body: "",
    payload: {},
    created_at: "2026-06-13T00:00:00Z",
    ...partial,
  };
}

export function approvalFixture(
  partial: Partial<Approval> & Pick<Approval, "id" | "status">,
): Approval {
  return {
    organization_id: "org_default",
    task_id: "task_1",
    requested_by_type: "agent",
    requested_by_id: "agent_1",
    action: "git.push",
    risk: "high",
    summary: "Push branch",
    created_at: "2026-06-13T00:00:00Z",
    ...partial,
  };
}

export function artifactFixture(
  partial: Partial<Artifact> & Pick<Artifact, "id" | "type" | "uri">,
): Artifact {
  return {
    organization_id: "org_default",
    task_id: "task_1",
    metadata: {},
    created_at: "2026-06-13T00:00:00Z",
    ...partial,
  };
}

export function memoryFixture(
  partial: Partial<Memory> & Pick<Memory, "id" | "status" | "scope">,
): Memory {
  return {
    organization_id: "org_default",
    project_id: "proj_artoo",
    author_type: "agent",
    author_id: "agent_claude",
    confidence: 1,
    tags: [],
    text: "a memory",
    created_at: "2026-06-13T00:00:00Z",
    ...partial,
  };
}

export function auditEventFixture(
  partial: Partial<AuditEvent> & Pick<AuditEvent, "id" | "type" | "position">,
): AuditEvent {
  return {
    schema_version: "2026-06-11",
    organization_id: "org_default",
    actor: { type: "system", id: "control_plane" },
    occurred_at: "2026-06-13T00:00:00Z",
    correlation_id: "task_1",
    payload: {},
    ...partial,
  };
}

export function schedulerDecisionFixture(
  partial: Partial<SchedulerDecision> & Pick<SchedulerDecision, "id">,
): SchedulerDecision {
  return {
    organization_id: "org_default",
    task_id: "task_1",
    selected_computer_id: "computer_1",
    selected_agent_instance_id: "ai_1",
    mode: "auto",
    score: 100,
    reason: "capability_match_and_idle",
    candidates: [],
    created_at: "2026-06-13T00:00:00Z",
    ...partial,
  };
}

export function auditBundleFixture(partial: Partial<TaskAuditBundle> = {}): TaskAuditBundle {
  return {
    task: taskFixture({ id: "task_1", title: "Audited task", status: "review" }),
    room: null,
    messages: [],
    runs: [],
    artifacts: [],
    approvals: [],
    scheduler_decisions: [],
    events: [],
    ...partial,
  };
}

export function renderWithProviders(
  ui: ReactElement,
  options: { client: ApiClient; queryClient?: QueryClient; route?: string },
): RenderResult {
  const queryClient = options.queryClient ?? createTestQueryClient();
  return render(
    <MemoryRouter initialEntries={[options.route ?? "/"]}>
      <QueryClientProvider client={queryClient}>
        <ApiProvider client={options.client}>
          <SelectionProvider>{ui}</SelectionProvider>
        </ApiProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}
