/**
 * ContextPack schema (design.md §6.11, codex Round 14 — FROZEN).
 *
 * v0.1-core fills only the static fields. v0.1-complete (Memory/Skill/Lease) may
 * only ADD optional, versioned fields — it must never break adapter injection of
 * the shape below.
 */
import { z } from "zod";

import { ActorSchema } from "./events.js";

export const ContextPackSchema = z.object({
  conversation: z.object({
    room_id: z.string(), turn_id: z.string(), current_request: z.string(),
    thread_root_id: z.string().nullable().optional(),
    messages: z.array(z.object({ id: z.string(), role: z.enum(["user", "assistant"]), body: z.string(), actor_id: z.string().optional() })),
    history_truncated: z.boolean(),
  }).optional(),
  review_feedback: z.object({
    version: z.literal(1),
    entries: z.array(z.object({
      event_id: z.string().min(1),
      position: z.number().int().positive(),
      task_id: z.string().min(1),
      actor: ActorSchema,
      occurred_at: z.string().min(1),
      comment: z.string().refine((value) => value.trim().length > 0),
      artifact_ids: z.array(z.string().min(1)).nullable().optional(),
    })).min(1),
  }).optional(),
  task: z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    acceptance_criteria: z.array(z.string()),
  }),
  project: z.object({
    id: z.string(),
    name: z.string(),
    default_workspace: z.string().nullable(),
  }),
  workspace: z.object({
    root: z.string(),
    file_scope: z.array(z.string()),
  }),
  policy: z.object({
    execution_mode: z.literal("discussion").optional(),
    filesystem_write_scope: z.array(z.string()),
    requires_approval: z.array(z.string()),
  }),
  memory: z.object({
    task_summary: z.string().nullable(),
    project_notes: z.array(z.string()),
  }),
  artifacts: z.object({
    expected: z.array(z.string()),
  }),
});

export type ContextPack = z.infer<typeof ContextPackSchema>;
