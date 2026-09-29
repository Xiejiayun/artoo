import { z } from "zod";
import { TaskSpecSchema } from "./goal.js";
import { wouldCreateCycle, type DagEdge } from "./dag.js";

export const DiscussionPlanOutputSchema = z.object({
  rationale: z.string().max(20000).default(""),
  task_specs: z.array(TaskSpecSchema).min(1).max(50),
});

const PreviewTaskSpecSchema = TaskSpecSchema.extend({
  description: z.string(),
  required_capabilities: z.array(z.string()),
  dependencies: TaskSpecSchema.shape.dependencies.removeDefault(),
  approval_gates: z.array(z.string()),
  write_scopes: z.array(z.string()),
  expected_artifacts: z.array(z.object({ type: z.string(), description: z.string() })),
});

/** Server-attributed presentation of a synthesis, never a saved/accepted plan.
 * Metadata is normalized by the server; clients must not invent missing fields. */
export const DiscussionPlanPreviewSchema = z.object({
  version: z.literal(1),
  discussion_id: z.string().min(1),
  goal_id: z.string().min(1),
  rationale: z.string().max(20000),
  task_specs: z.array(PreviewTaskSpecSchema).min(1).max(50),
}).superRefine((plan, ctx) => {
  const edges: DagEdge[] = [];
  plan.task_specs.forEach((spec, index) => {
    if (spec.approval_gates.length || spec.write_scopes.length) {
      ctx.addIssue({ code: "custom", path: ["task_specs", index], message: "Unsupported plan controls" });
    }
    spec.dependencies.forEach((dep, offset) => {
      const source = Number(dep.ref);
      const path = ["task_specs", index, "dependencies", offset];
      if (!/^(0|[1-9]\d*)$/.test(dep.ref) || !Number.isSafeInteger(source) || source >= plan.task_specs.length || source === index) {
        ctx.addIssue({ code: "custom", path, message: "Invalid plan prerequisite" });
      } else if (wouldCreateCycle(edges, dep.ref, String(index))) {
        ctx.addIssue({ code: "custom", path, message: "Cyclic plan prerequisites" });
      } else {
        edges.push({ from_task_id: dep.ref, to_task_id: String(index), type: dep.type });
      }
    });
  });
});
export type DiscussionPlanPreview = z.infer<typeof DiscussionPlanPreviewSchema>;

export const DiscussionParticipantSchema = z.object({
  agent_instance_id: z.string().min(1),
  role: z.string().trim().min(1).max(200),
});
export const StartDiscussionRequestSchema = z.object({
  participants: z.array(DiscussionParticipantSchema).min(2).max(6)
    .refine((items) => new Set(items.map((item) => item.agent_instance_id)).size === items.length, "Choose distinct agent instances"),
  rounds: z.number().int().min(1).max(3).default(2),
  max_minutes: z.number().int().min(2).max(60).default(15),
  room_id: z.string().min(1).optional(),
});
export type StartDiscussionRequest = z.infer<typeof StartDiscussionRequestSchema>;
export const DiscussionSchema = z.object({
  id: z.string(), goal_id: z.string(), room_id: z.string(), thread_root_id: z.string(),
  participants: z.array(DiscussionParticipantSchema), rounds: z.number().int(), max_minutes: z.number().int(),
  status: z.enum(["running", "stopping", "ready", "failed", "cancelled"]),
  current_step: z.number().int(), total_steps: z.number().int(),
  active_turn_id: z.string().nullable(), plan_id: z.string().nullable(), error: z.string().nullable(),
  created_at: z.string(), updated_at: z.string(), deadline_at: z.string(),
});
export type Discussion = z.infer<typeof DiscussionSchema>;
