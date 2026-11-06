import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SourceSupervisorLaunchV1Schema, SourceCleanStopIntentV1Schema, SourceCleanRestartGrantV1Schema,
  SourceCleanRestartCheckpointV1Schema, inspectSourceCleanClosureV1, inspectSourceCleanCheckpointV1, sourceCleanDigestV1 } from "@artoo/domain";
import { sourceRecoveryRequestFixture, recoveryFixtureSha as sha } from "./test-fixtures/source-recovery-request.js";
import { SourceLifecycleServerMessageV1Schema, encodeSourceLifecycleServerMessageV1, assertSourceLifecyclePayloadReplyFitsV1,
  SOURCE_LIFECYCLE_REQUEST_MAX_BYTES_V1, SOURCE_LIFECYCLE_REPLY_MAX_BYTES_V1,
  SOURCE_LIFECYCLE_CONTROL_REPLY_RESERVE_BYTES_V1 } from "@artoo/protocol";

/** Wire validation only: these ordinary fixture objects have no native owner,
 * observer, storage lineage or recovered-workspace brand. */
function fixture() {
  const old = sourceRecoveryRequestFixture(), observer = randomUUID(), lineage = randomUUID(), generation = randomUUID();
  const identity = { pid: 100, creationTime: "1000", image: "C:\\controlled\\Supervisor.exe", sid: "S-1-5-21-100" };
  const launch = SourceSupervisorLaunchV1Schema.parse({ version: 1, observer_id: observer, supervisor: identity,
    launch_identity_digest: sha("original launch"), runtime_manifest_digest: sha("fixed native inventory"),
    stable: { version: 1, node_id: old.registration.binding.node_id, device_id: old.registration.binding.device_id,
      store_family_identity_digest: sha("physical family"), genesis_store_identity_digest: old.registration.binding.store_identity_digest,
      workspace_root: old.registration.binding.workspace_root, workspace_identity_digest: old.registration.binding.workspace_identity_digest,
      stable_configuration_digest: sha("execution-relevant configuration") } });
  const intent = SourceCleanStopIntentV1Schema.parse({ version: 1, stop_id: randomUUID(), lineage_id: lineage, generation_id: generation,
    revision: 0, launch, registration: old.registration, origin: old.request.origin, goal_id: old.request.goal_id, plan_id: old.request.plan_id,
    authorization: { ...old.request.authorization, consent_id: null }, operations: old.request.operations });
  const closure = { version: 1, kind: "whole-supervisor-job-closed.v1", stop_id: intent.stop_id, intent_digest: sourceCleanDigestV1(intent, sha),
    observer_id: observer, supervisor: identity, launch_identity_digest: launch.launch_identity_digest,
    native_terminal_digest: sha("controlled original terminal"), retained_history_digest: sha("controlled old-store inventory"),
    incarnations: [{ generation: 0, identity: { ...identity, pid: 101 }, root_wait_observed: true, exit_code: 0,
      stdout_eof: true, stderr_eof: true, input_settled: true, atomic_job_member: true }],
    normal_daemon_shutdown: true, graceful_stop_armed: true, graceful_stop_timed_out: false, job_empty_observed: true, forced_job_termination: false,
    parent: { spawned: true, exited: true, closed: true, stdout_eof: true, stderr_eof: true, exit_code: 0, close_code: 0,
      signal: null, close_signal: null, inputs_unchanged: true } };
  const successorObserver = randomUUID(), grant = SourceCleanRestartGrantV1Schema.parse({ version: 1, lineage_id: lineage,
    predecessor_generation_id: generation, generation_id: randomUUID(), claimant_observer_id: successorObserver, revision: 3,
    stable: launch.stable, predecessor_history_digest: closure.retained_history_digest,
    predecessor: { version: 1, stop_id: intent.stop_id, lineage_id: lineage, generation_id: generation,
      intent_digest: sourceCleanDigestV1(intent, sha), closure_digest: sourceCleanDigestV1(closure, sha), committed_event_id: "original-closure-event" },
    origin: old.request.origin, goal_id: old.request.goal_id, plan_id: old.request.plan_id, authorization: intent.authorization, scope: "unverified-h7-recovery" });
  const registration = { ...old.registration, registration_id: randomUUID(), binding: { ...old.registration.binding,
    guardian_instance_id: randomUUID(), store_identity_digest: sha("fresh generation store") },
    epoch: { ...old.registration.epoch, epoch_id: randomUUID(), generation: 0, session_id: "fresh-supervisor-daemon-session" } };
  const checkpoint = SourceCleanRestartCheckpointV1Schema.parse({ version: 1, lineage_id: lineage, generation_id: grant.generation_id,
    grant_digest: sourceCleanDigestV1(grant, sha), lifecycle_registration: { version: 1, registration, successor_grant_digest: sourceCleanDigestV1(grant, sha),
      launch: { ...launch, observer_id: successorObserver, supervisor: { ...identity, pid: 200, creationTime: "2000" }, launch_identity_digest: sha("fresh actual launch") } },
    predecessor_history_digest: grant.predecessor_history_digest, subject_digest: old.checkpoint.subject_digest,
    baseline: old.checkpoint.baseline, accepted_inputs: old.checkpoint.accepted_inputs, source_state: "unverified" });
  return { intent, closure, grant, checkpoint };
}
describe("whole-supervisor clean restart contracts (controlled wire objects only)", () => {
  it.each(["prepared", "claimed"] as const)("preserves complete %s replies at the UTF-8 byte limit and rejects one extra byte", kind => {
    const f = fixture(), payload = kind === "prepared" ? f.intent : f.grant;
    const type = kind === "prepared" ? "node.source-clean-stop.prepared.v1" : "node.source-clean-restart.claimed.v1";
    const frame = { version: 1, type, request_id: randomUUID(), sequence: 2147483647, observer_id: randomUUID(), payload };
    // Include multibyte and JSON-escaped characters; a character count cannot
    // stand in for the actual encoded transport budget.
    const task = payload.origin.execution_request.run_start.context_pack.payload.task;
    task.description = "中文\n\"\\\u0000";
    const baseBytes = Buffer.byteLength(JSON.stringify(SourceLifecycleServerMessageV1Schema.parse(frame)), "utf8");
    expect(baseBytes).toBeLessThan(SOURCE_LIFECYCLE_REPLY_MAX_BYTES_V1);
    task.description += "x".repeat(SOURCE_LIFECYCLE_REPLY_MAX_BYTES_V1 - baseBytes);
    const encoded = encodeSourceLifecycleServerMessageV1(frame);
    expect(Buffer.byteLength(encoded, "utf8")).toBe(SOURCE_LIFECYCLE_REPLY_MAX_BYTES_V1);
    expect(JSON.parse(encoded).payload).toEqual(payload);
    expect(() => assertSourceLifecyclePayloadReplyFitsV1(type, payload)).not.toThrow();
    expect(() => assertSourceLifecyclePayloadReplyFitsV1(type, payload, SOURCE_LIFECYCLE_REPLY_MAX_BYTES_V1 - 1)).toThrow("retained reply budget");
    task.description += "x";
    expect(() => encodeSourceLifecycleServerMessageV1(frame)).toThrow("1 MiB UTF-8 byte limit");
    expect(() => assertSourceLifecyclePayloadReplyFitsV1(type, payload)).toThrow("1 MiB UTF-8 byte limit");
  });
  it("keeps small control replies below their reserved capacity even with maximum JSON escaping", () => {
    const f = fixture(), header = { version: 1, request_id: randomUUID(), sequence: 2147483647, observer_id: randomUUID() };
    const replies = [
      { ...header, type: "node.source-lifecycle.error.v1", message: "\u0000".repeat(500) },
      { ...header, type: "node.source-clean-stop.committed.v1", payload: { ...f.grant.predecessor, committed_event_id: "\u0000".repeat(128) } },
      { ...header, type: "node.source-lifecycle.bound.v1", payload: { version: 1, observer_id: randomUUID(), launch_digest: sha("launch") } },
    ];
    for (const reply of replies) expect(Buffer.byteLength(encodeSourceLifecycleServerMessageV1(reply), "utf8"))
      .toBeLessThan(SOURCE_LIFECYCLE_CONTROL_REPLY_RESERVE_BYTES_V1);
    expect(SOURCE_LIFECYCLE_REQUEST_MAX_BYTES_V1).toBe(65536);
    for (const budget of [-1, 0.5, Number.NaN, SOURCE_LIFECYCLE_REPLY_MAX_BYTES_V1 + 1])
      expect(() => assertSourceLifecyclePayloadReplyFitsV1("node.source-clean-stop.prepared.v1", f.intent, budget)).toThrow("Invalid clean lifecycle reply budget");
  });
  it("keeps explicit local consent and fresh source unverified across a distinct store generation", () => {
    const f = fixture(); expect(f.intent.authorization.consent_id).toBeNull();
    expect(inspectSourceCleanClosureV1(f.intent, f.closure, sha)).toMatchObject({ kind: "whole-supervisor-job-closed.v1" });
    expect(inspectSourceCleanCheckpointV1(f.grant, f.checkpoint, sha).source_state).toBe("unverified");
  });
  it.each(["stop", "observer", "launch", "parent EOF", "job", "input", "roster"] as const)("rejects changed or incomplete %s closure", change => {
    const f = fixture(), value = structuredClone(f.closure);
    if (change === "stop") value.stop_id = randomUUID();
    else if (change === "observer") value.observer_id = randomUUID();
    else if (change === "launch") value.launch_identity_digest = sha("different launch");
    else if (change === "parent EOF") value.parent.stderr_eof = false;
    else if (change === "job") value.job_empty_observed = false;
    else if (change === "input") value.incarnations[0]!.input_settled = false;
    else value.incarnations[0]!.generation = 1;
    expect(() => inspectSourceCleanClosureV1(f.intent, value, sha)).toThrow();
  });
  it.each(["history", "old store", "source", "accepted inputs", "claimant", "verification"] as const)("rejects a checkpoint that changes %s", change => {
    const f = fixture(), value = structuredClone(f.checkpoint);
    if (change === "history") value.predecessor_history_digest = sha("new launcher substituted history");
    else if (change === "old store") value.lifecycle_registration.registration.binding.store_identity_digest = f.grant.stable.genesis_store_identity_digest;
    else if (change === "source") value.subject_digest = sha("unmeasured source");
    else if (change === "accepted inputs") value.accepted_inputs.files[0]!.checksum = sha("changed accepted input");
    else if (change === "claimant") value.lifecycle_registration.launch.observer_id = randomUUID();
    else Object.assign(value, { verification: { outcome: "passed" } });
    expect(() => inspectSourceCleanCheckpointV1(f.grant, value, sha)).toThrow();
  });
});
