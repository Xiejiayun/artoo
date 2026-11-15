import { z } from "zod";

export const SCHEDULER_ROLLOUT_FLAGS = [
  "task_mirror",
  "unified_enqueue",
  "claim_shadow",
  "daemon_claim",
  "lease_failover",
  "isolated_workspaces",
  "delegation_limits",
  "attempt_credentials",
] as const;
export type SchedulerRolloutFlag = (typeof SCHEDULER_ROLLOUT_FLAGS)[number];

const switches = z
  .object(
    Object.fromEntries(SCHEDULER_ROLLOUT_FLAGS.map((name) => [name, z.boolean().optional()])) as Record<
      SchedulerRolloutFlag,
      z.ZodOptional<z.ZodBoolean>
    >,
  )
  .strict();
const id = z.string().trim().min(1).max(128);
const configSchema = z
  .object({
    version: z.literal(1),
    workspaces: z.record(
      id,
      z
        .object({
          flags: switches.optional(),
          projects: z.record(id, switches).optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type SchedulerRolloutConfig = z.infer<typeof configSchema>;

/** Local startup configuration only; an API request cannot opt into a migration. */
export function loadSchedulerRollout(env: NodeJS.ProcessEnv): SchedulerRolloutConfig | undefined {
  const raw = env.ARTOO_SCHEDULER_ROLLOUT;
  if (raw === undefined) return undefined;
  if (Buffer.byteLength(raw) > 65536) throw new Error("ARTOO_SCHEDULER_ROLLOUT exceeds 64 KiB");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("ARTOO_SCHEDULER_ROLLOUT must be valid JSON");
  }
  const parsed = configSchema.safeParse(value);
  if (!parsed.success) throw new Error("ARTOO_SCHEDULER_ROLLOUT is not a valid version 1 configuration");
  for (const workspace of Object.values(parsed.data.workspaces)) {
    if (workspace.flags) Object.freeze(workspace.flags);
    for (const project of Object.values(workspace.projects ?? {})) Object.freeze(project);
    if (workspace.projects) Object.freeze(workspace.projects);
    Object.freeze(workspace);
  }
  Object.freeze(parsed.data.workspaces);
  return Object.freeze(parsed.data);
}

/** Organization is Artoo's workspace boundary. Explicit project false wins. */
export function schedulerRolloutEnabled(
  config: SchedulerRolloutConfig | undefined,
  flag: SchedulerRolloutFlag,
  scope: { organizationId: string; projectId: string },
): boolean {
  const workspace = config?.workspaces[scope.organizationId];
  return workspace?.projects?.[scope.projectId]?.[flag] ?? workspace?.flags?.[flag] ?? false;
}
