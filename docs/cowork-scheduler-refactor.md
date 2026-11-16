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

Reserved switches: `task_mirror`, `unified_enqueue`, `claim_shadow`, `capacity_admission`, `execution_requests`, `daemon_claim`,
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
these full policies remain staged. The separate `capacity_admission` status below
reports optional consumption of concurrency limits only. Missing policy is null,
never an implicit unpinning or limit.
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

Source-context reads filter moderated comments in SQL and return at most 101
visible entries, using the extra entry to reject overflow. They select only the
context fields; a separate one-row scoped existence check distinguishes no source
input from entirely moderated history, which retains its empty input digest.
Visible ordering, digest bytes and the 200,000 JavaScript-character limit stay
unchanged. This bounds rows materialized by the server, not the database work
needed to scan historical comments.

Context creation and acceptance now freeze those visible source-message rows
under `FOR SHARE OF messages NOWAIT` through the same owner transaction. The
caller already owns the Task lock, which serializes new source comments; message
locks separately prevent concurrent moderation from changing the captured body.
A busy message returns 409 and rolls back the complete assignment/review. Only
the actual lock-unavailable database code is mapped; other errors retain their
original meaning. NOWAIT avoids waiting against moderation's message-to-Task
event order. Empty, entirely moderated, scoped and overflow semantics stay the
same. Read-only request snapshots and enqueue accounting remain plain reads and
acquire no new execution authority. No node pre-spawn or lease guarantee follows
from this context/review fence alone.

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
Its three capacity levels constrain **shadow claims only**. Real reservations use
the separately gated capacity admission boundary described below, with their own
mutex namespace. Shadow claims never reserve physical execution capacity.
These internal functions have no node HTTP endpoint or execution
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

### Assignment transaction boundary

Ordinary `assignTask` retains request preparation, its original clock sample,
transaction ownership and the post-commit `onRunQueued` call. Its private
`assignTaskInTransaction` core owns the existing ordered assignment statements:
authorization, Task and configuration locks, capability revalidation, approval,
context, Run, reservations, projection and events. It has no dispatch hook or
new HTTP entry point. The extraction does not enable claim execution or change
existing manual, assistant or dedicated-operation authorization.

Regression coverage rejects a real database transaction after all assignment
writes and checks complete rollback with no dispatch. Successful dispatch reads
committed records through the original client; a transport failure retains the
committed queued Run and cannot create a duplicate assignment. A future real
claim must own its complete admission transaction and use an internal core;
calling ordinary `assignTask` inside an outer transaction remains unsupported.

### Exact scheduling policy revisions

Additive migration `0067_scheduler_policy_revisions.sql` adds a positive
safe-integer `revision` to project, Agent and computer scheduling policies.
Existing rows start at 1 without changing their policy, actor or timestamp;
this is an upgrade baseline, not a reconstruction of past edits. Every accepted
administrator PUT atomically increments the current row in SQL, including
repeated values and changes back to an earlier value. Exhaustion rejects with
no write. The audit event records that same revision in the same transaction.
Pin import creates revision 1 and preserves existing rows and their revisions.

New shadow snapshots include optional version 1 `policy_revisions` provenance
for exactly their captured project, Agent and computer policies. Missing policy
stays null/absent. Historical version 1 snapshots without this field retain
their original shape, and persisted observations and attempts are not rewritten.
Collection is still a bounded read interval, not a globally atomic policy
snapshot. Ranking and ordinary execution behavior do not change.

The revisions let a future deferred scheduling intent reject changed policy
even when its values or timestamp match again. They are not an execution grant;
original-user intent, exact consent/profile bindings and shared real capacity
admission still require their own integration.

### Original-user intent staging

Migration `0068_scheduler_intents.sql` adds immutable version 1 shadow request
snapshots, a unique request key per Task, one pending request per Task and durable
cancellation history. It imports no historical authorizations. These requests
are explicitly inactive and have `execution_authorized:false`; they cannot
create a Run, dispatch work, reserve a real execution slot or authorize review.

With `claim_shadow` enabled, POST `/api/v1/tasks/:id/scheduler-intents` accepts
only `version:1`, `request_key`, the exact current Task `base_version`, a logical
`agent_id`, `branch_backed:true` and explicit `write_paths`. It does not accept a
computer/instance, actor, consent, profile, command or policy revision from the
caller. The current authenticated user must have active membership and current
AI-sharing authorization. Version 1 supports only ordinary ready Tasks; Goal,
plan, discussion, assistant and other dedicated owners retain their existing
paths. A current execution approval, if requested, must already be approved.

One repeatable-read transaction captures the original user, exact AI consent
ID/disclosure version, Task/source-comment/approval digest and durable input
event version, queue revision and explicit project/Agent/candidate-computer
policy revisions. It also hashes the configured Agent instance pool, project
workspace, computer capabilities, model/effort catalog and project/organization
skill configuration. Configuration contents are never stored in the request or
its audit payload. Status/heartbeat changes do not change this configuration
digest; changed configuration, including additions to the captured pool or
catalog, requires a new request. No node-local verifier authority is captured.

The Task input version excludes only the explicitly named shadow and execution-request metadata audit types;
other Task events, source input changes and approval replacement invalidate the
request. Every accepted policy edit invalidates through its revision, including
equal values and changes back to an old value. An exact request-key replay returns
the original record and cannot revive cancellation. Another pending request must
be explicitly cancelled first. Creation and cancellation audit writes commit
with their records.

Concurrent staging that loses the pending/request unique constraint or the
repeatable-read snapshot returns an explicit 409 conflict, without retrying or
committing an extra audit. Other database errors are not reclassified.

GET on the same collection retains the latest 50 scoped records even after the
rollout switch is off. POST
`/api/v1/tasks/:id/scheduler-intents/:intentId/cancel` requires `{"version":1}`
and the original active user or a current administrator. Cancellation remains
available after consent withdrawal and when staging is off; it never rewrites
the original snapshot or historical shadow attempts.

Internal shadow claim optionally takes an `intentId`. Under the Task lock it
rechecks the original user's membership and exact consent, rebuilds every
captured binding and limits candidates to that original logical Agent. The
sampling context's default actor cannot replace the original user. New shadow
snapshots add optional version 1 `intent_provenance`; old snapshots retain their
shape. Cancellation or changed/revoked bindings reject another shadow claim.
An existing hypothetical attempt does not acquire real execution authority.

These are bounded configuration reads and shadow comparisons. Shared real
capacity admission, complete executing-claim authorization, node protocol,
attempt credentials and real failover remain separate work. Actual scheduling
activation must not reinterpret this staged metadata as an execution grant.
The exact-cost requirement remains unchanged and cost budgets remain disabled.

During intent validation, two complete parallel Windows invocations each timed
out in a different existing case of `application-invocation-bridge.test.ts`.
The unchanged full 40-case file passed locally at its original deadlines. The
specific host delay is not established. CI now runs that entire synchronous
SQLite/wire suite in the existing dedicated Windows serial partition, alongside
the four process-observation files. The actual-reporter coverage gate still
requires every discovered file exactly once across all partitions. No bridge
case, assertion, deadline, platform skip or cleanup rule changes; this isolation
is not evidence that the earlier failed invocations passed.

### Shared real reservation capacity

`capacity_admission` is independently default off. In an organization with any
enabled workspace or project scope, all seven Run insertion paths and seven
standalone operation owners participate in one non-waiting organization advisory
mutex. An actual read-committed database transaction is required; a bare handle
or repeatable-read snapshot is rejected. Contention returns a 409 and requires
retrying the complete business operation, including its original authorization.
The off organization adds no capacity reads or mutex queries.

Enabled projects require explicit project, computer and every participant Agent
policy. Project `false` disables that project's quota and explicit-policy
requirement. Every reservation in the organization still obeys present shared
Agent/computer policies, including work in projects with the project quota off.
Missing policies are never invented; malformed consumed policies fail closed.
This consumes only concurrency limits, without activating new pinning, labels,
ranking, claim, execution tokens or failover.

Capacity counts the existing durable execution facts: active Runs, held Run-backed
file leases, unconfirmed disconnects and unsettled dedicated operations. A backed
Run counts once; a standalone review counts once for its project/computer and once
for each distinct participant Agent. All exact participant instance identities
are retained in observation evidence. Logical completion or lease expiry cannot
stand in for actual process closure or release protected workspaces.

Run-backed owners check before Run insertion. Five standalone review owners check
before inserting their reservation. Handoff and imported-product review check in
the first start-delivery transaction, where their existing occupancy begins.
An already-counted start may replay only with the exact project, computer, Task
and participant instance/Agent bindings, while retaining every original start
fence. Stop, status, result, receipt and physical closure remain available at full
capacity. Admission rejection rolls back original context, resources, events and
business records before dispatch.

Policy PUT and applied pin import use the same mutex. Lowering a quota preserves
existing work and rejects additional reservations until occupancy falls below it.
Active apply-import uses read committed; off-mode apply and read-only previews
retain their original repeatable-read behavior. Policy endpoints keep the legacy
`active:false` full-policy marker and add `capacity_admission` with precise shared
and project quota consumption status.

The focused capacity suite covers three quotas and ordinary transaction rollback;
fourteen controlled business-entry cases cover all dedicated reservation owners.
Their new full-history fixtures have a 90-second body limit; original cases,
process observations and 25-second cleanup drains are unchanged. The separate
PostgreSQL integration cases exercise distinct actual backend PIDs and contention
with policy lowering. `npm run test:e2e:capacity --workspace @artoo/web` runs an
isolated browser suite with explicit policies and controlled mock execution. It
checks a visible capacity conflict, no leaked Run, reload, capacity recovery and
human acceptance. These test scopes do not establish a live Provider run or an
installation's observation/rollout gates.

Ordinary assignment keeps its instance-then-computer lock order and refreshes
the selected candidate's eligibility only after acquiring both locks. Runtime
heartbeats share the computer lock; a changed runtime status, capability or
freshness, or a computer becoming offline during that wait therefore cannot
leave an already-stale eligibility result in use. Real PostgreSQL regression
cases observe the actual lock wait and check rollback without dispatch, plus
successful ordinary and shadow-enabled assignment when eligibility remains valid.
This fence does not by itself implement the later executing claim transaction.

### Configuration writer fence

Any `daemon_claim` opt-in within an organization now makes its configuration
writers share a non-waiting organization transaction mutex. Project creation and
workspace edits, Agent/instance creation and tombstones, instance project,
worktree and enable edits, skill installs, policy PUT and applied pin import all
participate, including new pool/catalog rows. An organization with the flag off
adds no mutex or isolation queries. Project opt-out cannot remove the shared
fence needed by another project using the same Agent pool or global skills.

The fence requires an actual read-committed transaction. Contention returns 409
and rolls back the complete operation; callers must repeat original authorization
on retry. Applied pin import uses read committed when either configuration or
capacity requires it; read-only preview retains repeatable read. Policy reads,
pin previews and runtime heartbeats do not acquire this configuration mutex.
Heartbeat eligibility retains its existing selected-computer row fence.

This is preparation for executing admission. There is still no real claim
consumer, and it does not fence Task inputs, moderation, approval, consent,
paired-node authority or local verifier configuration. Those remain separate
mandatory checks. All server instances must use the same startup rollout scopes;
future configuration writers must join this mutex before claims can use them.

### Explicit conditional execution requests (implementation in progress)

Version 1 shadow intents retain their false-authority constraint and original
request/snapshot contracts. They cannot become execution requests. Additive
migration `0069_scheduler_execution_requests.sql` creates a separate version 2
history with one pending request per Task and a unique request key per Task.
It imports no prior records or authorizations. SQL protects immutable identity,
snapshot, digest and creation time, rejects deletion and prevents cancellation
from being reversed or rewritten.

The independent startup switch `execution_requests` defaults off and enables
request **storage only**. POST `/api/v1/tasks/:id/scheduler-execution-requests`
requires `version:2`, explicit `permission:"execute_once"`, `request_key`, the
exact current Task `base_version`, one logical `agent_id`, `branch_backed:true`
and explicit `write_paths`. A caller cannot provide an actor, consent, computer,
instance, policy revision, profile, command or node authority. Only ordinary ready
Tasks are supported; all dedicated execution owners retain their paths.

The authenticated active user supplies fresh conditional permission. In one
repeatable-read transaction the server captures that user, exact AI consent and
disclosure, approved execution gate, current Task/source inputs, queue and policy
revisions, and configuration digests through the same bounded binding collector
used by shadow intents. Configuration contents and secrets are never copied.
Only the four named shadow/execution-request creation/cancellation audit types
are metadata; other Task events remain inputs. Equal accepted policy edits still
invalidate through revisions. Changed consent cannot be replaced by re-consent.

An exact key replay returns the original historical record, including after
cancellation. It does not refresh permission, its bindings, or its validity.
Another pending request must first be explicitly cancelled. GET returns the
latest 50 scoped records; POST on `/:requestId/cancel` requires `{"version":2}`
and the original active user or a current administrator. Listing and cancellation
remain available with the switch off, and cancellation needs no active AI consent.
Request and audit writes commit or roll back together. Concurrent serialization
or request-key/pending-Task unique conflicts return 409 without a hidden retry.

Every response says `consumer_available:false` and `execution_authorized:false`.
Storing permission creates no Run, shadow attempt, capacity/file reservation or
dispatch. The internal snapshot checker reconstructs the original user and rejects
changed/revoked bindings, but supplies no executing admission guarantee: current
configuration writers are not all serialized by these bounded reads. A later
consumer must fence the configuration it uses, rerun every legacy gate and shared
capacity admission, consume once into an exact durable attempt, and perform trusted
node pre-spawn revalidation. `branch_backed:true` alone does not establish an
isolated per-attempt directory. No real claim, node protocol, lease/failover,
attempt credential, publication or cost budget is enabled by request storage.

The request, migration and compatibility suites cover strict permission/version
boundaries, original-user authentication and revocation, exact consent, approval,
input/policy/configuration drift, replay/cancellation and audit rollback. The
separate PostgreSQL test exercises independent backend transactions, concurrent
staging/replay/cancellation and a Task-lock input-change race. Implementation and
executed validation are tracked separately in the PR; these cases do not establish
an available claim consumer or satisfy elapsed installation rollout gates.

### Internal one-time consumption kernel (Step 3; no node consumer)

Additive migration `0071_scheduler_execution_consumption.sql` extends version-2
requests with terminal `consumed` state and an exact Run, paired device, session
and timestamp binding. Pending/cancelled records keep their previous meaning;
no shadow intent or historical permission is imported. SQL prevents rewriting,
deleting, cancelling or reopening consumed history, preserves request-key
uniqueness, and requires the Run's tenant, project, Task, logical Agent, original
user, exact consent and generated per-run workspace metadata to match. A consumed
request frees the pending slot but cannot authorize another Run.

`claimSchedulerExecutionRequest` is an internal database entry, deliberately
unwired from HTTP, WS, polling or timers. It requires all four project startup
scopes: `execution_requests`, `daemon_claim`, `capacity_admission` and
`isolated_workspaces`. One read-committed transaction acquires the shared
configuration/capacity fences, Task lock, source-input locks, active original-user
authorization and the current registry-owned paired session's exact credential.
It ranks only eligible instances of the requested logical Agent, with fresh
runtime inventory and policy/queue constraints. It retains instance-before-computer
lock order and repeats snapshot/eligibility/ranking after both lock waits.

The original assignment transaction then supplies all existing approval,
capability, ownership, context, workspace, physical-uncertainty, capacity and file
lease gates. A generated branch without an actual per-run allocation is rejected;
mock runtimes cannot be consumed. Run/context/decision/leases, Task assignment,
terminal request consumption and the system scheduling audit commit together.
Run authorization remains attributed to the initiating user. The audit records
the policy ranking as decision evidence; that ranking object itself retains its
false-authority contract. A final synchronous registry comparison rejects a
session replacement observed during preparation. Node admission must still
revalidate before any physical process starts.

An exact replay on the same current paired session reads the original Run and
creates no additional reservation, event or dispatch. A different session cannot
take it over. This kernel intentionally invokes no dispatch hook, and ordinary
`run.start` rejects a Run bound to a consumed request even if a generic restart
dispatcher discovers it. Storage APIs therefore still report
`consumer_available:false` and `execution_authorized:false`. No startup flag alone
enables execution. The next protocol slice must provide node-owned pre-spawn
attempt identity, replay handling and explicit start authority before connecting
this kernel to a live consumer; renewal, fencing epochs, failover and scoped
attempt credentials remain pending. A prepared database Run is not a running
process or a publication result.

Regression coverage uses actual migrated PGlite for atomic consumption/replay,
original-user attribution and consent, disabled scopes, credential/session/runtime
changes, missing isolation, audit rollback and ordinary-dispatch denial. Migration
coverage checks additive upgrade/rollback, exact SQL bindings, immutable terminal
history and backup restoration. The separate PostgreSQL integration case uses
independent backend sessions for competing consumption and an observed instance
lock wait followed by disabled eligibility. These are controlled database and
transport tests, not live Provider or elapsed rollout acceptance. Executed results
are recorded with the implementation PR.

Credential row locks prevent concurrent edits but cannot prevent wall-clock
expiry. The internal claim therefore retains only the locked token's expiry
and rechecks it with the original paired session after resource-lock waits,
before returning a replay, and after all new claim/prepared-start writes.
Reaching the exact expiry boundary rejects and rolls back permission consumption,
Run, context, reservations and audit together. No new awaited work follows the
last check. Node physical admission still needs its own current-credential
check; a committed database preparation cannot extend a token's lifetime.
Regression coverage advances a controlled clock during preparation and during
an independently observed PostgreSQL instance-lock wait, without modifying the
locked credential or weakening rollback assertions.

### Immutable prepared-start bindings (Step 3 to Step 4 boundary)

Assignment legitimately changes the Task's state, assignee, timestamp and approval
Run binding. Its ready-state permission digest cannot be reused as the digest of
that assigned Task. Migration `0072_scheduler_prepared_starts.sql` adds a separate
immutable version-1 record for each newly consumed request. It preserves the
original request digest and user/device/session identities while recording the
actual assigned Task/source/approval digest and durable input version, policy and
queue revisions, configuration digest, and a digest of the queued Run, frozen
ContextPack, scheduling decision and file leases. Configuration contents and
context text are not copied into this record.

The record is inserted after assignment and the consumption audit, inside the
same claim transaction. An insertion failure rolls back the complete claim.
SQL binds it to the exact consumed request, assigned Task, queued unstarted Run
and paired session; update and deletion are forbidden. Upgrade does not backfill
old consumed requests, and ordinary request replay does not manufacture a record.
Their absence therefore cannot be treated as permission to launch old work.

The internal comparison helper compares persisted post-assignment evidence without
pretending the Task is still ready or silently refreshing its user permission.
Its contract explicitly says `execution_authorized:false`. Callers must still
fence concurrent writes; equality alone checks no current user consent, node
eligibility, protected local profile or physical process. No route, poller,
transport consumer or pre-spawn grant uses it yet. The ordinary `run.start`
rejection remains in place. Node-owned attempt admission, authorization/eligibility
revalidation, durable replay protection and a physical-start receipt are still
required before live dispatch can be enabled.

Regression coverage includes actual bound execution approval, post-assignment
Task/approval/context/Run/decision/lease/configuration drift, atomic receipt-write
failure, original request replay, additive migration rollback without backfill,
SQL identity rejection and backup restoration of immutable history. Independent
PostgreSQL backend consumption also checks that exactly one false-authority
prepared-start record exists. Executed results remain separate from this coverage
description and do not establish live Provider acceptance.

### Current prepared-start revalidation (Step 4 prerequisite)

The internal revalidation service opens a new read-committed transaction and
reuses the claim's configuration/capacity/Task/original-user/device/credential
fences and all four startup scopes. Only an already consumed request with its
original immutable prepared-start record is eligible. Current team access and
the exact original AI-sharing consent are required again; renewed consent cannot
replace a withdrawn grant. Instance and computer locks retain the existing order.
Source-message locks and a complete prepared-binding comparison follow those
waits, then fresh runtime, capability, online/trust, instance-capacity and policy
checks run. The current paired session and credential expiry are checked last.
The exact Run, context, decision and existing file-lease rows are held under
non-waiting shared locks after the waiting resource locks. A busy lifecycle or
evidence writer returns a complete-operation 409 rather than waiting against
Run-event ingestion's Run-to-Task lock order. Other database errors are preserved.

The scheduler has a separate internal prepared-candidate entry point. It derives
the sole self-reservation exclusion from the immutable queued unstarted Run,
rather than accepting an arbitrary Run ID in ordinary scheduling options. This
lets a single-slot reservation validate itself. Policy revalidation likewise
subtracts only that exact ordinary occupant, after checking its Task, project,
Agent, instance, computer and occupancy evidence. Other Runs, held leases and
dedicated reservations still count at every quota level. The reservation remains
persisted throughout; no capacity is freed or reallocated.

Revalidation writes no event, request, Run, lease or receipt and calls no dispatch
hook. Its observation explicitly returns `execution_authorized:false`; it cannot
be cached as a later start permit. No HTTP/WS/poller invokes it yet. A node-owned
attempt protocol must incorporate current admission within its own transaction,
durable journal replay protection and a physical-start receipt before live
execution can be connected. Ordinary consumed-Run dispatch remains rejected.

Regressions cover single-slot self-validation, retention of other reservations in
instance/project/Agent/computer capacity, repeated read-only validation, pending
request rejection, access/consent/session/expiry/inventory/input changes and an
observed PostgreSQL resource-lock wait followed by disabled eligibility. Executed
results remain distinct from these coverage sources and from live acceptance.

## Explicit delegation (independent Step 7)

Existing `parent_task_id` also records conversation continuations and research
successors. It retains those original semantics; historical parent links are not
guessed into delegation or capped. Additive migration `0070_task_delegations.sql`
stores new explicit version 1 child/parent/root/depth identities separately and
keeps the original Task row and existing conditional-request digests unchanged.
SQL rejects lineage rewrites/deletion and changes to a participating Task's
scoped identity or a delegated child's parent. Ordinary lifecycle status updates
remain available.

`POST /api/v1/tasks` optionally accepts strict
`delegation:{version:1,parent_task_id:"..."}`. An additionally supplied legacy
`parent_task_id` must agree. The independent `delegation_limits` startup scope
defaults off and rejects new explicit delegation while off. Ordinary creation and
legacy parent provenance add no delegation queries. Explicit delegation sets the
normal Task parent too, so existing human parent review still sees open children.
It grants no assignment, automatic review, merge, publication or deletion rights.

The root is depth zero; child depth is at most three. A tree contains at most 30
Tasks including its root and all terminal history. The central enqueue writer
checks only an actual new insertion, after exact source replay and active dedupe.
A replay consumes no slot and remains available with delegation rollout off.
The guard requires a real read-committed transaction, shares a non-waiting root
transaction mutex across different leaves, and retains a direct-parent SHARE
NOWAIT lock through commit. A changing or terminal parent cannot admit new work.
Contention returns 409 and requires the complete original operation to retry;
rejection rolls back Task, lineage, source, room and audit writes together.

`GET /api/v1/tasks/:id/delegation-tree` reads a tenant/project-scoped repeatable-read
snapshot of the complete explicit tree, current statuses, depths, creation scope
and limits. It uses bounded indexed history reads and remains usable with rollout
off. A legacy provenance child is its own explicit root. Inconsistent history
fails closed instead of silently truncating. No recursive process cancellation or legacy-lineage
import is implemented. Existing per-Task stop/physical-closure requirements and
human release owners remain authoritative.

Task detail now has an on-demand **Task delegation** panel. It renders the complete
explicit hierarchy with each Task's current state and depth, the selected Task,
and the historical tree count. Selecting a node opens its ordinary detail and
preserves the panel's expansion while loading. **Delegate task** reuses the full
task brief, criteria, priority and capabilities form, sends explicit version-1
parent identity, and opens the new Backlog Task without assigning or executing it.
Ordinary creation sends no delegation field. Server conflicts retain the brief.

Both ordinary and delegated creation retain the same idempotency key when an
unchanged submitted brief is retried in the same open dialog. Editing submitted
fields (including project or parent identity), or opening a new dialog, starts a
fresh creation identity. This recovers a successful response already cached by
the server without creating another Task, room or delegation slot. A real browser
regression first lets the server commit/cache success, aborts only its delivery,
then checks that retry returns the original Task and one durable record. It does
not establish recovery from the separate business-commit/response-cache crash
window or exactly-once external side effects.

The panel explains disabled rollout, terminal parents, depth-three and thirty-Task
limits. A failed or refreshing tree cannot admit creation from stale UI state;
the server remains authoritative if state changes while the form is open. Project
Task and relevant Run lifecycle events refresh all cached selected-node views of
the tree, with polling recovery. Reads still work with creation rollout off.
Select a Task to use its existing stop confirmation and actual process-closure
rules; stopping one Run does not recursively cancel other Tasks. Parent acceptance
and product release retain their existing reviews.

The scheduler browser suite also opts into `delegation_limits`. Its delegation
scenario exercises the real routes/database/browser: three brief-preserving child
creations, navigation back to root, live child-state refresh, server rejection at
depth four, no leaked extra Task and persisted history after page reload. It
creates no Run and calls no Provider. Component checks cover disabled creation,
full history, fetch/conflict recovery and cached-view invalidation. Executed
results and remaining latest-main acceptance are recorded separately in the PR.

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
