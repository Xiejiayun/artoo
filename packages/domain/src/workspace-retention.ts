import { z } from "zod";

const identity = z.string().min(1).max(256);
const path = z.string().min(1).max(4096).refine((value) => !value.includes("\0"), "path must not contain NUL");
const branch = z.string().min(1).max(1024).refine((value) => !value.includes("\0") && value === value.trim(), "branch must not contain NUL or surrounding whitespace");

export const WorkspaceRetentionOutcomeSchema = z.enum(["completed", "failed", "cancelled", "incomplete_delivery", "unconfirmed"]);
export type WorkspaceRetentionOutcome = z.infer<typeof WorkspaceRetentionOutcomeSchema>;

/** A worker's historical retention report, never proof of current disk availability. */
export const RunWorkspaceRetainedPayloadSchema = z.object({
  version: z.literal(1),
  workspace_root: path,
  workspace_branch: branch,
  outcome: WorkspaceRetentionOutcomeSchema,
}).strict();
export type RunWorkspaceRetainedPayload = z.infer<typeof RunWorkspaceRetainedPayloadSchema>;

/** Reporter identity is added by the server, not accepted from runtime output. */
export const StoredWorkspaceRetainedPayloadSchema = RunWorkspaceRetainedPayloadSchema.extend({
  reporter_computer_id: identity,
}).strict();
export type StoredWorkspaceRetainedPayload = z.infer<typeof StoredWorkspaceRetainedPayloadSchema>;

export const WorkspaceRetentionProjectionSchema = StoredWorkspaceRetainedPayloadSchema.extend({
  event_id: identity,
  position: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  reported_at: z.string().datetime(),
}).strict();
export type WorkspaceRetentionProjection = z.infer<typeof WorkspaceRetentionProjectionSchema>;
