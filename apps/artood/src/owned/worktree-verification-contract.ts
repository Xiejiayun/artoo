import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { RunVerificationPayloadSchema } from "@artoo/domain";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/u);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const text = z.string().min(1).max(4096).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
const absolutePath = text.refine(value => isAbsolute(value) && resolve(value) === value);
const resultReference = z.object({ result_id: id, receipt_digest: digest }).strict();
const template = z.object({ id, digest, node_id: id, project_id: id }).strict();
const workspace = z.object({ root: absolutePath, branch: text }).strict();

/** Local intent, not a wire run request and not a prepared verifier authority. */
export const OwnedVerificationIntentSchema = z.object({
  version: z.literal(1), kind: z.literal("owned-result-verification.v1"), request_id: id, materialization_request_id: id,
  template, result: z.object({ reference: resultReference, profile_id: id, profile_digest: digest }).strict(),
  workspace, context_digest: digest,
}).strict();
export type OwnedVerificationIntent = z.infer<typeof OwnedVerificationIntentSchema>;

/** Prepared after materialization. Preserve the ordinary root-sensitive digest. */
export const OwnedVerificationExecutionSchema = z.object({
  version: z.literal(1), request_id: id, profile_id: id, profile_digest: digest,
  workspace_root: absolutePath, subject_digest: digest, context_digest: digest,
}).strict();
export type OwnedVerificationExecution = z.infer<typeof OwnedVerificationExecutionSchema>;

export const OwnedWorktreeVerificationEvidenceSchema = z.object({
  version: z.literal(1), template,
  result: z.object({ reference: resultReference, profile_id: id, profile_digest: digest, repository_binding: digest,
    commit: oid, tree: oid, manifest_digest: digest }).strict(),
  workspace, verification: RunVerificationPayloadSchema,
  scope: z.literal("node-local exact-result command verification; not independent review, integration acceptance or publication"),
}).strict();
export type OwnedWorktreeVerificationEvidence = z.infer<typeof OwnedWorktreeVerificationEvidenceSchema>;

export const OwnedVerificationReceiptReferenceSchema = z.object({ verification_id: id, receipt_digest: digest }).strict();
export type OwnedVerificationReceiptReference = z.infer<typeof OwnedVerificationReceiptReferenceSchema>;
export const OwnedVerificationReceiptSchema = z.object({
  version: z.literal(1), kind: z.literal("owned-result-verification-receipt.v1"),
  request_id: id, request_digest: digest, profile_digest: digest, repository_binding: digest,
  started_at: z.string().datetime(), completed_at: z.string().datetime(),
  intent: OwnedVerificationIntentSchema, execution: OwnedVerificationExecutionSchema,
  evidence: OwnedWorktreeVerificationEvidenceSchema,
  scope: z.literal("historical node-local exact-result verification; no delivery, writer recovery, review or publication authority"),
}).strict();
export type OwnedVerificationReceipt = z.infer<typeof OwnedVerificationReceiptSchema>;
export interface SealedOwnedVerificationReceipt { reference: OwnedVerificationReceiptReference; receipt: OwnedVerificationReceipt }
export type OwnedVerificationLookup = { phase: "absent" }
  | { phase: "preparing" | "failed" | "uncertain"; request_id: string; execution?: OwnedVerificationExecution }
  | { phase: "sealed"; sealed: SealedOwnedVerificationReceipt };

export function canonicalOwnedVerification(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalOwnedVerification).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalOwnedVerification(child)}`).join(",")}}`;
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error("Unsupported verification JSON value");
  return result;
}
export const ownedVerificationDigest = (value: unknown) => `sha256:${createHash("sha256").update(canonicalOwnedVerification(value)).digest("hex")}`;

/** Consistency validation is not evidence authentication. The store additionally requires the original node-issued candidate. */
export function assertOwnedVerificationEvidenceBindings(intent: OwnedVerificationIntent, execution: OwnedVerificationExecution,
  evidence: OwnedWorktreeVerificationEvidence): void {
  const same = (left: unknown, right: unknown) => canonicalOwnedVerification(left) === canonicalOwnedVerification(right);
  if (execution.request_id !== intent.request_id || execution.profile_id !== intent.template.id
    || execution.workspace_root !== intent.workspace.root || execution.context_digest !== intent.context_digest
    || !same(evidence.template, intent.template) || !same(evidence.workspace, intent.workspace)
    || !same(evidence.result.reference, intent.result.reference) || evidence.result.profile_id !== intent.result.profile_id
    || evidence.result.profile_digest !== intent.result.profile_digest
    || evidence.verification.request_id !== execution.request_id || evidence.verification.profile_id !== execution.profile_id
    || evidence.verification.profile_digest !== execution.profile_digest
    || evidence.verification.subject_digest !== execution.subject_digest) throw new Error("Verification intent, execution and evidence bindings differ");
  if (evidence.verification.checks.some(check => check.observation !== undefined) || evidence.verification.measurement_plan !== undefined) {
    throw new Error("Owned verification receipts currently support plain commands only");
  }
}
