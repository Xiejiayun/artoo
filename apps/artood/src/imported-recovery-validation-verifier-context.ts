import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { canonicalProductSourceTransferValueV1 as canonical, importedExecutionAcceptedInputsV1,
  inspectImportedRecoveryValidationReviewVerificationEnvelopeV1, inspectImportedRecoveryValidationVerificationEnvelopeV1,
  importedRecoveryValidationReviewVerificationEchoV1, importedRecoveryValidationVerificationEchoV1,
  type ContextPack, type ProductResearchReport, type StaticWebCapabilityBinding } from "@artoo/domain";
import { assertWindowsProcessBackend, type PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
import { isV3WebAcceptanceOptions, type WebAcceptanceOptions } from "./web-acceptance-config.js";

const sha = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
type Input = {
  envelope: unknown; root: string; context: ContextPack; researchBytes: Uint8Array; designBytes: Uint8Array;
  requestId: string; scope: unknown; profileId: unknown; profileDigest: unknown; subjectDigest: unknown;
  binding: StaticWebCapabilityBinding; options: WebAcceptanceOptions; backend: PreparedWindowsProcessBackend;
};
type Kind = "review" | "author";
type Projection = { kind: Kind; input: Input; backend: PreparedWindowsProcessBackend; dev: number; ino: number; contextDigest: string;
  invocationDigest: string; researchDigest: string; researchSize: number; designDigest: string; designSize: number; research: ProductResearchReport };
// Child-only bindings cannot reconstruct the parent node's review or author authority.
const projections = new WeakMap<ContextPack, Projection>();
const invocation = (kind: Kind, input: Input) => canonical({ kind, root: input.root, envelope: input.envelope,
  requestId: input.requestId, scope: input.scope, profileId: input.profileId, profileDigest: input.profileDigest,
  subjectDigest: input.subjectDigest, binding: input.binding, options: input.options });
function inspect(kind: Kind, input: Input, researchBytes: Uint8Array, designBytes: Uint8Array) {
  if (kind === "review") {
    const value = inspectImportedRecoveryValidationReviewVerificationEnvelopeV1(input.envelope, researchBytes, designBytes, sha);
    const envelope = value.envelope;
    return { envelope, execution: envelope.request.origin.execution_request,
      start: envelope.phase === "before" ? envelope.request.before_start : envelope.request.after_start,
      scope: "final", research: value.research, echo: () => importedRecoveryValidationReviewVerificationEchoV1(envelope, input.binding.command_id, sha) };
  }
  const value = inspectImportedRecoveryValidationVerificationEnvelopeV1(input.envelope, researchBytes, designBytes, sha);
  const envelope = value.envelope;
  return { envelope, execution: envelope.request.origin.execution_request, start: envelope.request.run_start,
    scope: envelope.scope, research: value.research, echo: () => importedRecoveryValidationVerificationEchoV1(envelope, input.binding.command_id, sha) };
}
function bind(kind: Kind, input: Input) {
  assertWindowsProcessBackend(input.backend);
  if (projections.has(input.context)) throw Error("Validation verifier context is already bound");
  const inspected = inspect(kind, input, input.researchBytes, input.designBytes), envelope = inspected.envelope;
  const destination = inspected.execution.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination;
  const designPin = importedExecutionAcceptedInputsV1(inspected.execution).files.find(file => file.path === ".artoo/product/design.json");
  const stat = lstatSync(input.root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(input.root) !== input.root
    || destination.workspace_root !== input.root || canonical(input.context) !== canonical(inspected.start.context_pack.payload)
    || input.profileId !== destination.profile_id || input.profileDigest !== destination.capabilities.profile_digest
    || input.subjectDigest !== envelope.subject_digest || input.scope !== inspected.scope
    || input.requestId !== envelope.verification_request_id || input.binding.profile_digest !== input.profileDigest
    || !isV3WebAcceptanceOptions(input.options) || !input.options.windows_browser_process || input.options.design_capture_cases !== true
    || destination.capabilities.measurement_plan_policy?.version !== 2
    || !destination.capabilities.checks.some(check => check.command_id === input.binding.command_id
      && check.config_digest === input.binding.config_digest && check.contract_digest === input.binding.contract_digest
      && check.contract.browser_steps_version === 3 && check.contract.stage_policy.validation === "declared-cases")
    || !designPin || designPin.checksum !== sha(input.designBytes) || designPin.size !== input.designBytes.byteLength)
    throw Error("Validation private mapping differs from the exact phase, accepted inputs or protected command");
  const echo = inspected.echo();
  projections.set(input.context, { kind, input, backend: input.backend, dev: stat.dev, ino: stat.ino, contextDigest: sha(canonical(input.context)),
    invocationDigest: sha(invocation(kind, input)), researchDigest: sha(input.researchBytes), researchSize: input.researchBytes.byteLength,
    designDigest: sha(input.designBytes), designSize: input.designBytes.byteLength, research: structuredClone(inspected.research) });
  return echo;
}
export function bindImportedRecoveryValidationReviewVerifierContext(input: Input) { return bind("review", input); }
export function bindImportedRecoveryValidationVerifierContext(input: Input) { return bind("author", input); }
function readProjection(root: string, context: ContextPack, researchBytes: Uint8Array): Projection | undefined {
  const saved = projections.get(context);
  if (!saved) return undefined;
  const input = saved.input; assertWindowsProcessBackend(input.backend);
  const stat = lstatSync(root);
  if (input.backend !== saved.backend || input.context !== context || root !== input.root || realpathSync.native(root) !== root
    || !stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== saved.dev || stat.ino !== saved.ino
    || sha(canonical(context)) !== saved.contextDigest || sha(invocation(saved.kind, input)) !== saved.invocationDigest
    || researchBytes.byteLength !== saved.researchSize || sha(researchBytes) !== saved.researchDigest)
    throw Error("Validation private phase changed after binding");
  return saved;
}
/** Unbound in-process contexts must use the original node permit, never this child projection. */
export function readImportedRecoveryValidationVerifierResearch(root: string, context: ContextPack, bytes: Uint8Array): ProductResearchReport | undefined {
  const saved = readProjection(root, context, bytes);
  return saved ? structuredClone(saved.research) : undefined;
}
export function recheckImportedRecoveryValidationVerifierContext(root: string, context: ContextPack, researchBytes: Uint8Array, designBytes: Uint8Array) {
  const saved = readProjection(root, context, researchBytes);
  if (!saved) return undefined;
  if (designBytes.byteLength !== saved.designSize || sha(designBytes) !== saved.designDigest)
    throw Error("Validation accepted design bytes changed during protected execution");
  return inspect(saved.kind, saved.input, researchBytes, designBytes).echo();
}
