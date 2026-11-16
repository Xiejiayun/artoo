import { randomUUID } from "node:crypto";
import type { SchedulerExecutionLeaseV1, SchedulerStartGrantV1 } from "@artoo/domain";
import type { RunEventMessage, SchedulerRunRequestMessage } from "@artoo/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { createSchedulerRunClientChannel } from "./scheduler-run-channel.js";

// Controlled protocol metadata; this fixture grants no physical process authority.
const channels: ReturnType<typeof createSchedulerRunClientChannel>[] = [];
afterEach(() => {
  for (const channel of channels.splice(0)) channel.close(new Error("fixture closed"));
});
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
    scope: "scheduler.attempt-events.v1" as const,
    credential_id: randomUUID(),
    secret: "A".repeat(43),
  };
  const sent: SchedulerRunRequestMessage[] = [];
  const channel = createSchedulerRunClientChannel({
    session,
    assertCurrent: vi.fn(),
    send: (message) => {
      sent.push(message);
    },
  });
  channels.push(channel);
  const client = channel.open();
  const reply = (fields: object = { status: "issued", lease, credential, stop_requested: false }) => {
    const exchange = sent.at(-1)!.exchange_id;
    return {
      kind: "command",
      type: "scheduler.run.response.v1",
      id: exchange,
      idempotency_key: exchange,
      payload: { version: 1, node_id: session.nodeId, session_id: session.sessionId, exchange_id: exchange, ...fields },
    };
  };
  const acquire = async () => {
    const pending = client.acquire(grant);
    await Promise.resolve();
    channel.receive(reply());
    return pending;
  };
  const frame: RunEventMessage = {
    kind: "run.event",
    node_id: session.nodeId,
    run_id: grant.run_id,
    sequence: 0,
    event: { type: "run.lifecycle", payload: { phase: "started" } },
  };
  return { session, grant, lease, credential, sent, channel, client, reply, acquire, frame };
}
it("keeps event credentials private and wraps the unchanged inner durable frame only at exposure", async () => {
  const f = fixture(),
    authority = await f.acquire();
  expect(JSON.stringify(authority)).not.toContain(f.credential.secret);
  expect(authority).not.toHaveProperty("credential");
  const wrapped = JSON.parse(f.channel.encode(f.frame));
  expect(wrapped).toMatchObject({
    kind: "scheduler.run.event.v1",
    credential: f.credential,
    binding: f.lease.binding,
    frame: f.frame,
  });
  expect(f.frame).not.toHaveProperty("credential");
  authority.forget();
  expect(() => f.channel.encode(f.frame)).toThrow("no event authority");
});
it("polls original Stop authority and rejects changed epochs", async () => {
  const f = fixture(),
    authority = await f.acquire(),
    status = authority.status();
  await Promise.resolve();
  await Promise.resolve();
  f.channel.receive(f.reply({ status: "current", lease: f.lease, stop_requested: true }));
  expect(await status).toEqual({ stop_requested: true });
  const stale = authority.status();
  await Promise.resolve();
  await Promise.resolve();
  f.channel.receive(
    f.reply({
      status: "current",
      lease: { ...f.lease, binding: { ...f.lease.binding, epoch: 2 } },
      stop_requested: false,
    }),
  );
  await expect(stale).rejects.toThrow("no longer current");
});
it("does not inherit old credentials or queued work after generation loss", async () => {
  const f = fixture(),
    authority = await f.acquire();
  const pending = authority.status(),
    failed = expect(pending).rejects.toThrow("generation lost");
  await Promise.resolve();
  await Promise.resolve();
  f.channel.close(new Error("generation lost"));
  await failed;
  expect(authority.signal.aborted).toBe(true);
  expect(() => f.channel.encode(f.frame)).toThrow("generation lost");
  await expect(f.client.acquire(f.grant)).rejects.toThrow("generation lost");
});
it("retains pre-existing Stop on the original authority for the physical owner to fence startup", async () => {
  const f = fixture(),
    pending = f.client.acquire(f.grant);
  await Promise.resolve();
  f.channel.receive(f.reply({ status: "issued", lease: f.lease, credential: f.credential, stop_requested: true }));
  const authority = await pending;
  expect(authority.stopRequested).toBe(true);
  expect(JSON.stringify(authority)).not.toContain(f.credential.secret);
  authority.forget();
});
