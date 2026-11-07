import { ContextPackSchema, MeasurementPlanSummarySchema, productStageHandoffPaths,
  type RunVerificationPayload, type VerificationRequirement } from "@artoo/domain";
import { isDeepStrictEqual } from "node:util";
import { verificationCapabilityBinding } from "./verification-capabilities.js";

/** Qualify node attestation against persisted scope; this does not derive plan semantics or a digest from prose. */
export function measurementPlanQualificationError(payload: RunVerificationPayload, requirement: VerificationRequirement,
  persistedContext: unknown | undefined): string | undefined {
  const parsedContext = persistedContext === undefined ? undefined : ContextPackSchema.safeParse(persistedContext);
  if (parsedContext && !parsedContext.success) return "Stored verification context is malformed";
  const context = parsedContext?.data, capabilities = context?.verification_capabilities;
  const policy = capabilities?.measurement_plan_policy, summary = payload.measurement_plan;
  if (payload.outcome !== "passed") return summary === undefined ? undefined : "Failed verification cannot carry a measurement-plan summary";
  // A bound request cannot prove it was legacy if its policy snapshot was lost.
  if (!context && (requirement.capability_binding || requirement.release_capability_binding)) return "Capability-bound verification lacks its persisted context";
  if (!policy) return summary === undefined && !context?.release_capabilities && !requirement.release_capability_binding
    ? undefined : "Measurement-plan summary has no persisted policy";
  if (!summary) return "Passed verification lacks its required measurement-plan summary";
  const parsed = MeasurementPlanSummarySchema.safeParse(summary);
  if (!parsed.success || summary.scope !== "final" || !isDeepStrictEqual(summary.policy, policy)) {
    return "Measurement-plan summary differs from its final persisted policy";
  }
  const stage = context?.product_development?.stage ?? context?.review_subject?.development_stage;
  if (!context || !stage || !capabilities) return "Measurement-plan policy requires a persisted product or review stage";
  const release = context.release_capabilities;
  if (summary.version === 1 && (release || requirement.release_capability_binding)) return "Legacy measurement plan cannot adopt publication acceptance";
  if (summary.version === 2) {
    if (!isDeepStrictEqual(requirement.release_capability_binding, release?.binding)) return "Release capability differs from the persisted verification requirement";
    if (release && (release.binding.project_id !== context.project.id || release.binding.workspace_root !== context.workspace.root
      || release.binding.verification_profile_id !== requirement.profile_id || release.binding.verification_profile_digest !== payload.profile_digest
      || !context.goal_context?.plan || summary.pending_release.length === 0)) return "Publication acceptance lacks its fixed goal, profile or pending criteria";
    if (summary.pending_release.some(ref => !release || !isDeepStrictEqual(ref.release_binding, release.binding)
      || ref.claim_id !== release.contract.criterion.id || ref.statement_digest !== release.contract.criterion.statement_digest)) {
      return "Pending release criteria differ from the configured publication contract";
    }
  }
  if (payload.checks.some((check) => check.observation && check.observation.stage !== stage)) {
    return "Measurement-plan observations differ from the persisted product stage";
  }
  const expectedBinding = verificationCapabilityBinding(capabilities);
  if (capabilities.profile_id !== requirement.profile_id || payload.profile_id !== requirement.profile_id
    || payload.profile_digest !== capabilities.profile_digest || !isDeepStrictEqual(requirement.capability_binding, expectedBinding)) {
    return "Measurement-plan policy differs from the persisted verification binding";
  }
  if (requirement.expected_subject_digest !== undefined && payload.subject_digest !== requirement.expected_subject_digest) {
    return "Measurement-plan verification differs from the required source digest";
  }
  if (productStageHandoffPaths(stage).some((path) => !payload.required_files.some((file) => file.path === path && file.size > 0))) {
    return "Product stage lacks node-measured handoff file evidence";
  }
  const research = payload.required_files.find((file) => file.path === ".artoo/product/research.json");
  if (!isDeepStrictEqual(research, summary.research)) return "Measurement-plan research differs from the node-measured file";
  const pins = context.product_development?.accepted_inputs?.files ?? [];
  if (context.product_development && stage !== "research" && !pins.some((pin) => pin.path === summary.research.path)) {
    return "Measurement-plan stage has no accepted research pin";
  }
  for (const pin of pins) {
    const actual = payload.required_files.find((file) => file.path === pin.path);
    if (!actual || actual.checksum !== pin.checksum || actual.size !== pin.size) return `Accepted product input changed: ${pin.path}`;
  }
  for (const used of summary.used_checks) {
    const configured = capabilities.checks.find((check) => check.command_id === used.command_id);
    const requested = requirement.capability_binding?.checks.find((check) => check.command_id === used.command_id);
    const actual = payload.checks.find((check) => check.id === used.command_id);
    if (!configured || !isDeepStrictEqual(used, requested)
      || used.config_digest !== configured.config_digest || used.contract_digest !== configured.contract_digest
      || actual?.exit_code !== 0 || !isDeepStrictEqual(actual.observation?.capability_binding,
        { version: 1, profile_digest: payload.profile_digest, ...used })) {
      return "Measurement-plan used checks differ from the configured, requested or measured bindings";
    }
  }
  if (context.review_subject) {
    const source = context.review_subject.verification;
    if (context.review_subject.subject_digest !== payload.subject_digest
      || source?.profile_id !== payload.profile_id || source.profile_digest !== payload.profile_digest
      || !isDeepStrictEqual(source.measurement_plan, summary)) {
      return "Independent measurement-plan summary differs from its persisted reviewed source";
    }
  }
  return undefined;
}
