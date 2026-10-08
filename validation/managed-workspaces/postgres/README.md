# Owned PostgreSQL regression validation

Prepared source only. These relocated suites, the new cluster launcher and its
exceptional cleanup have not run. Earlier artifact results do not qualify this
repository graph. Ordinary `npm test` does not collect `validation/`.

## Explicit prerequisites and invocation

Use macOS, Python 3.10 or newer, Node 24.19.0 on PATH, the normal project
dependencies and the fixture-local locked `pg` dependencies. The copied local
package/lock files retain `pg` 8.16.3 and `@types/pg` 8.15.5. Root may prepare
these separately with `npm ci --prefix validation/managed-workspaces/postgres
--ignore-scripts`; the launcher never installs dependencies.

Supply an **absolute** `--pg-bin` directory containing `postgres`, `initdb`,
`pg_ctl` and `createdb` from PostgreSQL **17.11**. The launcher does not search
PATH, Homebrew installations or arbitrary database URLs for PostgreSQL. It
resolves the one supplied directory, requires all four tools in that directory,
pins their bytes and checks every version when actually executed. The original
source's 17.11 assertions remain unchanged; “receipt 15” means fifteen cases.

From the repository root, execute each phase separately after root releases the
runtime gate. Replace the example path with the actual selected installation:

```sh
nice -n 10 python3 validation/managed-workspaces/postgres/run.py receipt --pg-bin /absolute/postgresql-17.11/bin --execute
nice -n 10 python3 validation/managed-workspaces/postgres/run.py admin --pg-bin /absolute/postgresql-17.11/bin --execute
nice -n 10 python3 validation/managed-workspaces/postgres/run.py assignment --pg-bin /absolute/postgresql-17.11/bin --execute
```

There is no all-phases option or retry. Each invocation acquires the same
checkout build lock as the managed Node wrapper, captures source/runtime pins,
forces the complete `tsc -b --force` build, runs this directory's noEmit check,
then starts one fresh private cluster and selects one dedicated Vitest phase.
All product imports and transitive aliases use the repository's compiled `dist`
graph. No old implementation or artifact source tree is imported.

## Ownership and finite budgets

Child environments are rebuilt from a small explicit list; no provider key,
database URL, inherited `PG*` setting or old fixture selector is passed through.
Node connection options come only from the matching fresh cluster receipt and
per-run token. The receipt verifies run scope, uid, private directory and marker
inodes, data/socket paths, port and postmaster pid/start time. The cluster uses
only its private Unix socket, `listen_addresses=''`, local trust inside mode
0700 directories, and rejected host authentication. Port 55479 names the owned
Unix socket; no shared TCP listener is started or contacted.

Build, noEmit and test commands each have 600 seconds plus the shared helper's
10 second cleanup budget. Original PostgreSQL command limits are retained:
initdb 90 seconds, pg_ctl start/stop 40 seconds (internal wait 30), createdb 25
seconds, version probes 10 seconds each and identity ps 5 seconds. A timed-out
command receives TERM then KILL within two 5 second waits, only for its freshly
created process group. Cluster shutdown first checks marker/inodes and actual
postmaster pid/data/binary identity, then targets only that data directory with
pg_ctl. PID file, owned socket and recorded postmaster PID must all be absent.

Cluster files are retained even after successful shutdown, as in the source
harness. Their exact path appears in the cleanup receipt. No recursive deletion,
existing-cluster adoption or external URL fallback exists.

For a retained run, `owned_postgres.py status` or `stop` accepts only its exact
`--receipt`, matching `--phase` and original `--pg-bin`. Stop additionally
requires `--execute` under nice 10. It repeats ownership/binary/PID checks and
never falls back to stopping an unchecked process. For example:

```sh
nice -n 10 python3 validation/managed-workspaces/postgres/owned_postgres.py stop --phase receipt --pg-bin /absolute/postgresql-17.11/bin --receipt /absolute/repo/artifacts/managed-workspaces/postgres/receipt/run-0123456789abcdef0123456789abcdef/cluster.json --execute
```

## Cases and evidence limits

The receipt suite preserves 15 exact cases, including identical/changed-body
races, actual rollback, lost ACK, NULL history and terminal ordering. The admin
suite preserves 10 exact cases; assignment preserves 4. All existing physical
connections, SQL blockers, transaction states, rollback and side-effect
assertions remain. A single shared pg adapter is used because all three source
copies were byte-identical before relocating its storage type import.

Admin/assignment setup explicitly declares a qualified metadata fixture and
requires the same current registry binding. It does not claim real WebSocket
negotiation or physical execution. Those remain separate managed gates.

Receipt PG13 prepares the real old 0021 schema using labelled raw SQL for old
task/run columns, then applies the real current 0022 receipt-identity and 0023
allocation suffix. Current assignTask cannot prepare a schema that lacks its
new allocation column. All original NULL-history rejection, no-backfill,
unchanged event/state and new-sequence qualification assertions remain. This
historical database fixture does not manufacture accepted local journal history
or a physical producer receipt.

Each attempt writes JSON and HTML under
`artifacts/managed-workspaces/postgres/<phase>/run-<id>/`, including failures.
Acceptance requires exact file/full-title multisets, every assertion and case
receipt passed, real independent backend identities, source/runtime stability
and confirmed owned cluster shutdown. Reports contain database evidence and no
GUI photographs; they do not qualify a production PostgreSQL adapter, providers,
packaged daemon or Mac/iOS GUI flow.

Root must run TypeScript parsing/typechecks and all three actual phases, then
exercise new startup/timeout/observer/write-failure/cleanup paths. Python AST
inspection and source-preservation review alone do not qualify those paths.
