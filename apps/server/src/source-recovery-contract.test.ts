import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ProductSourceRecoveryRegistrationV1Schema, ProductSourceRecoveryRequestV1Schema, ProductSourceRecoveryCheckpointV1Schema,
  ProductSourceRecoveryResultV1Schema, RecoveryOperationRefV1Schema, inspectProductSourceRecoveryResultV1,
  productSourceRecoveryRegistrationDigestV1, productSourceRecoveryRequestDigestV1, type ProductSourceRecoveryRequestV1,
  importedExecutionAcceptedInputsV1, canonicalProductSourceTransferValueV1 as canonical,
  ImportedRecoveryValidationRequestV1Schema, importedRecoveryValidationContextV1, importedRecoveryValidationRequestDigestV1,
  ImportedRecoveryValidationVerificationEnvelopeV1Schema, inspectImportedRecoveryValidationVerificationEnvelopeV1,
  importedRecoveryValidationVerificationEchoV1, inspectProductSourceRecoveryRequestV1 } from "@artoo/domain";
import { importedValidationRequestFixture } from "../../artood/src/test-fixtures/imported-validation-request.js";

const sha = (value: string | Uint8Array) => "sha256:" + createHash("sha256").update(value).digest("hex");
const oldEpoch = "a47d69f7-00d2-49da-8c80-f7cf51e12427", newEpoch = "46f0b9fc-a7df-40e9-aeb4-f6e1d14a2745";
function fixture() {
  const original = importedValidationRequestFixture(), origin = original.request.origin;
  const destination = origin.execution_request.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination;
  const registration = ProductSourceRecoveryRegistrationV1Schema.parse({ version: 1, registration_id: "f3d561c4-46cf-40b9-ac77-93404c7c0a0a",
    binding: { version: 1, node_id: destination.node_id, device_id: "device-b", guardian_instance_id: "f59fc26d-c852-4aeb-bf2b-b38246336826",
      store_identity_digest: sha("store"), configuration_digest: sha("config"), workspace_root: origin.execution_request.run_start.workspace.root, workspace_identity_digest: sha("physical workspace") },
    epoch: { version: 1, epoch_id: oldEpoch, generation: 0, session_id: "old-authenticated-session", roster_revision: 2, roster_digest: sha("complete native roster") } });
  const request = ProductSourceRecoveryRequestV1Schema.parse({ version: 1, recovery_id: "recovery-one", registration_id: registration.registration_id,
    origin_review_id: origin.review_id, origin, goal_id: origin.execution_request.run_start.context_pack.payload.goal_context!.goal_id,
    plan_id: origin.execution_request.run_start.context_pack.payload.goal_context!.plan!.id, binding: registration.binding,
    previous_epoch: registration.epoch, current_session_id: "new-authenticated-session", new_daemon_identity_digest: sha("exact new daemon"),
    challenge_id: "f9f06d6b-343e-4653-a630-015bb5e6d354",
    operations: [{ kind: "validation", operation_id: "old-validation", request_digest: sha("old author request"), run_id: "actual-old-run" },
      { kind: "validation_review", operation_id: "old-review", request_digest: sha("old review request") }],
    authorization: { event_id: "new-authorization", actor_user_id: "initiating-user", consent_id: "current-consent", policy_version: "original-policy" } });
  const directories = [".artoo/product", "product"], files = [{ path: "product/index.html", checksum: sha("actual fixture bytes"), size: 20, reference: "protected-file-reference" }];
  const subject = sha("unverified current source"), checkpoint = ProductSourceRecoveryCheckpointV1Schema.parse({ version: 1, recovery_id: request.recovery_id,
    request_digest: productSourceRecoveryRequestDigestV1(request, sha), binding: request.binding, old_epoch_id: oldEpoch, new_epoch_id: newEpoch, generation: 1,
    current_session_id: request.current_session_id, new_daemon_identity_digest: request.new_daemon_identity_digest, challenge_id: request.challenge_id,
    roster_revision: request.previous_epoch.roster_revision, roster_digest: request.previous_epoch.roster_digest, closure_set_digest: sha("native closure set"),
    operations: request.operations, subject_digest: subject, baseline: { version: 1, snapshot_id: "fresh-baseline", subject_digest: subject,
      manifest_digest: sha(canonical({ directories, files })), directories, files }, accepted_inputs: importedExecutionAcceptedInputsV1(origin.execution_request), source_state: "unverified" });
  const result = ProductSourceRecoveryResultV1Schema.parse({ version: 1, recovery_id: request.recovery_id, request_digest: checkpoint.request_digest,
    outcome: "recovered", closed: true, checkpoint });
  return { registration, request, checkpoint, result, original };
}

function authorFixture() {
  const f = fixture(), start = structuredClone(f.original.request.run_start);
  start.run_id = "new-recovery-author-run"; start.context_pack.id = "new-recovery-author-context"; start.verification.request_id = "new-recovery-final-verifier";
  delete start.context_pack.payload.imported_validation;
  const fields = { validation_id: "new-recovery-author", root_validation_id: "new-recovery-author", generation: 0, kind: "initial" as const,
    recovery_id: f.request.recovery_id, checkpoint: f.checkpoint, origin: f.request.origin,
    authorization: { event_id: "new-recovery-author-authorization", goal_id: f.request.goal_id, attempt_index: 1 } };
  start.context_pack.payload.imported_recovery_validation = importedRecoveryValidationContextV1(fields, sha);
  const request = ImportedRecoveryValidationRequestV1Schema.parse({ version: 1, ...fields, writer: f.original.request.writer, run_start: start });
  const envelope = ImportedRecoveryValidationVerificationEnvelopeV1Schema.parse({ version: 1, request, request_digest: importedRecoveryValidationRequestDigestV1(request, sha),
    run_id: start.run_id, verification_request_id: start.verification.request_id, subject_digest: sha("controlled new final subject"), scope: "final" });
  return { ...f, authorRequest: request, envelope };
}

describe("H9 recovery wire projections (controlled contracts, no native authority)", () => {
  it("binds a fresh unverified checkpoint and never adds verifier or review authority", () => {
    const { request, result } = fixture();
    expect(inspectProductSourceRecoveryResultV1(request, result, sha)).toEqual(result);
    expect(ProductSourceRecoveryCheckpointV1Schema.safeParse({ ...fixture().checkpoint, verification: { outcome: "passed" } }).success).toBe(false);
    expect(ProductSourceRecoveryCheckpointV1Schema.safeParse({ ...fixture().checkpoint, source_state: "verified" }).success).toBe(false);
  });
  it("keeps unknown closure fenced and excludes checkpoints from unknown results", () => {
    const { request, checkpoint } = fixture();
    const unknown = { version: 1, recovery_id: request.recovery_id, request_digest: checkpoint.request_digest, outcome: "unknown", closed: false, reason: "Guardian vanished" };
    expect(inspectProductSourceRecoveryResultV1(request, unknown, sha)).toEqual(unknown);
    expect(ProductSourceRecoveryResultV1Schema.safeParse({ ...unknown, checkpoint }).success).toBe(false);
    expect(ProductSourceRecoveryResultV1Schema.safeParse({ ...unknown, closed: true }).success).toBe(false);
  });
  it.each(["current_session_id", "new_daemon_identity_digest", "challenge_id", "roster_digest", "old_epoch_id"] as const)("rejects result drift of %s", field => {
    const { request, result } = fixture(); if (result.outcome !== "recovered") throw Error("Fixture result");
    result.checkpoint[field] = field === "challenge_id" || field === "old_epoch_id" ? "1ff49bb3-d9e0-4e39-9b6e-cfbe6d5b0ee8" : field.endsWith("digest") ? sha("foreign") : "foreign-session";
    expect(() => inspectProductSourceRecoveryResultV1(request, result, sha)).toThrow();
  });
  it.each(["generation", "roster_revision"] as const)("rejects result drift of %s", field => {
    const { request, result } = fixture(); if (result.outcome !== "recovered") throw Error("Fixture result");
    result.checkpoint[field]++;
    expect(() => inspectProductSourceRecoveryResultV1(request, result, sha)).toThrow();
  });
  it("rejects a changed manifest, omitted old operation and switched physical binding", () => {
    for (const mutate of [
      (result: ReturnType<typeof fixture>["checkpoint"]) => result.baseline.files[0]!.checksum = sha("other bytes"),
      (result: ReturnType<typeof fixture>["checkpoint"]) => result.operations.pop(),
      (result: ReturnType<typeof fixture>["checkpoint"]) => result.binding.workspace_identity_digest = sha("other physical workspace"),
    ]) {
      const { request, result } = fixture(); if (result.outcome !== "recovered") throw Error("Fixture result"); mutate(result.checkpoint);
      expect(() => inspectProductSourceRecoveryResultV1(request, result, sha)).toThrow();
    }
  });
  it("requires different authenticated sessions and non-repeated epochs", () => {
    const { request, checkpoint } = fixture();
    expect(ProductSourceRecoveryRequestV1Schema.safeParse({ ...request, current_session_id: request.previous_epoch.session_id }).success).toBe(false);
    expect(ProductSourceRecoveryCheckpointV1Schema.safeParse({ ...checkpoint, new_epoch_id: checkpoint.old_epoch_id }).success).toBe(false);
  });
  it("keeps dedicated review and release identifiers out of the ordinary run namespace", () => {
    const base = { operation_id: "operation", request_digest: sha("request") };
    expect(RecoveryOperationRefV1Schema.safeParse({ ...base, kind: "validation" }).success).toBe(false);
    for (const kind of ["validation_review", "release"]) expect(RecoveryOperationRefV1Schema.safeParse({ ...base, kind, run_id: "invented-run" }).success).toBe(false);
  });
  it("rejects duplicate or reordered operation refs and authority-shaped extra fields", () => {
    const { request, registration } = fixture();
    expect(ProductSourceRecoveryRequestV1Schema.safeParse({ ...request, operations: [...request.operations].reverse() }).success).toBe(false);
    expect(ProductSourceRecoveryRequestV1Schema.safeParse({ ...request, operations: [request.operations[0], request.operations[0]] }).success).toBe(false);
    expect(ProductSourceRecoveryRegistrationV1Schema.safeParse({ ...registration, process_handle: "serialized HANDLE" }).success).toBe(false);
  });
  it("binds registration and request digests to every field", () => {
    const { request, registration } = fixture();
    expect(productSourceRecoveryRegistrationDigestV1(registration, sha)).not.toBe(productSourceRecoveryRegistrationDigestV1({ ...registration, epoch: { ...registration.epoch, generation: 1 } }, sha));
    const other: ProductSourceRecoveryRequestV1 = { ...request, authorization: { ...request.authorization, consent_id: "different-consent" } };
    expect(productSourceRecoveryRequestDigestV1(request, sha)).not.toBe(productSourceRecoveryRequestDigestV1(other, sha));
  });
  it("recovery request carries the original accepted source before any H7 author exists", () => {
    const f = fixture();
    expect(inspectProductSourceRecoveryRequestV1(f.request, f.original.bytes, sha)).toEqual(f.request);
    expect(() => inspectProductSourceRecoveryRequestV1({ ...f.request, origin_review_id: "foreign-h6" }, f.original.bytes, sha)).toThrow();
    expect(() => inspectProductSourceRecoveryRequestV1(f.request, new TextEncoder().encode("changed accepted research"), sha)).toThrow();
  });
  it("fresh verifier binds original research/design bytes, current checkpoint and protected command", () => {
    const f = authorFixture(), originalVerification = f.authorRequest.origin.execution_request.run_start.verification;
    expect(originalVerification).toBeDefined();
    if (!originalVerification) throw Error("Original accepted execution fixture must retain its verification request");
    const commandId = originalVerification.profile_id;
    const allowed = f.authorRequest.run_start.verification.capability_binding!.checks[0]!.command_id;
    const inspected = inspectImportedRecoveryValidationVerificationEnvelopeV1(f.envelope, f.original.bytes, f.original.designBytes, sha);
    expect(inspected.envelope).toEqual(f.envelope); expect(inspected.research.measurement_plan).toBeDefined();
    expect(importedRecoveryValidationVerificationEchoV1(f.envelope, allowed, sha)).toMatchObject({ recovery_id: f.request.recovery_id,
      epoch_id: f.checkpoint.new_epoch_id, validation_id: f.authorRequest.validation_id, verification_request_id: f.authorRequest.run_start.verification.request_id });
    expect(() => importedRecoveryValidationVerificationEchoV1(f.envelope, "foreign-command:" + commandId, sha)).toThrow();
    expect(() => inspectImportedRecoveryValidationVerificationEnvelopeV1(f.envelope, f.original.bytes, new TextEncoder().encode("changed design"), sha)).toThrow();
  });
  it("author preview cannot borrow final verifier identity or an old H7 request", () => {
    const f = authorFixture();
    expect(ImportedRecoveryValidationVerificationEnvelopeV1Schema.safeParse({ ...f.envelope, scope: "preview" }).success).toBe(false);
    expect(() => inspectImportedRecoveryValidationVerificationEnvelopeV1({ ...f.envelope, request_digest: sha("unbound") }, f.original.bytes, f.original.designBytes, sha)).toThrow();
    expect(ImportedRecoveryValidationVerificationEnvelopeV1Schema.safeParse({ ...f.envelope, request: f.original.request }).success).toBe(false);
    const preview = { ...f.envelope, scope: "preview", verification_request_id: "new-recovery-preview-verifier" };
    expect(inspectImportedRecoveryValidationVerificationEnvelopeV1(preview, f.original.bytes, f.original.designBytes, sha).envelope.scope).toBe("preview");
  });
});
