// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WebSocketLike } from "../ws/realtimeClient.js";
import { RealtimeProvider, useSubscription } from "./RealtimeContext.js";

afterEach(() => {
  cleanup();
});

class FakeSocket implements WebSocketLike {
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.onclose?.();
  }
  open(): void {
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
});
