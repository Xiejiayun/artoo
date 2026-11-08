import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RunStartPayloadSchema } from "./node-payloads.js";
import { OwnedResultRunAdmissionV1Schema, canonicalOwnedResultRunAdmissionV1,
  type OwnedResultRunAdmissionV1 } from "./worktree-result.js";

const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
// Synthetic metadata only: this fixture creates no prepared node authority.
function request(): OwnedResultRunAdmissionV1 {
  return {
    version: 1,
    run_start: { run_id: "run_one", task_id: "task_one", agent_instance_id: "ai_one", runtime: "codex",
      workspace: { root: "/fixture/author", branch: "fixture/author" },
      workspace_allocation: { version: 1, strategy: "per-run", base_path: "/fixture" }, workspace_retention_reporting: "typed-v1",
      context_pack: { id: "context_one", payload: {
        task: { id: "task_one", title: "Task", description: "Author the requested change", acceptance_criteria: ["Checks pass"] },
        project: { id: "project_one", name: "Project", default_workspace: null },
        workspace: { root: "/fixture/author", file_scope: ["src"] },
        policy: { filesystem_write_scope: ["src"], requires_approval: [] }, memory: { task_summary: null, project_notes: [] },
        artifacts: { expected: [] },
      } }, policy_snapshot: { filesystem_write_scope: ["/fixture/author"], requires_approval: [] }, artifact_rules: { paths: ["src/**"] } },
    requirement: { version: 1, request_id: "verification_one", capture_request_id: "capture_one",
      verification_materialization_request_id: "materialization_one", author_context_digest: digest("context"), input: { kind: "baseline" },
      profile: { version: 1, node_id: "node_one", project_id: "project_one",
        result_profile: { id: "result_profile", digest: digest("result profile"), repository_binding: digest("repository"), baseline_commit: "a".repeat(40) },
        verifier_template: { id: "template", digest: digest("template") }, workspace_strategy: "per-run", verification_mode: "plain-commands",
        verification_context_policy: { version: 1, mode: "none" }, content_paths: ["src"],
        scope: "authored-result command verification; no product-stage, review or publication acceptance" } },
  };
}

describe("owned result admission metadata", () => {
  it("round-trips the full request and adds the canonical discriminator itself", () => {
    const raw = request(), parsed = OwnedResultRunAdmissionV1Schema.parse(JSON.parse(JSON.stringify(raw)));
    expect(parsed).toEqual(raw);
    expect(parsed).not.toBe(raw);
    const canonical = canonicalOwnedResultRunAdmissionV1(raw);
    expect(JSON.parse(canonical)).toEqual({ kind: "owned-result-run-admission.v1", ...raw });
    expect(Object.keys(JSON.parse(canonical))).toEqual(["kind", "requirement", "run_start", "version"]);
    expect(canonicalOwnedResultRunAdmissionV1({ requirement: raw.requirement, run_start: { ...raw.run_start,
      workspace: { branch: raw.run_start.workspace.branch, root: raw.run_start.workspace.root } }, version: 1 })).toBe(canonical);
    expect(OwnedResultRunAdmissionV1Schema.safeParse({ kind: "owned-result-run-admission.v1", ...raw }).success).toBe(false);
  });

  it("binds every launch field and the selected requirement, including nested context and array order", () => {
    const original = digest(canonicalOwnedResultRunAdmissionV1(request()));
    const changes: ((value: OwnedResultRunAdmissionV1) => void)[] = [
      value => { value.run_start.run_id = "run_two"; },
      value => { value.run_start.task_id = "task_two"; },
      value => { value.run_start.agent_instance_id = "ai_two"; },
      value => { value.run_start.runtime = "other"; },
      value => { value.run_start.workspace.root = "/fixture/other"; },
      value => { value.run_start.workspace.branch = "fixture/other"; },
      value => { value.run_start.workspace_allocation!.base_path = "/other"; },
      value => { value.run_start.workspace_retention_reporting = "other"; },
      value => { value.run_start.context_pack.id = "context_two"; },
      value => { value.run_start.context_pack.uri = "local://context"; },
      value => { value.run_start.context_pack.payload!.task.description = "Different task"; },
      value => { value.run_start.context_pack.payload!.workspace.file_scope = ["tests", "src"]; },
      value => { value.run_start.policy_snapshot.requires_approval = ["git.push"]; },
      value => { value.run_start.artifact_rules.paths = ["tests/**", "src/**"]; },
      value => { value.requirement.request_id = "verification_two"; },
      value => { value.requirement.capture_request_id = "capture_two"; },
      value => { value.requirement.verification_materialization_request_id = "materialization_two"; },
      value => { value.requirement.author_context_digest = digest("other context"); },
      value => { value.requirement.profile.verifier_template.digest = digest("other template"); },
      value => { value.requirement.input = { kind: "result", reference: { result_id: "prior", receipt_digest: digest("prior") } }; },
    ];
    for (const change of changes) { const changed = request(); change(changed); expect(digest(canonicalOwnedResultRunAdmissionV1(changed))).not.toBe(original); }
    const left = request(), right = request(); left.run_start.artifact_rules.paths = ["src/**", "tests/**"];
    right.run_start.artifact_rules.paths = ["tests/**", "src/**"];
    expect(canonicalOwnedResultRunAdmissionV1(left)).not.toBe(canonicalOwnedResultRunAdmissionV1(right));
  });

  it("rejects nested fields before legacy codecs can discard them", () => {
    const raw = request(), start = raw.run_start, context = start.context_pack.payload!;
    const starts = [
      { ...start, ignored: true }, { ...start, workspace: { ...start.workspace, ignored: true } },
      { ...start, context_pack: { ...start.context_pack, ignored: true } },
      { ...start, context_pack: { ...start.context_pack, payload: { ...context, ignored: true } } },
      { ...start, context_pack: { ...start.context_pack, payload: { ...context, task: { ...context.task, ignored: true } } } },
      { ...start, policy_snapshot: { ...start.policy_snapshot, ignored: true } },
      { ...start, artifact_rules: { ...start.artifact_rules, ignored: true } },
    ];
    for (const run_start of starts) {
      expect(RunStartPayloadSchema.safeParse(run_start).success).toBe(true);
      expect(OwnedResultRunAdmissionV1Schema.safeParse({ ...raw, run_start }).success).toBe(false);
      expect(() => canonicalOwnedResultRunAdmissionV1({ ...raw, run_start })).toThrow();
    }
    for (const extra of [{ version: 2 }, { issuer: {} }, { prepared: {} }, { requirement: { ...raw.requirement, issuer: {} } }]) {
      expect(OwnedResultRunAdmissionV1Schema.safeParse({ ...raw, ...extra }).success).toBe(false);
    }
  });

  it("applies the finalizer's UTF-8 byte budget without truncating input", () => {
    const raw = request(); raw.run_start.context_pack.payload!.task.description = "中".repeat(350_000);
    expect(JSON.stringify(raw).length).toBeLessThan(1024 * 1024);
    expect(OwnedResultRunAdmissionV1Schema.safeParse(raw).success).toBe(false);
    expect(() => canonicalOwnedResultRunAdmissionV1(raw)).toThrow("bounded journal payload size");
  });
});
