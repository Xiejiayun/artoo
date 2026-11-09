import { z } from "zod";
import { AutonomousSourceHandoffV1Schema } from "./autonomy.js";
import { ApplicationDeliveryV1Schema } from "./application-development.js";
import { ApplicationPublicationGrantV1Schema } from "./application-publication.js";

/** Display defaults for a prepared request, never evidence of node capability. */
const preparedFields = {
  execution_mode: z.literal("agent_team"),
  verification_profile_id: z.string().min(1).max(128),
  max_retries: z.number().int().min(0).max(10),
};
export const PreparedGoalRequestV1Schema = z.union([
  z.object({ ...preparedFields, release_profile_id: z.string().min(1).max(128),
    source_handoff: AutonomousSourceHandoffV1Schema, app_delivery: z.never().optional(), app_publication: z.never().optional() }).strict(),
  z.object({ ...preparedFields, app_delivery: ApplicationDeliveryV1Schema,
    release_profile_id: z.never().optional(), source_handoff: z.never().optional(), app_publication: z.never().optional() }).strict(),
  z.object({ ...preparedFields, app_publication: ApplicationPublicationGrantV1Schema,
    release_profile_id: z.never().optional(), source_handoff: z.never().optional(), app_delivery: z.never().optional() }).strict(),
]);
const common = {
  version: z.literal(1), session_id: z.string().min(1).max(128),
  project_id: z.string().min(1).max(128), goal_id: z.string().min(1).nullable(),
  progress_updates: z.literal("polling").optional(),
};
/** Omitted on ordinary servers and older bootstrap responses. */
export const PreparedGoalEntryV1Schema = z.discriminatedUnion("submission_owner", [
  z.object({ ...common, submission_owner: z.literal("console") }).strict(),
  z.object({ ...common, submission_owner: z.literal("browser"),
    request_key: z.string().min(1).max(128), request: PreparedGoalRequestV1Schema }).strict(),
]);
export type PreparedGoalEntryV1 = z.infer<typeof PreparedGoalEntryV1Schema>;
export type PreparedGoalRequestV1 = z.infer<typeof PreparedGoalRequestV1Schema>;
