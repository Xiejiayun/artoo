# Trusted-team preview operations

For concrete systemd/Caddy templates and shared Windows/macOS gates, see
[Shared preview server](shared-server.md).

This release targets one trusted organization per server. Windows computers
execute under the local OS account; install and sign into Codex CLI or Claude
Code before enabling a worker. Web/iOS control the server remotely. iOS source
requires the separate Mac/Xcode validation described in `apps/ios`.

## Install and start

Use Node 24+ and npm 11+. From the repository root:

```text
npm ci
npm run build:preview
```

Copy `.env.example` to `.env`. Register a Google OAuth Web application and enter
its client ID, secret, and exact HTTPS callback URL. Configure admitted verified
email addresses (or a Workspace domain), and explicit owner emails. Owners must
also satisfy the admission rule. Generate a stable pairing pepper using the
command in the example. Preserve these secrets outside backups with restricted
access; they are not bundled in the app.

```text
npm run start:preview
```

This command always enables production auth and serves the built Web app from
the same origin. Put the loopback listener behind an HTTPS reverse proxy that
forwards WebSocket upgrades. Native clients accept HTTPS, or loopback HTTP for
local testing only. Do not expose a development server to the network. Production
never enables `/dev` routes or development node tokens, even if their environment
flags are present. Public health endpoints are `/health/live` and `/health/ready`.

Set `ARTOO_TRUSTED_PROXIES` to the reverse proxy's exact IP addresses so device
pairing is limited per client rather than per proxy. The bundled same-host Caddy
setup uses `127.0.0.1`; leave the setting empty without a proxy. Arbitrary clients'
forwarded headers are not trusted. See the shared-server guide for the trust
boundary and existing-deployment configuration update.

Use a service manager with graceful stop and restart-on-failure. Keep only one
server process per database. PGlite is embedded; this deployment does not support
multiple replicas sharing its directory. Durable state defaults to `.artoo/db`
and `.artoo/artifacts`. Optional `ARTOO_DB_DIR` and `ARTOO_ARTIFACT_DIR` override
those locations. The first production boot creates the organization, configured
owner and a default project, with no fictional online computers or model workers.

## Pair a Windows execution computer

Sign in to Web, open Settings and generate a Windows pairing code. Build the
installer with `npm run dist:win --workspace @artoo/desktop`; it appears under
`apps/desktop/release`. The internal preview installer is unsigned unless the
operator supplies signing credentials to electron-builder. Distribute it only
through your trusted team channel and publish its SHA-256 alongside it.

Install and enter the server origin, device name and one-time code. Credentials
are encrypted with Electron `safeStorage` in that Windows account's app data.
No local database/server is installed by the desktop package. In Settings,
configure absolute allowed workspace folders and installed runtimes, then start
the worker. In Computers, register the available runtime with its workspace.
Project default workspaces are paths on the executing computer, not the server.

Codex uses its workspace-write sandbox. Claude defaults to unattended permission
denial; the explicit local trusted-execution setting permits broader execution.
The task's "Request execution approval" control adds a server-enforced gate
before its next assignment. Pending, rejected or information-needed gates cannot
start a run; an approved gate permits exactly one assignment. Retries need a new
approval if that task uses execution approval. Re-requesting creates a new,
immutable approval ID, expires superseded pending requests and preserves prior
decisions and run bindings. Decisions from an old page receive a conflict; linked
unresolved blockers follow the new request with an audit trail. The approval inbox
does not intercept arbitrary commands inside an already-running CLI; runtime
permissions remain the gate for those tool calls.
Pause on a goal prevents new scheduling while existing runs finish. Cancel asks
every connected worker to stop and waits for acknowledgements. An offline worker
causes a conflict and retains its leases; reconnect it and retry cancellation.

Goal budgets enforce elapsed time, retry count and concurrent execution limits.
The background monitor pauses new scheduling when a supported budget is reached;
it does not interrupt a CLI already running. Cost metering is unavailable, so a
non-null `max_cost_usd` is rejected. The supported stop-rule combination is
`budget_exceeded` with action `pause`; other combinations are rejected explicitly.

Web commands waiting for reconnection are cancelled when the session expires or
the user signs out. They cannot replay under the next login. A request already
sent may have committed; inspect current task state after reconnecting before
submitting a replacement command.

Plan task controls have an explicit preview boundary. Nonempty `approval_gates`
and `write_scopes` are rejected when proposing or accepting a plan, and before
starting or retrying tasks restored from an older plan. The error names the task
specification and unsupported field. Use the task's execution-approval workflow
for a server-enforced pre-run approval. Local allowed workspace roots determine
where a worker admits work; the CLI's runtime permissions govern its filesystem
access. Run `write_paths` coordinate file leases and are not a filesystem sandbox.
`expected_artifacts` remains an advisory list in the plan and audit history; it
does not automatically enforce artifact presence, type, contents, or acceptance.
Reviewers must verify deliverables against the task's acceptance criteria.

To replace an accepted plan, pause its goal and wait for every prior execution
to stop. A disconnected execution requires the owning worker's confirmation,
even when it declared no file leases. Replacement cancels the old plan's tasks
that have never run and preserves executed tasks, artifacts, rooms and audit
history. Tasks from a superseded plan cannot start another run. The new plan
remains paused until explicitly resumed, and goal completion considers the
current plan's tasks plus any manually linked goal tasks.

Logout stops the local worker and removes this app's credentials, even offline.
When connected it also revokes the control session. An owner can
revoke a device in Web; this revokes its compute and control access. Expired or
revoked native sessions return to pairing. A new worker start requires a valid
session. Worker status and runtime availability are separate: a connected worker
may still report a missing CLI. Restart a worker after installing a CLI or
changing its login environment.

## Backup, restore, upgrade and legacy adoption

Stop the server gracefully before maintenance. Each storage command takes the
same exclusive DB lock as startup; it refuses to operate while a server is live.
The storage command loads `.env` so it uses the same configured directories.

```text
npm run storage -- backup C:/backups/artoo-2026-09-28
npm run storage -- restore C:/backups/artoo-2026-09-28 C:/artoo-restored
```

Backup destinations must be new directories. A backup includes a consistent
database archive, content-addressed artifacts, and a checksum/size manifest.
Restore validates all files before publishing a new data directory and never
overwrites an existing deployment. Point `ARTOO_DATA_DIR` to the restored folder
and keep the original OAuth/pairing configuration. Inspect tasks, downloads and
devices before switching the team endpoint. `.partial-*` directories indicate a
failed operation; they are never treated as completed backups.

For an upgrade, stop, back up, install the release with `npm ci`, build, then
start. Migration statements are journaled with checksums and applied atomically.
Existing migrations must not be edited; append a new migration. A failed upgrade
rolls back its newly applied migrations. A downgrade is refused. Roll back by
restoring the matching backup into a new directory and using its matching code,
rather than pointing old code at a newer database.

An old database without a migration journal is refused at startup. To adopt one
whose schema exactly matches this release:

```text
npm run storage -- adopt-legacy C:/backups/artoo-before-adoption
```

For the reviewed `c97e0c3` legacy database, specify its last migration explicitly:
`npm run storage -- adopt-legacy C:/backups/artoo-before-adoption 0012_team_comms.sql`.
The next server start then applies the appended preview migrations normally.
The boundary is an existing release filename, never arbitrary SQL or a guessed
schema version; the schema comparison must still match exactly.

This creates the complete backup first and compares the schema to a disposable
reference database before writing the journal. A mismatched legacy schema is
left untouched; migrate it with the original release instead of guessing history.

After an ungraceful server crash a `<db-dir>.artoo-lock` directory may remain.
`npm run storage -- unlock` verifies the recorded process is dead on this host
before removing it. It refuses a live or unverifiable owner. Do not share the
data directory between hosts. Keep regular backups: process recovery is not a
substitute for a verified restore after a machine/storage failure.

## Verification

```text
npm run typecheck
npm test
npm run test:e2e --workspace @artoo/web
npm run e2e:auth
npm run smoke:win --workspace @artoo/desktop
npm audit --omit=dev
```

The acceptance record is `docs/trusted-team-preview.md`. Deterministic subprocess
tests prove dispatch, filesystem effects, output, artifacts, cancellation and
restart without model credits; they do not certify model answer quality. Google
test-provider auth is also distinct from signing in with the real deployed OAuth
application. Keep artifact contents private: they may contain project code.
