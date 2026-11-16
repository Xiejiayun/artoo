import { randomUUID } from "node:crypto";
import type { SchedulerExecutionLeaseV1, SchedulerStartGrantV1 } from "@artoo/domain";
import type { SchedulerLeaseRequestMessage } from "@artoo/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSchedulerLeaseClientChannel } from "./scheduler-lease-channel.js";

// Controlled protocol metadata only; no journal, process or Provider authority.
const channels: ReturnType<typeof createSchedulerLeaseClientChannel>[] = [];
function fixture() {
  const session = {
    nodeId: "node",
    namespace: randomUUID(),
    sessionId: randomUUID(),
    generation: 1,
    helloNonce: randomUUID(),
  };
  const grant: SchedulerStartGrantV1 = {
    version: 1,
    scope: "scheduler-start.once.v1",
    grant_id: randomUUID(),
    organization_id: "org",
    project_id: "project",
    task_id: "task",
    request_id: "request",
    run_id: "run",
    actor_user_id: "user",
    agent_instance_id: "instance",
    computer_id: session.nodeId,
    device_id: "device",
    session_id: session.sessionId,
    journal_namespace: session.namespace,
    node_attempt_id: randomUUID(),
    ready_id: randomUUID(),
    proposal_digest: `sha256:${"a".repeat(64)}`,
    issued_at: "2026-11-16T00:00:00.000Z",
    expires_at: "2026-11-16T00:00:05.000Z",
  };
  const { ready_id: _ready, proposal_digest: _digest, issued_at: _issued, expires_at: _expires, ...binding } = grant;
  const lease: SchedulerExecutionLeaseV1 = {
    version: 1,
    binding: { ...binding, scope: "scheduler.execution-lease.v1", lease_id: randomUUID(), epoch: 1 },
    state: "active",
    claimed_at: grant.issued_at,
    observed_at: grant.issued_at,
    expires_at: "2026-11-16T00:00:30.000Z",
    closed_at: null,
  };
  const credential = {
    version: 1 as const,
    scope: "scheduler.attempt-renew.v1" as const,
    credential_id: randomUUID(),
    secret: "A".repeat(43),
  };
  const sent: SchedulerLeaseRequestMessage[] = [],
    assertCurrent = vi.fn();
  const channel = createSchedulerLeaseClientChannel({
    session,
    assertCurrent,
    send: (message) => {
      sent.push(message);
    },
  });
  channels.push(channel);
  const client = channel.open();
  const reply = (fields: object = { status: "issued", lease, credential }) => {
    const exchange = sent.at(-1)!.exchange_id;
    return {
      kind: "command",
      type: "scheduler.lease.response.v1",
      id: exchange,
      idempotency_key: exchange,
      payload: { version: 1, node_id: session.nodeId, session_id: session.sessionId, exchange_id: exchange, ...fields },
    };
  };
  const acquire = async () => {
    const pending = client.acquire(grant);
    channel.receive(reply());
    const result = await pending;
    if (result.status !== "acquired") throw new Error("Expected a controlled private renewal handle");
    return result;
  };
  return { session, grant, lease, credential, sent, assertCurrent, channel, client, reply, acquire };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "hrtime"] });
});
afterEach(() => {
  for (const channel of channels.splice(0)) channel.close(new Error("fixture closed"));
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("keeps plaintext private and uses its closure for exact-bound renewal", async () => {
  const f = fixture(),
    acquired = await f.acquire();
  expect(JSON.stringify(acquired)).not.toContain(f.credential.secret);
  expect(acquired.renewal).not.toHaveProperty("credential");
  const pending = acquired.renewal.renew();
  expect(f.sent.at(-1)).toMatchObject({
    kind: "scheduler.lease.renew.v1",
    binding: f.lease.binding,
    credential: f.credential,
  });
  const lease = { ...f.lease, observed_at: "2026-11-16T00:00:01.000Z", expires_at: "2026-11-16T00:00:31.000Z" };
  f.channel.receive(f.reply({ status: "renewed", lease }));
  expect(await pending).toEqual(lease);
  expect(Object.isFrozen(acquired.lease.binding)).toBe(true);
  expect(Object.isFrozen(acquired.renewal)).toBe(true);
});
it("captures original grant bytes, bounds pending exchanges and returns retained without a secret", async () => {
  const f = fixture(),
    original = structuredClone(f.grant),
    pending = f.client.acquire(f.grant);
  f.grant.node_attempt_id = randomUUID();
  expect(f.sent[0]).toMatchObject({ grant: original });
  await expect(f.client.acquire(original)).rejects.toThrow("already pending");
  f.channel.receive(f.reply({ status: "retained", lease: f.lease }));
  expect(await pending).toEqual({ status: "retained", lease: f.lease });
  expect(f.sent).toHaveLength(1);
});
it("ignores malformed and foreign exchange/envelope/session replies", async () => {
  const f = fixture(),
    pending = f.client.acquire(f.grant),
    valid = f.reply();
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  for (const patch of [
    { node_id: "other" },
    { session_id: randomUUID() },
    { exchange_id: randomUUID() },
    { unknown: true },
  ])
    f.channel.receive({ ...valid, payload: { ...valid.payload, ...patch } });
  f.channel.receive({ ...valid, id: randomUUID() });
  f.channel.receive({ ...valid, idempotency_key: randomUUID() });
  await Promise.resolve();
  expect(settled).toBe(false);
  f.channel.receive(valid);
  expect((await pending).status).toBe("acquired");
});
it.each(["computer_id", "session_id", "journal_namespace"] as const)(
  "rejects a foreign grant %s before writing",
  async (key) => {
    const f = fixture();
    await expect(
      f.client.acquire({ ...f.grant, [key]: key === "computer_id" ? "other" : randomUUID() }),
    ).rejects.toThrow("original session");
    expect(f.sent).toHaveLength(0);
  },
);
it("rejects changed acquisition and renewal bindings without exposing the secret", async () => {
  const f = fixture(),
    pending = f.client.acquire(f.grant);
  f.channel.receive(
    f.reply({
      status: "issued",
      lease: { ...f.lease, binding: { ...f.lease.binding, project_id: "other" } },
      credential: f.credential,
    }),
  );
  await expect(pending).rejects.toThrow("original grant");
  const acquired = await f.acquire(),
    renewed = acquired.renewal.renew();
  f.channel.receive(f.reply({ status: "renewed", lease: { ...f.lease, binding: { ...f.lease.binding, epoch: 2 } } }));
  await expect(renewed).rejects.toThrow("original lease");
});
it("denies mismatched operations and explicit peer rejection", async () => {
  const f = fixture(),
    first = f.client.acquire(f.grant);
  f.channel.receive(f.reply({ status: "renewed", lease: f.lease }));
  await expect(first).rejects.toThrow("operation changed");
  const next = f.client.acquire(f.grant);
  f.channel.receive(f.reply({ status: "rejected", operation: "acquire" }));
  await expect(next).rejects.toThrow("acquisition was rejected");
});
it("expires the original exchange and cannot reuse an old response", async () => {
  const f = fixture(),
    first = f.client.acquire(f.grant),
    old = f.reply(),
    rejected = expect(first).rejects.toThrow("expired");
  await vi.advanceTimersByTimeAsync(10000);
  await rejected;
  const next = f.client.acquire(f.grant);
  let done = false;
  void next.then(() => {
    done = true;
  });
  f.channel.receive(old);
  await Promise.resolve();
  expect(done).toBe(false);
  f.channel.receive(f.reply());
  expect((await next).status).toBe("acquired");
});
it("checks the original window again when a timely continuation resumes late", async () => {
  const f = fixture(),
    pending = f.client.acquire(f.grant);
  vi.advanceTimersByTime(9999);
  f.channel.receive(f.reply());
  vi.advanceTimersByTime(1);
  await expect(pending).rejects.toThrow("original exchange window");
});
it("forgets only local plaintext and aborts all private handles and pending work on generation loss", async () => {
  const f = fixture(),
    acquired = await f.acquire();
  acquired.renewal.forget();
  expect(acquired.renewal.signal.aborted).toBe(true);
  await expect(acquired.renewal.renew()).rejects.toThrow("forgotten");
  expect(f.sent).toHaveLength(1);
  const next = await f.acquire(),
    pending = next.renewal.renew(),
    rejected = expect(pending).rejects.toThrow();
  f.channel.close(new Error("generation lost"));
  await rejected;
  expect(next.renewal.signal.aborted).toBe(true);
  expect(f.client.signal.aborted).toBe(true);
  await expect(f.client.acquire(f.grant)).rejects.toThrow("generation lost");
  expect(() => f.channel.open()).toThrow("generation lost");
});
it("bounds private credential memory and permits explicit local forgetting", async () => {
  const f = fixture(),
    handles = [];
  for (let i = 0; i < 64; i++) {
    f.grant.grant_id = randomUUID();
    f.lease.binding.grant_id = f.grant.grant_id;
    f.lease.binding.lease_id = randomUUID();
    handles.push((await f.acquire()).renewal);
  }
  await expect(f.client.acquire(f.grant)).rejects.toThrow("memory capacity");
  expect(f.sent).toHaveLength(64);
  handles[0]!.forget();
  expect((await f.acquire()).status).toBe("acquired");
});
