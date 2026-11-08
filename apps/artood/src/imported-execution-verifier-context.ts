import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { canonicalProductSourceTransferValueV1 as canonical, inspectImportedExecutionVerificationEnvelopeV1,
  importedExecutionVerificationEchoV1, type ContextPack, type ProductResearchReport, type StaticWebCapabilityBinding } from "@artoo/domain";
import { assertWindowsProcessBackend, type PreparedWindowsProcessBackend } from "./owned/windows-owned-process.js";
import { isV3WebAcceptanceOptions, type WebAcceptanceOptions } from "./web-acceptance-config.js";

const sha = (value: string | Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
type Input = {
  envelope: unknown; root: string; context: ContextPack; researchBytes: Uint8Array; designBytes: Uint8Array;
  requestId: string; scope: unknown; profileId: unknown; profileDigest: unknown; subjectDigest: unknown;
  binding: StaticWebCapabilityBinding; options: WebAcceptanceOptions; backend: PreparedWindowsProcessBackend;
};
type Projection = { input: Input; backend: PreparedWindowsProcessBackend; dev: number; ino: number; contextDigest: string; invocationDigest: string;
  researchDigest: string; researchSize: number; designDigest: string; designSize: number; research: ProductResearchReport };
// Child-only H5 projection. Neither H3's writer registry nor local revision authority is consulted.
const projections = new WeakMap<ContextPack, Projection>();
const invocation = (input: Input) => canonical({ root: input.root, envelope: input.envelope, requestId: input.requestId, scope: input.scope,
  profileId: input.profileId, profileDigest: input.profileDigest, subjectDigest: input.subjectDigest, binding: input.binding, options: input.options });

/** Called only after the independently hashed private envelope prepares the original native Job backend. */
export function bindImportedExecutionVerifierContext(input: Input) {
  assertWindowsProcessBackend(input.backend);
  if (projections.has(input.context)) throw Error("H5 verifier context is already bound");
  const inspected = inspectImportedExecutionVerificationEnvelopeV1(input.envelope, input.researchBytes, input.designBytes, sha);
  const envelope = inspected.envelope, request = envelope.request;
  const start = request.run_start;
  const destination = request.review_request.continuation_request.review_request.operation.intent.request.byte_request.destination;
  const completed = request.review_request.continuation_result.outcome === "finished" ? request.review_request.continuation_result.verified_design : undefined;
  const designPins = completed?.verification.required_files.filter(file => file.path === ".artoo/product/design.json");
  const stat = lstatSync(input.root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(input.root) !== input.root
    || destination.workspace_root !== input.root || canonical(input.context) !== canonical(start.context_pack.payload)
    || input.profileId !== destination.profile_id || input.profileDigest !== destination.capabilities.profile_digest
    || input.subjectDigest !== envelope.subject_digest || input.scope !== envelope.scope
    || input.requestId !== envelope.verification_request_id || input.binding.profile_digest !== input.profileDigest
    || !isV3WebAcceptanceOptions(input.options) || !input.options.windows_browser_process || input.options.design_capture_cases !== true
    || destination.capabilities.measurement_plan_policy?.version !== 2
    || !destination.capabilities.checks.some(check => check.command_id === input.binding.command_id
      && check.config_digest === input.binding.config_digest && check.contract_digest === input.binding.contract_digest
      && check.contract.browser_steps_version === 3 && check.contract.stage_policy.implementation === "declared-cases")
    || designPins?.length !== 1 || designPins[0]!.checksum !== sha(input.designBytes) || designPins[0]!.size !== input.designBytes.byteLength) {
    throw Error("H5 private mapping differs from the exact phase, completed design or protected command context");
  }
  projections.set(input.context, { input, backend: input.backend, dev: stat.dev, ino: stat.ino, contextDigest: sha(canonical(input.context)),
    invocationDigest: sha(invocation(input)), researchDigest: sha(input.researchBytes), researchSize: input.researchBytes.byteLength,
    designDigest: sha(input.designBytes), designSize: input.designBytes.byteLength, research: structuredClone(inspected.research) });
  return importedExecutionVerificationEchoV1(envelope, input.binding.command_id, sha);
}

function readProjection(root: string, context: ContextPack, researchBytes: Uint8Array): Projection | undefined {
  const saved = projections.get(context);
  if (!saved) return undefined;
  const input = saved.input; assertWindowsProcessBackend(input.backend);
  const stat = lstatSync(root);
  if (input.backend !== saved.backend || input.context !== context || root !== input.root || realpathSync.native(root) !== root || !stat.isDirectory() || stat.isSymbolicLink()
    || stat.dev !== saved.dev || stat.ino !== saved.ino || sha(canonical(context)) !== saved.contextDigest
    || sha(invocation(input)) !== saved.invocationDigest
    || researchBytes.byteLength !== saved.researchSize || sha(researchBytes) !== saved.researchDigest) {
    throw Error("H5 phase projection changed after private context binding");
  }
  return saved;
}

/** An unbound node context may consult only its separately owned H5 in-process permit. */
export function readImportedExecutionVerifierResearch(root: string, context: ContextPack, bytes: Uint8Array): ProductResearchReport | undefined {
  const saved = readProjection(root, context, bytes);
  return saved ? structuredClone(saved.research) : undefined;
}

/** Check raw files and the original phase again before emitting the child echo. */
export function recheckImportedExecutionVerifierContext(root: string, context: ContextPack, researchBytes: Uint8Array, designBytes: Uint8Array) {
  const saved = readProjection(root, context, researchBytes);
  if (!saved) return undefined;
  if (designBytes.byteLength !== saved.designSize || sha(designBytes) !== saved.designDigest) {
    throw Error("H5 completed design bytes changed during protected browser execution");
  }
  const inspected = inspectImportedExecutionVerificationEnvelopeV1(saved.input.envelope, researchBytes, designBytes, sha);
  return importedExecutionVerificationEchoV1(inspected.envelope, saved.input.binding.command_id, sha);
}
