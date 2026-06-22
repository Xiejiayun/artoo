import { describe, expect, it } from "vitest";

import {
  createCommandQueue,
  type CommandConflict,
  type PendingCommand,
  type SendResult,
} from "./command-queue.js";

function cmd(key: string, baseVersion?: number): PendingCommand {
  return { key, baseVersion, payload: { op: key } };
}

const conflict: CommandConflict = {
  reason: "stale_base_version",
  base_version: 5,
  current_version: 9,
  resource: { type: "task", id: "task_1" },
};

describe("@artoo/client command queue (offline replay)", () => {
  it("success: a queued command applies and leaves the queue empty", async () => {
    const sent: PendingCommand[] = [];
    const q = createCommandQueue({
      send: async (c): Promise<SendResult> => {
        sent.push(c);
        return { status: "applied", response: { ok: true } };
      },
    });
    q.enqueue(cmd("k1", 3));
    const out = await q.flush();
    expect(out).toEqual([{ status: "applied", key: "k1", response: { ok: true }, duplicate: false }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.baseVersion).toBe(3);
    expect(q.pending()).toEqual([]);
  });

  it("duplicate replay: re-sending the same key after a lost ack is marked duplicate, not double-counted", async () => {
    let applies = 0;
    const q = createCommandQueue({
      // Server idempotency returns the stored response on replay → always applied.
      send: async (): Promise<SendResult> => {
        applies += 1;
        return { status: "applied", response: { n: applies } };
      },
    });

    q.enqueue(cmd("dup"));
    const first = await q.flush();
    expect(first[0]).toMatchObject({ status: "applied", key: "dup", duplicate: false });

    // The ack was lost, so the client re-queues the SAME logical command.
    q.enqueue(cmd("dup"));
    const second = await q.flush();
    expect(second[0]).toMatchObject({ status: "applied", key: "dup", duplicate: true });
    expect(q.pending()).toEqual([]);
  });

  it("stale base_version conflict: surfaced to the caller, not silently dropped", async () => {
    const outcomes: unknown[] = [];
    const q = createCommandQueue({
      send: async (): Promise<SendResult> => ({ status: "conflict", conflict }),
      onOutcome: (o) => outcomes.push(o),
    });
    q.enqueue(cmd("stale", 5));
    const out = await q.flush();
    expect(out).toEqual([{ status: "conflict", key: "stale", conflict }]);
    expect(outcomes).toEqual([{ status: "conflict", key: "stale", conflict }]);
    expect(q.pending()).toEqual([]); // settled (surfaced), removed from queue
  });

  it("offline reconnect replay: commands stay queued in order while offline, then drain on reconnect", async () => {
    let online = false;
    const sent: string[] = [];
    const q = createCommandQueue({
      send: async (c): Promise<SendResult> => {
        if (!online) {
          return { status: "retry" };
        }
        sent.push(c.key);
        return { status: "applied", response: { key: c.key } };
      },
    });

    q.enqueue(cmd("a"));
    q.enqueue(cmd("b"));
    q.enqueue(cmd("c"));

    // Offline: nothing applies, order is preserved, queue intact.
    const offlinePass = await q.flush();
    expect(offlinePass).toEqual([]);
    expect(q.pending().map((p) => p.key)).toEqual(["a", "b", "c"]);
    expect(sent).toEqual([]);

    // Reconnect: the whole backlog drains in FIFO order.
    online = true;
    const out = await q.flush();
    expect(out.map((o) => o.key)).toEqual(["a", "b", "c"]);
    expect(out.every((o) => o.status === "applied")).toBe(true);
    expect(sent).toEqual(["a", "b", "c"]);
    expect(q.pending()).toEqual([]);
  });

  it("a mid-backlog retry stops the pass and preserves the remaining order", async () => {
    let failAfter = 1; // apply the first, then go offline
    const sent: string[] = [];
    const q = createCommandQueue({
      send: async (c): Promise<SendResult> => {
        if (failAfter <= 0) {
          return { status: "retry" };
        }
        failAfter -= 1;
        sent.push(c.key);
        return { status: "applied" };
      },
    });
    q.enqueue(cmd("a"));
    q.enqueue(cmd("b"));
    q.enqueue(cmd("c"));
    const out = await q.flush();
    expect(out.map((o) => o.key)).toEqual(["a"]);
    expect(sent).toEqual(["a"]);
    // b and c remain queued, in order, for the next reconnect.
    expect(q.pending().map((p) => p.key)).toEqual(["b", "c"]);
  });

  it("concurrent flushes are coalesced (a command is never sent twice in parallel)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const q = createCommandQueue({
      send: async (): Promise<SendResult> => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return { status: "applied" };
      },
    });
    q.enqueue(cmd("a"));
    q.enqueue(cmd("b"));
    const [r1, r2] = await Promise.all([q.flush(), q.flush()]);
    expect(maxInFlight).toBe(1);
    // Both callers observe the same coalesced result; no command duplicated.
    expect(r1).toBe(r2);
    expect(q.pending()).toEqual([]);
  });
});
