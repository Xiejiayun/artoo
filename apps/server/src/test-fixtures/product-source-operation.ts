// Controlled data-only destination receipts for server binding tests. No verifier/process/browser is run.
import {createHash} from "node:crypto";
import {canonicalProductSourceTransferValueV1 as canonical, productSourceOperationDigestV1,productSourceTransferRequestDigestV1,
  describeProductSourceMeasurementMappingV1,inspectProductSourceVerificationEnvelope,evaluateDeclaredMeasurementPlanV2,
  type ProductSourceOperationV1,type ProductSourceOperationResultV1} from "@artoo/domain";
const sha=(v:string|Uint8Array)=>`sha256:${createHash("sha256").update(v).digest("hex")}`;
export function controlledDestinationResult(operation:ProductSourceOperationV1,researchBytes:Uint8Array):ProductSourceOperationResultV1 {
  const request=operation.intent.request,base=request.byte_request,capabilities=base.destination.capabilities,start=operation.intent.destination_start;
  const ready={version:1,transfer_id:base.transfer_id,request_digest:productSourceTransferRequestDigestV1(base,sha),capsule_digest:base.source.capsule_digest,manifest_digest:base.source.manifest_digest,
    destination:{node_id:base.destination.node_id,project_id:base.project_id,profile_id:base.destination.profile_id,profile_digest:capabilities.profile_digest,
      workspace_root:base.destination.workspace_root,subject_digest:base.source.subject_digest},git_metadata_digest:sha("controlled Git metadata; no actual Git"),
    git_processes_closed:true,verification_passed:false,execution_authorized:false,semantic_mapping_accepted:false};
  const mapped=describeProductSourceMeasurementMappingV1({transfer:{request_digest:operation.request_digest,capsule_digest:base.source.capsule_digest,
    source_subject_digest:base.source.subject_digest,destination_subject_digest:base.source.subject_digest},researchPin:request.source_export.research_provenance.research,
    researchBytes,sourceCapabilities:request.source_export.source_capabilities,destinationCapabilities:capabilities,commandPairs:request.command_pairs,
    sourceRelease:request.source_export.measurement_v2!.source_release,destinationRelease:request.measurement_v2!.destination_release,sha256:sha});
  const inspected=inspectProductSourceVerificationEnvelope({version:2,request,request_digest:operation.request_digest,ready,run_start:start,mapping:mapped.mapping},researchBytes,sha);
  if(capabilities.measurement_plan_policy?.version!==2)throw Error("Controlled operation requires v2");
  const {canonical_plan,...counts}=evaluateDeclaredMeasurementPlanV2({research:{...JSON.parse(new TextDecoder().decode(researchBytes)),measurement_plan:mapped.effective_plan},
    policy:capabilities.measurement_plan_policy,capabilities,releaseCapabilities:request.measurement_v2!.destination_release,digest:sha});
  return {version:1,operation_id:operation.operation_id,payload_digest:productSourceOperationDigestV1(operation,sha),request_digest:operation.request_digest,outcome:"verified",closed:true,
    admission:inspected.envelope,fresh:{version:1,claim:"fresh-destination-research-verification",request_digest:operation.request_digest,source_export_digest:request.source_export_digest,
      admission_digest:inspected.admission_digest,mapping_digest:sha(canonical(mapped.mapping)),research_provenance_digest:request.source_export.research_provenance_digest,
      destination_run_id:start.run_id,execution_authorized:false,automatic_review_authorized:false,verification:{version:1,request_id:start.verification!.request_id,
        profile_id:base.destination.profile_id,profile_digest:capabilities.profile_digest,subject_digest:base.source.subject_digest,outcome:"passed",
        checks:capabilities.checks.map(check=>({id:check.command_id,exit_code:0,duration_ms:1,output_digest:sha("controlled output"),observation:{version:3,
          format:"static-web-acceptance.v3",scope:"final",stage:"research",device_scale_factor:1,cases:[],capability_binding:{version:1,
            profile_digest:capabilities.profile_digest,command_id:check.command_id,config_digest:check.config_digest,contract_digest:check.contract_digest},
          evidence_bundle:{bundle_id:"controlled_no_browser",manifest_digest:sha("controlled empty evidence")}}})),
        required_files:[request.source_export.research_provenance.research],measurement_plan:{version:2,claim:"declared-mapping-feasibility",scope:"final",
          policy:capabilities.measurement_plan_policy,research:request.source_export.research_provenance.research,measurement_plan_digest:sha(canonical_plan),...counts}}}};
}
