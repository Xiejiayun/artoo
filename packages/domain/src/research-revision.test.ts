import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AutonomousSourceHandoffV1Schema } from "./autonomy.js";
import { ContextPackSchema } from "./context-pack.js";
import { ProductSourceTransferRequestV2Schema } from "./product-source-semantics.js";
import { ResearchDestinationPoolSnapshotV1Schema, ResearchRevisionIntentV1Schema } from "./research-revision.js";
import { ProductResearchRevisionContextV1Schema } from "./research-revision-context.js";

const request = ProductSourceTransferRequestV2Schema.parse(JSON.parse(readFileSync(new URL("../test-fixtures/product-source-operation.json", import.meta.url), "utf8")).admission.request);
const digest = `sha256:${"a".repeat(64)}`, base = request.byte_request;
const mapping = { source_release: request.source_export.measurement_v2!.source_release,
  destination_release: request.measurement_v2!.destination_release, command_pairs: request.command_pairs };
const role = (instance: string, agent: string) => ({ instance_id: instance, agent_id: agent, runtime: "codex", model_profile_id: null, effort_profile_id: null });
const pool = { version: 1, project_id: base.project_id, goal_id: "goal", plan_id: "plan", next_task_id: "design", base_research_task_id: "research",
  actor_user_id: "user", consent_id: null, policy_version: "policy", goal_digest: digest, plan_digest: digest, max_retries: 1,
  source: { computer_id: "source", workspace_root: mapping.source_release.binding.workspace_root, release: mapping.source_release,
    writer: role("source-writer", "writer"), reviewer: role("source-reviewer", "reviewer") },
  destination: { computer_id: "destination", writer_agent_id: "writer", reviewer_agent_id: "reviewer" },
  members: [0, 1].map(index => ({ slot_id: `slot-${index}`, index,
    mapping: { ...mapping, destination_release: { ...mapping.destination_release, binding: { ...mapping.destination_release.binding,
      workspace_root: `C:/destination/${index}`, release_profile_id: `release-${index}` } } },
    writer: role(`writer-${index}`, "writer"), reviewer: role(`reviewer-${index}`, "reviewer") })) };
const baseline = { version: 1, source_task_id: base.source.task_id, source_run_id: base.source.run_id, evidence_id: base.source.evidence_id,
  computer_id: base.source.node_id, workspace_root: base.source.workspace_root, profile_id: base.source.profile_id,
  profile_digest: base.source.profile_digest, subject_digest: base.source.subject_digest, capsule_digest: base.source.capsule_digest,
  capsule_bytes: base.source.capsule_bytes, export_digest: request.source_export_digest, provenance_digest: request.source_export.research_provenance_digest,
  research: request.source_export.research_provenance.research };
const revision = { version: 1, revision_id: "revision", intent_digest: digest, author_run_id: "author", original_research_task_id: "research",
  goal_id: "goal", plan_id: "plan", parent_review: { review_id: "review", request_digest: digest, result_digest: digest }, baseline };

describe("optional H2 research revision contracts", () => {
  it("leaves legacy grants and contexts unchanged and rejects unknown revision versions", () => {
    const grant = { version: 1, mode: "automatic" };
    expect(AutonomousSourceHandoffV1Schema.parse(grant)).toEqual(grant);
    expect(AutonomousSourceHandoffV1Schema.parse({ ...grant, research_revision: { version: 1, strategy: "configured_pool" } })).toHaveProperty("research_revision");
    expect(AutonomousSourceHandoffV1Schema.safeParse({ ...grant, research_revision: { version: 2, strategy: "configured_pool" } }).success).toBe(false);
    const legacy = { task: { id: "task", title: "Research", description: "", acceptance_criteria: [] },
      project: { id: "project", name: "Product", default_workspace: null }, workspace: { root: "C:/source", file_scope: [] },
      policy: { filesystem_write_scope: ["C:/source"], requires_approval: [] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] } };
    expect(ContextPackSchema.parse(legacy)).toEqual(legacy);
    expect(ContextPackSchema.parse({ ...legacy, product_research_revision: revision }).product_research_revision).toEqual(revision);
    expect(ProductResearchRevisionContextV1Schema.safeParse({ ...revision, version: 2 }).success).toBe(false);
    expect(ProductResearchRevisionContextV1Schema.safeParse({ ...revision, execution_authorized: true }).success).toBe(false);
    expect(ProductResearchRevisionContextV1Schema.safeParse({ ...revision, baseline: { ...baseline, command: "remote-command" } }).success).toBe(false);
  });
  it("freezes a finite configured pool, exact source and stable logical roles", () => {
    expect(ResearchDestinationPoolSnapshotV1Schema.parse(pool).members).toHaveLength(2);
    const mutations = [
      (value: typeof pool) => { value.max_retries = 2; },
      (value: typeof pool) => { value.members[1]!.index = 0; },
      (value: typeof pool) => { value.members[1]!.slot_id = value.members[0]!.slot_id; },
      (value: typeof pool) => { value.members[1]!.writer.agent_id = "replacement"; },
      (value: typeof pool) => { value.members[1]!.writer.runtime = "different-runtime"; },
      (value: typeof pool) => { value.members[1]!.reviewer.instance_id = value.members[0]!.reviewer.instance_id; },
      (value: typeof pool) => { value.members[1]!.mapping.destination_release.binding.workspace_root = "c:\\DESTINATION\\0"; },
      (value: typeof pool) => { value.members[1]!.mapping.destination_release.binding.workspace_root = "C:/destination/0/child/../"; },
      (value: typeof pool) => { value.members[1]!.mapping.destination_release.binding.workspace_root = "C:/destination/0/child"; },
      (value: typeof pool) => { value.members[0]!.mapping.destination_release.binding.workspace_root = "/"; value.members[1]!.mapping.destination_release.binding.workspace_root = "/child"; },
      (value: typeof pool) => { value.members[0]!.mapping.destination_release.binding.workspace_root = "\\"; value.members[1]!.mapping.destination_release.binding.workspace_root = "\\child\\nested"; },
      (value: typeof pool) => { value.members[1]!.mapping.source_release = { ...value.members[1]!.mapping.source_release,
        binding: { ...value.members[1]!.mapping.source_release.binding, release_profile_id: "changed-source" } }; },
      (value: typeof pool) => { value.destination.computer_id = value.source.computer_id; },
      (value: typeof pool) => { value.source.writer.agent_id = value.destination.reviewer_agent_id; value.source.reviewer.agent_id = "other-source-peer"; },
    ];
    for (const mutate of mutations) { const changed = structuredClone(pool); mutate(changed); expect(ResearchDestinationPoolSnapshotV1Schema.safeParse(changed).success).toBe(false); }
  });
  it("pins the parent baseline separately from the revised final verification and rejects invented authority", () => {
    const intent = { version: 1, revision_id: "revision", project_id: base.project_id, goal_id: "goal", plan_id: "plan", next_task_id: "design",
      base_research_task_id: "research", auxiliary_task_id: "aux", actor_user_id: "user", consent_id: null, policy_version: "policy",
      goal_digest: digest, plan_digest: digest, pool_id: "pool", pool_digest: digest, slot_id: "slot-1", generation: 1, attempt_index: 2,
      authorization_event_id: "event", predecessor_revision_id: null,
      parent_review: { review_id: "review", handoff_id: "handoff", request_digest: digest, result_digest: digest }, baseline, execution_authorized: false };
    expect(ResearchRevisionIntentV1Schema.parse(intent)).toEqual(intent);
    expect(ResearchRevisionIntentV1Schema.safeParse({ ...intent, execution_authorized: true }).success).toBe(false);
    expect(ProductResearchRevisionContextV1Schema.safeParse({ ...revision, expected_subject_digest: digest }).success).toBe(false);
  });
});
