import { z } from "zod";

export const TaskAgentReviewArtifactV1Schema = z.object({
  id: z.string().min(1), type: z.string().min(1), run_id: z.string().min(1),
  checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
}).strict();
/** Descriptive, frozen artifact-opinion scope; never a verifier or automatic acceptance capability. */
export const TaskAgentReviewSubjectV1Schema = z.object({
  version: z.literal(1), review_id: z.string().min(1), source_task_id: z.string().min(1),
  source_run_id: z.string().min(1), reviewer_agent_id: z.string().min(1),
  artifacts: z.array(TaskAgentReviewArtifactV1Schema).min(1).max(100),
}).strict();
export const CreateTaskAgentReviewRequestV1Schema = z.object({
  version: z.literal(1), source_run_id: z.string().min(1), reviewer_agent_id: z.string().min(1),
  artifact_ids: z.array(z.string().min(1)).min(1).max(100).optional(),
}).strict();
export const ApplyTaskAgentReviewRequestV1Schema = z.object({
  version: z.literal(1), review_run_id: z.string().min(1), comment: z.string().trim().min(1).max(12000).optional(),
}).strict();
export const TaskAgentReviewV1Schema = z.object({
  version: z.literal(1), id: z.string().min(1), project_id: z.string().min(1),
  source_task_id: z.string().min(1), source_run_id: z.string().min(1), source_agent_id: z.string().min(1),
  review_task_id: z.string().min(1), reviewer_agent_id: z.string().min(1),
  artifacts: z.array(TaskAgentReviewArtifactV1Schema).min(1).max(100),
  requested_by_user_id: z.string().min(1), created_at: z.string().min(1),
}).strict();
export const TaskAgentReviewViewV1Schema = TaskAgentReviewV1Schema.extend({
  review_task_status: z.string(), review_run_id: z.string().nullable(), review_run_status: z.string().nullable(),
  report: z.string().nullable(), report_message_id: z.string().nullable(), report_artifact_ids: z.array(z.string()),
  stale: z.boolean(), stale_reason: z.string().nullable(), applied_at: z.string().nullable(), applied_event_id: z.string().nullable(),
});
export type TaskAgentReviewArtifactV1 = z.infer<typeof TaskAgentReviewArtifactV1Schema>;
export type TaskAgentReviewSubjectV1 = z.infer<typeof TaskAgentReviewSubjectV1Schema>;
export type TaskAgentReviewV1 = z.infer<typeof TaskAgentReviewV1Schema>;
export type TaskAgentReviewViewV1 = z.infer<typeof TaskAgentReviewViewV1Schema>;
export type CreateTaskAgentReviewRequestV1 = z.infer<typeof CreateTaskAgentReviewRequestV1Schema>;
export type ApplyTaskAgentReviewRequestV1 = z.infer<typeof ApplyTaskAgentReviewRequestV1Schema>;
