import type { AdmissionResult, Journal, JournalRun } from "./journal-types.js";
import type { SchedulerStartSession } from "./scheduler-start-channel.js";
import type { SchedulerStartGrantV1, RunStartPayload } from "@artoo/domain";

export type SchedulerSessionAdmission =
  | (Extract<AdmissionResult, { kind: "fresh" }> & { readonly grant: SchedulerStartGrantV1; readonly assertStartCurrent: () => void })
  | {
      readonly kind: "retained";
      readonly stage: "preparation" | "admission";
      readonly status: string;
      readonly run: JournalRun;
    };

/** Local composition only. It never claims server work, retries an exchange,
 * starts a producer or releases a reservation on an uncertain outcome. */
export async function admitSchedulerStartFromSession(input: {
  journal: Journal;
  channel: SchedulerStartSession;
  taskId: string;
  requestId: string;
  runId: string;
  signal?: AbortSignal;
  /** Local bounded input transfer, deliberately before the original ready clock. */
  prepareInputs?: (payload: RunStartPayload, signal: AbortSignal) => Promise<void>;
}): Promise<SchedulerSessionAdmission> {
  // Capture the original generation, identities and methods before the first
  // await. A reconnect or caller mutation cannot substitute later authority.
  const { journal, channel, taskId, requestId, runId } = input;
  const prepareInputs = input.prepareInputs;
  const session = { ...channel.session };
  const signal = input.signal ? AbortSignal.any([channel.signal, input.signal]) : channel.signal;
  const namespace = journal.namespace;
  signal.throwIfAborted();
  if (
    namespace !== session.namespace ||
    journal.schedulerPreparationVersion !== 1 ||
    journal.schedulerStartGrantStorageVersion !== 1 ||
    journal.schedulerStartGrantAdmissionVersion !== 1 ||
    !journal.prepareSchedulerStart ||
    !journal.beginSchedulerReady ||
    !journal.acceptSchedulerStartGrant ||
    !journal.assertSchedulerStartWindow ||
    !journal.admitSchedulerStart
  )
    throw new Error("Scheduler session admission requires the matching explicitly upgraded v6 journal");
  const propose = channel.propose.bind(channel);
  const grant = channel.grant.bind(channel);
  const prepare = journal.prepareSchedulerStart.bind(journal);
  const begin = journal.beginSchedulerReady.bind(journal);
  const accept = journal.acceptSchedulerStartGrant.bind(journal);
  const assertWindow = journal.assertSchedulerStartWindow.bind(journal);
  const admit = journal.admitSchedulerStart.bind(journal);

  const result = await propose({ taskId, requestId });
  signal.throwIfAborted();
  const original = result.proposal.prepared_start;
  if (
    original.task_id !== taskId ||
    original.request_id !== requestId ||
    original.run_id !== runId ||
    original.computer_id !== session.nodeId ||
    original.session_id !== session.sessionId
  )
    throw new Error("Scheduler proposal differs from the original consumed request and session");
  await prepareInputs?.(result.proposal.run_start, signal);
  signal.throwIfAborted();
  const prepared = await prepare({
    expectedNamespace: namespace,
    runId,
    idempotencyKey: `${runId}:scheduler-prepare:v1`,
    proposal: result.proposal,
  });
  // Join storage before observing cancellation: an interrupted commit is never
  // interpreted as absence, and this helper owns no compensating Stop/release.
  signal.throwIfAborted();
  if (prepared.kind !== "prepared")
    return Object.freeze({ kind: "retained", stage: "preparation", status: prepared.kind, run: prepared.run });
  const ready = begin(prepared.preparation, signal);
  if (ready.ready.proposal_digest !== result.proposal_digest)
    throw new Error("Scheduler preparation differs from the authenticated proposal digest");
  // begin starts the journal's conservative clock before any network work.
  const response = await grant({ taskId, ready: ready.ready });
  signal.throwIfAborted();
  const window = accept(ready.exchange, response);
  const assertStartCurrent = () => {
    signal.throwIfAborted();
    assertWindow(window);
  };
  assertStartCurrent();
  const admitted = await admit(window);
  assertStartCurrent();
  if (admitted.kind !== "fresh")
    return Object.freeze({ kind: "retained", stage: "admission", status: admitted.kind, run: admitted.run });
  // This guard must follow Git namespace/reservation/materialization too. The
  // journal separately retains it on the genuine fresh producer permit.
  return Object.freeze({ ...admitted, grant: response.grant, assertStartCurrent });
}
