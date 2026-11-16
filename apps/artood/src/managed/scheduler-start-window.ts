import { createHash, randomUUID } from "node:crypto";
import {
  SchedulerStartGrantResponseV1Schema,
  SchedulerStartProposalV1Schema,
  canonicalSchedulerStartProposalV1,
  type SchedulerStartProposalV1,
  type SchedulerStartGrantV1,
} from "@artoo/domain";
import { schedulerStartTickMs } from "./scheduler-start-clock.js";
import type {
  SchedulerPreparationPermit,
  SchedulerPreparationRecord,
  SchedulerReadyExchange,
  SchedulerReadyRequest,
  SchedulerStartWindow,
} from "./journal-types.js";

interface Prepared {
  readonly proposal: SchedulerStartProposalV1;
  readonly record: SchedulerPreparationRecord;
  used: boolean;
}
interface Exchange {
  readonly prepared: Prepared;
  readonly request: SchedulerReadyRequest;
  readonly signal: AbortSignal;
  readonly started: number;
  used: boolean;
}
interface StartWindow {
  readonly exchange: Exchange;
  readonly grant: SchedulerStartGrantV1;
  readonly deadline: number;
  readonly assertCurrent: () => void;
  used: boolean;
}
export class SchedulerStartWindowExpired extends Error {}

/** One manager per live journal facade. Objects from another manager/process
 * cannot acquire this facade's authority. This does not grant durable admission. */
export function createSchedulerStartWindows(assertAvailable: () => void, tick = schedulerStartTickMs) {
  const preparations = new WeakMap<SchedulerPreparationPermit, Prepared>();
  const exchanges = new WeakMap<SchedulerReadyExchange, Exchange>();
  const windows = new WeakMap<SchedulerStartWindow, StartWindow>();
  return Object.freeze({
    prepare(raw: SchedulerStartProposalV1, record: SchedulerPreparationRecord): SchedulerPreparationPermit {
      assertAvailable();
      const proposal = SchedulerStartProposalV1Schema.parse(raw);
      const prepared = proposal.prepared_start;
      const digest = `sha256:${createHash("sha256").update(canonicalSchedulerStartProposalV1(proposal)).digest("hex")}`;
      if (
        record.version !== 1 ||
        record.executionAuthorized !== false ||
        record.runId !== prepared.run_id ||
        record.requestId !== prepared.request_id ||
        record.nodeId !== prepared.computer_id ||
        record.sessionId !== prepared.session_id ||
        record.proposalDigest !== digest
      )
        throw new Error("Fresh scheduler preparation identity changed");
      const permit = Object.freeze({}) as SchedulerPreparationPermit;
      preparations.set(permit, { proposal, record: Object.freeze({ ...record }), used: false });
      return permit;
    },
    begin(permit: SchedulerPreparationPermit, signal: AbortSignal): SchedulerReadyRequest {
      assertAvailable();
      const prepared = preparations.get(permit);
      if (!prepared || prepared.used) throw new Error("One fresh local scheduler preparation is required");
      prepared.used = true;
      if (!(signal instanceof AbortSignal)) throw new Error("An actual scheduler channel AbortSignal is required");
      signal.throwIfAborted();
      const started = tick();
      if (!Number.isSafeInteger(started) || started < 0)
        throw new Error("Scheduler monotonic clock continuity is unknown");
      const record = prepared.record;
      const exchange = Object.freeze({}) as SchedulerReadyExchange;
      const ready = Object.freeze({
        version: 1 as const,
        request_id: record.requestId,
        run_id: record.runId,
        journal_namespace: record.namespace,
        node_attempt_id: record.nodeAttemptId,
        ready_id: randomUUID(),
        proposal_digest: record.proposalDigest,
      });
      const request = Object.freeze({ ready, exchange });
      exchanges.set(exchange, { prepared, request, signal, started, used: false });
      return request;
    },
    accept(exchange: SchedulerReadyExchange, raw: unknown): SchedulerStartWindow {
      assertAvailable();
      const state = exchanges.get(exchange);
      if (!state || state.used) throw new Error("One original local scheduler ready exchange is required");
      // Even an invalid reply cannot refresh this exchange or its start tick.
      state.used = true;
      const response = SchedulerStartGrantResponseV1Schema.parse(raw);
      const grant = response.grant,
        ready = state.request.ready;
      if (Object.entries(ready).some(([key, value]) => grant[key as keyof typeof grant] !== value))
        throw new Error("Scheduler grant does not match the original ready exchange");
      const original = state.prepared.proposal.prepared_start;
      for (const key of [
        "organization_id",
        "project_id",
        "task_id",
        "actor_user_id",
        "agent_instance_id",
        "computer_id",
        "device_id",
        "session_id",
      ] as const)
        if (grant[key] !== original[key]) throw new Error("Scheduler grant changed its original authority binding");
      // Start before sending ready, so all request, database, commit and response
      // latency consumes the server's returned remaining lifetime conservatively.
      const deadline = state.started + response.remaining_ms;
      if (!Number.isSafeInteger(deadline)) throw new Error("Scheduler monotonic clock continuity is unknown");
      let previous = state.started,
        invalid = false;
      let invalidCause: unknown;
      const assertCurrent = () => {
        if (invalid)
          throw invalidCause instanceof SchedulerStartWindowExpired
            ? new SchedulerStartWindowExpired("Scheduler start window is permanently invalid", { cause: invalidCause })
            : new Error("Scheduler start window is permanently invalid", { cause: invalidCause });
        try {
          assertAvailable();
          state.signal.throwIfAborted();
          const now = tick();
          if (!Number.isSafeInteger(now) || now < previous)
            throw new Error("Scheduler start deadline expired or monotonic continuity is unknown");
          if (now >= deadline) throw new SchedulerStartWindowExpired("Scheduler start deadline expired");
          previous = now;
        } catch (error) {
          invalid = true;
          invalidCause = error;
          throw error;
        }
      };
      assertCurrent();
      const window = Object.freeze({}) as SchedulerStartWindow;
      windows.set(window, { exchange: state, grant, deadline, assertCurrent, used: false });
      return window;
    },
    assertCurrent(window: SchedulerStartWindow): void {
      const state = windows.get(window);
      if (!state) throw new Error("This live journal's private scheduler start window is required");
      state.assertCurrent();
    },
    /** Private facade bridge. Claim before any await; failures, lost replies and
     * concurrent calls never restore the chance to admit this window. */
    consume(window: SchedulerStartWindow) {
      const state = windows.get(window);
      if (!state || state.used) throw new Error("One unused private scheduler start window is required");
      state.used = true;
      state.assertCurrent();
      return Object.freeze({
        proposal: state.exchange.prepared.proposal,
        record: state.exchange.prepared.record,
        grant: state.grant,
        startedTickMs: state.exchange.started,
        deadlineTickMs: state.deadline,
        assertCurrent: state.assertCurrent,
      });
    },
  });
}
