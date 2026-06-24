# V3 #113 — Agent Presence Model (Design)

Status: accepted direction (SkywalkerCodex, #artoo:8470d70f). Scope: **#113 only** —
presence read-model + scheduler eligibility. No Goal/Plan/Checkpoint/Decision/
Handoff tables; no #114/#115 schema. Grounded in `docs/v3-product-plan.md`
(Agent Presence + #113) and the accepted #111 daemon/multi-agent smoke evidence.

## 1. Principle

Presence is a **server-synthesized read model**, not a stored decorative dot.
v1 work-state is **derived-on-read** from `runs + tasks + agent_runtimes +
computers + devices/live-connection` — we do NOT trust `agent_instances.status`
(not reliably maintained by run/task lifecycle) and add NO presence cache table.

The **same domain eligibility helper** powers both presence synthesis and
scheduler candidate filtering, so there is one source of truth for
stale/revoked/busy/missing — never two copies.

## 2. State vocabulary (per `v3-product-plan.md`)

- `connection`: `online | stale | offline | revoked`
- `work`: `idle | queued | running | awaiting_input | awaiting_approval | blocked | paused`
- `runtime`: `available | busy | disabled | stale | missing`
- `health_reason` (nullable): `heartbeat_timeout | device_revoked | runtime_missing | approval_required | lease_conflict | daemon_restarting`

`paused` work is derived from existing run/task state only; goal-level pause is
#115, not implemented here.

## 3. Read-model contract (UI-ready)

```
AgentInstancePresence {
  agent_instance_id, agent_id, computer_id,
  connection, work, runtime, health_reason,
  concurrency_limit, active_runs,            // capacity (#113)
  last_seen_at, age_ms,
  source: { connection, work, runtime },     // which input produced each dim
  as_of                                      // server clock at synthesis
}
ComputerPresence {
  computer_id, connection, health_reason,
  runtimes: [{ runtime, status, last_seen_at, age_ms }],
  active_runs, queue_depth,                  // queue_depth >= queued|starting runs on this computer
  last_heartbeat_at, age_ms, as_of
}
DevicePresence {  // backward compatible — existing fields preserved
  device_id, state, last_seen_at,            // unchanged
  health_reason?, age_ms?, source?, as_of?   // additive only
}
```

`connection=revoked` is used only on the NEW Agent/Computer model. DevicePresence
stays `state=offline + health_reason=device_revoked` for compatibility.

## 4. Synthesis rules (source of truth)

Inputs: authenticated control WS + node WS live-connection (from the app layer /
nodeRegistry — passed in, never stored in domain), `agent_runtimes` heartbeat,
`runs`/`tasks` state, `computers.last_heartbeat_at`, `devices.trust`/last_seen,
freshness windows.

- **connection**: live socket + device trust + last_seen window. `revoked` when
  device trust ≠ active (or node credential/`node_id` mismatch — exposed only as
  a generic `runtime_missing`/`heartbeat_timeout`-class reason, never raw secret).
  Else `online | stale | offline` from the freshness window.
- **work** (derived-on-read from the instance's non-terminal `runs` + their `tasks`):
  run `queued/starting`→`queued`; run `running`→`running`; task `awaiting_approval`
  →`awaiting_approval`; run `awaiting_input`→`awaiting_input`; task `blocked`
  →`blocked`; run/task `paused`→`paused`; none→`idle`.
- **runtime**: from `agent_runtimes` row — fresh + `available` → `available`;
  has active run → `busy`; `disabled`; last_seen beyond window → `stale`;
  no row → `missing`.
- **capacity**: `concurrency_limit` = `agent_instances.config.concurrency_limit`
  (default 1); `active_runs` = the instance's non-terminal runs;
  `work=busy` and scheduler-exclusion when `active_runs >= concurrency_limit`.
- **health_reason** priority (dominant non-healthy cause):
  `device_revoked > heartbeat_timeout|runtime_missing > daemon_restarting >
  approval_required > lease_conflict`.
- **source + age**: each dimension records which input produced it + the age of
  the freshest relevant timestamp (UI must show source + age, not only state).

## 5. Scheduler eligibility (single source of truth)

`scheduler.ts` does NOT call HTTP/API presence. It reuses the domain
`isSchedulable(candidate, now, windows)` helper. A runtime is schedulable iff:
fresh (last_seen within window) + non-disabled + connection online + device not
revoked + `active_runs < concurrency_limit`. The existing "missing runtime row"
compatibility behavior is preserved unless explicitly changed.

## 6. Read API (thin routes)

- `GET /api/v1/agent-instances/presence` (list, org/project scoped)
- `GET /api/v1/agent-instances/:id/presence`
- `GET /api/v1/computers/presence` (list)
- `GET /api/v1/computers/:id/presence`
- `GET /api/v1/devices/:id/presence` — **unchanged shape + additive fields only**
- Realtime: `agent.presence_changed` / `computer.presence_changed` over WS.

## 7. Event-log + redaction

`agent.presence_changed` / `computer.presence_changed` payload allows ONLY
`{ dimension, from, to, reason, agent_instance_id|computer_id, source, as_of }`
metadata — never token/lookup/raw node-id-mismatch secret. Emit on **explicit
edges only**: socket connect/disconnect/revoke, runtime heartbeat/state change,
run/task status → work change. Plain reads do NOT write events for age-threshold
expiry; the read API still returns correct stale/offline. A pure-time sweeper for
stale/offline transition events is deferred to #115 / a future presence sweeper.

## 8. Implementation locations

- NEW `packages/domain/src/presence.ts` (export from `index.ts`): pure types,
  enums, age/window helpers, `healthReasonPriority`, work/capacity synthesis
  helpers, `isSchedulable` eligibility helper. No DB, no nodeRegistry.
- `apps/server/src/services/presence-service.ts`: add `synthesizeAgentInstancePresence`
  / `synthesizeComputerPresence` (+ list variants), receiving live-connection info
  from the app layer.
- `apps/server/src/app.ts`: thin routes only.
- `apps/server/src/services/scheduler.ts`: reuse the domain eligibility helper.

## 9. Test gate

- **domain**: 3-dim synthesis; `health_reason` priority; `age_ms`/window edges;
  capacity `busy` at `active_runs>=limit`; runtime stale/missing/disabled;
  `isSchedulable` eligibility.
- **server service/routes**: agent-instance/computer list + detail shape; device
  presence compat fields; `active_runs`/`queue_depth`; no raw secret keys in events.
- **scheduler regression**: unavailable/stale/revoked/busy-at-capacity excluded;
  fresh eligible runtime still schedulable; missing-runtime-row behavior unchanged
  unless separately specified.
- **e2e/source reuse**: may reuse #111 revoke/mismatch/reconnect ideas, but #113
  normal tests must NOT depend on the gated smoke.

## 10. Slices

1. `packages/domain/src/presence.ts` types/enums/helpers + domain unit tests.
2. `presence-service` synthesize agent-instance/computer (+ lists) + service tests.
3. read API routes + api schemas + route tests.
4. presence-changed events (explicit edges, secret-safe) + redaction tests.
5. `scheduler.ts` refactor to the shared eligibility helper + scheduler regression.
