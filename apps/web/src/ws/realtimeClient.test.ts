import { describe, expect, it, vi } from "vitest";

import { RealtimeClient, type WebSocketLike } from "./realtimeClient.js";

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
    fake.emit(JSON.stringify({ type: "event", topic: "task:1", event: { id: "e", type: "run.completed", task_id: "1" } }));
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
    sockets[0]?.onclose?.();
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
});
