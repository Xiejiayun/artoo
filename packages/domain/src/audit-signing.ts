import { z } from "zod";

import { GoalAuditBundleSchema } from "./goal.js";
import { TaskAuditBundleSchema } from "./schemas.js";

export const AuditSigningKeyIdV1Schema = z.string().regex(/^ed25519-spki-sha256:[a-f0-9]{64}$/);
export const AuditIssuerV1Schema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
export const AuditPublicKeyringV1Schema = z
  .object({
    version: z.literal(1),
    issuer: AuditIssuerV1Schema,
    keys: z
      .array(
        z
          .object({
            key_id: AuditSigningKeyIdV1Schema,
            status: z.enum(["active", "retired", "revoked"]),
            public_key_spki_pem: z.string().min(1).max(4096),
          })
          .strict(),
      )
      .min(1)
      .max(64),
  })
  .strict()
  .refine((value) => new Set(value.keys.map((key) => key.key_id)).size === value.keys.length, "Duplicate key IDs");
export type AuditPublicKeyringV1 = z.infer<typeof AuditPublicKeyringV1Schema>;

const signedFields = {
  schema_version: z.literal("artoo.audit-signed.v1"),
  exported_at: z.string().datetime(),
  bundle_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  signing: z
    .object({
      status: z.literal("signed"),
      algorithm: z.literal("Ed25519"),
      canonicalization: z.literal("artoo-json-v1"),
      issuer: AuditIssuerV1Schema,
      key_id: AuditSigningKeyIdV1Schema,
    })
    .strict(),
};

/** Explicitly negotiated envelope; the legacy v1alpha1 schemas stay unchanged. */
export const SignedTaskAuditExportV1Schema = z
  .object({
    ...signedFields,
    kind: z.literal("task"),
    bundle: TaskAuditBundleSchema,
  })
  .strict();
export const SignedGoalAuditExportV1Schema = z
  .object({
    ...signedFields,
    kind: z.literal("goal"),
    bundle: GoalAuditBundleSchema,
  })
  .strict();
export const SignedAuditExportV1Schema = z.discriminatedUnion("kind", [
  SignedTaskAuditExportV1Schema,
  SignedGoalAuditExportV1Schema,
]);
export type SignedTaskAuditExportV1 = z.infer<typeof SignedTaskAuditExportV1Schema>;
export type SignedGoalAuditExportV1 = z.infer<typeof SignedGoalAuditExportV1Schema>;
export type SignedAuditExportV1 = z.infer<typeof SignedAuditExportV1Schema>;
