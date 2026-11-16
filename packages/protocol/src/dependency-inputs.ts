import { z } from "zod";

/** Input reads only: no execution, publication, file browsing or receipt authority. */
export const dependencyInputsRegistrationSchema = z.object({ version: z.literal(1) }).strict();
export const dependencyInputsSessionCommandSchema = z.object({
  kind: z.literal("command"),
  id: z.string().min(1).max(256),
  idempotency_key: z.string().min(1).max(256),
  type: z.literal("node.dependency-inputs.session.v1"),
  payload: z.object({
    version: z.literal(1),
    node_id: z.string().min(1).max(128),
    session_id: z.string().guid(),
  }).strict(),
}).strict();
export type DependencyInputsSessionCommand = z.infer<typeof dependencyInputsSessionCommandSchema>;
