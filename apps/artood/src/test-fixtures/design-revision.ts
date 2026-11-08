// Controlled policy-v2 product data. This helper supplies no native or server authority.
import { createHash } from "node:crypto";
import { ContextPackSchema, ProductDesignV2Schema, ProductResearchReportV2Schema, ProductDesignRevisionContextV1Schema,
  productDevelopmentContext, validateProductDevelopmentHandoff, type ContextPack, type RunStartPayload, type VerificationCapabilities } from "@artoo/domain";

export const revisionSha = (bytes: string | Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export function designRevisionFixture(options: { workspace?: string; capabilities?: VerificationCapabilities } = {}) {
  const workspace = options.workspace ?? "C:\\controlled-design-revision", capabilities = options.capabilities;
  const check = capabilities?.checks[0], digest = revisionSha("controlled profile");
  const ref = { requirement_id: "search", criterion_index: 0 };
  const research = ProductResearchReportV2Schema.parse({ version: 1, objective: "Search journal entries", assumptions: [],
    requirements: [{ id: "search", description: "Literal title and body search", priority: "must", acceptance_criteria: ["Return only matching entries"] }],
    sources: [{ id: "source", url: "https://example.com/spec", title: "Controlled fixture", retrieved_at: "2026-11-06T00:00:00Z", content_digest: revisionSha("source") }],
    findings: [{ summary: "Match a literal query", source_ids: ["source"] }], decisions: [],
    measurement_plan: { version: 2, profile_digest: capabilities?.profile_digest ?? digest,
      entries: [{ method: "workspace-check", ...ref, command_id: check?.command_id ?? "browser",
        config_digest: check?.config_digest ?? digest, contract_digest: check?.contract_digest ?? digest,
        actions: ["navigate", "fill", "assert_text", "assert_count"], keys: [], needs: [],
        viewports: check?.contract.viewports ?? [{ id: "compact", width: 390, height: 844 }] }] } });
  const baseline = ProductDesignV2Schema.parse({ version: 2, requirement_ids: ["search"], information_architecture: ["Journal"],
    user_flows: [{ id: "find", name: "Find entries", requirement_ids: ["search"], steps: ["Read entries", "Type a query"] }],
    screens: [{ id: "journal", name: "Journal", purpose: "Find saved writing", states: ["Empty", "Results"], accessibility: ["Label input"], responsive: ["Single column"] }],
    prototype: { entrypoint: "product/index.html", description: "Searchable journal" }, data_model: [], api_contracts: [],
    decisions: [{ decision: "Literal search", rationale: "Predictable" }], validation_cases: [{ id: "original", method: "workspace-check",
      requirement_ids: ["search"], requirement_criteria: [ref], procedure: ["Open journal"], expected_result: "Saved content appears",
      browser_program: { version: 3, contract_digest: check?.contract_digest ?? digest, steps: [
        { action: "navigate", page: "main", path: "/" }, { action: "assert_text", page: "main", selector: "#entry", text: "Saved" },
      ] } }] });
  // Screens permit unknown data that the public parser discards. Cases are
  // strict, so only supported screen extensions exercise raw preservation.
  Object.assign(baseline.screens[0]!, { retained_extension: { exact: " baseline text " } });
  const revised = structuredClone(baseline);
  revised.validation_cases.push({ id: "literal-separator", method: "workspace-check", requirement_ids: ["search"], requirement_criteria: [ref],
    procedure: ["Search for a literal nonmatching separator"], expected_result: "Unrelated entries disappear",
    browser_program: { version: 3, contract_digest: check?.contract_digest ?? digest, steps: [
      { action: "navigate", page: "main", path: "/" }, { action: "fill", page: "main", selector: "#search", value: "n" },
      { action: "assert_count", page: "main", selector: ".entry", count: 0 },
    ] } });
  // Assert validity after adding raw extensions without replacing the raw data
  // with the parser output. An invalid shared fixture can mask later failures.
  for (const design of [baseline, revised]) {
    const parsed = ProductDesignV2Schema.parse(design);
    const errors = validateProductDevelopmentHandoff(research, parsed);
    if (errors.length) throw new Error(`Invalid controlled design handoff: ${errors.join(" ")}`);
  }
  const researchBytes = Buffer.from(JSON.stringify(research)), baselineText = JSON.stringify(baseline, null, 2);
  const revision = ProductDesignRevisionContextV1Schema.parse({ version: 1, revision_id: "revision", project_id: "project", goal_id: "goal", plan_id: "plan",
    computer_id: "computer", workspace_root: workspace, design_task_id: "design-task", author_run_id: "revised-author",
    request: { version: 1, kind: "add-validation-cases", reason: "Cover the literal separator regression", requirement_criteria: [ref] },
    requesting_review: { review_id: "implementation-review", subject_run_id: "implementation-author", subject_evidence_id: "implementation-evidence",
      reviewer_instance_id: "implementation-reviewer", reviewer_run_id: "implementation-reviewer-run", reviewer_evidence_id: "implementation-reviewer-evidence",
      turn_id: "request-turn", response_message_id: "request-message", response_digest: revisionSha("request response") },
    baseline: { run_id: "accepted-design", evidence_id: "accepted-design-evidence", review_id: "accepted-design-review",
      reviewer_run_id: "accepted-design-reviewer", reviewer_evidence_id: "accepted-design-reviewer-evidence",
      design: { path: ".artoo/product/design.json", checksum: revisionSha(baselineText), size: Buffer.byteLength(baselineText), text: baselineText },
      research: { path: ".artoo/product/research.json", checksum: revisionSha(researchBytes), size: researchBytes.length,
        source_task_id: "research-task", source_run_id: "research-author", evidence_id: "research-evidence" } } });
  const development = productDevelopmentContext("design", capabilities);
  development.accepted_inputs = { version: 1, files: [revision.baseline.research] };
  const context = ContextPackSchema.parse({ task: { id: "design-task", title: "Design revision", description: revision.request.reason, acceptance_criteria: [] },
    project: { id: "project", name: "Product", default_workspace: workspace }, workspace: { root: workspace, file_scope: [] },
    policy: { filesystem_write_scope: [workspace], requires_approval: [] }, memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
    goal_context: { version: 1, goal_id: "goal", objective: research.objective, acceptance_criteria: [], plan: { id: "plan", version: 1, rationale: "Original plan", spec_ref: null } },
    product_development: development, product_design_revision: revision,
    ...(capabilities ? { verification_capabilities: { ...capabilities, profile_id: "checks" } } : {}) });
  const start: RunStartPayload = { run_id: revision.author_run_id, task_id: context.task.id, agent_instance_id: "design-author", runtime: "controlled",
    workspace: { root: workspace }, verification: { version: 1, request_id: "verification", profile_id: "checks",
      ...(capabilities ? { capability_binding: { version: 1, profile_digest: capabilities.profile_digest,
        checks: capabilities.checks.map(({ command_id, config_digest, contract_digest }) => ({ command_id, config_digest, contract_digest })) } } : {}) },
    context_pack: { id: "revision-context", payload: context }, policy_snapshot: { filesystem_write_scope: [workspace], requires_approval: [] }, artifact_rules: { paths: [] } };
  return { workspace, research, researchBytes, baseline, baselineBytes: Buffer.from(baselineText), revised,
    revisedBytes: Buffer.from(JSON.stringify(revised)), revision: context.product_design_revision!, context, start };
}

export function revisionReviewContext(context: ContextPack): ContextPack {
  const review = structuredClone(context), revision = review.product_design_revision!;
  delete review.product_development;
  review.task.id = "independent-design-review";
  review.policy = { execution_mode: "discussion", filesystem_write_scope: [], requires_approval: [] };
  review.review_subject = { version: 1, task_id: revision.design_task_id, run_id: revision.author_run_id,
    evidence_id: "revised-author-evidence", subject_digest: revisionSha("reviewed source"), development_stage: "design" };
  return review;
}
