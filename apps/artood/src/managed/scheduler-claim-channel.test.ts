import { randomUUID } from "node:crypto";
import type { SchedulerClaimPollMessage } from "@artoo/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { createSchedulerClaimClientChannel } from "./scheduler-claim-channel.js";

const channels: ReturnType<typeof createSchedulerClaimClientChannel>[] = [];
afterEach(() => {
  for (const channel of channels.splice(0)) channel.close(new Error("fixture closed"));
  vi.useRealTimers();
});
function fixture() {
  const session = {
    nodeId: "node",
    namespace: randomUUID(),
    sessionId: randomUUID(),
    generation: 1,
    helloNonce: randomUUID(),
  };
  const sent: SchedulerClaimPollMessage[] = [];
  const channel = createSchedulerClaimClientChannel({
    session,
    assertCurrent() {},
    send(message) {
      sent.push(message);
    },
  });
  channels.push(channel);
  const client = channel.open();
  const reply = (patch: object = {}) => {
    const id = sent.at(-1)!.exchange_id;
    return {
      kind: "command",
      type: "scheduler.claim.response.v1",
      id,
      idempotency_key: id,
      payload: {
        version: 1,
        node_id: session.nodeId,
        session_id: session.sessionId,
        exchange_id: id,
        status: "claimed",
        task_id: "task",
        request_id: "request",
        run_id: "run",
        ...patch,
      },
    };
  };
  return { session, sent, channel, client, reply };
}
it("keeps one original-session poll and ignores foreign response identities", async () => {
  const f = fixture(),
    pending = f.client.poll();
  await expect(f.client.poll()).rejects.toThrow("already pending");
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  f.channel.receive(f.reply({ session_id: randomUUID() }));
  f.channel.receive({ ...f.reply(), id: randomUUID() });
  await Promise.resolve();
  expect(settled).toBe(false);
  f.channel.receive(f.reply());
  expect(await pending).toMatchObject({ status: "claimed", task_id: "task", request_id: "request", run_id: "run" });
});
it("cannot revive an old poll or its session after disconnect", async () => {
  const f = fixture(),
    pending = f.client.poll(),
    rejected = expect(pending).rejects.toThrow("generation lost"),
    old = f.reply();
  f.channel.close(new Error("generation lost"));
  f.channel.receive(old);
  await rejected;
  expect(f.client.signal.aborted).toBe(true);
  await expect(f.client.poll()).rejects.toThrow("generation lost");
});
it("expires the original response window without treating late claims as starts", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "hrtime"] });
  const f = fixture(),
    pending = f.client.poll(),
    rejected = expect(pending).rejects.toThrow("expired"),
    old = f.reply();
  await vi.advanceTimersByTimeAsync(10000);
  await rejected;
  f.channel.receive(old);
  expect(f.sent).toHaveLength(1);
});
