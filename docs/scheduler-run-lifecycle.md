# Scheduler Run lifecycle v1

Paired managed nodes may negotiate `scheduler_run: {version: 1}` together with
`scheduler_start` and `scheduler_lease`. The operator's existing
`attempt_credentials` rollout flag is required. Manual Run transports retain
their existing path.

The private acquisition exchange accepts the exact persisted start grant and
issues one memory-only `scheduler.attempt-events.v1` secret. Its stored hash is
bound to the immutable execution lease, including original user, project, task,
Run, Agent instance, machine, device, session, epoch and journal namespace.
Acquisition replay cannot recover a lost secret. The renewal-only credential
does not authorize lifecycle events or Stop.

`scheduler.run.event.v1` wraps the original complete `run.event`. The existing
Run receipt owner qualifies the original body and applies transitions within
the same transaction as scheduler authorization. The private envelope and secret
are never journaled or emitted as domain events. Run events retain ordinary
committed `run.event.ack` semantics. A revoked terminal credential can only
replay an exact already committed body from its original current paired session;
it cannot append another event or revive an old epoch.

`POST /api/v1/runs/:id/cancel` records a durable scheduler Stop intent and returns
`{run, stop_requested: true}`. The returned Run remains active until its sole
node process owner confirms physical closure through the scoped lifecycle lane.
Repeated Stop requests do not create more intents. Private status polling reads
the intent; neither a timer nor the HTTP response releases resources. The
`scheduler_run_stop_intents` table is a safe read-model source; lifecycle hashes
and credential tables must stay outside public projections.

Disconnect timers preserve Runs with a scoped lifecycle owner. Expired/fenced
leases reject new ordinary lifecycle writes and retain uncertain resources;
recovery and post-expiry closure reconciliation require the separate recovery
work. This change does not install a retry, failover or deployment executor.

Regression cases were added for scoped authority, Stop intent durability, real
Run transitions, qualified terminal replay, secret exclusion, final-session
fencing and expiry rollback. Per the implementation request, checks are deferred
to the final integrated validation; this document is not a passing test report.
