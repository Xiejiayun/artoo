import { z } from "zod";
import { ProductResearchReportV1Schema, ProductResearchReportV2Schema } from "./product-development.js";
import { MeasurementPlanPolicySchema, ProductMeasurementPlanSchema, evaluateDeclaredMeasurementPlanV1,
  evaluateDeclaredMeasurementPlanV2, type ProductMeasurementPlan } from "./measurement-plan.js";
import { VerificationCapabilitiesSchema } from "./verification-capabilities.js";
import { canonicalReleaseJson, ReleaseCapabilitiesV1Schema } from "./release-capabilities.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const identifier = z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/u);
const binding = z.object({ command_id: identifier, config_digest: digest, contract_digest: digest }).strict();
const researchPin = z.object({ path: z.literal(".artoo/product/research.json"), checksum: digest,
  size: z.number().int().min(1).max(1024 * 1024) }).strict();
const transferBinding = z.object({ request_digest: digest, capsule_digest: digest,
  source_subject_digest: digest, destination_subject_digest: digest }).strict();
const commandPairs = z.array(z.object({ source_command_id: identifier, destination_command_id: identifier }).strict()).min(1).max(32)
  .refine(pairs => new Set(pairs.map(pair => pair.source_command_id)).size === pairs.length
    && new Set(pairs.map(pair => pair.destination_command_id)).size === pairs.length, "Check mapping must be one-to-one");

/** Public configuration equivalence, never authenticated import, research provenance or execution authority. */
export const ProductSourceMeasurementMappingV1Schema = z.object({
  version: z.literal(1), claim: z.literal("configured-measurement-equivalence"),
  transfer: transferBinding, research: researchPin,
  source_profile_digest: digest, destination_profile_digest: digest,
  source_capabilities_digest: digest, destination_capabilities_digest: digest,
  source_measurement_plan_digest: digest, effective_measurement_plan_digest: digest,
  checks: z.array(z.object({ source: binding, destination: binding }).strict()).min(1).max(32),
  release: z.object({ source_capabilities_digest: digest, destination_capabilities_digest: digest,
    contract_digest: digest }).strict().optional(),
  verification_passed: z.literal(false), execution_authorized: z.literal(false),
}).strict().superRefine((value, context) => {
  if (new Set(value.checks.map(check => check.source.command_id)).size !== value.checks.length
    || new Set(value.checks.map(check => check.destination.command_id)).size !== value.checks.length
    || value.checks.some(check => check.source.contract_digest !== check.destination.contract_digest)) {
    context.addIssue({ code: "custom", path: ["checks"], message: "Check mapping must preserve unique bindings and exact contracts" });
  }
});
export type ProductSourceMeasurementMappingV1 = z.infer<typeof ProductSourceMeasurementMappingV1Schema>;

/**
 * Describes a possible destination configuration without changing accepted report bytes.
 * A trusted caller must separately authenticate the transfer, source receipts and local
 * prepared destination profile, then run fresh destination verification. This function
 * is deliberately not called by the existing verifier, scheduler or context builder.
 */
export function describeProductSourceMeasurementMappingV1(input: {
  transfer: unknown; researchPin: unknown; researchBytes: Uint8Array;
  sourceCapabilities: unknown; destinationCapabilities: unknown; commandPairs: unknown;
  sourceRelease?: unknown; destinationRelease?: unknown;
  sha256: (value: string | Uint8Array) => string;
}): { mapping: ProductSourceMeasurementMappingV1; effective_plan: ProductMeasurementPlan } {
  const hash = (value: string | Uint8Array) => digest.parse(input.sha256(value));
  const transfer = transferBinding.parse(input.transfer), pin = researchPin.parse(input.researchPin);
  if (!(input.researchBytes instanceof Uint8Array) || input.researchBytes.byteLength !== pin.size
    || hash(input.researchBytes) !== pin.checksum) throw new Error("Transferred research bytes differ from their measured pin");
  const original = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input.researchBytes));
  const source = VerificationCapabilitiesSchema.parse(input.sourceCapabilities);
  const destination = VerificationCapabilitiesSchema.parse(input.destinationCapabilities);
  const policy = MeasurementPlanPolicySchema.parse(source.measurement_plan_policy);
  if (canonicalReleaseJson(policy) !== canonicalReleaseJson(MeasurementPlanPolicySchema.parse(destination.measurement_plan_policy))) {
    throw new Error("Transferred measurement policy differs between source and destination");
  }
  const pairs = commandPairs.parse(input.commandPairs);
  // Map every configured check: optional design cases may use checks not mentioned
  // by a must-criterion entry. A partial mapping must not make those cases disappear.
  if (pairs.length !== source.checks.length || pairs.length !== destination.checks.length) throw new Error("Transfer requires a complete check mapping");
  const checks = pairs.map(pair => {
    const from = source.checks.find(check => check.command_id === pair.source_command_id);
    const to = destination.checks.find(check => check.command_id === pair.destination_command_id);
    if (!from || !to) throw new Error("Transfer mapping contains an unknown check");
    if (canonicalReleaseJson(from.contract) !== canonicalReleaseJson(to.contract)
      || from.contract_digest !== to.contract_digest
      || hash(canonicalReleaseJson(from.contract)) !== from.contract_digest
      || hash(canonicalReleaseJson(to.contract)) !== to.contract_digest) throw new Error("Transfer check contracts differ or have an invalid digest");
    return { source: { command_id: from.command_id, config_digest: from.config_digest, contract_digest: from.contract_digest },
      destination: { command_id: to.command_id, config_digest: to.config_digest, contract_digest: to.contract_digest } };
  }).sort((a, b) => a.source.command_id < b.source.command_id ? -1 : a.source.command_id > b.source.command_id ? 1 : 0);
  const sourceRelease = input.sourceRelease === undefined ? undefined : ReleaseCapabilitiesV1Schema.parse(input.sourceRelease);
  const destinationRelease = input.destinationRelease === undefined ? undefined : ReleaseCapabilitiesV1Schema.parse(input.destinationRelease);
  if (!!sourceRelease !== !!destinationRelease) throw new Error("Release mapping requires both source and destination configurations");
  if (sourceRelease && destinationRelease && (policy.version !== 2
    || sourceRelease.binding.verification_profile_digest !== source.profile_digest
    || destinationRelease.binding.verification_profile_digest !== destination.profile_digest
    || sourceRelease.binding.project_id !== destinationRelease.binding.project_id
    || canonicalReleaseJson(sourceRelease.contract) !== canonicalReleaseJson(destinationRelease.contract)
    || sourceRelease.binding.contract_digest !== destinationRelease.binding.contract_digest
    || hash(canonicalReleaseJson(sourceRelease.contract)) !== sourceRelease.binding.contract_digest)) {
    throw new Error("Transferred release contracts or profile bindings differ");
  }
  const research = policy.version === 1 ? ProductResearchReportV1Schema.parse(original) : ProductResearchReportV2Schema.parse(original);
  const evaluate = (plan: ProductMeasurementPlan, capabilities: typeof source, release: typeof sourceRelease) => policy.version === 1
    ? evaluateDeclaredMeasurementPlanV1({ research: { ...research, measurement_plan: plan }, policy, capabilities })
    : evaluateDeclaredMeasurementPlanV2({ research: { ...research, measurement_plan: plan }, policy, capabilities, releaseCapabilities: release, digest: hash });
  const plan = ProductMeasurementPlanSchema.parse(research.measurement_plan);
  if (plan.version !== policy.version) throw new Error("Transferred plan and measurement policy versions differ");
  const accepted = evaluate(plan, source, sourceRelease);
  const effective = ProductMeasurementPlanSchema.parse({ ...plan, profile_digest: destination.profile_digest,
    entries: plan.entries.map(entry => {
      if ("method" in entry && entry.method === "configured-static-release") {
        if (!destinationRelease) throw new Error("Transferred release criterion has no destination configuration");
        return { ...entry, release_binding: destinationRelease.binding };
      }
      const selected = checks.find(check => check.source.command_id === entry.command_id);
      if (!selected) throw new Error("Transferred criterion has no mapped destination check");
      return { ...entry, ...selected.destination };
    }) });
  const measured = evaluate(effective, destination, destinationRelease);
  return { effective_plan: effective, mapping: ProductSourceMeasurementMappingV1Schema.parse({ version: 1,
    claim: "configured-measurement-equivalence", transfer, research: pin,
    source_profile_digest: source.profile_digest, destination_profile_digest: destination.profile_digest,
    source_capabilities_digest: hash(canonicalReleaseJson(source)), destination_capabilities_digest: hash(canonicalReleaseJson(destination)),
    source_measurement_plan_digest: hash(accepted.canonical_plan), effective_measurement_plan_digest: hash(measured.canonical_plan), checks,
    ...(sourceRelease && destinationRelease ? { release: { source_capabilities_digest: hash(canonicalReleaseJson(sourceRelease)),
      destination_capabilities_digest: hash(canonicalReleaseJson(destinationRelease)), contract_digest: sourceRelease.binding.contract_digest } } : {}),
    verification_passed: false, execution_authorized: false }) };
}
