/**
 * ContextPack schema (design.md §6.11, codex Round 14 — FROZEN).
 *
 * v0.1-core fills only the static fields. v0.1-complete (Memory/Skill/Lease) may
 * only ADD optional, versioned fields — it must never break adapter injection of
 * the shape below.
 */
import { z } from "zod";

export const ContextPackSchema = z.object({
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
