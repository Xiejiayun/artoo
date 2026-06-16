import { describe, expect, it, vi } from "vitest";

import { RealtimeClient, type WebSocketLike } from "./realtimeClient.js";

class FakeSocket implements WebSocketLike {
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.onclose?.({ code: 1000, reason: "" });
  }
  /** Simulate a server/transport close with a specific code. */
  closeWith(code: number, reason = ""): void {
    this.onclose?.({ code, reason });
  }
  open(): void {
    this.onopen?.();
  }
  emit(data: string): void {
    this.onmessage?.({ data });
  }
  lastFrame(): unknown {
    const raw = this.sent.at(-1);
    return raw === undefined ? undefined : JSON.parse(raw);
  }
}

describe("RealtimeClient", () => {
  it("sends a subscribe frame for the current topics on open", () => {
    const fake = new FakeSocket();
    const client = new RealtimeClient({ url: "ws://x", onEvent: () => undefined, socketFactory: () => fake });
    client.subscribe(["task:1", "inbox:u"]);
    client.connect();
    fake.open();
    expect(fake.sent).toHaveLength(1);
    expect(fake.lastFrame()).toEqual({ type: "subscribe", topics: ["task:1", "inbox:u"] });
  });

  it("dispatches event frames to onEvent", () => {
    const fake = new FakeSocket();
    const onEvent = vi.fn();
    const client = new RealtimeClient({ url: "ws://x", onEvent, socketFactory: () => fake });
    client.connect();
    fake.open();
    fake.emit(
      JSON.stringify({
        type: "event",
        topic: "task:1",
        event: {
          id: "e",
          type: "run.completed",
          schema_version: "2026-06-11",
          organization_id: "org_default",
          actor: { type: "agent", id: "agent_1" },
          occurred_at: "2026-06-13T00:00:00Z",
          correlation_id: "corr_1",
          task_id: "1",
          payload: {},
        },
      }),
    );
    expect(onEvent).toHaveBeenCalledWith("task:1", expect.objectContaining({ id: "e" }));
  });

  it("ignores malformed or non-event frames", () => {
    const fake = new FakeSocket();
    const onEvent = vi.fn();
    const client = new RealtimeClient({ url: "ws://x", onEvent, socketFactory: () => fake });
    client.connect();
    fake.open();
    fake.emit("not json");
    fake.emit(JSON.stringify({ type: "other" }));
    fake.emit(JSON.stringify({ type: "event", topic: "task:1", event: { id: "e", type: "run.completed" } }));
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("sends incremental subscribe/unsubscribe while open", () => {
    const fake = new FakeSocket();
    const client = new RealtimeClient({ url: "ws://x", onEvent: () => undefined, socketFactory: () => fake });
    client.connect();
    fake.open();
    client.subscribe(["task:1"]);
    expect(fake.lastFrame()).toEqual({ type: "subscribe", topics: ["task:1"] });
    client.unsubscribe(["task:1"]);
    expect(fake.lastFrame()).toEqual({ type: "unsubscribe", topics: ["task:1"] });
  });

  it("re-subscribes the current topic set after reconnect", () => {
    const sockets: FakeSocket[] = [];
    const factory = (): FakeSocket => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    };
    const timeouts: Array<() => void> = [];
    const client = new RealtimeClient({
      url: "ws://x",
      onEvent: () => undefined,
      socketFactory: factory,
      reconnectDelayMs: 5,
      setTimeoutFn: (handler) => {
        timeouts.push(handler);
        return 0;
      },
    });
    client.subscribe(["task:1"]);
    client.connect();
    sockets[0]?.open();
    expect(sockets[0]?.lastFrame()).toEqual({ type: "subscribe", topics: ["task:1"] });

    // server-side close triggers a scheduled reconnect.
    sockets[0]?.closeWith(1006);
    expect(timeouts).toHaveLength(1);
    timeouts[0]?.();
    sockets[1]?.open();
    expect(sockets[1]?.lastFrame()).toEqual({ type: "subscribe", topics: ["task:1"] });
  });

  it("does not reconnect after an explicit close", () => {
    const sockets: FakeSocket[] = [];
    const timeouts: Array<() => void> = [];
    const client = new RealtimeClient({
      url: "ws://x",
      onEvent: () => undefined,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      reconnectDelayMs: 5,
      setTimeoutFn: (handler) => {
        timeouts.push(handler);
        return 0;
      },
    });
    client.connect();
    sockets[0]?.open();
    client.close();
    expect(timeouts).toHaveLength(0);
  });

  it("does not run a scheduled reconnect after a later explicit close", () => {
    const sockets: FakeSocket[] = [];
    const timeouts: Array<() => void> = [];
    const client = new RealtimeClient({
      url: "ws://x",
      onEvent: () => undefined,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      reconnectDelayMs: 5,
      setTimeoutFn: (handler) => {
        timeouts.push(handler);
        return 0;
      },
    });
    client.connect();
    sockets[0]?.open();
    sockets[0]?.closeWith(1006);
    expect(timeouts).toHaveLength(1);
    client.close();
    timeouts[0]?.();
    expect(sockets).toHaveLength(1);
  });

  it("does not reconnect on a 1008 terminal auth failure and signals onUnauthenticated", () => {
    const sockets: FakeSocket[] = [];
    const timeouts: Array<() => void> = [];
    const onUnauthenticated = vi.fn();
    const client = new RealtimeClient({
      url: "ws://x",
      onEvent: () => undefined,
      onUnauthenticated,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      reconnectDelayMs: 5,
      setTimeoutFn: (handler) => {
        timeouts.push(handler);
        return 0;
      },
    });
    client.subscribe(["task:1"]);
    client.connect();
    sockets[0]?.open();

    sockets[0]?.closeWith(1008, "unauthenticated");
    // No reconnect scheduled; the app is told to route through the #34 gate.
    expect(timeouts).toHaveLength(0);
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
  });

  it("stays terminal after 1008: a subsequent transport close does not reconnect", () => {
    const sockets: FakeSocket[] = [];
    const timeouts: Array<() => void> = [];
    const client = new RealtimeClient({
      url: "ws://x",
      onEvent: () => undefined,
      onUnauthenticated: () => undefined,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      reconnectDelayMs: 5,
      setTimeoutFn: (handler) => {
        timeouts.push(handler);
        return 0;
      },
    });
    client.connect();
    sockets[0]?.open();
    sockets[0]?.closeWith(1008, "unauthenticated");
    // A stray later close (e.g. a duplicate event) must not resurrect reconnect.
    sockets[0]?.closeWith(1006);
    expect(timeouts).toHaveLength(0);
    expect(sockets).toHaveLength(1);
  });
});
