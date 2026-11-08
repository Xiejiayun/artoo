// Controlled data only: these projections cannot create original runtime/receipt authority.
import { productDevelopmentContext, importedExecutionContextV1, importedExecutionAcceptedInputsV1,
  inspectImportedExecutionRequestV1, importedDesignReviewSubjectV1, importedDesignReviewRequestDigestV1,
  canonicalProductSourceTransferValueV1 as canonical, type ImportedExecutionRequestV1, type ImportedDesignReviewRequestV1,
  type ImportedDesignReviewResultV1, type RunVerificationPayload, importedExecutionRequestDigestV1, type ImportedCompletedExecutionV1,
  type ImportedDesignContinuationRequestV1, ProductDesignV2Schema, inspectProductSourceVerificationEnvelope, validateProductDevelopmentHandoff } from "@artoo/domain";
import { importedDesignReviewRequestFixture, importedCompletedDesignResultFixture, controlledDesignVerification,
  h4RequestForCompletedFixture, fixtureSha as sha } from "./imported-design-review-request.js";
import { designRevisionFixture } from "./design-revision.js";

export function h5RequestForH4Fixture(review_request: ImportedDesignReviewRequestV1, review_result: ImportedDesignReviewResultV1): ImportedExecutionRequestV1 {
  const run_start = structuredClone(review_request.continuation_request.run_start), context = run_start.context_pack.payload;
  run_start.run_id = "h5-author-run"; run_start.task_id = "h5-implementation-task"; run_start.agent_instance_id = "h5-author-instance";
  run_start.context_pack.id = "h5-context"; run_start.verification!.request_id = "h5-final-request";
  context.task = { id: run_start.task_id, title: "Implement accepted design", description: "Controlled H5 contract fixture", acceptance_criteria: [] };
  if (context.goal_context?.plan) context.goal_context.plan.spec_ref = "2";
  const fields = { execution_id: "h5-execution", review_request, review_result, acceptance_event_id: "controlled-h4-acceptance", design_evidence_id: "controlled-h3-evidence" };
  context.product_development = { ...productDevelopmentContext("implementation"), accepted_inputs: importedExecutionAcceptedInputsV1(fields) };
  const payload = { ...context, imported_execution: importedExecutionContextV1(fields, sha) };
  return { version: 1, stage: "implementation", ...fields, writer: { agent_id: "h5-author-agent", instance_id: run_start.agent_instance_id },
    run_start: { ...run_start, context_pack: { id: run_start.context_pack.id, payload } } };
}
export function importedExecutionRequestFixture() {
  const previous = importedDesignReviewRequestFixture(), continuation = previous.request.continuation_request;
  const { designBytes, verification } = controlledPinnedDesignVerification(continuation, previous.bytes);
  const completion = importedCompletedDesignResultFixture(continuation, verification), review_request = h4RequestForCompletedFixture(continuation, completion);
  const subject = importedDesignReviewSubjectV1(review_request, sha);
  const measured = (start: typeof review_request.before_start) => ({ run_id: start.run_id, config_digest: sha(canonical(start)),
    closure: "windows-job-and-tools-closed.v1" as const, scope: "all-declared-workspace-design-cases" as const,
    verification: { ...structuredClone(verification), request_id: start.verification!.request_id } });
  const review_result: ImportedDesignReviewResultV1 = { version: 1, review_id: review_request.review_id,
    request_digest: importedDesignReviewRequestDigestV1(review_request, sha), execution_authorized: false, outcome: "reviewed", closed: true,
    before: measured(review_request.before_start), after: measured(review_request.after_start),
    reviewer: { run_id: review_request.review_start.run_id, config_digest: sha(canonical(review_request.review_start)), closure: "windows-job-and-tools-closed.v1" },
    verdict: { version: 1, review_id: review_request.review_id, continuation_id: continuation.continuation_id,
      completed_design_digest: subject.completed_design_digest, subject_digest: subject.subject_digest,
      outcome: "accepted", summary: "Controlled H4 verdict; no model/browser execution", findings: [] } };
  const request = h5RequestForH4Fixture(review_request, review_result);
  inspectImportedExecutionRequestV1(request, previous.bytes, sha);
  return { request, bytes: previous.bytes, designBytes };
}
export { sha as executionFixtureSha };

/** Actual schema-valid design programs match these controlled H4 case projections; traces remain synthetic. */
export function controlledPinnedDesignVerification(request: ImportedDesignContinuationRequestV1, researchBytes: Uint8Array) {
  if (request.review_result.outcome !== "reviewed") throw Error("Controlled accepted H2 required");
  const capabilities = request.review_request.operation.intent.request.byte_request.destination.capabilities;
  const mapped = inspectProductSourceVerificationEnvelope(request.review_result.after.admission, researchBytes, sha);
  if (mapped.effective_plan.version !== 2) throw Error("Controlled H5 requires policy v2");
  const research = { ...JSON.parse(Buffer.from(researchBytes).toString("utf8")), measurement_plan: mapped.effective_plan };
  const baseline = designRevisionFixture({ capabilities }).baseline;
  const design = ProductDesignV2Schema.parse({ ...baseline, requirement_ids: research.requirements.map((item: { id: string }) => item.id),
    user_flows: [{ id: "preserve", name: "Read preserved product", requirement_ids: ["preserve"], steps: ["Open the product"] }],
    validation_cases: mapped.effective_plan.entries.map((entry, index) => ({
      id: "accepted-case-" + index, method: entry.method, requirement_ids: [entry.requirement_id],
      requirement_criteria: [{ requirement_id: entry.requirement_id, criterion_index: entry.criterion_index }],
      procedure: ["Measure the accepted criterion"], expected_result: "The accepted criterion is measured",
      ...(entry.method === "configured-static-release" ? { release_binding: entry.release_binding, claim_id: entry.claim_id, statement_digest: entry.statement_digest }
        : { browser_program: { version: 3, contract_digest: entry.contract_digest, steps: [
          { action: "navigate", page: "main", path: "/" }, { action: "assert_text", page: "main", selector: "h1", text: "Preserved product" } ] } }),
    })) });
  const firstWorkspace = design.validation_cases.find(test => test.method === "workspace-check");
  if (!firstWorkspace) throw Error("Controlled H5 requires a workspace case");
  design.validation_cases.push({ ...structuredClone(firstWorkspace), id: "accepted-additional-case" });
  ProductDesignV2Schema.parse(design);
  const errors = validateProductDevelopmentHandoff(research, design); if (errors.length) throw Error(errors.join(" "));
  const designBytes = Buffer.from(JSON.stringify(design)), verification = controlledDesignVerification(request);
  verification.required_files = verification.required_files.map(file => file.path === ".artoo/product/design.json"
    ? { ...file, checksum: sha(designBytes), size: designBytes.length } : file);
  for (const check of verification.checks) {
    if (check.observation?.version !== 3) throw Error("Controlled v3 observation required");
    const template = check.observation.cases[0]!, configured = capabilities.checks.find(item => item.command_id === check.id)!;
    if (configured.contract.version !== 3) throw Error("Controlled H5 requires v3 check contracts");
    check.observation.cases = configured.contract.viewports.flatMap(viewport => design.validation_cases.flatMap(test => test.method === "workspace-check"
      ? [{ ...structuredClone(template), case_id: test.id, viewport: { ...viewport }, program_digest: sha(canonical(test.browser_program)),
        trace_ref: `controlled_trace_${test.id}_${viewport.id}`, captures: template.captures.map(capture => ({ ...capture, screenshot_ref: `controlled_image_${test.id}_${viewport.id}` })) }] : []));
  }
  return { design, designBytes, verification };
}

export function controlledImplementationVerification(request: ImportedExecutionRequestV1): RunVerificationPayload {
  if (request.review_result.outcome !== "reviewed") throw Error("Controlled H5 fixture requires H4 review");
  const value = structuredClone(request.review_result.after.verification);
  value.request_id = request.run_start.verification!.request_id; value.subject_digest = sha("controlled implementation subject");
  for (const check of value.checks) if (check.observation?.version === 3) check.observation.stage = "implementation";
  value.required_files.push({ path: ".artoo/product/implementation.md", checksum: sha("controlled implementation"), size: 25 });
  return value;
}
export function controlledCompletedImplementation(request: ImportedExecutionRequestV1): ImportedCompletedExecutionV1 {
  const context = request.run_start.context_pack.payload, prior = context.imported_execution, source = context.transferred_product_input;
  const destination = request.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination;
  const verification = controlledImplementationVerification(request);
  return { version: 1, stage: "implementation", execution_id: request.execution_id, request_digest: importedExecutionRequestDigestV1(request, sha),
    run_id: request.run_start.run_id, run_start_digest: sha(canonical(request.run_start)), author: request.writer,
    destination: { node_id: destination.node_id, workspace_root: destination.workspace_root, profile_id: destination.profile_id, profile_digest: destination.capabilities.profile_digest },
    initial_subject_digest: prior.initial_subject_digest, subject_digest: verification.subject_digest!, h4_review_id: prior.h4_review_id,
    h4_result_digest: prior.h4_result_digest, acceptance_event_id: request.acceptance_event_id, transfer_id: source.transfer_id,
    source_export_digest: source.source_export_digest, mapping_digest: source.mapping_digest, research_provenance_digest: source.research_provenance_digest,
    closure: "windows-job-and-tools-closed.v1", scope: "all-declared-workspace-implementation-cases", verification };
}
