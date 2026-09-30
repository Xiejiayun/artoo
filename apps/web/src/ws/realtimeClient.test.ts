import { describe, expect, it, vi } from "vitest";

import { RealtimeClient, type WebSocketLike } from "./realtimeClient.js";

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
  /** Simulate a server/transport close with a specific code. */
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
  lastFrame(): unknown {
    const raw = this.sent.at(-1);
    return raw === undefined ? undefined : JSON.parse(raw);
  }
}

describe("RealtimeClient", () => {
  it("loads native credentials asynchronously and sends them only as an auth subprotocol", async () => {
    const socketFactory = vi.fn(() => new FakeSocket());
    const client = new RealtimeClient({ url: "wss://example.test/api/v1/ws", onEvent: () => undefined, socketFactory, tokenProvider: async () => "sk_device_test_secret" });
    client.connect();
    await vi.waitFor(() => expect(socketFactory).toHaveBeenCalled());
    expect(socketFactory).toHaveBeenCalledWith("wss://example.test/api/v1/ws", ["artoo", "artoo-auth.sk_device_test_secret"]);
    client.close();
  });

  it("does not open a socket after unmount while the secure token is still loading", async () => {
    let resolve!: (token: string) => void;
    const token = new Promise<string>((done) => { resolve = done; });
    const socketFactory = vi.fn(() => new FakeSocket());
    const client = new RealtimeClient({ url: "wss://example.test/api/v1/ws", onEvent: () => undefined, socketFactory, tokenProvider: () => token });
    client.connect(); client.close(); resolve("sk_device_test_secret");
    await Promise.resolve();
    expect(socketFactory).not.toHaveBeenCalled();
  });
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

  it("keeps shared room subscriptions alive when the thread panel closes", () => {
    const fake = new FakeSocket();
    const client = new RealtimeClient({ url: "ws://x", onEvent: () => undefined, socketFactory: () => fake });
    client.connect(); fake.open();
    client.subscribe(["room:1"]); client.subscribe(["room:1"]);
    client.unsubscribe(["room:1"]);
    expect(fake.sent).toHaveLength(1);
    client.unsubscribe(["room:1"]);
    expect(fake.lastFrame()).toEqual({ type: "unsubscribe", topics: ["room:1"] });
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

  it("does not send to a connecting replacement when connected-status listeners remount subscriptions", () => {
    const first = new FakeSocket(), replacement = new FakeSocket();
    const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(replacement);
    const client = new RealtimeClient({ url: "ws://x", onEvent: () => undefined, socketFactory: factory });
    client.subscribe(["room:old"]);
    const stopListening = client.subscribeStatus(() => {
      if (client.getStatus() !== "connected") return;
      stopListening();
      client.close();
      client.connect();
      client.unsubscribe(["room:old"]);
      client.subscribe(["room:current"]);
    });
    client.connect();
    expect(() => first.open()).not.toThrow();
    expect(client.getStatus()).toBe("connecting");
    expect(replacement.sent).toHaveLength(0);
    replacement.open();
    expect(replacement.lastFrame()).toEqual({ type: "subscribe", topics: ["room:current"] });
  });

  it("ignores queued open callbacks from a closed generation during subscription cleanup", () => {
    const first = new FakeSocket(), replacement = new FakeSocket();
    const client = new RealtimeClient({ url: "ws://x", onEvent: () => undefined,
      socketFactory: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(replacement) });
    client.subscribe(["room:old", "inbox:user"]);
    client.connect();
    const queuedOpen = first.onopen!;
    client.close(); client.connect();
    expect(() => queuedOpen()).not.toThrow();
    expect(() => { client.unsubscribe(["room:old"]); client.subscribe(["room:new"]); }).not.toThrow();
    expect(client.getStatus()).toBe("connecting");
    expect(replacement.sent).toHaveLength(0);
    replacement.open();
    expect(replacement.sent.map((frame) => JSON.parse(frame))).toEqual([{ type: "subscribe", topics: ["inbox:user", "room:new"] }]);
  });

  it("ignores retired socket events without clearing a replacement or its subscriptions", () => {
    const first = new FakeSocket(), replacement = new FakeSocket();
    const onEvent = vi.fn(), onUnauthenticated = vi.fn(), schedule = vi.fn();
    const client = new RealtimeClient({ url: "ws://x", onEvent, onUnauthenticated, setTimeoutFn: schedule,
      socketFactory: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(replacement) });
    client.subscribe(["room:current"]);
    client.connect(); first.open();
    client.close(); client.connect(); replacement.open();
    first.emit(JSON.stringify({ type: "event", topic: "room:current", event: {
      id: "stale", type: "run.completed", schema_version: "2026-06-11", organization_id: "org_default",
      actor: { type: "agent", id: "agent_1" }, occurred_at: "2026-06-13T00:00:00Z", correlation_id: "corr_1", payload: {},
    } }));
    first.closeWith(1008, "retired connection");
    first.closeWith(1006);
    expect(onEvent).not.toHaveBeenCalled();
    expect(onUnauthenticated).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
    expect(client.getStatus()).toBe("connected");
    client.unsubscribe(["room:current"]);
    expect(replacement.lastFrame()).toEqual({ type: "unsubscribe", topics: ["room:current"] });
  });

  it("uses transport readyState before close notification and replays only current reference-counted topics", () => {
    const first = new FakeSocket(), replacement = new FakeSocket();
    let reconnect!: () => void;
    const client = new RealtimeClient({ url: "ws://x", onEvent: () => undefined,
      socketFactory: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(replacement),
      setTimeoutFn: (handler) => { reconnect = handler; } });
    client.subscribe(["room:old", "room:shared"]); client.subscribe(["room:shared"]);
    client.connect(); first.open();
    const send = vi.spyOn(first, "send");
    first.close(); // CLOSING is visible before the browser delivers its close event.
    client.unsubscribe(["room:old", "room:shared"]); client.subscribe(["room:next"]);
    expect(send).not.toHaveBeenCalled();
    first.closeWith(1006); reconnect();
    client.unsubscribe(["room:next"]); client.subscribe(["room:latest"]);
    expect(replacement.sent).toHaveLength(0);
    replacement.open();
    expect(replacement.lastFrame()).toEqual({ type: "subscribe", topics: ["room:shared", "room:latest"] });
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
