import { randomUUID } from "node:crypto";
import type { SchedulerStartGrantResponseV1 } from "@artoo/domain";
import type { SchedulerStartRequestMessage, SchedulerStartResponseCommand } from "@artoo/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSchedulerStartClientChannel } from "./scheduler-start-channel.js";

// Controlled wire/state tests only: these bytes have no journal/producer authority.
function fixture() {
  const session = {
    nodeId: "node",
    namespace: randomUUID(),
    sessionId: randomUUID(),
    generation: 1,
    helloNonce: randomUUID(),
  };
  const sent: SchedulerStartRequestMessage[] = [],
    assertCurrent = vi.fn();
  const lane = createSchedulerStartClientChannel({
    session,
    assertCurrent,
    send: (message) => {
      sent.push(message);
    },
  });
  const client = lane.open();
  const input = {
    taskId: "task",
    ready: {
      version: 1 as const,
      request_id: "request",
      run_id: "run",
      journal_namespace: session.namespace,
      node_attempt_id: randomUUID(),
      ready_id: randomUUID(),
      proposal_digest: `sha256:${"a".repeat(64)}`,
    },
  };
  const result = (): SchedulerStartGrantResponseV1 => ({
    version: 1,
    remaining_ms: 5000,
    grant: {
      ...input.ready,
      scope: "scheduler-start.once.v1",
      grant_id: randomUUID(),
      organization_id: "org",
      project_id: "project",
      task_id: input.taskId,
      actor_user_id: "user",
      agent_instance_id: "instance",
      computer_id: session.nodeId,
      device_id: "device",
      session_id: session.sessionId,
      issued_at: "2026-11-16T00:00:00.000Z",
      expires_at: "2026-11-16T00:00:05.000Z",
    },
  });
  const reply = (value = result()): SchedulerStartResponseCommand => ({
    kind: "command",
    type: "scheduler.start.response.v1",
    id: randomUUID(),
    idempotency_key: randomUUID(),
    payload: {
      version: 1,
      node_id: session.nodeId,
      session_id: session.sessionId,
      exchange_id: sent.at(-1)!.exchange_id,
      status: "grant",
      result: value,
    },
  });
  return { session, sent, assertCurrent, lane, client, input, result, reply };
}
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe("one generation's scheduler exchange lane", () => {
  it("captures the original ready bytes, bounds pending work and cannot reuse an old reply", async () => {
    const f = fixture(),
      original = f.result(),
      first = f.client.grant(f.input);
    const previous = f.reply(original);
    f.input.ready.node_attempt_id = randomUUID();
    expect(f.sent[0]).toMatchObject({ ready: { node_attempt_id: original.grant.node_attempt_id } });
    await expect(f.client.grant(f.input)).rejects.toThrow("already pending");
    expect(f.sent).toHaveLength(1);
    f.lane.receive(previous);
    expect(await first).toEqual(original);
    const second = f.client.grant(f.input),
      value = f.result();
    let settled = false;
    void second.then(() => {
      settled = true;
    });
    f.lane.receive(previous);
    await Promise.resolve();
    expect(settled).toBe(false);
    f.lane.receive(f.reply(value));
    expect(await second).toEqual(value);
  });
  it("ignores foreign exchange/node/session replies, including malformed authority fields", async () => {
    const f = fixture(),
      pending = f.client.grant(f.input),
      valid = f.reply();
    for (const fields of [{ node_id: "other" }, { session_id: randomUUID() }, { exchange_id: randomUUID() }])
      f.lane.receive({ ...valid, payload: { ...valid.payload, ...fields } });
    f.lane.receive({ ...valid, payload: { ...valid.payload, execution_authorized: true } } as never);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    f.lane.receive(valid);
    expect(await pending).toEqual(valid.payload.status === "grant" ? valid.payload.result : null);
  });
  it("rejects an otherwise valid grant for another ready attempt", async () => {
    const f = fixture(),
      pending = f.client.grant(f.input),
      value = f.result();
    value.grant.node_attempt_id = randomUUID();
    f.lane.receive(f.reply(value));
    await expect(pending).rejects.toThrow("original ready/session");
  });
  it("does not refresh the original deadline and discards late replies", async () => {
    const f = fixture(),
      pending = f.client.grant(f.input);
    const observed = expect(pending).rejects.toThrow("expired");
    await vi.advanceTimersByTimeAsync(5000);
    await observed;
    f.lane.receive(f.reply());
    expect(f.sent).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects a timely receipt whose continuation resumes only at the original deadline", async () => {
    const f = fixture(),
      pending = f.client.grant(f.input);
    vi.advanceTimersByTime(4999);
    f.lane.receive(f.reply());
    vi.advanceTimersByTime(1);
    await expect(pending).rejects.toThrow("original exchange window");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("aborts the original signal even after reply resolution and denies further requests", async () => {
    const f = fixture(),
      pending = f.client.grant(f.input);
    f.lane.receive(f.reply());
    await pending;
    const reason = new Error("generation lost");
    f.lane.close(reason);
    expect(f.client.signal.aborted).toBe(true);
    expect(f.client.signal.reason).toBe(reason);
    await expect(f.client.grant(f.input)).rejects.toThrow("generation lost");
    expect(() => f.lane.open()).toThrow("generation lost");
    expect(f.sent).toHaveLength(1);
  });
  it("joins pending failure on closure and validates the original live generation before writes", async () => {
    const f = fixture(),
      pending = f.client.grant(f.input);
    f.lane.close(new Error("closed"));
    await expect(pending).rejects.toThrow("closed");
    expect(vi.getTimerCount()).toBe(0);
    const next = fixture();
    next.assertCurrent.mockImplementation(() => {
      throw new Error("replaced");
    });
    await expect(next.client.grant(next.input)).rejects.toThrow("replaced");
    expect(next.sent).toHaveLength(0);
  });
  it("rejects explicit peer denial without exposing details or changing namespaces", async () => {
    const f = fixture();
    await expect(
      f.client.grant({ ...f.input, ready: { ...f.input.ready, journal_namespace: randomUUID() } }),
    ).rejects.toThrow("namespace");
    const pending = f.client.grant(f.input),
      valid = f.reply();
    f.lane.receive({
      ...valid,
      payload: {
        version: 1,
        node_id: f.session.nodeId,
        session_id: f.session.sessionId,
        exchange_id: valid.payload.exchange_id,
        status: "rejected",
        operation: "grant",
      },
    });
    await expect(pending).rejects.toThrow("grant was rejected");
    expect(vi.getTimerCount()).toBe(0);
  });
});
