import { z } from "zod";
import { RunVerificationPayloadSchema, type RunVerificationPayload } from "./autonomy.js";
import { ContextPackSchema } from "./context-pack.js";
import { RunStartPayloadSchema } from "./node-payloads.js";

// Public metadata contracts. Parsing never grants a local prepared handle,
// writer permit, verification issuer or acceptance authority.
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/u);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const text = z.string().min(1).max(4096).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
// Lexical POSIX audit fact only. It proves neither a physical path nor access.
const physicalRoot = text.refine(value => value.startsWith("/") && value.length > 1
  && value.slice(1).split("/").every(part => part && part !== "." && part !== "..") && !value.includes("\\"));
const relativePath = z.string().min(1).max(1024).refine(value => !value.startsWith("/") && !value.startsWith("-")
  && !value.includes("\\") && !value.includes(":") && !/[\u0000-\u001f\u007f]/u.test(value)
  && value.split("/").every(part => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git"));
const workspace = z.object({ root: physicalRoot, branch: text }).strict();
const covered = (path: string, roots: readonly string[]) => roots.some(root => path === root || path.startsWith(`${root}/`));
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);

/** SHA-256 of UTF-8 `null`, exactly matching absent local verifier context.
 * This is unrelated to the separately frozen author ContextPack digest. */
export const OWNED_RESULT_NO_VERIFICATION_CONTEXT_DIGEST = "sha256:74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b" as const;
export const OwnedResultVerificationContextPolicyV1Schema = z.object({ version: z.literal(1), mode: z.literal("none") }).strict();

/** Exact local result reference; its containing contract supplies the version. */
export const OwnedResultReferenceV1Schema = z.object({ result_id: id, receipt_digest: digest }).strict();
export type OwnedResultReferenceV1 = z.infer<typeof OwnedResultReferenceV1Schema>;
const resultProfile = z.object({ id, digest, repository_binding: digest, baseline_commit: oid }).strict();
const verifierTemplate = z.object({ id, digest }).strict();

/** Routing facts to be derived from an opened store and a genuine prepared
 * template. Parsing metadata does not advertise an executable local capability. */
export const NodeOwnedResultProfileDescriptorV1Schema = z.object({
  version: z.literal(1), node_id: id, project_id: id,
  result_profile: resultProfile, verifier_template: verifierTemplate,
  workspace_strategy: z.literal("per-run"), verification_mode: z.literal("plain-commands"),
  verification_context_policy: OwnedResultVerificationContextPolicyV1Schema,
  content_paths: z.array(relativePath).min(1).max(32),
  scope: z.literal("authored-result command verification; no product-stage, review or publication acceptance"),
}).strict().superRefine((value, ctx) => {
  for (let index = 0; index < value.content_paths.length; index++) {
    const path = value.content_paths[index]!;
    if (value.content_paths.slice(index + 1).some(other => path === other || path.startsWith(`${other}/`) || other.startsWith(`${path}/`))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["content_paths"], message: "Content paths must be unique and nonoverlapping" });
    }
  }
});
export type NodeOwnedResultProfileDescriptorV1 = z.infer<typeof NodeOwnedResultProfileDescriptorV1Schema>;
export const NodeOwnedResultProfileDescriptorsV1Schema = z.array(NodeOwnedResultProfileDescriptorV1Schema).max(64)
  .superRefine((values, ctx) => {
    const pairs = new Set<string>(), profiles = new Map<string, string>();
    for (const [index, value] of values.entries()) {
      if (value.node_id !== values[0]?.node_id) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, "node_id"], message: "A descriptor set belongs to one node" });
      const profileKey = `${value.project_id}:${value.result_profile.id}`, pair = `${profileKey}:${value.verifier_template.id}`;
      const profileValue = canonical({ profile: value.result_profile, paths: value.content_paths });
      if (pairs.has(pair) || profiles.has(profileKey) && profiles.get(profileKey) !== profileValue) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index], message: "Duplicate or contradictory result profile descriptor" });
      }
      pairs.add(pair); profiles.set(profileKey, profileValue);
    }
  });

/** A persisted selection, not commands, allocation paths, or execution authority.
 * Baseline is explicit: omission cannot silently select a mutable repository HEAD. */
export const OwnedResultRequirementV1Schema = z.object({
  version: z.literal(1), request_id: id, capture_request_id: id, verification_materialization_request_id: id,
  profile: NodeOwnedResultProfileDescriptorV1Schema,
  author_context_digest: digest,
  input: z.discriminatedUnion("kind", [z.object({ kind: z.literal("baseline") }).strict(),
    z.object({ kind: z.literal("result"), reference: OwnedResultReferenceV1Schema }).strict()]),
}).strict().superRefine((value, ctx) => {
  const requests = [value.request_id, value.capture_request_id, value.verification_materialization_request_id];
  if (new Set(requests).size !== requests.length || value.input.kind === "result" && requests.includes(value.input.reference.result_id)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Store operation IDs and an existing input result ID must be distinct" });
  }
});
export type OwnedResultRequirementV1 = z.infer<typeof OwnedResultRequirementV1Schema>;

const ownedResultRunAdmissionShape = z.object({ version: z.literal(1),
  run_start: RunStartPayloadSchema, requirement: OwnedResultRequirementV1Schema }).strict();
/** Distinct opt-in request. Compare the original input before returning parsed
 * data: legacy nested codecs must not silently strip part of this full binding. */
export const OwnedResultRunAdmissionV1Schema = z.unknown().transform((raw, ctx) => {
  const parsed = ownedResultRunAdmissionShape.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue({ ...issue });
    return z.NEVER;
  }
  try {
    if (canonical(raw) !== canonical(parsed.data)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Unsupported fields cannot be stripped from an owned result admission" });
      return z.NEVER;
    }
    const binding = canonical({ kind: "owned-result-run-admission.v1", ...parsed.data });
    if (new TextEncoder().encode(binding).byteLength > 1024 * 1024) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Owned result admission exceeds its bounded journal payload size" });
      return z.NEVER;
    }
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Owned result admission requires canonical JSON data" });
    return z.NEVER;
  }
  return parsed.data;
});
export type OwnedResultRunAdmissionV1 = z.infer<typeof OwnedResultRunAdmissionV1Schema>;

/** Same canonical metadata binding as the node finalizer's exactRunRequest.
 * It includes the complete original run.start and adds the discriminator here.
 * Physical allocation, context coherence and local authority remain node checks. */
export function canonicalOwnedResultRunAdmissionV1(raw: unknown): string {
  return canonical({ kind: "owned-result-run-admission.v1", ...OwnedResultRunAdmissionV1Schema.parse(raw) });
}

/** Projection excludes raw reason/stdout, observation, capabilities and measurement
 * fields. Preserve the ordinary measured profile_digest and subject_digest. */
const verificationBase = RunVerificationPayloadSchema.shape;
export const OwnedResultCommandVerificationV1Schema = z.object({
  version: verificationBase.version, request_id: id, profile_id: id,
  profile_digest: verificationBase.profile_digest, subject_digest: digest,
  outcome: verificationBase.outcome,
  checks: z.array(z.object({ id, exit_code: z.number().int().nullable(),
    duration_ms: z.number().finite().nonnegative(), output_digest: digest }).strict()).max(32),
  required_files: z.array(z.object({ path: relativePath, checksum: digest, size: z.number().int().nonnegative() }).strict()).max(128),
}).strict().superRefine((value, ctx) => {
  const ordinary = RunVerificationPayloadSchema.safeParse(value);
  if (!ordinary.success) for (const issue of ordinary.error.issues) ctx.addIssue({ ...issue });
});
export type OwnedResultCommandVerificationV1 = z.infer<typeof OwnedResultCommandVerificationV1Schema>;

/** Sanitization only. Callers must authenticate the node-owned receipt first.
 * Never silently downgrade a capability/measurement result into this contract. */
export function projectOwnedResultCommandVerificationV1(raw: RunVerificationPayload): OwnedResultCommandVerificationV1 {
  const value = RunVerificationPayloadSchema.parse(raw);
  if (value.measurement_plan !== undefined || value.checks.some(check => check.observation !== undefined)) {
    throw new Error("Owned result v1 accepts plain commands without observations or measurement plans");
  }
  return OwnedResultCommandVerificationV1Schema.parse({ version: value.version, request_id: value.request_id,
    profile_id: value.profile_id, profile_digest: value.profile_digest, subject_digest: value.subject_digest,
    outcome: value.outcome, checks: value.checks.map(check => ({ id: check.id, exit_code: check.exit_code,
      duration_ms: check.duration_ms, output_digest: check.output_digest })),
    required_files: value.required_files.map(file => ({ path: file.path, checksum: file.checksum, size: file.size })) });
}

/** Must match the frozen owning run/allocation. The digest is the existing
 * allocation launch key with the sha256 prefix, never a new writer permit. */
export const OwnedResultAuthorBindingV1Schema = z.object({
  run_id: id, task_id: id, agent_instance_id: id, runtime: id,
  launch_binding_digest: digest, author_context_digest: digest, workspace,
}).strict();
export type OwnedResultAuthorBindingV1 = z.infer<typeof OwnedResultAuthorBindingV1Schema>;

export const NodeOwnedResultVerificationEvidenceV1Schema = z.object({
  version: z.literal(1), kind: z.literal("authored-result-verification"),
  requirement: OwnedResultRequirementV1Schema, requirement_digest: digest,
  author: OwnedResultAuthorBindingV1Schema,
  template: z.object({ id, digest, node_id: id, project_id: id }).strict(),
  result: z.object({ kind: z.literal("authored"), reference: OwnedResultReferenceV1Schema,
    profile_id: id, profile_digest: digest, repository_binding: digest,
    base_commit: oid, commit: oid, tree: oid, manifest_digest: digest,
    inputs: z.array(OwnedResultReferenceV1Schema).max(1) }).strict(),
  verification: z.object({
    receipt: z.object({ verification_id: id, receipt_digest: digest }).strict(),
    intent_digest: digest, workspace,
    execution: z.object({ version: z.literal(1), request_id: id, profile_id: id, profile_digest: digest,
      workspace_root: physicalRoot, subject_digest: digest,
      context_digest: z.literal(OWNED_RESULT_NO_VERIFICATION_CONTEXT_DIGEST) }).strict(),
    payload: OwnedResultCommandVerificationV1Schema,
  }).strict(),
  scope: z.literal("historical plain-command node evidence; no product-stage, independent review or publication acceptance"),
}).strict().superRefine((value, ctx) => {
  const requirement = value.requirement, descriptor = requirement.profile, result = value.result;
  const { execution, payload, receipt } = value.verification;
  const reject = (path: (string | number)[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
  if (value.author.author_context_digest !== requirement.author_context_digest) reject(["author"], "Author context differs from the frozen requirement");
  if (value.template.id !== descriptor.verifier_template.id || value.template.digest !== descriptor.verifier_template.digest
    || value.template.node_id !== descriptor.node_id || value.template.project_id !== descriptor.project_id) reject(["template"], "Template differs from the selected descriptor");
  if (result.reference.result_id !== requirement.capture_request_id || result.profile_id !== descriptor.result_profile.id
    || result.profile_digest !== descriptor.result_profile.digest || result.repository_binding !== descriptor.result_profile.repository_binding) {
    reject(["result"], "Authored result differs from the selected capture/profile/repository");
  }
  if (requirement.input.kind === "baseline") {
    if (result.base_commit !== descriptor.result_profile.baseline_commit || result.inputs.length !== 0) reject(["result", "inputs"], "Baseline capture must retain the fixed baseline and have no input result");
  } else if (result.inputs.length !== 1 || !same(result.inputs[0], requirement.input.reference)) {
    reject(["result", "inputs"], "Capture input differs from the exact selected result");
  }
  if (receipt.verification_id !== requirement.request_id || execution.request_id !== requirement.request_id
    || payload.request_id !== requirement.request_id || execution.profile_id !== descriptor.verifier_template.id
    || payload.profile_id !== execution.profile_id || payload.profile_digest !== execution.profile_digest
    || payload.subject_digest !== execution.subject_digest || execution.workspace_root !== value.verification.workspace.root) {
    reject(["verification"], "Physical execution, measured payload and durable request do not match");
  }
  const authorRoot = value.author.workspace.root, verificationRoot = value.verification.workspace.root;
  if (authorRoot === verificationRoot || authorRoot.startsWith(`${verificationRoot}/`) || verificationRoot.startsWith(`${authorRoot}/`)
    || value.author.workspace.branch === value.verification.workspace.branch) reject(["verification", "workspace"], "Verification needs its separate allocation and branch");
  if (payload.required_files.some(file => !covered(file.path, descriptor.content_paths))) reject(["verification", "payload", "required_files"], "Measured required files must be in the selected result scope");
  if (JSON.stringify(value).length > 256_000) reject([], "Owned result evidence exceeds its bounded projection");
});
export type NodeOwnedResultVerificationEvidenceV1 = z.infer<typeof NodeOwnedResultVerificationEvidenceV1Schema>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error("Unsupported canonical contract value");
  return result;
}
export function canonicalOwnedResultRequirementV1(raw: OwnedResultRequirementV1): string {
  return canonical(OwnedResultRequirementV1Schema.parse(raw));
}
/** Hash the original parsed author context without rewriting its workspace.
 * Product-stage/capability/review execution needs a later versioned contract. */
export function canonicalOwnedResultAuthorContextV1(raw: unknown): string {
  const context = ContextPackSchema.parse(raw);
  if (context.product_development || context.review_subject || context.verification_capabilities || context.release_capabilities
    || context.policy.execution_mode === "discussion") throw new Error("Owned result v1 does not support product-stage, capability or review context");
  return canonical(context);
}

/** The exact local durable intent, reconstructed from public data. Its digest
 * is deliberately distinct from the larger public requirement digest. */
export function ownedResultVerificationIntentV1(raw: NodeOwnedResultVerificationEvidenceV1) {
  const value = NodeOwnedResultVerificationEvidenceV1Schema.parse(raw), request = value.requirement;
  return { version: 1 as const, kind: "owned-result-verification.v1" as const, request_id: request.request_id,
    materialization_request_id: request.verification_materialization_request_id, template: value.template,
    result: { reference: value.result.reference, profile_id: value.result.profile_id, profile_digest: value.result.profile_digest },
    workspace: value.verification.workspace, context_digest: value.verification.execution.context_digest };
}
export function canonicalOwnedResultVerificationIntentV1(raw: NodeOwnedResultVerificationEvidenceV1): string {
  return canonical(ownedResultVerificationIntentV1(raw));
}

/** Pure coherence check only. Expected values must come from the authenticated
 * connection and persisted assignment; this function grants no local authority. */
export function assertOwnedResultEvidenceMatchesExpectedV1(raw: NodeOwnedResultVerificationEvidenceV1, expected: {
  descriptor: NodeOwnedResultProfileDescriptorV1; requirement: OwnedResultRequirementV1; author: OwnedResultAuthorBindingV1;
  accepted_input?: { reference: OwnedResultReferenceV1; commit: string };
}, sha256: (canonicalJson: string) => string): NodeOwnedResultVerificationEvidenceV1 {
  const value = NodeOwnedResultVerificationEvidenceV1Schema.parse(raw);
  const requirement = OwnedResultRequirementV1Schema.parse(expected.requirement), descriptor = NodeOwnedResultProfileDescriptorV1Schema.parse(expected.descriptor);
  const author = OwnedResultAuthorBindingV1Schema.parse(expected.author);
  if (!same(requirement.profile, descriptor) || !same(value.requirement, requirement) || !same(value.author, author)
    || value.requirement_digest !== digest.parse(sha256(canonicalOwnedResultRequirementV1(requirement)))
    || value.verification.intent_digest !== digest.parse(sha256(canonicalOwnedResultVerificationIntentV1(value)))) {
    throw new Error("Owned result evidence differs from the authenticated expected assignment or digests");
  }
  if (requirement.input.kind === "baseline") {
    if (expected.accepted_input !== undefined) throw new Error("Baseline assignment cannot accept an unsolicited input result");
  } else if (!expected.accepted_input || !same(OwnedResultReferenceV1Schema.parse(expected.accepted_input.reference), requirement.input.reference)
    || oid.parse(expected.accepted_input.commit) !== value.result.base_commit) {
    throw new Error("Owned result base requires the exact previously accepted input result");
  }
  return value;
}
