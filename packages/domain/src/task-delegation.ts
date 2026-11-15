import { z } from "zod";
import { TaskStatusSchema } from "./state.js";

export const TASK_DELEGATION_LIMITS = { max_depth: 3, max_tasks: 30 } as const;
const id = z.string().min(1).max(128);

/** Explicit new delegation; legacy parent links also represent conversation/history. */
export const TaskDelegationRequestV1Schema = z
  .object({
    version: z.literal(1),
    parent_task_id: id,
  })
  .strict();
export type TaskDelegationRequestV1 = z.infer<typeof TaskDelegationRequestV1Schema>;

export const TaskDelegationTreeV1Schema = z
  .object({
    version: z.literal(1),
    root_task_id: id,
    selected_task_id: id,
    creation_enabled: z.boolean(),
    limits: z.object({ max_depth: z.literal(3), max_tasks: z.literal(30) }).strict(),
    nodes: z
      .array(
        z
          .object({
            task_id: id,
            parent_task_id: id.nullable(),
            depth: z.number().int().min(0).max(3),
            title: z.string(),
            status: TaskStatusSchema,
          })
          .strict(),
      )
      .min(1)
      .max(30),
  })
  .strict();
export type TaskDelegationTreeV1 = z.infer<typeof TaskDelegationTreeV1Schema>;
