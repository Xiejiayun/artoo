import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach } from "vitest";

import type { Message, Room, Run, Task } from "@artoo/domain";

import { ApiClient } from "../api/client.js";
import { ApiProvider } from "../app/ApiContext.js";

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

export function renderWithProviders(
  ui: ReactElement,
  options: { client: ApiClient; queryClient?: QueryClient },
): RenderResult {
  const queryClient = options.queryClient ?? createTestQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <ApiProvider client={options.client}>{ui}</ApiProvider>
    </QueryClientProvider>,
  );
}
