// Actual contract/private-context inspectors with controlled native authority and directory identity.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { importedRecoveryValidationRequestDigestV1, importedRecoveryValidationReviewRequestDigestV1 } from "@artoo/domain";
import { importedRecoveryValidationRequestFixture, controlledRecoveryValidationResult, controlledRecoveryValidationSource, recoveryValidationReviewFixture, recoveryValidationFixtureSha as sha } from "./test-fixtures/imported-recovery-validation-request.js";
import type { PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
const native = vi.hoisted(() => ({ backends: new WeakSet<object>(), ino: 2 }));
vi.mock("./owned/windows-owned-process.js", () => ({ assertWindowsProcessBackend: (value: object) => {
  if (!native.backends.has(value)) throw Error("Controlled unprepared backend");
} }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, lstatSync: () => ({ dev: 1, ino: native.ino, isDirectory: () => true, isSymbolicLink: () => false }),
    realpathSync: Object.assign((path: string) => path, { native: (path: string) => path }) };
});
import { bindImportedRecoveryValidationVerifierContext, bindImportedRecoveryValidationReviewVerifierContext, readImportedRecoveryValidationVerifierResearch as read,
  recheckImportedRecoveryValidationVerifierContext as recheck } from "./imported-recovery-validation-verifier-context.js";
beforeEach(() => { native.ino = 2; });
function fixture(phase: "before" | "after" | "preview" | "final" = "before") {
  const f = importedRecoveryValidationRequestFixture(), source = controlledRecoveryValidationSource(f.request, controlledRecoveryValidationResult(f.request)), review = recoveryValidationReviewFixture(f.request, source);
  const isReview = phase === "before" || phase === "after", start = phase === "before" ? review.before_start : phase === "after" ? review.after_start : f.request.run_start;
  const destination = f.request.origin.execution_request.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination;
  const check = destination.capabilities.checks[0]!, scope = isReview ? "final" : phase;
  const envelope: Record<string, unknown> = { version: 1, request: isReview ? review : f.request,
    request_digest: isReview ? importedRecoveryValidationReviewRequestDigestV1(review, sha) : importedRecoveryValidationRequestDigestV1(f.request, sha), run_id: start.run_id,
    verification_request_id: phase === "preview" ? "preview-diagnostics" : start.verification.request_id,
    subject_digest: isReview ? source.subject_digest : sha("author-current-subject"), ...(isReview ? { phase } : { scope }) };
  const backend = Object.freeze({}) as PreparedWindowsProcessBackend; native.backends.add(backend);
  const input: Parameters<typeof bindImportedRecoveryValidationVerifierContext>[0] = { envelope, root: start.workspace.root, context: start.context_pack.payload,
    researchBytes: f.bytes, designBytes: f.designBytes, requestId: envelope.verification_request_id as string, scope,
    profileId: destination.profile_id, profileDigest: destination.capabilities.profile_digest, subjectDigest: envelope.subject_digest,
    binding: { version: 1, profile_digest: destination.capabilities.profile_digest, command_id: check.command_id, config_digest: check.config_digest, contract_digest: check.contract_digest },
    options: { windows_browser_process: { version: 1 }, design_capture_cases: true, browser_program: { version: 3, viewports: [{ id: "compact", width: 390, height: 844 }] } }, backend };
  return { input, envelope, bind: isReview ? bindImportedRecoveryValidationReviewVerifierContext : bindImportedRecoveryValidationVerifierContext };
}
describe("H9 dedicated private verifier child binding", () => {
  it.each(["before", "after", "preview", "final"] as const)("binds exact %s and cannot lend the mapping to cloned contexts", phase => {
    const f = fixture(phase), echo = f.bind(f.input);
    expect(echo).toMatchObject({ stage: "validation", run_id: f.envelope.run_id, verification_request_id: f.input.requestId });
    expect(read(f.input.root, f.input.context, f.input.researchBytes)!.measurement_plan!.profile_digest).toBe(f.input.profileDigest);
    expect(read(f.input.root, structuredClone(f.input.context), f.input.researchBytes)).toBeUndefined();
    expect(recheck(f.input.root, f.input.context, f.input.researchBytes, f.input.designBytes)).toEqual(echo);
    expect(() => f.bind(f.input)).toThrow("already bound");
  });
  it.each(["run", "phase", "subject", "profile", "command", "context", "research", "design", "backend", "all-cases", "checkpoint", "epoch", "old-validation"])("rejects mismatched %s", change => {
    const f = fixture();
    if (change === "run") f.envelope.run_id = "other";
    if (change === "phase") f.envelope.phase = "after";
    if (change === "subject") f.input.subjectDigest = sha("other");
    if (change === "profile") f.input.profileDigest = sha("other");
    if (change === "command") f.input.binding.command_id = "other";
    if (change === "context") f.input.context = { ...f.input.context, task: { ...f.input.context.task, title: "other" } };
    if (change === "research") f.input.researchBytes = Buffer.from("other");
    if (change === "design") f.input.designBytes = Buffer.from("other");
    if (change === "backend") f.input.backend = {} as PreparedWindowsProcessBackend;
    if (change === "all-cases") f.input.options.design_capture_cases = false;
    if (change === "checkpoint") f.input.context.imported_recovery_validation_review_subject!.checkpoint_digest = sha("other-checkpoint");
    if (change === "epoch") f.input.context.imported_recovery_validation_review_subject!.epoch_id = "00000000-0000-4000-8000-000000000099";
    if (change === "old-validation") f.input.context.imported_validation_review_subject = { ...f.input.context.imported_recovery_validation_review_subject! } as never;
    expect(() => f.bind(f.input)).toThrow();
  });
  it("rechecks physical directory, original backend and accepted bytes after binding", () => {
    const f = fixture(); f.bind(f.input); native.ino++;
    expect(() => recheck(f.input.root, f.input.context, f.input.researchBytes, f.input.designBytes)).toThrow(); native.ino--;
    native.backends.delete(f.input.backend); expect(() => recheck(f.input.root, f.input.context, f.input.researchBytes, f.input.designBytes)).toThrow();
    native.backends.add(f.input.backend); expect(() => recheck(f.input.root, f.input.context, f.input.researchBytes, Buffer.from("other"))).toThrow();
  });
});
