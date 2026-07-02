# V3 #140 — Goal-level Audit Bundle (release note)

**Status:** shipped (follow-up to #115 persistent goals; deferred P4).
**Endpoints:**
- `GET /api/v1/goals/:id/audit-bundle` — the consolidated goal-level evidence object.
- `GET /api/v1/goals/:id/audit-bundle/export` — the same bundle wrapped in the `v1alpha1` export envelope (`exported_at`, `bundle_sha256`, `signing.status = "deferred"`), mirroring the task audit-bundle export.

## What it is

A **read-only, deterministic** consolidation of a goal's full evidence chain, so a
reviewer can inspect an entire autonomous goal from one call instead of stitching
together per-task audits by hand. The bundle contains:

- `goal` — the goal row: lifecycle `status`, `budgets`, `retry_count`, `running_since`,
  and `current_plan_id` provenance.
- `room` — the goal's room (nullable).
- `plans[]` — every plan version (ordered by `version`), each with `status` and
  `materialized_at` / `materialization_event_id` provenance (which plan was accepted
  and materialized into the DAG).
- `checkpoints[]` — ordered checkpoints, including the `dag_materialized`, `paused`,
  and `resumed` markers with their `trigger_event_id` and `state_refs`.
- `tasks[]` — the **full per-task audit bundle** for each child task (its runs,
  artifacts, approvals, blockers, messages, scheduler decisions, and its own ordered
  event slice), already redacted.
- `events[]` — the goal's own ordered event stream: goal lifecycle events
  (`goal.created`, `goal.plan_*`, `goal.paused/resumed`, `goal.checkpoint_created`,
  `goal.budget_exceeded`) plus the `task.created` materialization-provenance events.

## What it is NOT (explicit boundary)

- **Not a replacement for the per-task audit bundle.** It *composes* the per-task
  bundle for each child; per-task callers are unchanged.
- **No flattened mega-timeline.** Child run-execution detail (`task.assigned`,
  `run.started/completed`, `artifact.created`, …) is NOT re-expanded into the
  goal-level `events[]`; it lives inside each child's own bundle. The goal-level
  stream is deliberately the goal-provenance slice, keeping the bundle bounded.
- **Unsigned.** Like the task export, `signing.status = "deferred"` until key
  management exists. `bundle_sha256` is a content hash over the bundle only
  (deterministic and stable across repeated exports), not a signature.

## Safety

Every query is organization-scoped on `organizationId` + the foreign key, so a
cross-org `goal_id` (or a task's cross-org `goal_id`) is never mounted. An unknown
or out-of-org goal returns 404. Secrets are redacted via the same field-name +
token-pattern redactor used by the task bundle.
