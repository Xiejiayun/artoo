import {
  ProjectControlViewV1Schema,
  RunStatusSchema,
  TaskStatusSchema,
  type ProjectControlViewV1,
} from "@artoo/domain";

/** Controlled component fixture, never imported by the application. */
export function controlViewFixture(patch: Partial<ProjectControlViewV1> = {}): ProjectControlViewV1 {
  return ProjectControlViewV1Schema.parse({
    version: 1,
    project_id: "proj_artoo",
    observed_at: "2026-11-16T00:00:00.000Z",
    tasks: [],
    page: { limit: 100, next_after: null, has_more: false, order: "task_id_desc" },
    summary: {
      total_tasks: 0,
      tasks_by_status: Object.fromEntries(TaskStatusSchema.options.map((status) => [status, 0])),
      runs_by_status: Object.fromEntries(RunStatusSchema.options.map((status) => [status, 0])),
      active_execution_leases: 0,
      pending_execution_requests: 0,
    },
    project_policy: null,
    capacity: { shared_quotas_enabled: false, project_quota_enabled: false, occupied: null, source: "not_requested" },
    rollout: {},
    cost_budget_enabled: false,
    ...patch,
  });
}
