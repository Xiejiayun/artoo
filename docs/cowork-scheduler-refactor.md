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
