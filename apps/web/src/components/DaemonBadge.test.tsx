// @vitest-environment jsdom
import { onlineManager, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client.js";
import type { DaemonPresence } from "../api/types.js";
import { queryKeys } from "../app/queryKeys.js";
import { bootstrapFixture, createTestQueryClient, fakeApi, renderWithProviders } from "../test/utils.js";
import { DaemonBadge } from "./DaemonBadge.js";

const snapshot = (status: DaemonPresence["status"] = "online") => ({ daemons: [{
  computer_id: "computer_1", display_name: "Worker", status, connected: status === "online",
  last_heartbeat_at: "2026-09-29T00:00:00Z", heartbeat_age_ms: 2000, active_runs: 2, runtimes: [],
}] });
const clients: QueryClient[] = [];

function renderBadge(listDaemons: ApiClient["listDaemons"], cached = true) {
  const query = createTestQueryClient();
  query.setDefaultOptions({ queries: { retry: false, staleTime: 5000 } });
  query.setQueryData(queryKeys.bootstrap, bootstrapFixture());
  if (cached) query.setQueryData(queryKeys.daemons, snapshot());
  clients.push(query);
  renderWithProviders(<DaemonBadge computerId="computer_1" />, {
    queryClient: query, client: fakeApi({ bootstrap: async () => bootstrapFixture(), listDaemons }),
  });
  return query;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-29T00:00:02Z"));
  onlineManager.setOnline(true);
});
afterEach(async () => {
  cleanup();
  for (const query of clients.splice(0)) { await query.cancelQueries(); query.clear(); }
  onlineManager.setOnline(true);
  vi.useRealTimers();
});

describe("execution daemon freshness", () => {
  it("does not keep cached online presence when offline requests are paused without an error", async () => {
    const listDaemons = vi.fn<ApiClient["listDaemons"]>().mockResolvedValue(snapshot());
    const query = renderBadge(listDaemons);
    expect(screen.getByText("Daemon: unknown")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByText("Daemon: online")).toBeInTheDocument();
    act(() => { onlineManager.setOnline(false); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5001); });
    expect(query.getQueryState(queryKeys.daemons)).toMatchObject({ fetchStatus: "paused", error: null });
    expect(listDaemons).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Daemon: unknown")).toBeInTheDocument();
    expect(screen.queryByText("Daemon: offline")).not.toBeInTheDocument();
    expect(screen.getByText(/Last known: 2 active runs/)).toBeInTheDocument();
    expect(screen.queryByText(/Connected ·/)).not.toBeInTheDocument();
  });

  it("expires an old snapshot while a request hangs and recovers only after a successful response", async () => {
    let respond!: (value: ReturnType<typeof snapshot>) => void;
    const listDaemons = vi.fn<ApiClient["listDaemons"]>().mockResolvedValueOnce(snapshot()).mockImplementation(() => new Promise((resolve) => { respond = resolve; }));
    const query = renderBadge(listDaemons);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByText("Daemon: online")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(12001); });
    expect(query.getQueryState(queryKeys.daemons)).toMatchObject({ fetchStatus: "fetching", error: null });
    expect(listDaemons).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Daemon: unknown")).toBeInTheDocument();
    expect(screen.queryByText(/s ago/)).not.toBeInTheDocument();
    await act(async () => { respond(snapshot("reconnecting")); await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByText("Daemon: reconnecting")).toBeInTheDocument();
    expect(screen.queryByText(/Last known:/)).not.toBeInTheDocument();
  });

  it("does not treat restored browser connectivity as a new daemon confirmation", async () => {
    let respond!: (value: ReturnType<typeof snapshot>) => void;
    renderBadge(vi.fn<ApiClient["listDaemons"]>().mockResolvedValueOnce(snapshot()).mockImplementation(() => new Promise((resolve) => { respond = resolve; })));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByText("Daemon: online")).toBeInTheDocument();
    act(() => { onlineManager.setOnline(false); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5001); });
    expect(screen.getByText("Daemon: unknown")).toBeInTheDocument();
    await act(async () => { onlineManager.setOnline(true); await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByText("Daemon: unknown")).toBeInTheDocument();
    await act(async () => { respond(snapshot()); await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByText("Daemon: online")).toBeInTheDocument();
  });

  it("stops showing checking indefinitely when the first request never returns", async () => {
    renderBadge(() => new Promise(() => {}), false);
    expect(screen.getByText("Daemon: checking")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(12001); });
    expect(screen.getByText("Daemon: unknown")).toBeInTheDocument();
    expect(screen.getByText(/cannot be verified/)).toBeInTheDocument();
    expect(screen.queryByText("Daemon: offline")).not.toBeInTheDocument();
  });

  it("rechecks snapshot age on foreground even when background timers were suspended", async () => {
    renderBadge(vi.fn<ApiClient["listDaemons"]>().mockResolvedValueOnce(snapshot()).mockImplementation(() => new Promise(() => {})));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByText("Daemon: online")).toBeInTheDocument();
    vi.setSystemTime(new Date("2026-09-29T00:01:02Z"));
    fireEvent.focus(window);
    expect(screen.getByText("Daemon: unknown")).toBeInTheDocument();
  });

  it("keeps a remounted cached badge unknown until a new server response confirms presence", async () => {
    let respond!: (value: ReturnType<typeof snapshot>) => void;
    const listDaemons = vi.fn<ApiClient["listDaemons"]>().mockResolvedValueOnce(snapshot()).mockImplementation(() => new Promise((resolve) => { respond = resolve; }));
    const query = renderBadge(listDaemons);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByText("Daemon: online")).toBeInTheDocument();
    act(() => { onlineManager.setOnline(false); });
    expect(screen.getByText("Daemon: unknown")).toBeInTheDocument();
    cleanup();
    act(() => { onlineManager.setOnline(true); });
    renderWithProviders(<DaemonBadge computerId="computer_1" />, {
      queryClient: query, client: fakeApi({ bootstrap: async () => bootstrapFixture(), listDaemons }),
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(listDaemons).toHaveBeenCalledTimes(2);
    expect(query.getQueryState(queryKeys.daemons)).toMatchObject({ fetchStatus: "fetching", error: null });
    expect(screen.getByText("Daemon: unknown")).toBeInTheDocument();
    expect(screen.queryByText(/Connected ·/)).not.toBeInTheDocument();
    await act(async () => { respond(snapshot("reconnecting")); await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByText("Daemon: reconnecting")).toBeInTheDocument();
  });

  it("retains an actual server-confirmed offline state while fresh polling succeeds", async () => {
    const listDaemons = vi.fn<ApiClient["listDaemons"]>().mockResolvedValue(snapshot("offline"));
    renderBadge(listDaemons, false);
    await act(async () => { await vi.advanceTimersByTimeAsync(15001); });
    expect(listDaemons.mock.calls.length).toBeGreaterThan(1);
    expect(screen.getByText("Daemon: offline")).toBeInTheDocument();
    expect(screen.queryByText("Daemon: unknown")).not.toBeInTheDocument();
  });
});
