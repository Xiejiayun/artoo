// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useQuery } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WebSocketLike } from "../ws/realtimeClient.js";
import { queryKeys } from "./queryKeys.js";
import { RealtimeProvider, useSubscription } from "./RealtimeContext.js";
import type { RunOutputChunk } from "./runOutputs.js";

afterEach(() => {
  cleanup();
});

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string): void {
    if (this.readyState === 0) throw new DOMException("WebSocket is still CONNECTING", "InvalidStateError");
    if (this.readyState !== 1) return;
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 2;
  }
  closeWith(code: number, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(data: string): void {
    this.onmessage?.({ data });
  }
}

function Subscriber({ topics }: { topics: string[] }): null {
  useSubscription(topics);
  return null;
}

describe("RealtimeProvider", () => {
  it("renders streamed run output once without refetching chat or task snapshots", async () => {
    const socket = new FakeSocket();
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);
    function OutputProbe() {
      const output = useQuery<RunOutputChunk[]>({ queryKey: queryKeys.runOutputs("task_1"), queryFn: async () => [], enabled: false });
      return <pre>{output.data?.map((chunk) => chunk.text).join("\n")}</pre>;
    }
    render(<QueryClientProvider client={queryClient}><RealtimeProvider socketFactory={() => socket} reconnectDelayMs={0}><OutputProbe /></RealtimeProvider></QueryClientProvider>);
    act(() => socket.open()); invalidate.mockClear();
    const event = { id: "output_1", type: "run.output", schema_version: "2026-06-11", organization_id: "org_default", actor: { type: "agent", id: "agent_1" }, occurred_at: "2026-06-13T00:00:00Z", correlation_id: "corr_1", task_id: "task_1", room_id: "room_1", run_id: "run_1", payload: { stream: "stdout", text: "streamed output" } };
    act(() => { socket.emit(JSON.stringify({ type: "event", topic: "task:task_1", event })); socket.emit(JSON.stringify({ type: "event", topic: "room:room_1", event })); });
    expect(await screen.findByText("streamed output")).toBeInTheDocument();
    expect(queryClient.getQueryData<RunOutputChunk[]>(queryKeys.runOutputs("task_1"))).toHaveLength(1);
    expect(invalidate).not.toHaveBeenCalled();
  });
  it("subscribes mounted topics and invalidates queries on a matching push", async () => {
    let socket: FakeSocket | undefined;
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);

    render(
      <QueryClientProvider client={queryClient}>
        <RealtimeProvider
          socketFactory={() => {
            socket = new FakeSocket();
            return socket;
          }}
          reconnectDelayMs={0}
        >
          <Subscriber topics={["task:task_1"]} />
        </RealtimeProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(socket).toBeDefined());
    socket?.open();
    expect(socket?.sent.some((frame) => frame.includes('"subscribe"'))).toBe(true);

    socket?.emit(
      JSON.stringify({
        type: "event",
        topic: "task:task_1",
        event: {
          id: "evt_1",
          type: "run.completed",
          schema_version: "2026-06-11",
          organization_id: "org_default",
          actor: { type: "agent", id: "agent_1" },
          occurred_at: "2026-06-13T00:00:00Z",
          correlation_id: "corr_1",
          task_id: "task_1",
          payload: {},
        },
      }),
    );

    expect(spy).toHaveBeenCalledWith({ queryKey: ["task", "task_1"] });
  });

  it("re-probes the session when the control WS closes 1008 (routes to #34 gate)", async () => {
    let socket: FakeSocket | undefined;
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);

    render(
      <QueryClientProvider client={queryClient}>
        <RealtimeProvider
          socketFactory={() => {
            socket = new FakeSocket();
            return socket;
          }}
          reconnectDelayMs={0}
        >
          <Subscriber topics={["task:task_1"]} />
        </RealtimeProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(socket).toBeDefined());
    socket?.open();
    spy.mockClear();

    socket?.closeWith(1008, "unauthenticated");
    expect(spy).toHaveBeenCalledWith({ queryKey: queryKeys.session });
  });
});
