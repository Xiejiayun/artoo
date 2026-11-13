// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { expect, it, vi } from "vitest";
import type { AgentHistoryDetail, AgentHistoryPage } from "@artoo/domain";
import { ApiClient } from "../api/client.js";
import { bootstrapFixture, fakeApi, renderWithProviders, runFixture } from "../test/utils.js";
import { AgentHistoryPage as HistoryPage } from "./AgentHistoryPage.js";

const run = runFixture({ id: "run_1", status: "failed", failure_reason: "Process exited 1", agent_instance_id: "instance_mock_coder" });
const execution = { run, task_title: "Current title", project_id: "proj_artoo" };
const page: AgentHistoryPage = { version: 1, agent_id: "agent_mock_coder", agent_name: "Mock Coder", runs: [execution], next_before_run_id: null };
const detail: AgentHistoryDetail = { version: 1, agent_id: "agent_mock_coder", execution,
  request: { id: run.task_id, title: "Original title", description: "Original request 原文 <script>text only</script>", acceptance_criteria: ["Preserve evidence"] },
  events: [{ id: "evt_1", position: 2, type: "run.output", actor: { type: "agent", id: "instance_mock_coder" }, sequence: 2, occurred_at: "2026-11-13T00:00:00Z", response_text: null,
    payload: { text: "raw provider output", activity: { version: 1, operations: [{ call_id: "call_1", name: "Bash", phase: "failed", request: "npm test", response: "Assertion failed", exit_code: 1, response_truncated: true }] } } },
    { id: "evt_2", position: 1, type: "message.created", actor: { type: "agent", id: "instance_mock_coder" }, sequence: 1, occurred_at: "2026-11-13T00:00:00Z", response_text: "Final response 中文", payload: {} }], next_before: null };
function render(client: ApiClient, search = "") {
  return renderWithProviders(<Routes><Route path="/agents/:agentId/history" element={<HistoryPage />} /></Routes>, {
    client, route: `/agents/agent_mock_coder/history${search}`,
  });
}
const api = (overrides: Partial<ApiClient> = {}) => fakeApi({ bootstrap: async () => bootstrapFixture(), agentHistory: async () => page, agentHistoryRun: async () => detail, ...overrides });

it("shows immutable request, tool request/response, failures and final answers as safe text", async () => {
  render(api(), "?run_id=run_1");
  expect(await screen.findByText("Original title")).toBeInTheDocument();
  expect(screen.getByText(detail.request!.description)).toBeInTheDocument();
  expect(document.querySelector("script")).toBeNull();
  expect(screen.getByText("Process exited 1")).toBeInTheDocument();
  await userEvent.click(screen.getByText("Tool activity", { exact: true }));
  expect(screen.getByText("npm test")).toBeVisible();
  expect(screen.getByText("Assertion failed")).toBeVisible();
  expect(screen.getByText("Response (truncated)")).toBeVisible();
  await userEvent.click(screen.getByText("Recorded output"));
  expect(screen.getByText("raw provider output")).toBeVisible();
  await userEvent.click(screen.getByText("Final answer", { exact: true }));
  expect(screen.getByText("Final response 中文")).toBeVisible();
});

it("loads older execution and event pages without discarding the selected run", async () => {
  const history = vi.fn<ApiClient["agentHistory"]>(async (_id, query) => query?.before_run_id ? { ...page, runs: [{ ...execution, run: { ...run, id: "run_old" }, task_title: "Older execution" }] } : { ...page, next_before_run_id: "run_1" });
  const events = vi.fn<ApiClient["agentHistoryRun"]>(async (_id, _runId, query) => query?.before ? { ...detail, events: [{ ...detail.events[0]!, id: "evt_old", position: 1, type: "run.started", payload: {} }] } : { ...detail, events: [detail.events[0]!], next_before: 2 });
  render(api({ agentHistory: history, agentHistoryRun: events }), "?run_id=run_1");
  await userEvent.click(await screen.findByRole("button", { name: "Load older executions" }));
  expect(await screen.findByRole("button", { name: /Older execution/ })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Load older events" }));
  expect(await screen.findByText("run.started", { exact: true })).toBeInTheDocument();
  expect(screen.getByText("Original title")).toBeInTheDocument();
  expect(history.mock.calls.at(-1)?.[1]?.before_run_id).toBe("run_1");
  expect(events.mock.calls.at(-1)?.[2]?.before).toBe(2);
});

it("preserves deep-linked historical instances and resets selection when filters change", async () => {
  const history = vi.fn<ApiClient["agentHistory"]>(async () => page);
  render(api({ agentHistory: history }), "?instance_id=removed_instance&run_id=run_1");
  await screen.findByText("Original title");
  expect(screen.getByLabelText("History instance")).toHaveValue("removed_instance");
  await userEvent.selectOptions(screen.getByLabelText("History status"), "failed");
  expect(await screen.findByText("Select an execution")).toBeInTheDocument();
  expect(history.mock.calls.at(-1)?.[1]).toMatchObject({ instance_id: "removed_instance", status: "failed" });
});

it("explains missing legacy requests and allows refreshing persisted history", async () => {
  const events = vi.fn<ApiClient["agentHistoryRun"]>(async () => ({ ...detail, request: null, events: [] }));
  render(api({ agentHistoryRun: events }), "?run_id=run_1");
  expect(await screen.findByText("The original request is unavailable for this execution.")).toBeInTheDocument();
  expect(screen.getByText("No events recorded yet.")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Refresh history" }));
  expect(events).toHaveBeenCalledTimes(2);
});

it("shows loading, failure/retry and empty results without inventing history", async () => {
  const history = vi.fn<ApiClient["agentHistory"]>().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue({ ...page, runs: [] });
  render(api({ agentHistory: history }));
  expect(within(screen.getByRole("region", { name: "Agent executions" })).getByRole("status")).toHaveTextContent("Loading history");
  await userEvent.click(await screen.findByRole("button", { name: "Retry history" }));
  expect(await screen.findByText("No executions found")).toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "Execution history" })).getByText("Select an execution")).toBeInTheDocument();
});

it("keeps execution fetch errors independent from the execution list and supports retry", async () => {
  const events = vi.fn<ApiClient["agentHistoryRun"]>().mockRejectedValueOnce(new Error("failed")).mockResolvedValue(detail);
  render(api({ agentHistoryRun: events }), "?run_id=run_1");
  expect(await screen.findByRole("button", { name: /Current title/ })).toBeInTheDocument();
  await userEvent.click(await screen.findByRole("button", { name: "Retry execution" }));
  expect(await screen.findByText("Original title")).toBeInTheDocument();
});
