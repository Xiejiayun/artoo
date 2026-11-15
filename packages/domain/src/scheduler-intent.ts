import { z } from "zod";

const id = z.string().min(1).max(128);
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);

/** Explicit shadow staging. No caller-supplied actor, consent, profile or command. */
export const CreateSchedulerIntentV1Schema = z
  .object({
    version: z.literal(1),
    request_key: id,
    base_version: revision,
    agent_id: id,
    branch_backed: z.literal(true),
    write_paths: z.array(z.string().min(1).max(4096)).max(256),
  })
  .strict();
export type CreateSchedulerIntentV1 = z.infer<typeof CreateSchedulerIntentV1Schema>;

/** Server-captured bindings only; no node-local authority or secret configuration. */
export const SchedulerIntentSnapshotV1Schema = z
  .object({
    version: z.literal(1),
    organization_id: id,
    project_id: id,
    task_id: id,
    actor_user_id: id,
    request: CreateSchedulerIntentV1Schema,
    ai_sharing: z.object({ consent_id: id.nullable(), policy_version: z.string().min(1) }).strict(),
    task_input_version: revision,
    task_input_digest: digest,
    queue_revision: revision.nullable(),
    policy_revisions: z
      .object({
        project: revision,
        agent: revision,
        computers: z.record(id, revision),
      })
      .strict(),
    configuration_digest: digest,
    execution_authorized: z.literal(false),
  })
  .strict();
export type SchedulerIntentSnapshotV1 = z.infer<typeof SchedulerIntentSnapshotV1Schema>;
