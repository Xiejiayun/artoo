import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { OwnedWorktreeVerificationTemplateSchema, verifyOwnedWorktreeResult,
  type PreparedOwnedWorktreeVerificationTemplate, type VerifyOwnedWorktreeResultInput } from "./owned-worktree-verification.js";
import { executeOwnedResultVerificationTarget, OwnedResultVerificationCleanupError, worktreeResultFailureIsUncertain } from "./owned/worktree-results.js";
import { authenticateOwnedVerificationCandidate } from "./owned-worktree-verification.js";
import { authenticateSealedOwnedVerificationReceipt, OwnedResultVerificationPersistenceError } from "./owned/worktree-results.js";
import { OwnedVerificationIntentSchema, OwnedVerificationExecutionSchema, OwnedWorktreeVerificationEvidenceSchema,
  assertOwnedVerificationEvidenceBindings, ownedVerificationDigest, type SealedOwnedVerificationReceipt } from "./owned/worktree-verification-contract.js";

const root = resolve(tmpdir(), "artoo-worktree-verification-unit");
const profile = () => ({ version: 1, id: "local", node_id: "node_1", project_id: "project_1", results_profile_id: "results_1",
  results_profile_digest: `sha256:${"a".repeat(64)}`, repository_root: join(root, "repo"), allocation_base: join(root, "checks"),
  commands: [{ id: "check", argv: [join(root, "node"), join(root, "verify.mjs")], timeout_ms: 1000 }],
  subject_paths: ["src"], required_files: ["src/index.js"] });

describe("owned worktree verification contracts (no process/Git execution)", () => {
  it("keeps protected program selection separate from ordinary capability and release contracts", () => {
    expect(OwnedWorktreeVerificationTemplateSchema.parse(profile())).toEqual(profile());
    for (const change of [{ version: 2 }, { results_profile_digest: "unknown" }, { workspace_root: root }, { allocation_base: "relative" },
      { measurement_plan_policy: { version: 1 } }, { capabilities: { version: 1 } }, { release_profile_id: "release" },
      { commands: [{ ...profile().commands[0], observation: { format: "static-web-acceptance.v1" } }] },
      { subject_paths: ["../outside"] }, { subject_paths: [".git/config"] }]) {
      expect(OwnedWorktreeVerificationTemplateSchema.safeParse({ ...profile(), ...change }).success).toBe(false);
    }
  });
  it("rejects serialized template metadata and target tokens before executing any supplied callback", async () => {
    await expect(verifyOwnedWorktreeResult({ version: 1, id: "local", digest: `sha256:${"b".repeat(64)}` } as PreparedOwnedWorktreeVerificationTemplate,
      {} as VerifyOwnedWorktreeResultInput)).rejects.toThrow("genuine locally prepared template");
    await expect(executeOwnedResultVerificationTarget({ version: 1, kind: "owned-result-verification-target" },
      async () => { throw new Error("must not execute"); })).rejects.toThrow("fresh genuine verification-only");
  });
  it("classifies explicit verifier cleanup uncertainty without inferring authority from JSON", () => {
    const failure = new OwnedResultVerificationCleanupError("controlled uncertainty classification only");
    expect(worktreeResultFailureIsUncertain(failure)).toBe(true);
    expect(worktreeResultFailureIsUncertain(new Error("outer", { cause: failure }))).toBe(true);
    expect(worktreeResultFailureIsUncertain({ name: "OwnedResultVerificationCleanupError" })).toBe(false);
  });
});

describe("durable owned verification binding contracts (synthetic data, no authority or subprocess)", () => {
  const hash = (character: string) => `sha256:${character.repeat(64)}`;
  function records() {
    const intent = OwnedVerificationIntentSchema.parse({ version: 1, kind: "owned-result-verification.v1",
      request_id: "verification_1", materialization_request_id: "allocation_1",
      template: { id: "verifier", digest: hash("a"), node_id: "node_1", project_id: "project_1" },
      result: { reference: { result_id: "result_1", receipt_digest: hash("b") }, profile_id: "results", profile_digest: hash("c") },
      workspace: { root: join(root, "actual-worktree"), branch: "fixture/verified" }, context_digest: ownedVerificationDigest(null) });
    const execution = OwnedVerificationExecutionSchema.parse({ version: 1, request_id: intent.request_id,
      profile_id: "verifier", profile_digest: hash("d"), workspace_root: intent.workspace.root,
      subject_digest: hash("e"), context_digest: intent.context_digest });
    const evidence = OwnedWorktreeVerificationEvidenceSchema.parse({ version: 1, template: intent.template,
      result: { ...intent.result, repository_binding: hash("f"), commit: "a".repeat(40), tree: "b".repeat(40), manifest_digest: hash("0") },
      workspace: intent.workspace, verification: { version: 1, request_id: intent.request_id, profile_id: execution.profile_id,
        profile_digest: execution.profile_digest, subject_digest: execution.subject_digest, outcome: "passed",
        checks: [{ id: "check", exit_code: 0, duration_ms: 1, output_digest: hash("1") }], required_files: [] },
      scope: "node-local exact-result command verification; not independent review, integration acceptance or publication" });
    return { intent, execution, evidence };
  }
  it("keeps context, materialization, immutable result and actual root in the intent identity", () => {
    const { intent } = records(), original = ownedVerificationDigest(intent);
    for (const changed of [{ ...intent, context_digest: hash("2") }, { ...intent, materialization_request_id: "other" },
      { ...intent, result: { ...intent.result, reference: { ...intent.result.reference, result_id: "other" } } },
      { ...intent, workspace: { ...intent.workspace, root: join(root, "another-worktree") } }]) {
      expect(ownedVerificationDigest(changed)).not.toBe(original);
    }
    expect(OwnedVerificationIntentSchema.safeParse({ ...intent, argv: ["remote"] }).success).toBe(false);
  });
  it("rejects digest substitutions across template, physical profile, subject and result", () => {
    const { intent, execution, evidence } = records();
    expect(() => assertOwnedVerificationEvidenceBindings(intent, execution, evidence)).not.toThrow();
    for (const changed of [
      { ...execution, profile_digest: intent.template.digest }, { ...execution, context_digest: hash("2") },
      { ...execution, subject_digest: evidence.result.manifest_digest }, { ...execution, workspace_root: join(root, "other") },
    ]) expect(() => assertOwnedVerificationEvidenceBindings(intent, changed, evidence)).toThrow("bindings differ");
  });
  it("valid JSON cannot manufacture either a local verifier candidate or a recovered receipt", () => {
    const { intent, execution, evidence } = records();
    expect(() => authenticateOwnedVerificationCandidate(evidence, { version: 1, kind: "owned-result-verification-target" }, intent, execution))
      .toThrow("node-issued verification candidate");
    expect(() => authenticateSealedOwnedVerificationReceipt({ receipt: { intent } } as SealedOwnedVerificationReceipt, intent))
      .toThrow("original authenticated verification receipt");
  });
  it("keeps unknown durable commit fenced without treating JSON as that error", () => {
    const error = new OwnedResultVerificationPersistenceError("controlled storage classification only");
    expect(worktreeResultFailureIsUncertain(error)).toBe(true);
    expect(worktreeResultFailureIsUncertain(new Error("outer", { cause: error }))).toBe(true);
    expect(worktreeResultFailureIsUncertain({ name: "OwnedResultVerificationPersistenceError" })).toBe(false);
  });
});
