import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  SchedulerStartGrantResponseV1Schema,
  SchedulerStartProposalV1Schema,
  canonicalSchedulerStartProposalV1,
  type SchedulerStartProposalV1,
} from "@artoo/domain";
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

/** One manager per live journal facade. Objects from another manager/process
 * cannot acquire this facade's authority. This does not grant durable admission. */
export function createSchedulerStartWindows(assertAvailable: () => void, tick = () => performance.now()) {
  const preparations = new WeakMap<SchedulerPreparationPermit, Prepared>();
  const exchanges = new WeakMap<SchedulerReadyExchange, Exchange>();
  const windows = new WeakMap<SchedulerStartWindow, () => void>();
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
      if (!Number.isFinite(started) || started < 0) throw new Error("Scheduler monotonic clock continuity is unknown");
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
      let previous = state.started,
        invalid = false;
      const assertCurrent = () => {
        if (invalid) throw new Error("Scheduler start window is permanently invalid");
        try {
          assertAvailable();
          state.signal.throwIfAborted();
          const now = tick();
          if (!Number.isFinite(now) || now < previous || now >= deadline)
            throw new Error("Scheduler start deadline expired or monotonic continuity is unknown");
          previous = now;
        } catch (error) {
          invalid = true;
          throw error;
        }
      };
      assertCurrent();
      const window = Object.freeze({}) as SchedulerStartWindow;
      windows.set(window, assertCurrent);
      return window;
    },
    assertCurrent(window: SchedulerStartWindow): void {
      const check = windows.get(window);
      if (!check) throw new Error("This live journal's private scheduler start window is required");
      check();
    },
  });
}
