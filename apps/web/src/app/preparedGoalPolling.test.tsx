// @vitest-environment jsdom
import { useQuery } from "@tanstack/react-query";
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapFixture, createTestQueryClient, fakeApi, renderWithProviders } from "../test/utils.js";
import { ConnectionStatus } from "../components/ConnectionStatus.js";
import { ApiClientError } from "../api/client.js";
import { useCommands } from "./ApiContext.js";
import { RealtimeProvider } from "./RealtimeContext.js";
import { queryKeys } from "./queryKeys.js";
import type { WebSocketLike } from "../ws/realtimeClient.js";
import type { PreparedGoalEntryV1 } from "@artoo/domain";

const entry: PreparedGoalEntryV1 = { version: 1, session_id: "prepared-poll", project_id: "proj_artoo", goal_id: "goal_one",
  submission_owner: "console", progress_updates: "polling" };
class Socket implements WebSocketLike {
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  send(): void {}
  close = vi.fn(() => { this.readyState = 3; });
}
function Resource({ name, read }: { name: string; read(): Promise<string> }) {
  const query = useQuery({ queryKey: [name, "one"], queryFn: read });
  return <p>{name}: {query.data ?? "loading"}</p>;
}
function QueuedAction({ send, settled }: { send(): Promise<string>; settled(value: unknown): void }) {
  const commands = useCommands();
  return <button onClick={() => { void commands.submit(send, { key: "stable-task-action" }).then(settled, settled); }}>Task action</button>;
}
afterEach(() => { vi.useRealTimers(); });

describe("explicit prepared-session progress polling", () => {
  it("uses HTTP refresh for task, review and audit views without opening an unauthenticated control socket", async () => {
    vi.useFakeTimers();
    const query = createTestQueryClient(); query.setQueryData(queryKeys.bootstrap, bootstrapFixture({ goal_entry: entry }));
    let state = "waiting";
    const read = vi.fn(async () => state), socketFactory = vi.fn(() => new Socket());
    renderWithProviders(<RealtimeProvider socketFactory={socketFactory}>
      <ConnectionStatus />
      {["tasks", "task", "auditBundle", "approvals", "runUsage", "dependencies", "leases"].map(name => <Resource key={name} name={name} read={read} />)}
    </RealtimeProvider>, { client: fakeApi({}), queryClient: query });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(socketFactory).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Connection status")).toHaveTextContent("Automatic progress refresh");
    expect(screen.getByLabelText("Connection status")).not.toHaveTextContent("Sign in");
    state = "review accepted";
    await act(async () => { await vi.advanceTimersByTimeAsync(5001); });
    for (const name of ["tasks", "task", "auditBundle", "approvals", "runUsage", "dependencies", "leases"]) {
      expect(screen.getByText(`${name}: review accepted`)).toBeInTheDocument();
    }
    expect(socketFactory).not.toHaveBeenCalled();
  });

  it("closes an initial connection when trusted bootstrap selects polling, and cancels its reconnect path", async () => {
    vi.useFakeTimers();
    const query = createTestQueryClient(), socket = new Socket(), factory = vi.fn(() => socket);
    renderWithProviders(<RealtimeProvider socketFactory={factory}><ConnectionStatus /></RealtimeProvider>, { client: fakeApi({}), queryClient: query });
    expect(factory).toHaveBeenCalledTimes(1);
    await act(async () => { query.setQueryData(queryKeys.bootstrap, bootstrapFixture({ goal_entry: entry })); await vi.advanceTimersByTimeAsync(1); });
    expect(socket.close).toHaveBeenCalled();
    socket.onclose?.({ code: 1006, reason: "late close" });
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("retains ordinary realtime authentication behavior without the explicit prepared flag", async () => {
    const query = createTestQueryClient(); query.setQueryData(queryKeys.bootstrap, bootstrapFixture());
    const socket = new Socket(), factory = vi.fn(() => socket);
    renderWithProviders(<RealtimeProvider socketFactory={factory}><ConnectionStatus /></RealtimeProvider>, { client: fakeApi({}), queryClient: query });
    expect(factory).toHaveBeenCalledTimes(1);
    await act(async () => { socket.onclose?.({ code: 1008, reason: "unauthenticated" }); });
    expect(screen.getByLabelText("Connection status")).toHaveTextContent("Sign in to reconnect");
  });

  it("replays a pending action when HTTP recovers without an online or WebSocket event", async () => {
    vi.useFakeTimers();
    const query = createTestQueryClient(); query.setQueryData(queryKeys.bootstrap, bootstrapFixture({ goal_entry: entry }));
    let available = false;
    const send = vi.fn(async () => {
      if (!available) throw new ApiClientError("network_error", "temporary connection failure", 0);
      return "applied";
    }), settled = vi.fn(), socketFactory = vi.fn(() => new Socket());
    renderWithProviders(<RealtimeProvider socketFactory={socketFactory}>
      <ConnectionStatus /><QueuedAction send={send} settled={settled} />
    </RealtimeProvider>, { client: fakeApi({}), queryClient: query });
    await act(async () => { fireEvent.click(screen.getByText("Task action")); await vi.advanceTimersByTimeAsync(1); });
    expect(send).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Connection status")).toHaveTextContent("1 pending command");
    available = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(5001); });
    expect(send).toHaveBeenCalledTimes(2);
    expect(settled).toHaveBeenCalledExactlyOnceWith("applied");
    expect(screen.getByLabelText("Connection status")).not.toHaveTextContent("pending command");
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(send).toHaveBeenCalledTimes(2);
    expect(socketFactory).not.toHaveBeenCalled();
  });

  it("does not add timed command replay to ordinary realtime sessions", async () => {
    vi.useFakeTimers();
    const query = createTestQueryClient(); query.setQueryData(queryKeys.bootstrap, bootstrapFixture());
    const send = vi.fn(async (): Promise<string> => { throw new ApiClientError("network_error", "offline", 0); });
    renderWithProviders(<RealtimeProvider socketFactory={() => new Socket()}>
      <ConnectionStatus /><QueuedAction send={send} settled={vi.fn()} />
    </RealtimeProvider>, { client: fakeApi({}), queryClient: query });
    await act(async () => { fireEvent.click(screen.getByText("Task action")); await vi.advanceTimersByTimeAsync(12000); });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
