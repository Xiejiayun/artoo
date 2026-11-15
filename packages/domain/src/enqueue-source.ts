import { z } from "zod";

const key = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim().length > 0);
/** Provenance supplied by a user is metadata, never an Issue/Agent execution grant. */
export const EnqueueSourceV1Schema = z
  .object({
    version: z.literal(1),
    kind: z.enum(["manual", "issue"]),
    key,
    event_id: key,
    target_key: key.default("default"),
    comment: z
      .string()
      .min(1)
      .max(20000)
      .refine((value) => value.trim().length > 0)
      .optional(),
  })
  .strict();
export type EnqueueSourceV1 = z.infer<typeof EnqueueSourceV1Schema>;

export const SourceInputsV1Schema = z
  .object({
    version: z.literal(1),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    entries: z
      .array(
        z
          .object({
            event_id: key,
            message_id: z.string().min(1),
            body: z.string().min(1).max(20000),
            actor_id: z.string().min(1),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
  .refine(
    (value) => value.entries.reduce((sum, entry) => sum + entry.body.length, 0) <= 200000,
    "Source inputs exceed 200,000 characters",
  );
export type SourceInputsV1 = z.infer<typeof SourceInputsV1Schema>;
