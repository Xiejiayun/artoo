# Unused scheduler permit closure

`scheduler.permit_unused` is a node-owned event with the strict domain payload `SchedulerPermitUnusedV1`: version `1`, scope `scheduler-unused-permit.v1`, the original `grant_id`, `journal_namespace` and `node_attempt_id`, and `process_never_started: true`. It is deliberately absent from the adapter event schema.

Only the protected journal owner may produce this evidence after irreversibly consuming its genuine fresh permit before invoking its producer. The node must also know that any physical preparation helpers have closed. A copied payload, CLI return, timeout or unknown helper state cannot establish that fact. The node implementation and its qualification remain separate from the server's receipt acceptance.

The server accepts the event only through the original scoped scheduler lifecycle lane. It authenticates the exact consumed request, initiating user, Run, machine, device, session, grant, journal attempt, lease and latest epoch. The Run must still be queued with null start/end times, its Task must retain the original assigned state, and no earlier Run receipt may exist. An ordinary frame or domain-only ingest cannot settle it.

The accepted evidence, qualified receipt, logical lease fence, Run/Task cancellation and file-lease release commit together. The original `execute_once` request remains consumed. This does not grant retries, failover or another physical start. The audit says `process_never_started`; it does not claim `process_exit_confirmed`.

The exact original session may relinquish this unused permit after logical lease expiry/revocation or AI-sharing withdrawal. That exception accepts only this closure event, and it never restores normal event writes, renewal or start authority. A replaced session, newer epoch, prior process activity, changed journal identity or missing original credential remains rejected. An exact committed receipt can be replayed without repeating the transition.

This solves the qualified unused-permit case. Stop before any grant, an inaccessible old-session journal, unknown physical state and closure after an actual process start require their own owner/reconciliation; they must retain uncertainty until that evidence exists. Server regression cases are written for the scoped boundary, atomic rollback, expiry/revocation, sharing withdrawal, prior activity, body replay and identity tampering. They have not been run during implementation; validation is deferred to the final integrated pass.
