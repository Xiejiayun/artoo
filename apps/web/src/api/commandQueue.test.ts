import { describe, expect, it } from "vitest";

import { ApiClientError } from "./client.js";
import { CommandConflictError, createApiCommandQueue } from "./commandQueue.js";

/** Build a queue that never attaches the window online listener (tests drive flush). */
function makeQueue(): ReturnType<typeof createApiCommandQueue> {
  return createApiCommandQueue({ attachOnlineListener: false });
}

const conflictError = new ApiClientError("conflict", "stale", 409, {
  reason: "stale_base_version",
  base_version: 3,
  current_version: 7,
  resource: { type: "task", id: "task_1" },
});

describe("web ApiCommandQueue (canonical @artoo/client dogfood)", () => {
  it("applies a successful mutation and resolves with its result", async () => {
    const q = makeQueue();
    const result = await q.submit(async () => ({ task: { id: "t1" } }), { key: "k1" });
    expect(result).toEqual({ task: { id: "t1" } });
    expect(q.pendingCount()).toBe(0);
  });

  it("queues an offline (network_error) send and replays it on reconnect", async () => {
    const q = makeQueue();
    let online = false;
    const run = async (): Promise<string> => {
      if (!online) {
        throw new ApiClientError("network_error", "offline", 0);
      }
      return "ok";
    };
    const p = q.submit(run, { key: "k1" });
    // Wait for the initial send pass (which returns retry) to settle.
    await q.flush();
    expect(q.pendingCount()).toBe(1);

    online = true;
    await q.flush();
    await expect(p).resolves.toBe("ok");
    expect(q.pendingCount()).toBe(0);
  });

  it("rejects a duplicate in-flight key without orphaning the original command", async () => {
    const q = makeQueue();
    let online = false;
    const run = async (): Promise<string> => {
      if (!online) {
        throw new ApiClientError("network_error", "offline", 0);
      }
      return "first";
    };
    const first = q.submit(run, { key: "k1" });
    await q.flush();
    expect(q.pendingCount()).toBe(1);

    await expect(q.submit(async () => "second", { key: "k1" })).rejects.toThrow("command already pending: k1");

    online = true;
    await q.flush();
    await expect(first).resolves.toBe("first");
    expect(q.pendingCount()).toBe(0);
  });

  it("rejects with CommandConflictError on a stale_base_version 409", async () => {
    const q = makeQueue();
    await expect(
      q.submit(
        async () => {
          throw conflictError;
        },
        { key: "k1", baseVersion: 3 },
      ),
    ).rejects.toBeInstanceOf(CommandConflictError);
    expect(q.pendingCount()).toBe(0); // settled, not stuck
  });

  it("rejects a non-retryable error and does not wedge the queue", async () => {
    const q = makeQueue();
    const validation = new ApiClientError("validation_error", "bad", 400);
    await expect(
      q.submit(async () => {
        throw validation;
      }, { key: "k1" }),
    ).rejects.toBe(validation);
    expect(q.pendingCount()).toBe(0);
    // A later command still flows.
    await expect(q.submit(async () => "ok", { key: "k2" })).resolves.toBe("ok");
  });

  it("replays queued commands in order on reconnect", async () => {
    const q = makeQueue();
    let online = false;
    const applied: string[] = [];
    const mk = (id: string) => async (): Promise<string> => {
      if (!online) {
        throw new ApiClientError("network_error", "offline", 0);
      }
      applied.push(id);
      return id;
    };
    const pa = q.submit(mk("a"), { key: "a" });
    const pb = q.submit(mk("b"), { key: "b" });
    await q.flush();
    expect(q.pendingCount()).toBe(2);

    online = true;
    await q.flush();
    await Promise.all([pa, pb]);
    expect(applied).toEqual(["a", "b"]);
    expect(q.pendingCount()).toBe(0);
  });
});
