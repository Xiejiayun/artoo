import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RunVerificationPayloadSchema } from "./autonomy.js";
import { NodeOwnedResultProfileDescriptorV1Schema, NodeOwnedResultProfileDescriptorsV1Schema,
  OwnedResultRequirementV1Schema, NodeOwnedResultVerificationEvidenceV1Schema,
  OwnedResultCommandVerificationV1Schema, projectOwnedResultCommandVerificationV1,
  OWNED_RESULT_NO_VERIFICATION_CONTEXT_DIGEST, canonicalOwnedResultRequirementV1, canonicalOwnedResultAuthorContextV1,
  canonicalOwnedResultVerificationIntentV1, ownedResultVerificationIntentV1, assertOwnedResultEvidenceMatchesExpectedV1 } from "./worktree-result.js";

const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

// Every object below is synthetic contract data. Passing these parsers is not
// node authentication, a verifier process receipt or a product acceptance run.
function fixture() {
  const authorContext = { task: { id: "task_1", title: "Task", description: "Author the requested change", acceptance_criteria: ["Checks pass"] },
    project: { id: "project_1", name: "Project", default_workspace: null }, workspace: { root: "/fixture/authors/one", file_scope: ["src", "tests"] },
    policy: { filesystem_write_scope: ["src", "tests"], requires_approval: [] }, memory: { task_summary: null, project_notes: [] },
    artifacts: { expected: [] } };
  const descriptor = NodeOwnedResultProfileDescriptorV1Schema.parse({ version: 1, node_id: "node_1", project_id: "project_1",
    result_profile: { id: "results", digest: sha("protected result profile"), repository_binding: sha("repository binding"), baseline_commit: "a".repeat(40) },
    verifier_template: { id: "verifier", digest: sha("protected verifier template") }, workspace_strategy: "per-run",
    verification_mode: "plain-commands", verification_context_policy: { version: 1, mode: "none" }, content_paths: ["src", "tests"],
    scope: "authored-result command verification; no product-stage, review or publication acceptance" });
  const requirement = OwnedResultRequirementV1Schema.parse({ version: 1, request_id: "verify_1", capture_request_id: "capture_1",
    verification_materialization_request_id: "verify_allocation_1", profile: descriptor,
    author_context_digest: sha(canonicalOwnedResultAuthorContextV1(authorContext)), input: { kind: "baseline" } });
  const author = { run_id: "run_1", task_id: "task_1", agent_instance_id: "agent_1", runtime: "codex",
    launch_binding_digest: sha("frozen allocated run.start"), author_context_digest: requirement.author_context_digest,
    workspace: { root: "/fixture/authors/one", branch: "fixture/author-one" } };
  const payload = OwnedResultCommandVerificationV1Schema.parse({ version: 1, request_id: requirement.request_id,
    profile_id: descriptor.verifier_template.id, profile_digest: sha("physical verification profile at root one"), subject_digest: sha("measured subject"),
    outcome: "passed", checks: [{ id: "check", exit_code: 0, duration_ms: 10, output_digest: sha("bounded actual output") }],
    required_files: [{ path: "src/index.ts", checksum: sha("source bytes"), size: 12 }] });
  const evidence = NodeOwnedResultVerificationEvidenceV1Schema.parse({ version: 1, kind: "authored-result-verification", requirement,
    requirement_digest: sha(canonicalOwnedResultRequirementV1(requirement)), author,
    template: { ...descriptor.verifier_template, node_id: descriptor.node_id, project_id: descriptor.project_id },
    result: { kind: "authored", reference: { result_id: requirement.capture_request_id, receipt_digest: sha("capture receipt") },
      profile_id: descriptor.result_profile.id, profile_digest: descriptor.result_profile.digest,
      repository_binding: descriptor.result_profile.repository_binding, base_commit: descriptor.result_profile.baseline_commit,
      commit: "b".repeat(40), tree: "c".repeat(40), manifest_digest: sha("scoped mode and empty directory manifest"), inputs: [] },
    verification: { receipt: { verification_id: requirement.request_id, receipt_digest: sha("complete private durable receipt") },
      intent_digest: sha("placeholder before canonical mapping"), workspace: { root: "/fixture/verifiers/one", branch: "fixture/verifier-one" },
      execution: { version: 1, request_id: requirement.request_id, profile_id: payload.profile_id, profile_digest: payload.profile_digest,
        workspace_root: "/fixture/verifiers/one", subject_digest: payload.subject_digest, context_digest: OWNED_RESULT_NO_VERIFICATION_CONTEXT_DIGEST }, payload },
    scope: "historical plain-command node evidence; no product-stage, independent review or publication acceptance" });
  evidence.verification.intent_digest = sha(canonicalOwnedResultVerificationIntentV1(evidence));
  return { descriptor, requirement, author, authorContext, payload, evidence };
}

describe("public owned result v1 contracts (standalone, not installed on wire)", () => {
  it("represents one fixed authored/plain-command selection and coherent public evidence", () => {
    const f = fixture();
    expect(OwnedResultRequirementV1Schema.parse(f.requirement)).toEqual(f.requirement);
    expect(NodeOwnedResultVerificationEvidenceV1Schema.parse(f.evidence)).toEqual(f.evidence);
    expect(assertOwnedResultEvidenceMatchesExpectedV1(f.evidence, f, sha)).toEqual(f.evidence);
    expect(f.evidence.verification.payload.profile_digest).not.toBe(f.evidence.template.digest);
    expect(f.evidence.result.manifest_digest).not.toBe(f.evidence.verification.payload.subject_digest);
  });

  it("refuses commands, state/config paths, opaque capabilities and unknown versions at every public boundary", () => {
    const f = fixture();
    for (const extra of [{ argv: ["/private/verifier"] }, { state_root: "/private/state" }, { repository_root: "/private/repository" },
      { trustedFiles: [] }, { environment: { TOKEN: "hidden" } }, { version: 2 }, { target: { version: 1 } }, { capabilities: {} }]) {
      expect(NodeOwnedResultProfileDescriptorV1Schema.safeParse({ ...f.descriptor, ...extra }).success).toBe(false);
      expect(OwnedResultRequirementV1Schema.safeParse({ ...f.requirement, ...extra }).success).toBe(false);
      expect(NodeOwnedResultVerificationEvidenceV1Schema.safeParse({ ...f.evidence, ...extra }).success).toBe(false);
    }
    const nested = { ...f.evidence, verification: { ...f.evidence.verification,
      execution: { ...f.evidence.verification.execution, argv: ["/private/verifier"] } } };
    expect(NodeOwnedResultVerificationEvidenceV1Schema.safeParse(nested).success).toBe(false);
    expect(NodeOwnedResultVerificationEvidenceV1Schema.safeParse({ ...f.evidence, accepted: true }).success).toBe(false);
  });

  it("requires bounded exact IDs, fixed object IDs and canonical relative scope without overlap", () => {
    const { descriptor, requirement } = fixture();
    for (const changes of [{ node_id: "n".repeat(97) }, { content_paths: ["../outside"] }, { content_paths: [".git/config"] },
      { content_paths: ["src", "src/lib"] }, { content_paths: ["src", "src"] }, { content_paths: ["src\\file"] },
      { result_profile: { ...descriptor.result_profile, baseline_commit: "HEAD" } },
      { result_profile: { ...descriptor.result_profile, baseline_commit: "A".repeat(40) } }]) {
      expect(NodeOwnedResultProfileDescriptorV1Schema.safeParse({ ...descriptor, ...changes }).success).toBe(false);
    }
    for (const changes of [{ capture_request_id: requirement.request_id }, { verification_materialization_request_id: requirement.capture_request_id },
      { input: undefined }, { input: { kind: "branch", branch: "main" } },
      { input: { kind: "result", reference: { result_id: requirement.request_id, receipt_digest: sha("input") } } }]) {
      expect(OwnedResultRequirementV1Schema.safeParse({ ...requirement, ...changes }).success).toBe(false);
    }
  });

  it("keeps descriptor sets unambiguous without advertising them as execution authority", () => {
    const { descriptor } = fixture();
    expect(NodeOwnedResultProfileDescriptorsV1Schema.parse([descriptor])).toEqual([descriptor]);
    const second = { ...descriptor, verifier_template: { id: "second", digest: sha("second protected template") } };
    expect(NodeOwnedResultProfileDescriptorsV1Schema.safeParse([descriptor, second]).success).toBe(true);
    for (const other of [descriptor, { ...second, node_id: "another_node" },
      { ...second, result_profile: { ...descriptor.result_profile, digest: sha("changed profile") } },
      { ...second, content_paths: ["other"] }]) {
      expect(NodeOwnedResultProfileDescriptorsV1Schema.safeParse([descriptor, other]).success).toBe(false);
    }
  });

  it("separates the real absent verifier context from the original author ContextPack", () => {
    const f = fixture();
    expect(OWNED_RESULT_NO_VERIFICATION_CONTEXT_DIGEST).toBe(sha("null"));
    expect(f.requirement.author_context_digest).not.toBe(OWNED_RESULT_NO_VERIFICATION_CONTEXT_DIGEST);
    expect(sha(canonicalOwnedResultAuthorContextV1({ ...f.authorContext,
      workspace: { ...f.authorContext.workspace, root: f.evidence.verification.workspace.root } }))).not.toBe(f.requirement.author_context_digest);
    expect(() => canonicalOwnedResultAuthorContextV1({ ...f.authorContext,
      policy: { ...f.authorContext.policy, execution_mode: "discussion" } })).toThrow("does not support");
    expect(() => canonicalOwnedResultAuthorContextV1({ ...f.authorContext, review_subject: { version: 1,
      task_id: "task_1", run_id: "run_original", evidence_id: "evidence_original", subject_digest: sha("subject") } })).toThrow("does not support");
    expect(NodeOwnedResultProfileDescriptorV1Schema.safeParse({ ...f.descriptor,
      verification_context_policy: { version: 1, mode: "rebind-author" } }).success).toBe(false);
    const changed = { ...f.evidence, verification: { ...f.evidence.verification,
      execution: { ...f.evidence.verification.execution, context_digest: f.requirement.author_context_digest } } };
    expect(NodeOwnedResultVerificationEvidenceV1Schema.safeParse(changed).success).toBe(false);
    const differentAuthor = structuredClone(f.evidence); differentAuthor.author.author_context_digest = sha("other author context");
    expect(NodeOwnedResultVerificationEvidenceV1Schema.safeParse(differentAuthor).success).toBe(false);
  });

  it("sanitizes node diagnostics while refusing a downgrade from browser/measurement contracts", () => {
    const { payload } = fixture();
    const raw = RunVerificationPayloadSchema.parse({ ...payload, outcome: "failed", checks: [], reason: "private argv /private/state and raw output" });
    const projected = projectOwnedResultCommandVerificationV1(raw);
    expect(projected.outcome).toBe("failed");
    expect(JSON.stringify(projected)).not.toContain("private");
    expect(OwnedResultCommandVerificationV1Schema.safeParse(raw).success).toBe(false);
    expect(OwnedResultCommandVerificationV1Schema.safeParse({ ...payload,
      checks: [{ ...payload.checks[0], observation: {} }] }).success).toBe(false);
    expect(OwnedResultCommandVerificationV1Schema.safeParse({ ...payload, measurement_plan: {} }).success).toBe(false);
    const observed = RunVerificationPayloadSchema.parse({ ...payload, checks: [{ ...payload.checks[0],
      observation: { version: 1, format: "static-web-acceptance.v1", scope: "final", stage: "design",
        cases: [{ case_id: "prototype", viewport: 390, assertions: 0, screenshot_digest: sha("controlled screenshot") }] } }] });
    expect(() => projectOwnedResultCommandVerificationV1(observed)).toThrow("plain commands");
  });

  it("preserves ordinary passing-check rules and does not upgrade failure evidence", () => {
    const f = fixture();
    for (const change of [{ checks: [] }, { checks: [{ ...f.payload.checks[0], exit_code: 9 }] },
      { subject_digest: null }, { checks: [f.payload.checks[0], f.payload.checks[0]] }]) {
      expect(OwnedResultCommandVerificationV1Schema.safeParse({ ...f.payload, ...change }).success).toBe(false);
    }
    f.evidence.verification.payload.outcome = "failed";
    f.evidence.verification.payload.checks[0]!.exit_code = 9;
    expect(NodeOwnedResultVerificationEvidenceV1Schema.parse(f.evidence).verification.payload.outcome).toBe("failed");
  });

  it("binds capture/result/template and physical execution while rejecting a reused author workspace", () => {
    const f = fixture();
    const changes = [
      (v: typeof f.evidence) => { v.result.reference.result_id = "other_capture"; },
      (v: typeof f.evidence) => { v.template.digest = sha("other template"); },
      (v: typeof f.evidence) => { v.result.repository_binding = sha("other repository"); },
      (v: typeof f.evidence) => { v.result.base_commit = "d".repeat(40); },
      (v: typeof f.evidence) => { v.verification.execution.profile_digest = v.template.digest; },
      (v: typeof f.evidence) => { v.verification.execution.subject_digest = v.result.manifest_digest; },
      (v: typeof f.evidence) => { v.verification.receipt.verification_id = "other_verification"; },
      (v: typeof f.evidence) => { v.verification.workspace = v.author.workspace; v.verification.execution.workspace_root = v.author.workspace.root; },
      (v: typeof f.evidence) => { v.verification.payload.required_files[0]!.path = "outside/index.ts"; },
    ];
    for (const change of changes) { const changed = structuredClone(f.evidence); change(changed); expect(NodeOwnedResultVerificationEvidenceV1Schema.safeParse(changed).success).toBe(false); }
  });

  it("maps the public selection to the local durable intent without merging its two digests", () => {
    const f = fixture(), intent = ownedResultVerificationIntentV1(f.evidence);
    expect(intent).toEqual({ version: 1, kind: "owned-result-verification.v1", request_id: f.requirement.request_id,
      materialization_request_id: f.requirement.verification_materialization_request_id, template: f.evidence.template,
      result: { reference: f.evidence.result.reference, profile_id: f.evidence.result.profile_id, profile_digest: f.evidence.result.profile_digest },
      workspace: f.evidence.verification.workspace, context_digest: OWNED_RESULT_NO_VERIFICATION_CONTEXT_DIGEST });
    expect(f.evidence.requirement_digest).not.toBe(f.evidence.verification.intent_digest);
    const changed = structuredClone(f.evidence); changed.verification.intent_digest = changed.requirement_digest;
    expect(() => assertOwnedResultEvidenceMatchesExpectedV1(changed, f, sha)).toThrow("digests");
    const other = structuredClone(f.evidence); other.author.run_id = "other_run";
    expect(() => assertOwnedResultEvidenceMatchesExpectedV1(other, f, sha)).toThrow("expected assignment");
  });

  it("requires the exact previously accepted input when the author consumes an earlier result", () => {
    const f = fixture(), reference = { result_id: "accepted_input", receipt_digest: sha("accepted input receipt") }, commit = "d".repeat(40);
    const requirement = OwnedResultRequirementV1Schema.parse({ ...f.requirement, input: { kind: "result", reference } });
    const evidence = structuredClone(f.evidence); evidence.requirement = requirement;
    evidence.result.inputs = [reference]; evidence.result.base_commit = commit;
    evidence.requirement_digest = sha(canonicalOwnedResultRequirementV1(requirement));
    evidence.verification.intent_digest = sha(canonicalOwnedResultVerificationIntentV1(evidence));
    const expected = { descriptor: f.descriptor, requirement, author: f.author, accepted_input: { reference, commit } };
    expect(assertOwnedResultEvidenceMatchesExpectedV1(evidence, expected, sha)).toEqual(evidence);
    expect(() => assertOwnedResultEvidenceMatchesExpectedV1(evidence, { ...expected, accepted_input: undefined }, sha)).toThrow("previously accepted input");
    expect(() => assertOwnedResultEvidenceMatchesExpectedV1(evidence, { ...expected, accepted_input: { reference, commit: "e".repeat(40) } }, sha)).toThrow("previously accepted input");
  });
});
