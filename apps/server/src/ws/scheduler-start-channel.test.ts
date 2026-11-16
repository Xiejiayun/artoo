import { randomUUID } from "node:crypto";
import type { SchedulerStartResponseCommand } from "@artoo/protocol";
import { afterEach, expect, it, vi } from "vitest";
import type { ServerContext } from "../context.js";
import * as proposalService from "../services/scheduler-start-proposal-service.js";
import { createSchedulerStartServerChannel } from "./scheduler-start-channel.js";

afterEach(() => {
  vi.restoreAllMocks();
});

it("bounds the whole server exchange through pending local response-write completion", async () => {
  // Controlled channel lifecycle only. No database, authorization or process is supplied.
  const service = vi
    .spyOn(proposalService, "prepareSchedulerStartProposal")
    .mockRejectedValue(new Error("controlled rejection"));
  let release!: () => void,
    entered!: () => void,
    current = true;
  const writing = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const send = vi.fn(async (_reply: SchedulerStartResponseCommand) => {
    entered();
    await writing;
  });
  const close = vi.fn(() => {
      current = false;
    }),
    onRejected = vi.fn();
  const sessionId = randomUUID(),
    handler = createSchedulerStartServerChannel({} as ServerContext, {
      computerId: "node",
      sessionId,
      namespace: randomUUID(),
      isCurrent: () => current,
      send,
      close,
      onRejected,
    });
  const message = {
    kind: "scheduler.start.propose.v1" as const,
    node_id: "node",
    session_id: sessionId,
    exchange_id: randomUUID(),
    task_id: "task",
    request_id: "request",
  };
  const first = handler(message);
  try {
    await started;
    await handler({ ...message, exchange_id: randomUUID() });
    expect(close).toHaveBeenCalledWith("scheduler start channel already has a pending exchange");
    expect(service).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(onRejected).toHaveBeenCalledWith(expect.any(Error), "proposal");
    expect(send.mock.calls[0]?.[0]).toMatchObject({ payload: { status: "rejected", operation: "proposal" } });
  } finally {
    release();
    await first;
  }
});
