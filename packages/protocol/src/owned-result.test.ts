import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NodeOwnedResultProfileDescriptorV1Schema, NodeOwnedResultVerificationEvidenceV1Schema,
  OwnedResultRunAdmissionV1Schema, OWNED_RESULT_NO_VERIFICATION_CONTEXT_DIGEST,
  canonicalOwnedResultRequirementV1, canonicalOwnedResultRunAdmissionV1, canonicalOwnedResultVerificationIntentV1 } from "@artoo/domain";
import { adapterRunEventBodySchema, commandSchema, nodeHelloSchema, runEventBodySchema,
  runEventMessageSchema, runStartCommandSchema, runStartOwnedResultCommandSchema } from "./node-messages.js";
import type { RunStartOwnedResultCommand } from "./node-messages.js";
import type { ServerToNodeMessage } from "./transport.js";

const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
// Controlled wire data, never a provider result or issuer-produced authority.
function fixture() {
  const descriptor = NodeOwnedResultProfileDescriptorV1Schema.parse({ version: 1, node_id: "node_one", project_id: "project_one",
    result_profile: { id: "results", digest: sha("profile"), repository_binding: sha("repository"), baseline_commit: "a".repeat(40) },
    verifier_template: { id: "template", digest: sha("template") }, workspace_strategy: "per-run", verification_mode: "plain-commands",
    verification_context_policy: { version: 1, mode: "none" }, content_paths: ["src"],
    scope: "authored-result command verification; no product-stage, review or publication acceptance" });
  const admission = OwnedResultRunAdmissionV1Schema.parse({ version: 1,
    run_start: { run_id: "run_one", task_id: "task_one", agent_instance_id: "ai_one", runtime: "codex",
      workspace: { root: "/fixture/author", branch: "fixture/author" }, context_pack: { id: "context_one", uri: "inline" },
      policy_snapshot: { filesystem_write_scope: ["/fixture/author"], requires_approval: [] }, artifact_rules: { paths: ["src/**"] } },
    requirement: { version: 1, request_id: "verify_one", capture_request_id: "capture_one", verification_materialization_request_id: "materialize_one",
      profile: descriptor, author_context_digest: sha("context"), input: { kind: "baseline" } } });
  const command: RunStartOwnedResultCommand = { kind: "command", id: "command_one", idempotency_key: "run_one:start:owned-result:v1",
    type: "run.start.owned-result.v1", payload: admission };
  const requirement = admission.requirement, payload = { version: 1, request_id: requirement.request_id, profile_id: "template",
    profile_digest: sha("measured profile"), subject_digest: sha("subject"), outcome: "passed", checks: [{ id: "check", exit_code: 0,
      duration_ms: 10, output_digest: sha("output") }], required_files: [{ path: "src/index.ts", checksum: sha("source"), size: 12 }] };
  const evidence = NodeOwnedResultVerificationEvidenceV1Schema.parse({ version: 1, kind: "authored-result-verification", requirement,
    requirement_digest: sha(canonicalOwnedResultRequirementV1(requirement)), author: { run_id: "run_one", task_id: "task_one", agent_instance_id: "ai_one", runtime: "codex",
      launch_binding_digest: sha("launch"), author_context_digest: requirement.author_context_digest, workspace: admission.run_start.workspace },
    template: { ...descriptor.verifier_template, node_id: descriptor.node_id, project_id: descriptor.project_id },
    result: { kind: "authored", reference: { result_id: "capture_one", receipt_digest: sha("capture") }, profile_id: "results",
      profile_digest: descriptor.result_profile.digest, repository_binding: descriptor.result_profile.repository_binding,
      base_commit: "a".repeat(40), commit: "b".repeat(40), tree: "c".repeat(40), manifest_digest: sha("manifest"), inputs: [] },
    verification: { receipt: { verification_id: "verify_one", receipt_digest: sha("receipt") }, intent_digest: sha("placeholder"),
      workspace: { root: "/fixture/verifier", branch: "fixture/verifier" }, execution: { version: 1, request_id: "verify_one", profile_id: "template",
        profile_digest: payload.profile_digest, workspace_root: "/fixture/verifier", subject_digest: payload.subject_digest,
        context_digest: OWNED_RESULT_NO_VERIFICATION_CONTEXT_DIGEST }, payload },
    scope: "historical plain-command node evidence; no product-stage, independent review or publication acceptance" });
  evidence.verification.intent_digest = sha(canonicalOwnedResultVerificationIntentV1(evidence));
  return { descriptor, admission, command, evidence };
}

describe("owned result wire opt-in", () => {
  it("uses a distinct command type and preserves the exact canonical request across JSON", () => {
    const { command, admission } = fixture(), transportMessage: ServerToNodeMessage = command;
    const parsed = commandSchema.parse(JSON.parse(JSON.stringify(transportMessage)));
    expect(parsed.type).toBe("run.start.owned-result.v1");
    expect(runStartOwnedResultCommandSchema.parse(parsed)).toEqual(command);
    if (parsed.type !== "run.start.owned-result.v1") throw new Error("Wrong discriminator");
    expect(canonicalOwnedResultRunAdmissionV1(parsed.payload)).toBe(canonicalOwnedResultRunAdmissionV1(admission));
    expect(runStartCommandSchema.safeParse(command).success).toBe(false);
    expect(commandSchema.safeParse({ ...command, type: "run.start.owned-result.v2" }).success).toBe(false);
    expect(runStartCommandSchema.safeParse({ ...command, type: "run.start" }).success).toBe(false);
  });

  it("preserves ordinary legacy parsing while rejecting known new-mode fields before stripping", () => {
    const { command, admission } = fixture(), legacy = { ...command, type: "run.start", payload: admission.run_start };
    expect(runStartCommandSchema.parse(legacy).payload).toEqual(admission.run_start);
    expect(commandSchema.parse({ ...legacy, future_envelope: 1, payload: { ...admission.run_start, future_ordinary_field: true,
      workspace: { ...admission.run_start.workspace, future_workspace_field: true } } })).toEqual(legacy);
    for (const key of ["requirement", "run_start", "owned_result", "owned_result_assignment", "owned_result_requirement",
      "owned_result_admission", "owned_result_profile", "owned_result_profiles"]) {
      for (const marker of [null, {}, { version: 99 }, admission.requirement]) {
        expect(commandSchema.safeParse({ ...legacy, payload: { ...admission.run_start, [key]: marker } }).success).toBe(false);
        expect(commandSchema.safeParse({ ...legacy, [key]: marker }).success).toBe(false);
      }
    }
  });

  it("rejects new-command nested additions without normalizing them away", () => {
    const { command, admission } = fixture(), start = admission.run_start;
    for (const run_start of [{ ...start, owned_result: {} }, { ...start, workspace: { ...start.workspace, hidden: true } },
      { ...start, context_pack: { ...start.context_pack, hidden: true } },
      { ...start, policy_snapshot: { ...start.policy_snapshot, hidden: true } }]) {
      expect(commandSchema.safeParse({ ...command, payload: { ...admission, run_start } }).success).toBe(false);
    }
    expect(commandSchema.safeParse({ ...command, payload: { ...admission, issuer: {} } }).success).toBe(false);
    expect(commandSchema.safeParse({ ...command, payload: { ...admission, version: 2 } }).success).toBe(false);
    expect(commandSchema.safeParse({ ...command, ignored: true }).success).toBe(false);
  });

  it("keeps profile advertisement optional and applies the exact descriptor contract", () => {
    const { descriptor } = fixture(), hello = { kind: "node.hello", node_id: "node_one", protocol_version: "1", artood_version: "fixture",
      machine: { hostname: "fixture", os: "linux", arch: "x64" } };
    expect(nodeHelloSchema.parse(hello)).toEqual(hello);
    expect(nodeHelloSchema.parse({ ...hello, owned_result_profiles: [descriptor] }).owned_result_profiles).toEqual([descriptor]);
    expect(nodeHelloSchema.safeParse({ ...hello, owned_result_profiles: [descriptor, descriptor] }).success).toBe(false);
    expect(nodeHelloSchema.safeParse({ ...hello, owned_result_profiles: [{ ...descriptor, issuer: {} }] }).success).toBe(false);
  });

  it("reserves authored-result evidence for the node event union", () => {
    const { evidence } = fixture(), event = { type: "run.owned-result.verification", payload: evidence };
    expect(runEventBodySchema.parse(event)).toEqual(event);
    expect(runEventMessageSchema.parse({ kind: "run.event", node_id: "node_one", run_id: "run_one", sequence: 4, event }).event).toEqual(event);
    expect(adapterRunEventBodySchema.safeParse(event).success).toBe(false);
    const output = { type: "run.output", payload: { stream: "stdout", text: JSON.stringify(event) } };
    expect(adapterRunEventBodySchema.parse(output)).toEqual(output);
    expect(runEventBodySchema.safeParse({ ...event, payload: { ...evidence, issuer: {} } }).success).toBe(false);
  });
});
