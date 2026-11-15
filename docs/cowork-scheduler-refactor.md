# Cowork scheduler refactor

Source: `Artoo 重构设计与实现方案.docx`, supplied by the user, 2026-11-14.
SHA-256: `1fd6936d9145f567f1b61a53e2d30e8f938b4480f76782612987e68d79b2f648`.
The reference explicitly did not inspect Artoo's source and has no authentication.
Its SQLite model is a specification example, not a replacement database or an
execution/verification authority. This document records the §3.3 source alignment
and staged acceptance evidence for the actual PostgreSQL/PGlite application.

## Source alignment (§3.3)

| Component | Existing owner / evidence | Required adaptation |
| --- | --- | --- |
| Tasks | `packages/db/src/schema/work.ts`: tasks, dependencies; nine existing task states, optional parent and assignee; no required computer | Reuse identities and public states. New queue projection must explicitly map states and keep historical attempts. |
| Enqueue paths | Task service; assistant service; discussion service; plan materialization; independent review; research revision | Central transactional writer, active source dedupe; preserve room creation, plan/spec uniqueness, authorization and attribution. |
| Claim / assignment | `services/lifecycle-service.ts`, `services/scheduler.ts`: locked task assignment, eligibility then ranking, runtime capabilities, device trust, per-instance capacity, workspace reservations | Add shadow claim and machine/Agent/project capacity under a shared database lock; retain all existing policy and approval gates. Do not execute shadow results. |
| Machines | `computers`, `agent_runtimes`, `agent_instances`; paired devices and `runtime-registry-service.ts` | Reuse stable paired computer identity and CLI/runtime inventory; migrate fixed instance bindings as explicit initial pinning. |
| Heartbeat / leases | `ws/node-ws.ts`, `services/presence-service.ts`; file leases in `lease-service.ts` | Execution leases are separate from file leases. Add versioned epoch-bound renewal without changing old frames. |
| Reaper / recovery | `execution-recovery-service.ts`, `ws/grace-window.ts`, `run-service.ts` | Existing disconnect means process uncertainty. Lease expiry must not release file resources or claim physical closure. Automatic failover needs per-attempt isolation and side-effect policy. |
| Work directories | Protocol allocation; artood workspace binding, owned worktree reservation, preflight and verification, retained workspace evidence | Reuse per-run allocation, protected roots, actual closure and retention. Bare cache is an optional strategy, not a reason to discard node ownership. |
| CLI adapter | `apps/artood/src/process-adapter.ts`, node runner/client and protected verification | Retain process-tree stop, output normalization and separate node-owned verification; model output cannot acquire authority. |
| Event stream | Append-only `event_log`, run-event ingest identity, ordered replay and client reconciliation | Reuse durable ordered log. Add optional versioned event metadata only if required; retain tenant/run/source binding. |
| Delegation | Task parent, plan DAG, GoalRunner, independent-review and research revision services | Add bounded depth/tree size to creation with cycle and tenant guards; preserve visible provenance, cancellation and human release authority. |
| Project | Project schema/routes, project-scoped instances, configured worktree baseline and trusted profile roots | Extend project scheduling configuration without treating a repo URL or remote argv as trusted local execution permission. |
| Authentication | Request-scoped session actor, paired device/node token, current session identity, approval and verifier binding | Enforce scoped attempt credentials in addition to existing auth. Do not use the prototype's logging-only authentication rollout. |

Organization ID is the blueprint's workspace/tenant ID. Public task states and
Run lifecycle remain unchanged during migration. Manual goals, autonomous goals,
dedicated source/release workflows and node verification retain their current
owners. Product merge/publish/delete gates must remain separate from task review.
The earlier user decision to require exact costs and defer cost budgeting remains
in force: no estimated expense cap is enabled by this refactor.

## Step 0: safety net and baseline

`ARTOO_SCHEDULER_ROLLOUT` is startup-only version 1 JSON. Configuration is validated
and frozen; unknown fields, non-boolean switches and unsupported versions fail
startup. Every switch defaults off. Explicit project values override workspace
values, including `false`. Project IDs are nested under their organization so a
project override cannot cross a tenant boundary.

```json
{
  "version": 1,
  "workspaces": {
    "org_default": {
      "flags": { "task_mirror": false },
      "projects": { "proj_artoo": { "claim_shadow": false } }
    }
  }
}
```

Reserved switches: `task_mirror`, `unified_enqueue`, `claim_shadow`, `daemon_claim`,
`lease_failover`, `isolated_workspaces`, `delegation_limits`, `attempt_credentials`.
Only implemented consumers can change behavior; defining a reserved flag is not
evidence that its phase is implemented or accepted. No real claim, reaper or new
Daemon protocol is enabled by step 0.

Settings contains an on-demand **Scheduler baseline · last seven days** panel
for the selected project. It reads
`GET /api/v1/projects/:id/scheduler-observations`. The endpoint uses the existing
request context, tenant-scoped project validation and a read-only repeatable-read
transaction. It never creates tasks, events, authorizations or scheduling decisions.

| Measurement | Definition |
| --- | --- |
| Queue | Durable `task.updated(status=ready)` to the next `task.assigned`; each retry/review cycle has its own sample. Event position disambiguates equal timestamps. Missing/reversed timestamps are omitted and sample counts exposed. |
| Execution | Started to ended for terminal Run records whose end falls in the requested window; no start means no duration sample. |
| Failure rate | Failed / completed+failed+cancelled Runs with a persisted end inside the window; no denominator returns null. |
| Hanging tasks now | Distinct tasks with queued/starting/running/paused/awaiting-input attempts older than the configured threshold. Includes intentional waiting; not a claim of deadlock. |
| Unconfirmed disconnects now | Failed daemon-disconnect Runs without exact persisted process-exit confirmation. These remain separate from active-status hanging tasks. |

Default window: the previous seven days, ending at the server clock. API query
fields: ISO `from`, ISO `to`, integer `hanging_after_ms` (default one hour; range
one second to seven days). Window is `[from,to)`, positive, no more than 31 days,
and cannot extend into the future. Current gauges use observation time, even when
an explicit historical window is supplied. Historical observations require saved
snapshots; this API does not reconstruct previous current gauges.

Characterization tests exercise existing submission, assignment, node ingestion,
failure/retry and disconnect handling. Existing mixed-node, allocation, trusted
verification, grace and execution-recovery suites remain required compatibility
checks. Controlled CLI/E2E runs are not external Provider acceptance.

## Step 1: additive policies and task projection

Migration `0063_scheduler_projection.sql` adds versioned project, Agent and
computer policy records, a minimal task projection and durable reconciliation
history. Existing identities, Task/Run states, room contents, authorization and
node-owned evidence remain authoritative. DDL does not import historical rows.
An explicit `task_mirror` startup scope enables import and mirror writes. Only
nonterminal tasks are initially imported; a mirrored task keeps its terminal
record. `attempt_count` counts persisted Runs, never inferred retries; initial
`lease_epoch` is zero. No prompt, command, token or verifier capability is copied.

All six creation paths and all seven Run creation paths mirror in the original
transaction, as does `transitionTask`. Assignment mirrors again after inserting
the Run and updating the assignee, so the attempt count cannot lag. Incompatible
projection identity/version or a nonzero lease epoch causes the original write
to roll back. Turning the startup flag off returns to legacy-only writes while
retaining projection and reconciliation evidence for later inspection.

`POST /api/v1/projects/:id/scheduler-reconciliations` accepts an explicit
`{"repair":false}` or `{"repair":true}`. It requires the current request's
administrator and reads one repeatable-read snapshot. It avoids taking extra
Task locks across existing multi-task workflows. A projection concurrently
changed after that PostgreSQL snapshot rejects repair with a serialization
error; the monitor reports it and retries at the next scan. Source and mirror
changes commit together in enabled writers. Repair cannot overwrite a nonzero
epoch or foreign identity/version.
Timestamp comparison and copying retain the database's full microsecond precision.
The report persists counts and drift **before** and **after** repair; unresolved
identity mismatches stay visible. A clean repaired result alone does not satisfy
three days of consistent observations. GET returns the latest 50 scoped reports.
The non-overlapping monitor repairs enabled scopes every minute, reports drift
even when repaired, and waits for outstanding work when the server closes.

GET/PUT `/api/v1/{projects,agents,computers}/:id/scheduling-policy` reads or saves
strict version 1 metadata. PUT holds administrative authorization through commit
and validates targets and Agent pin against the same tenant and non-deleted resources.
Changes append an actor-attributed event. Responses explicitly say `active:false`:
these policy limits and labels are prepared for shadow scheduling, not consumed
by legacy scheduling. Missing policy is null, never an implicit unpinning or limit.
Fixed legacy Agent-instance/computer bindings remain in effect. Before claim
activation, their mapping must be reviewed and migrated as explicit pins; a
multi-computer identity cannot be resolved to one pin by guesswork.

Repository URLs and branch names are metadata, not local clone/execution
permissions. Trusted node profiles, approval gates and workspace ownership retain
their existing authority. No live claim, reaper, budget, node token or automatic
publication is enabled in this step.

The opt-in mirror's browser characterization is
`npm run test:e2e:scheduler --workspace @artoo/web`: a separate ephemeral server
starts with `task_mirror:true`, then browser submission, controlled mock execution,
human acceptance, reload and drift-free reconciliation exercise the real routes.
The ordinary Web E2E suite continues to use its existing default-off setup.

## Step 2: unified transactional enqueue

`services/task-enqueue-service.ts` is the sole production Task insert owner. All
six creation paths call it inside their original business transaction. Their
room/message/events, request authorization, initiating actor, plan/spec uniqueness,
assistant request replay, discussion guards and independent-review/revision
attempt guards remain with their existing owners. The off path keeps the legacy
Task insert and optional mirror in this writer for the required release cycle.
Parent references must resolve in the same organization and project.

`unified_enqueue` remains default off. Enabling it records explicit source
bindings and immutable event replay identities in additive migration
`0064_task_enqueue.sql`; it does not invent historical source keys. Internal keys
are manual Task identity, assistant room/thread + durable client request,
discussion operation identity, plan/spec identity, independent-review operation
identity and research-revision operation identity. Existing complete-operation
guards run first. A repeated internal insertion fails instead of duplicating its
business side effects. No Issue connector is introduced.

The existing `POST /api/v1/tasks` optionally accepts strict version 1
`enqueue_source`: `kind` (`manual` or `issue`), `key`, `event_id`, optional
`target_key` (default `default`) and optional nonblank `comment` (at most 20,000
characters). These are user provenance, not an Agent/Issue execution grant. An
off project rejects this opt-in explicitly instead of silently creating undeduped
work. Source scope includes organization, project, authenticated initiating user,
kind and target. The source row serializes concurrent insertions, then locks its
active Task; lifecycle transitions never acquire the source lock.

An exact event replay returns the original Task/room even after it is terminal;
changed event content is a conflict. A new event reuses a nonterminal Task only
when immutable description, criteria, capabilities, parent/policy, preference,
priority and creation provenance match. A new event after `done` or `cancelled`
creates fresh work. Acceptance/cancellation and enqueue serialize through the
Task lock. There is no implicit ready/assignment or additional authorization.

Every accepted source comment becomes one normal user message in the task room
and a `message.created` event in the same transaction. Event replay creates no
extra message. Source replay records hold only a digest and message reference;
comment content uses the existing moderated message table. Frozen Run contexts
retain their then-visible content as execution history. Content rules
and active team membership apply. New comments remain visible during a run, but
cannot amend that run's frozen ContextPack.

Assignment freezes all currently visible comments in optional version 1
`source_inputs`, including their digest and message/event identities. Comments
also appear in the existing `task.description` context field for older Daemons;
the persisted Task's original description/criteria do not change. There is no
silent truncation: at most 100 visible comments and 200,000 aggregate characters
are accepted per Task; a new input over the bound is rejected explicitly. A
moderated comment is excluded from future contexts. The shared Task transition
owner rejects acceptance unless the latest completed Run's persisted scoped
ContextPack has the current digest. Late inputs therefore require the existing
human `changes_requested -> ready -> run -> review` loop. Turning the rollout
flag off does not bypass the acceptance check for already persisted comments.

Focused integration covers active dedupe, exact replay, terminal new triggers,
intent conflicts, scope isolation, transaction rollback, moderation and the late
input review loop. The opted-in browser suite also exercises visible comments and
that review loop. The explicit PostgreSQL integration suite uses built production
services and concurrent independent transactions to check actual source/Task
locks; PGlite alone is not concurrency evidence. Automated checks and elapsed
installation rollout remain separate acceptance scopes.

`npm test -- --config vitest.enqueue.config.mjs --maxWorkers=2` reruns the
original assistant, discussion, plan, Agent Team peer-review and imported research
revision suites with both enqueue and mirror enabled. Its test-only environment
sets fixture configuration; it does not mock product services or weaken their
original assertions. The normal suite keeps deterministic default-off fixtures.

## Step 3 in progress: shadow ownership and counterfactual ranking

`packages/domain/src/scheduler-ranking.ts` defines a versioned, non-executing
comparison over the existing scheduler's qualified candidates. It preserves
legacy score ordering and explicit manual choice, then explains exclusions for
new policy, capacity, queue timing, pinning and soft affinity. Missing policies
remain explicit. The old manual runtime-inventory fallback can appear in the
snapshot, but an unconfirmed runtime is not evidence for new-path eligibility.
Every result carries `execution_authorized:false`.

The pure module evaluates supplied occupancy. Server-side shadow collection
includes active Runs, held Run-backed file reservations, unconfirmed disconnects
and unsettled dedicated operations from the existing execution-state owner.
Run-backed reservations count once; dedicated identifiers keep their namespaces.
Each participant Agent counts once per operation, across all of its instances.
The project count is scoped to the current project; Agent/computer occupancy spans
the tenant. Records retain the capacity evidence, not just aggregate counts.

With `claim_shadow` enabled, ordinary `assignTask` captures its original qualified
candidate set and reads the new policies/capacity before creating the real Run.
It stores the snapshot, explained ranking, collection start/end times and later
selected-instance revalidation with the original scheduler decision, in the same
transaction. These reads are a bounded collection interval under the existing
transaction isolation, not an atomic global snapshot or an alternate historical
schedule. No shadow attempt is created by observation. Only the existing owner
creates/dispatches the real Run. Turning the switch off stops sampling and keeps
the historical evidence. GET `/api/v1/projects/:id/scheduler-shadow-observations`
returns the latest 50 scoped comparisons without recomputing their inputs.

Additive migration `0065_scheduler_shadow_leases.sql` keeps shadow heads, attempts
and observations separate from the legacy projection. Internal shadow-only
claim/start/renew/finish/cancel functions bind tenant, project, Task, attempt,
Agent, instance, computer and monotonically increasing safe-integer epoch. An
organization-scoped **non-waiting** advisory mutex serializes shadow mutations;
Task acquisition uses SKIP LOCKED. A busy result requires a whole-operation retry.
Lease comparisons occur in SQL at full timestamptz precision using the injected
server clock. Renewals cannot shorten a lease. An expired or terminal binding
cannot start, renew or finish a newer owner. Epoch exhaustion rejects atomically.

The kernel adds open shadow claims to observed occupancy, excluding any claim
whose Task already has a real execution, to avoid counting the same work twice.
Its three capacity levels constrain **shadow claims only**. Existing real Run and
dedicated-operation admissions do not acquire this new mutex; global real
capacity enforcement still requires their shared admission boundary in the later
executing path. These internal functions have no node HTTP endpoint or execution
grant. Every stored/resulting shadow attempt has `execution_authorized:false`.
Logical expiry/finish never changes Task/Run state, file resources, node-owned
verification, process-closure evidence or dispatch. Actual failover stays off.

POST `/api/v1/scheduler/agent-pin-import` requires the current administrator and
an explicit `{"apply":false}` preview or `{"apply":true}` import. One
repeatable-read configuration snapshot supplies only unambiguous non-deleted
Agent-instance/computer bindings. Existing policies, including explicit unpins,
are preserved. Missing/multi-computer mappings are returned for review rather
than guessed. Imports append an actor-attributed policy event; they do not move
instances or activate execution. Configuration changes after the snapshot need
separate review before activating a new path.

New automated regression sources cover these boundaries; their results are
tracked separately from elapsed installation observation. Durable original-user
scheduling intent still needs integration before a real claim protocol. No real one-week shadow observation,
global real-capacity guarantee or two-machine fault drill is claimed here.

### Persisted queue timing and soft affinity

Additive migration `0066_scheduler_queue_metadata.sql` stores optional per-Task
version 1 metadata and a monotonically increasing safe-integer revision. GET/PUT
`/api/v1/tasks/:id/scheduler-queue-metadata` explicitly returns `active:false` and
`execution_authorized:false`. PUT requires the current administrator, holds the
Task lock, and accepts only `backlog`/`ready` Tasks. It checks the preferred
computer's tenant and non-deleted identity. The strict input requires
`version:1`, nonnegative integer `not_before_ms`, and both
`preferred_computer_id`/`prefer_until_ms` (or both null). Milliseconds are bounded
by JavaScript's valid Date range. Explicit nulls clear affinity. The same
transaction stores the revision and actor-attributed audit event; it does not
modify Task/Run state or grant execution. Revision exhaustion rejects.

Original assignment capture and internal shadow claims read this exact scoped
row. New snapshots include optional version 1 `queue_metadata` provenance with
Task identity, source (`persisted`/`legacy_default`) and revision. Historical v1
snapshots retain their original shape. Missing historical configuration is
explicitly zero/null with a legacy-default origin; it is not backfilled or
inferred from a prior machine. Existing saved comparisons are never rewritten.
Shadow ranking explains a not-before exclusion and releases affinity at the
exact server deadline; explicit manual selection retains its existing affinity
override. The existing real assignment path remains unchanged while this
metadata is staged for comparison.

This item does not introduce automatic retries, change enqueue replay identities,
or create a durable execution authorization. The future original-user scheduling
intent must bind the metadata revision, exact consent/policy/profile and current
approval, then reject changed or revoked authority before real admission.

## Migration and acceptance gates

| Step | Implementation / activation gate |
| --- | --- |
| 0 | Central flags, read-only baseline and public-entry characterization. A real installation must collect one week of baseline; adding a seven-day query does not supply seven days of evidence. |
| 1 | Ordered additive SQL migration and compatible schema; nonterminal import, actual attempt counts, epoch zero; transactional task mirror plus reconciliation. Three consecutive days of consistent reconciliation before switching authority. |
| 2 | One transactional enqueue writer for all six paths; active tenant/source dedupe, existing room/plan uniqueness; preserve previous paths for a version cycle. |
| 3 | Database claim/fencing kernel, three capacity levels and replaceable ranking; one week of explained shadow comparisons. Existing approval, capability, project and physical-closure guards remain mandatory. |
| 4 | Optional versioned registration/claim/renewal; independently progressing heartbeat; mixed old/new nodes and server-restart drill. |
| 5 | Enable reaper only for eligible isolated attempts; real two-machine five-minute fault drill, takeover within one minute, stale writes rejected. State ownership is not exactly-once side effects. |
| 6 | Real concurrent Git isolation, cache/ref serialization, baseline freshness, retained branches and actual process closure before directory cleanup. |
| 7 | Depth 3, tree size 30, visible delegation/cancellation, human release gates. Exact-cost cap remains deferred by the user's earlier decision. |
| 8 | Replayable events and scoped credentials revoked on terminal/epoch change; cross-machine and cross-project denial tests. Existing auth always enforces. |
| 9 | All flags fully rolled out for one release cycle, backup/archive verified; only then retire one legacy path per commit. No legacy table deletion before this gate. |

Implementation, automated verification, merge, production activation and elapsed
observation are separate statuses. A local fixture, reference test, old Preview
CI, or a passing Web test cannot mark the remaining rollout gates complete.
