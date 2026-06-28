# V3 #115 Persistent Goals — Schema and Critical-Path Supplement (Task #128)

Supplements `docs/v3-product-plan.md` with concrete schema, state machines, and
implementation ordering for Goal/Plan/Checkpoint/Budget/Resume.

Scope: design/schema/critical-path only (no code changes). Explicitly marks
v3.0 must-have versus later for each area.

---

## 1. Goal State Machine

### Statuses (9)

```
draft | planned | running | awaiting_approval | paused | blocked | completed | cancelled | archived
```

### Triggers and Transitions

| From | To | Trigger | Notes |
|---|---|---|---|
| draft | planned | plan_accepted | First plan version accepted |
| draft | cancelled | cancel | Human cancels before planning |
| planned | running | dag_materialized | Plan converted to live task DAG |
| planned | draft | plan_rejected | Plan rejected, back to drafting |
| planned | cancelled | cancel | |
| running | awaiting_approval | approval_required | Hard approval gate hit |
| running | paused | pause | Human pauses |
| running | blocked | blocked_detected | Child blocker surfaced |
| running | completed | all_tasks_terminal | All child tasks done/cancelled + acceptance met |
| running | cancelled | cancel | |
| awaiting_approval | running | approval_granted | Unblocked |
| awaiting_approval | blocked | approval_rejected | |
| awaiting_approval | paused | pause | |
| awaiting_approval | cancelled | cancel | |
| paused | running | resume | Human resumes |
| paused | cancelled | cancel | |
| blocked | running | blocker_resolved | All blockers resolved |
| blocked | paused | pause | |
| blocked | cancelled | cancel | |
| completed | archived | archive | Human archives |
| cancelled | archived | archive | Human archives |

### Terminal States: `completed`, `cancelled`, `archived`

### Key Rule: Status Derivation

Goal status is **derived from child state**, not set directly by clients:
- `running` ← at least one non-terminal child task exists and no hard blockers
- `awaiting_approval` ← any child task/run in `awaiting_approval` with goal-level policy gate
- `blocked` ← at least one open blocker with no mitigation path
- `completed` ← all child tasks in terminal state AND acceptance criteria met

The `pause`/`resume`/`cancel` triggers are human-initiated overrides.
The `plan_accepted`/`dag_materialized`/`blocked_detected`/`blocker_resolved`/`all_tasks_terminal`
triggers are system-derived.

### v3.0 Scope
- **Must-have:** All 9 statuses, all transitions above, derivation from child state for running/blocked/completed
- **Later:** `archived` (can defer; goals just stay in completed/cancelled)

---

## 2. Plan Versioning Model

### Plan Statuses (4)

```
proposed | accepted | rejected | superseded
```

### Plan Transitions

| From | To | Trigger |
|---|---|---|
| proposed | accepted | accept |
| proposed | rejected | reject |
| accepted | superseded | new_version_accepted |

### Plan Schema

```typescript
Plan {
  id: string              // prefix: plan_
  goal_id: string         // FK → goals
  version: number         // monotonic per goal, starts at 1
  author_type: ActorType
  author_id: string
  rationale: string       // why this plan/revision
  status: PlanStatus
  task_specs: TaskSpec[]  // JSONB: planned tasks with deps, criteria, caps, expected artifacts
  created_at: string
  accepted_at: string | null
}

TaskSpec {
  title: string
  description: string
  acceptance_criteria: string[]
  required_capabilities: string[]
  dependencies: { ref: string, type: DependencyType }[]  // ref = 0-based task-spec index string
  approval_gates: string[]
  write_scopes: string[]
  expected_artifacts: { type: ArtifactType, description: string }[]
}
```

### Plan-to-DAG Materialization Rules

When a plan is `accepted`, the system materializes:
1. Creates one `task` per `TaskSpec`, linking to `goal_id`
2. Creates `task_dependencies` edges from the spec's dependencies
3. Marks the goal as `planned → running` via `dag_materialized` trigger
4. Phase 2 checkpoint-service creates a checkpoint (type: `dag_materialized`)
5. Emits `goal.plan_materialized` event

**Mutation rule:** A new plan version can only be proposed when:
- Current plan is `accepted` AND goal is `paused` or `blocked`, OR
- No accepted plan exists (first plan)

Re-planning while `running` requires explicit `pause` first.

### v3.0 Scope
- **Must-have:** Plan CRUD, versioning (v1 accept), plan-to-DAG materialization, status machine
- **Later:** Plan diff UI, request-for-change workflow, partial re-planning (amend subset of tasks)

---

## 3. Checkpoint Schema

### Checkpoint Types (7)

```
plan_accepted | dag_materialized | approval_decided | run_terminal | artifact_accepted | paused | resumed
```

### Checkpoint Design: Reference-Based (Not Full Copies)

Checkpoints store **pointers** to existing DB state, not full snapshots:

```typescript
Checkpoint {
  id: string              // prefix: ckpt_
  goal_id: string         // FK → goals
  plan_id: string | null  // FK → plans (which plan was active)
  type: CheckpointType
  trigger_event_id: string    // which event caused this checkpoint
  state_refs: CheckpointRefs // JSONB: pointers to current state
  summary: string            // human-readable "what happened"
  created_at: string
}

CheckpointRefs {
  goal_status: GoalStatus
  plan_version: number
  task_statuses: { task_id: string, status: TaskStatus }[]
  active_runs: string[]       // run IDs that were non-terminal
  open_blockers: string[]     // blocker IDs
  pending_approvals: string[] // approval IDs
  event_cursor: number        // event_log position at checkpoint time
}
```

### Checkpoint Triggers (automated)

| Lifecycle Event | Checkpoint Type | What's Captured |
|---|---|---|
| Plan accepted | `plan_accepted` | Plan version, goal transition to `planned` |
| DAG materialized | `dag_materialized` | Task IDs created, initial DAG shape |
| Approval resolved | `approval_decided` | Which approval, outcome, affected task/run |
| Run reaches terminal | `run_terminal` | Which run, outcome, artifacts produced |
| Artifact accepted | `artifact_accepted` | Which artifact, review decision |
| Human pauses goal | `paused` | Frozen state: active runs, open blockers |
| Human resumes goal | `resumed` | Resume point, what was active before pause |

### Resume from Checkpoint

On resume (after daemon/server restart or human `resume`):
1. Load latest checkpoint for goal
2. Compare `state_refs.active_runs` with actual run statuses in DB
3. Runs that are still non-terminal in DB: continue (no action needed)
4. Runs that server marked `failed` during outage: surface as blockers
5. Runs with no DB record update since checkpoint: mark stale, create blocker
6. Re-evaluate goal status from child state
7. If goal was `paused`: scheduler can pick up `ready` tasks again

### v3.0 Scope
- **Must-have:** Checkpoint creation on all 7 trigger types, reference-based storage, latest checkpoint read API, resume evaluation logic
- **Later:** Checkpoint diff (show what changed between two checkpoints), checkpoint-based rollback, cross-goal checkpoint correlation
- **Retention (v3.0):** Keep all checkpoints while goal is active; enforce cap of latest 200 + terminal/latest-accepted-plan checkpoints on completed/cancelled goals

---

## 4. Budget and Stop-Condition Enforcement

### Budget Schema (on Goal)

```typescript
GoalBudgets {
  max_elapsed_ms: number | null       // wall-clock since goal entered `running`
  max_cost_usd: number | null         // sum of all child run costs
  max_retries: number | null          // total retry count across all tasks
  max_concurrent_runs: number | null  // parallel run limit
  allowed_runtimes: string[] | null   // restrict to specific runtimes
}
```

### Stop Conditions (on Goal)

```typescript
StopConditions {
  rules: StopRule[]
}

StopRule {
  type: 'budget_exceeded' | 'approval_timeout' | 'consecutive_failures' | 'custom'
  threshold: number | string
  action: 'pause' | 'cancel' | 'notify'
}
```

### Enforcement Logic

**Evaluation points** (server-side, on each relevant event):
1. `run.completed` / `run.failed` → check cost accumulator, retry count, consecutive failures
2. Periodic tick (every 60s for active goals) → check elapsed time
3. `run.started` → check concurrent run limit, allowed runtimes
4. Task assignment → check retry budget

**Actions when threshold hit:**
- `pause`: trigger `pause` on goal, create checkpoint, emit `goal.budget_exceeded` event
- `cancel`: trigger `cancel` on goal
- `notify`: emit event only, no state change (for soft limits / warnings)

**Tracking:**
- `elapsed_ms`: computed from goal `running` entry time (stored on goal row)
- `cost_usd`: accumulated on `run.completed` events (stored on goal row or computed from runs)
- `retries`: count of `retry` triggers across all child tasks
- `concurrent_runs`: count of non-terminal runs at assignment time

### v3.0 Scope
- **Must-have:** `max_elapsed_ms` and `max_retries` enforcement with `pause` action; `allowed_runtimes` filtering at scheduler level; budget fields on goal table
- **Later:** `max_cost_usd` (requires cost-per-run tracking infrastructure), `max_concurrent_runs` (can use existing capacity), custom stop rules, `notify` action (requires notification infrastructure)

---

## 5. Resume Protocol

### Daemon Restart

**Current behavior:** In-flight runs are lost. Supervisor restarts process, new `node.hello` sent.

**V3 must-have design:**

1. Before dispatching `run.start`, server persists `{run_id, node_id, checkpoint_cursor}` to DB
2. On node disconnect (socket close), server starts a **grace window** (configurable, default 60s)
3. During grace window: runs remain `running` in DB, no blocker created
4. If node reconnects within grace: server sends `run.resume` command with last-known sequence
5. If grace expires: server transitions runs to `failed` (reason: `daemon_disconnect`), creates goal-level blocker
6. On goal `resume` after blocker: scheduler re-assigns the task (new run, new context pack with checkpoint state)

### Server Restart

**Current behavior:** In-memory event deduper lost.

**V3 must-have design:**

1. Event deduper state already persisted in `run_event_ingest` table (node_id + run_id + sequence)
2. On server restart: load deduper state from DB for active runs
3. Nodes reconnect with new `node.hello`; server matches by `node_id`
4. Active runs resume event ingestion from last-known sequence (no gap)
5. Goal checkpoints remain valid (stored in DB)

### Reconnect Reconciliation Protocol

```
Server                          Node (artood)
  │                               │
  │← socket close ───────────────│
  │  start grace_window (60s)     │
  │                               │ (daemon restarting...)
  │                               │
  │← node.hello ─────────────────│ (reconnect within grace)
  │                               │
  │  match node_id                │
  │  find active runs             │
  │── run.resume {run_id, seq} ──→│
  │                               │ (adapter resumes or reports lost)
  │← run.event {seq+1...} ───────│
  │                               │
```

If the adapter cannot resume (process died): node sends `command.ack {status: rejected, error_code: process_exited}` and server transitions run to `failed`.

### v3.0 Scope
- **Must-have:** Grace window on disconnect (server-side, configurable), run state persistence across reconnect, `run.resume` command in protocol, server restart loads deduper from DB
- **Later:** Checkpoint-based adapter resume (requires runtime support for mid-stream resume), cross-server failover, multi-node run migration

---

## 6. DB Schema (Drizzle Table Definitions)

### Migration 0011: V3 Foundation Tables

```sql
-- goals
CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  objective TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'p2',
  status TEXT NOT NULL DEFAULT 'draft',
  acceptance_criteria JSONB NOT NULL DEFAULT '[]',
  stop_conditions JSONB NOT NULL DEFAULT '{"rules":[]}',
  budgets JSONB NOT NULL DEFAULT '{}',
  current_plan_id TEXT,
  running_since TEXT,
  elapsed_cost_usd REAL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CONSTRAINT goals_status_chk CHECK (
    status IN ('draft','planned','running','awaiting_approval','paused','blocked','completed','cancelled','archived')
  ),
  CONSTRAINT goals_priority_chk CHECK (priority IN ('p0','p1','p2','p3'))
);
CREATE INDEX goals_project_status_idx ON goals(project_id, status);
CREATE INDEX goals_owner_idx ON goals(owner_user_id);

-- plans
CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id),
  version INTEGER NOT NULL,
  author_type TEXT NOT NULL,
  author_id TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'proposed',
  task_specs JSONB NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  accepted_at TEXT,
  CONSTRAINT plans_status_chk CHECK (status IN ('proposed','accepted','rejected','superseded')),
  CONSTRAINT plans_author_type_chk CHECK (author_type IN ('user','agent','system','bridge')),
  UNIQUE(goal_id, version)
);
CREATE INDEX plans_goal_idx ON plans(goal_id);

-- checkpoints
CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id),
  plan_id TEXT,
  type TEXT NOT NULL,
  trigger_event_id TEXT,
  state_refs JSONB NOT NULL DEFAULT '{}',
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  CONSTRAINT checkpoints_type_chk CHECK (
    type IN ('plan_accepted','dag_materialized','approval_decided','run_terminal','artifact_accepted','paused','resumed')
  )
);
CREATE INDEX checkpoints_goal_idx ON checkpoints(goal_id, created_at);

-- Add goal_id to tasks
ALTER TABLE tasks ADD COLUMN goal_id TEXT REFERENCES goals(id);
CREATE INDEX tasks_goal_idx ON tasks(goal_id);

-- Add goal_id to event_log
ALTER TABLE event_log ADD COLUMN goal_id TEXT;
CREATE INDEX event_log_goal_idx ON event_log(goal_id);
```

### Drizzle Table Definitions (for packages/db/src/schema.ts)

```typescript
export const goals = pgTable("goals", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizations.id),
  projectId: text("project_id").notNull().references(() => projects.id),
  ownerUserId: text("owner_user_id").notNull().references(() => users.id),
  title: text("title").notNull(),
  objective: text("objective").notNull().default(""),
  priority: text("priority").notNull().default("p2"),
  status: text("status").notNull().default("draft"),
  acceptanceCriteria: jsonbArray("acceptance_criteria"),
  stopConditions: jsonb("stop_conditions").notNull().default(sql`'{"rules":[]}'::jsonb`),
  budgets: jsonb("budgets").notNull().default(sql`'{}'::jsonb`),
  currentPlanId: text("current_plan_id"),
  runningSince: ts("running_since"),
  elapsedCostUsd: real("elapsed_cost_usd"),
  retryCount: integer("retry_count").notNull().default(0),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
}, (t) => [
  check("goals_status_chk", sql`${t.status} in ('draft','planned','running','awaiting_approval','paused','blocked','completed','cancelled','archived')`),
  check("goals_priority_chk", sql`${t.priority} in ('p0','p1','p2','p3')`),
  index("goals_project_status_idx").on(t.projectId, t.status),
  index("goals_owner_idx").on(t.ownerUserId),
]);

export const plans = pgTable("plans", {
  id: text("id").primaryKey(),
  goalId: text("goal_id").notNull().references(() => goals.id),
  version: integer("version").notNull(),
  authorType: text("author_type").notNull(),
  authorId: text("author_id").notNull(),
  rationale: text("rationale").notNull().default(""),
  status: text("status").notNull().default("proposed"),
  taskSpecs: jsonb("task_specs").notNull().default(sql`'[]'::jsonb`),
  createdAt: ts("created_at").notNull(),
  acceptedAt: ts("accepted_at"),
}, (t) => [
  check("plans_status_chk", sql`${t.status} in ('proposed','accepted','rejected','superseded')`),
  check("plans_author_type_chk", sql`${t.authorType} in ('user','agent','system','bridge')`),
  unique("plans_goal_version_uniq").on(t.goalId, t.version),
  index("plans_goal_idx").on(t.goalId),
]);

export const checkpoints = pgTable("checkpoints", {
  id: text("id").primaryKey(),
  goalId: text("goal_id").notNull().references(() => goals.id),
  planId: text("plan_id"),
  type: text("type").notNull(),
  triggerEventId: text("trigger_event_id"),
  stateRefs: jsonb("state_refs").notNull().default(sql`'{}'::jsonb`),
  summary: text("summary").notNull().default(""),
  createdAt: ts("created_at").notNull(),
}, (t) => [
  check("checkpoints_type_chk", sql`${t.type} in ('plan_accepted','dag_materialized','approval_decided','run_terminal','artifact_accepted','paused','resumed')`),
  index("checkpoints_goal_idx").on(t.goalId, t.createdAt),
]);
```

### New ID Prefixes (packages/domain/src/ids.ts)

```
goal_    → goals
plan_    → plans
ckpt_    → checkpoints
```

### New Event Types (packages/domain/src/events.ts)

```
goal.created
goal.status_changed
goal.plan_proposed
goal.plan_accepted
goal.plan_rejected
goal.plan_materialized
goal.checkpoint_created
goal.paused
goal.resumed
goal.cancelled
goal.completed
goal.budget_exceeded
```

---

## 7. Critical-Path Implementation Ordering

```
Phase 1: Goal + Plan Foundation (v3.0 must-have)
├── 1a. Domain: goal state machine + plan statuses (packages/domain/src/goal.ts)
├── 1b. DB: migration 0011 (goals + plans + checkpoints tables, tasks.goal_id)
├── 1c. Server: goal-service (CRUD + state transitions + derivation)
├── 1d. Server: plan-service (propose + accept/reject + materialize-to-DAG)
├── 1e. Server: goal API routes
└── 1f. Tests: goal lifecycle, plan versioning, materialization

Phase 2: Checkpoint + Resume (v3.0 must-have)
├── 2a. Domain: checkpoint types + refs schema
├── 2b. Server: checkpoint-service (auto-create on lifecycle events)
├── 2c. Server: resume evaluation logic (compare checkpoint vs. current state)
├── 2d. Protocol: run.resume command (packages/protocol/src/node-messages.ts)
├── 2e. Server: grace window on node disconnect (ws/node-registry.ts)
├── 2f. Daemon: handle run.resume command (apps/artood/src/node-client.ts)
└── 2g. Tests: checkpoint creation, resume after restart, grace window

Phase 3: Budget Enforcement (v3.0 partial)
├── 3a. Server: budget-service (elapsed_ms + retry tracking + evaluation)
├── 3b. Server: hook budget checks into lifecycle events
├── 3c. Server: allowed_runtimes filter in scheduler
└── 3d. Tests: elapsed pause, retry exceeded, runtime filtering

Phase 4: Events + Audit (v3.0 must-have)
├── 4a. Domain: new event types (goal.*)
├── 4b. Server: emit goal events on state changes
├── 4c. Server: goal audit bundle export (extend audit-service)
└── 4d. Tests: event emission, audit bundle shape
```

### Dependencies on Other Workstreams

| This Phase | Depends On | Reason |
|---|---|---|
| Phase 1d (plan materialization) | — | Uses existing DAG/task infra |
| Phase 2d-2f (resume protocol) | #113 merged | Scheduler uses presence eligibility |
| Phase 2e (grace window) | #113 merged | Connection state informs grace behavior |
| Phase 3c (runtime filtering) | #113 merged | Uses `isSchedulable` helper |
| Phase 4 (events) | #114 (partial) | Decision/handoff events in rooms need #114 taxonomy |

### Parallelization Opportunity

- **Phase 1** can start immediately (no external dependencies)
- **Phase 2a-2c** can start in parallel with Phase 1 (checkpoint service design doesn't need goal routes)
- **Phase 3** can start after Phase 1c (needs goal-service to hook into)
- **Phase 4** should come last (needs all state changes to be in place)

---

## 8. API Surface (New Endpoints)

```
# Goals (v3.0 must-have)
POST   /api/v1/goals                        → 201 + goal snapshot
GET    /api/v1/goals?project_id=&status=    → goal list
GET    /api/v1/goals/:id                    → goal snapshot + latest checkpoint summary
POST   /api/v1/goals/:id/pause              → goal paused + checkpoint
POST   /api/v1/goals/:id/resume             → goal resumed + checkpoint
POST   /api/v1/goals/:id/cancel             → goal cancelled

# Plans (v3.0 must-have)
POST   /api/v1/goals/:id/plans              → 201 + plan (proposes new version)
GET    /api/v1/goals/:id/plans              → plan version list
GET    /api/v1/plans/:id                    → plan detail with task_specs
POST   /api/v1/plans/:id/accept             → plan accepted, triggers materialization
POST   /api/v1/plans/:id/reject             → plan rejected

# Checkpoints (v3.0 must-have)
GET    /api/v1/goals/:id/checkpoints        → checkpoint list (latest first)
GET    /api/v1/checkpoints/:id              → checkpoint detail with state_refs

# Goal Audit (v3.0 must-have)
GET    /api/v1/goals/:id/audit-bundle       → goal-level audit events
GET    /api/v1/goals/:id/audit-bundle/export → formatted export
```

---

## 9. Resolved Design Decisions (@SkywalkerCodex, 2026-06-25)

1. **Goal ownership transfer:** **Later.** v3.0 stores creator/owner/participants for audit and filtering, but no transfer workflow unless trivial from admin update semantics.

2. **Plan materialization atomicity:** **Yes, single transaction.** Idempotent around accepted plan version → task DAG creation. No partial accepted plan with half-created tasks.

3. **Checkpoint retention:** **Bounded.** v3.0 keeps all checkpoints while goal is active, then enforces a cap: latest 200 per goal + terminal/latest-accepted-plan checkpoints always retained. Not a launch blocker since refs are small, but do not design as infinite by contract.

4. **Goal room:** **Yes.** Add `"goal"` to `RoomType` enum. Auto-create a goal room on goal creation — gives #114 a stable discussion surface.

5. **Event schema version:** **Keep `"2026-06-11"`.** Extend enum/payloads only. Bump only if event envelope shape changes incompatibly.
