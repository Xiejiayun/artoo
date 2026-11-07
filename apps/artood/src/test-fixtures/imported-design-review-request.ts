// Controlled protocol/runtime fixture. All changed capabilities, receipts and
// browser observations below are synthetic; no native/model execution is claimed.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { canonicalProductSourceTransferValueV1 as canonical, productSourceExportDigestV2, productSourceTransferRequestDigestV1,
  productSourceTransferRequestDigestV2, describeProductSourceMeasurementMappingV1, inspectProductSourceVerificationEnvelope,
  evaluateDeclaredMeasurementPlanV2, importedDesignContinuationRequestDigestV1, inspectImportedCompletedDesignV1,
  importedDesignReviewSubjectV1, importedDesignReviewRequestDigestV1, inspectImportedDesignReviewRequestV1,
  type ImportedDesignContinuationRequestV1, type ImportedDesignContinuationResultV1,
  type ImportedDesignReviewRequestV1, type ImportedDesignReviewResultV1, type RunVerificationPayload } from "@artoo/domain";
import { importedDesignRequestFixture } from "./imported-design-request.js";
export const fixtureSha = (bytes: string | Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const sha = fixtureSha;
function substitute(value: any, before: string, after: string): any {
  if (typeof value === "string") return value.replaceAll(before, after);
  if (Array.isArray(value)) return value.map(item => substitute(item, before, after));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, before, after)]));
  return value;
}
export function importedAllCaseRecordFixture() {
  let record = JSON.parse(readFileSync(new URL("../../../../packages/domain/test-fixtures/product-source-operation.json", import.meta.url), "utf8"));
  const original = record.admission.request;
  const pairs: [string, string][] = [[original.source_export.source_capabilities.profile_digest, sha("controlled-all-case-source-profile")],
    [original.byte_request.destination.capabilities.profile_digest, sha("controlled-all-case-destination-profile")],
    [original.source_export.source_capabilities.checks[0].config_digest, sha("controlled-source-all-case-options")],
    [original.byte_request.destination.capabilities.checks[0].config_digest, sha("controlled-destination-all-case-options")]];
  const contract = structuredClone(original.source_export.source_capabilities.checks[0].contract); contract.stage_policy.design = "declared-cases";
  pairs.push([original.source_export.source_capabilities.checks[0].contract_digest, sha(canonical(contract))]);
  for (const [before, after] of pairs) record = substitute(record, before, after);
  record = substitute(record, "prototype-only", "declared-cases");
  const request = record.admission.request, capabilities = request.byte_request.destination.capabilities, bytes = Buffer.from(record.research);
  const pin = { path: ".artoo/product/research.json", checksum: sha(bytes), size: bytes.length };
  request.source_export.research_provenance.research = pin;
  request.source_export.research_provenance_digest = sha(canonical(request.source_export.research_provenance));
  request.source_export_digest = productSourceExportDigestV2(request.source_export, sha);
  request.byte_request.destination.capability_digest = sha(canonical(capabilities));
  record.admission.request_digest = productSourceTransferRequestDigestV2(request, sha);
  record.admission.ready.request_digest = productSourceTransferRequestDigestV1(request.byte_request, sha);
  const mapped = describeProductSourceMeasurementMappingV1({ transfer: { request_digest: record.admission.request_digest,
    capsule_digest: record.admission.ready.capsule_digest, source_subject_digest: request.byte_request.source.subject_digest,
    destination_subject_digest: record.admission.ready.destination.subject_digest }, researchPin: pin, researchBytes: bytes,
    sourceCapabilities: request.source_export.source_capabilities, destinationCapabilities: capabilities, commandPairs: request.command_pairs,
    sourceRelease: request.source_export.measurement_v2.source_release, destinationRelease: request.measurement_v2.destination_release, sha256: sha });
  record.admission.mapping = mapped.mapping;
  const inspected = inspectProductSourceVerificationEnvelope(record.admission, bytes, sha);
  Object.assign(record.fresh, { request_digest: record.admission.request_digest, source_export_digest: request.source_export_digest,
    research_provenance_digest: request.source_export.research_provenance_digest, admission_digest: inspected.admission_digest,
    mapping_digest: sha(canonical(mapped.mapping)) });
  const { canonical_plan, ...counts } = evaluateDeclaredMeasurementPlanV2({ research: { ...JSON.parse(record.research), measurement_plan: mapped.effective_plan },
    policy: capabilities.measurement_plan_policy, capabilities, releaseCapabilities: request.measurement_v2.destination_release, digest: sha });
  record.fresh.verification.required_files = [pin];
  record.fresh.verification.measurement_plan = { version: 2, claim: "declared-mapping-feasibility", scope: "final", policy: capabilities.measurement_plan_policy,
    research: pin, measurement_plan_digest: sha(canonical_plan), ...counts };
  return record;
}
export function controlledDesignVerification(request: ImportedDesignContinuationRequestV1): RunVerificationPayload {
  const accepted = request.review_result;
  if (accepted.outcome !== "reviewed") throw Error("Controlled H2 accepted fixture required");
  const result = structuredClone(accepted.after.fresh.verification);
  result.request_id = request.run_start.verification!.request_id; result.subject_digest = sha("controlled completed design subject");
  result.required_files.push({ path: ".artoo/product/design.json", checksum: sha("controlled design bytes"), size: 23 });
  for (const check of result.checks) {
    if (check.observation?.version !== 3) throw Error("Controlled v3 observation required");
    check.observation.stage = "design";
    check.observation.cases = [{ case_id: "controlled-design-case", viewport: { id: "compact", width: 390, height: 844 },
      program_digest: sha("controlled browser program"), assertions: 1, operation_count: 2, trace_digest: sha("controlled trace"), trace_size: 123,
      trace_ref: "controlled_trace", captures: [{ page_id: "main", screenshot_digest: sha("controlled image"), screenshot_ref: "controlled_image", timing: { kind: "case-end" } }] }];
  }
  return result;
}
export function importedCompletedDesignResultFixture(request: ImportedDesignContinuationRequestV1,
  verification = controlledDesignVerification(request)): ImportedDesignContinuationResultV1 {
  const transfer = request.review_request.operation.intent.request, destination = transfer.byte_request.destination;
  const mapped = request.run_start.context_pack.payload.transferred_product_input;
  const verified_design = inspectImportedCompletedDesignV1(request, { version: 1, continuation_id: request.continuation_id,
    request_digest: importedDesignContinuationRequestDigestV1(request, sha), run_id: request.run_start.run_id,
    run_start_digest: sha(canonical(request.run_start)), subject_digest: verification.subject_digest, author: request.writer,
    destination: { node_id: destination.node_id, workspace_root: destination.workspace_root, profile_id: destination.profile_id, profile_digest: destination.capabilities.profile_digest },
    transfer_id: transfer.byte_request.transfer_id, source_export_digest: transfer.source_export_digest, mapping_digest: mapped.mapping_digest,
    research_provenance_digest: mapped.research_provenance_digest, scope: "all-declared-workspace-design-cases", closure: "windows-job-and-tools-closed.v1", verification }, sha);
  return { version: 1, continuation_id: request.continuation_id, request_digest: verified_design.request_digest,
    run_id: request.run_start.run_id, outcome: "finished", closed: true, verified_design };
}
export function h4RequestForCompletedFixture(continuation_request: ImportedDesignContinuationRequestV1,
  continuation_result: ImportedDesignContinuationResultV1): ImportedDesignReviewRequestV1 {
  if (continuation_result.outcome !== "finished" || !continuation_result.verified_design) throw Error("Controlled completed design required");
  const subjectDigest = continuation_result.verified_design.subject_digest;
  const starts = ["before", "review", "after"].map(phase => {
    const start = structuredClone(continuation_request.run_start);
    start.run_id = "h4-" + phase + "-run"; start.verification!.request_id = "h4-" + phase + "-request";
    start.verification!.expected_subject_digest = subjectDigest; start.policy_snapshot.filesystem_write_scope = [];
    start.context_pack.payload.policy.filesystem_write_scope = []; return start;
  });
  const [before_start, review_start, after_start] = starts as [typeof starts[number], typeof starts[number], typeof starts[number]];
  const context = review_start.context_pack.payload; review_start.task_id = "h4-review-task"; review_start.agent_instance_id = "h4-reviewer-instance";
  context.task.id = review_start.task_id; context.policy.execution_mode = "discussion"; delete context.product_development;
  const request: ImportedDesignReviewRequestV1 = { version: 1, review_id: "h4-review", continuation_request, continuation_result,
    reviewer: { agent_id: "h4-reviewer-agent", instance_id: review_start.agent_instance_id }, before_start, review_start, after_start };
  for (const start of starts) start.context_pack.payload.imported_design_review_subject = importedDesignReviewSubjectV1(request, sha);
  return request;
}
export function importedDesignReviewRequestFixture() {
  const { request: continuation, bytes } = importedDesignRequestFixture(importedAllCaseRecordFixture());
  const completion = importedCompletedDesignResultFixture(continuation), request = h4RequestForCompletedFixture(continuation, completion);
  inspectImportedDesignReviewRequestV1(request, bytes, sha);
  if (completion.outcome !== "finished" || !completion.verified_design) throw Error("Controlled completion unavailable");
  const measure = (start: typeof request.before_start) => ({ run_id: start.run_id, config_digest: sha(canonical(start)), closure: "windows-job-and-tools-closed.v1" as const,
    scope: "all-declared-workspace-design-cases" as const, verification: { ...structuredClone(completion.verified_design!.verification), request_id: start.verification!.request_id } });
  const subject = importedDesignReviewSubjectV1(request, sha);
  const result: ImportedDesignReviewResultV1 = { version: 1, review_id: request.review_id, request_digest: importedDesignReviewRequestDigestV1(request, sha),
    execution_authorized: false, outcome: "reviewed", closed: true, before: measure(request.before_start), after: measure(request.after_start),
    reviewer: { run_id: request.review_start.run_id, config_digest: sha(canonical(request.review_start)), closure: "windows-job-and-tools-closed.v1" },
    verdict: { version: 1, review_id: request.review_id, continuation_id: continuation.continuation_id, completed_design_digest: subject.completed_design_digest,
      subject_digest: subject.subject_digest, outcome: "accepted", summary: "Controlled reviewer fixture; no model/browser execution", findings: [] } };
  return { request, bytes, result };
}
