import type { EventEnvelope } from "@artoo/domain";
import { describe, expect, it } from "vitest";

import { buildSubscribeFrame, createSyncClient, SyncState, type SyncTransport } from "./sync-client.js";

function evt(id: string): EventEnvelope {
  return {
    id,
    type: "task.updated",
    schema_version: "2026-06-11",
    organization_id: "org_default",
    actor: { type: "system", id: "s" },
    occurred_at: "2026-06-13T00:00:00Z",
    correlation_id: "c",
    payload: {},
  };
}

function frame(id: string, cursor: number): string {
  return JSON.stringify({ type: "event", topic: "task:1", event: evt(id), cursor });
}

class MockTransport implements SyncTransport {
  sent: string[] = [];
  private msgCb?: (d: string) => void;
  private closeCb?: () => void;
  send(d: string): void {
    this.sent.push(d);
  }
  onMessage(cb: (d: string) => void): void {
    this.msgCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  close(): void {}
  deliver(d: string): void {
    this.msgCb?.(d);
  }
  drop(): void {
    this.closeCb?.();
  }
}

describe("SyncState", () => {
  it("dedupes by event id and tracks the max cursor (order-independent)", () => {
    const s = new SyncState();
    expect(s.accept(JSON.parse(frame("e1", 5)))).toMatchObject({ cursor: 5 });
    expect(s.cursor()).toBe(5);
    expect(s.accept(JSON.parse(frame("e1", 5)))).toBeNull(); // duplicate id
    // an out-of-order lower-cursor event still surfaces once; max stays 5
    expect(s.accept(JSON.parse(frame("e2", 3)))).toMatchObject({ cursor: 3 });
    expect(s.cursor()).toBe(5);
  });

  it("skips non-event and malformed frames", () => {
    const s = new SyncState();
    expect(s.accept(null)).toBeNull();
    expect(s.accept({ type: "other" })).toBeNull();
    expect(s.accept({ type: "event", event: evt("x") })).toBeNull(); // no cursor
    expect(s.accept({ type: "event", cursor: 1 })).toBeNull(); // no event
  });
});

describe("buildSubscribeFrame", () => {
  it("includes since_cursor only when > 0", () => {
    expect(buildSubscribeFrame(["t"], 0)).toEqual({ type: "subscribe", topics: ["t"] });
    expect(buildSubscribeFrame(["t"], 7)).toEqual({ type: "subscribe", topics: ["t"], since_cursor: 7 });
  });
});

describe("createSyncClient", () => {
  it("subscribes from 0, reconnects with the latest cursor, dedupes across the boundary", () => {
    const transports: MockTransport[] = [];
    const events: string[] = [];
    let scheduled: (() => void) | null = null;
    const client = createSyncClient({
      topics: ["task:1"],
      connect: () => {
        const t = new MockTransport();
        transports.push(t);
        return t;
      },
      onEvent: (e) => events.push(e.id),
      schedule: (reconnect) => {
        scheduled = reconnect; // manual reconnect for deterministic test
      },
    });
    client.start();

    // First subscribe: live-only (no since_cursor at cursor 0).
    const t0 = transports[0]!;
    expect(JSON.parse(t0.sent[0]!)).toEqual({ type: "subscribe", topics: ["task:1"] });
    t0.deliver(frame("e1", 1));
    t0.deliver(frame("e2", 2));
    expect(client.cursor()).toBe(2);

    // Disconnect -> a reconnect is scheduled.
    t0.drop();
    expect(scheduled).not.toBeNull();
    scheduled!();

    // Reconnect subscribes with since_cursor = last cursor.
    const t1 = transports[1]!;
    expect(JSON.parse(t1.sent[0]!)).toEqual({
      type: "subscribe",
      topics: ["task:1"],
      since_cursor: 2,
    });

    // Catch-up re-delivers e2 (deduped) plus the missed e3.
    t1.deliver(frame("e2", 2));
    t1.deliver(frame("e3", 3));
    expect(events).toEqual(["e1", "e2", "e3"]);
    expect(client.cursor()).toBe(3);
  });
});
