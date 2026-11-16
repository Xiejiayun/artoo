import { randomUUID } from "node:crypto";
import type { SchedulerLeaseRequestMessage, SchedulerLeaseResponseCommand } from "@artoo/protocol";
import { afterEach, expect, it, vi } from "vitest";
import type { ServerContext } from "../context.js";
import * as service from "../services/scheduler-attempt-credential-service.js";
import { createSchedulerLeaseServerChannel } from "./scheduler-lease-channel.js";

afterEach(() => {
  vi.restoreAllMocks();
});
function fixture() {
  // Deliberately incomplete controlled bytes: the DB service is always mocked;
  // these cases exercise lane lifetime, not authentication or a valid grant.
  const namespace = randomUUID(),
    sessionId = randomUUID();
  const message: SchedulerLeaseRequestMessage = {
    kind: "scheduler.lease.acquire.v1",
    node_id: "node",
    session_id: sessionId,
    exchange_id: randomUUID(),
    grant: { journal_namespace: namespace, task_id: "task", request_id: "request" } as never,
  };
  let current = true;
  const send = vi.fn(async (_reply: SchedulerLeaseResponseCommand) => {}),
    close = vi.fn(() => {
      current = false;
    }),
    onRejected = vi.fn();
  const handler = createSchedulerLeaseServerChannel({} as ServerContext, {
    computerId: "node",
    sessionId,
    namespace,
    isCurrent: () => current,
    send,
    close,
    onRejected,
  });
  return {
    message,
    send,
    close,
    onRejected,
    handler,
    replace() {
      current = false;
    },
  };
}
it("keeps the lane busy through local response writing and never reports raw secret-bearing errors", async () => {
  const secret = "controlled-private-secret",
    failure = new Error(secret);
  const acquire = vi.spyOn(service, "acquireSchedulerAttemptCredential").mockRejectedValue(failure),
    f = fixture();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
  f.send.mockImplementation(async () => {
    entered();
    await gate;
  });
  const first = f.handler(f.message);
  try {
    await started;
    await f.handler({ ...f.message, exchange_id: randomUUID() });
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalledWith("scheduler lease channel already has a pending exchange");
    expect(f.onRejected).toHaveBeenCalledWith("acquire");
    expect(JSON.stringify([...f.send.mock.calls, ...f.onRejected.mock.calls])).not.toContain(secret);
  } finally {
    release();
    await first;
  }
});
it("withholds the original session's reply after awaited work loses its generation", async () => {
  let reject!: (error: Error) => void;
  const gate = new Promise<never>((_resolve, fail) => {
    reject = fail;
  });
  vi.spyOn(service, "acquireSchedulerAttemptCredential").mockReturnValue(gate);
  const f = fixture(),
    pending = f.handler(f.message);
  f.replace();
  reject(new Error("controlled failure"));
  await pending;
  expect(f.send).not.toHaveBeenCalled();
});
it("rejects a namespace mismatch before the service and ignores foreign outer identities", async () => {
  const acquire = vi.spyOn(service, "acquireSchedulerAttemptCredential"),
    f = fixture();
  await f.handler({ ...f.message, node_id: "other" });
  await f.handler({ ...f.message, session_id: randomUUID() });
  expect(f.send).not.toHaveBeenCalled();
  if (f.message.kind !== "scheduler.lease.acquire.v1") throw new Error("Expected acquisition fixture");
  await f.handler({ ...f.message, grant: { ...f.message.grant, journal_namespace: randomUUID() } });
  expect(acquire).not.toHaveBeenCalled();
  expect(f.send.mock.calls[0]?.[0]).toMatchObject({ payload: { status: "rejected", operation: "acquire" } });
});
it("closes on an unconfirmed response write without retrying acquisition", async () => {
  const acquire = vi.spyOn(service, "acquireSchedulerAttemptCredential").mockRejectedValue(new Error("controlled")),
    f = fixture();
  f.send.mockRejectedValue(new Error("controlled write failure"));
  await f.handler(f.message);
  expect(f.close).toHaveBeenCalledWith("scheduler lease response write failed");
  expect(acquire).toHaveBeenCalledTimes(1);
});
