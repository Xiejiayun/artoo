# Scheduler node execution

Scheduler execution is a trusted local opt-in. Set `ARTOO_SCHEDULER_ENABLED=1`
only on a node with its saved managed journal binding, `ARTOO_MANAGED_EXECUTION=1`,
an explicitly upgraded v6 journal, genuine owned-process adapters, an allowed
workspace root, and a configured source repository. Ordinary configurations
retain their manual behavior. A hello or task payload cannot enable this mode.

The authenticated generation negotiates independent `scheduler_start`,
`scheduler_lease`, `scheduler_run`, and `scheduler_claim` extensions. Private poll
results identify existing user-authorized requests. They do not grant physical
start permission. Each request still obtains its original one-use preparation,
short start grant, journal permit, long execution lease and separate event
authority. Renewal never extends the original physical-start window.

Polls have a ten-second original response window. Idle replies wait between two
and thirty seconds. Each poll has only one outstanding exchange. Physical startup
returns before execution completes, allowing multiple runs to execute together.
Shared Git metadata mutation is serialized by actual common-directory identity;
every run retains its own immutable allocation, directory, branch and producer.
Each new materialization observes the current configured source HEAD under that
lane. It does not silently fetch or reset the operator's source checkout.

Disconnect stops the old generation's poller, drops its secrets and cancels its
existing physical owner. Stop and closure use the captured genuine process
owner. A socket disconnect, expired lease or successful CLI exit is not proof
that the process tree is closed. Workspaces and uncertain ownership are retained.
An original scheduler request cannot be downgraded into ordinary `run.start` or
an ordinary replay after daemon restart. A new generation can claim other eligible
work, but cannot recreate the old request's start permit or event credentials.
Missing scoped recovery proof is reported explicitly instead of adopting a writer
or sending scheduler receipts through the ordinary event lane.

The current protected journal remains qualified only for macOS. Existing Windows
manual/native execution is separate. Enabling this configuration does not qualify
Windows or Linux scheduler journal execution; the platform storage and physical
process boundaries continue to reject unsupported combinations.

Implementation and controlled regression cases are provided here. No live
Provider, cross-computer, restart or process-tree qualification is implied by
their existence; those runs belong to final integrated verification.
