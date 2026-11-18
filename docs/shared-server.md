# Shared preview server and repeatable gates

One server is the authority for Web and paired Windows workers. This
template targets one trusted team on one Linux host running Node 24+, npm 11+,
systemd and Caddy 2. PGlite permits one server process per data directory;
replicas, shared network storage and rolling concurrent instances are unsupported.
The repository supplies configuration; it does not provision a host, register
accounts, configure DNS, deploy credentials or prove a live deployment.

For Azure control-plane hosting with multiple Windows execution computers, see
[the Azure deployment guide](azure-deployment.md) and its Bicep resource template.
It preserves this single-process storage and same-origin proxy model.

## Prepare the host

Use an unprivileged `artoo` system user and group. Put the checked-out release
at `/opt/artoo/current`, build with `npm ci` and `npm run build:preview`, and keep
the release readable by `artoo` but writable only by the deployment operator.
Verify `/usr/bin/node` is Node 24+ or update the service's `ExecStart` path.

Copy `.env.example` to `/etc/artoo/artoo.env` outside the checkout. Restrict the
file to root and the artoo group (`0640`). Fill in the team's existing Google Web
OAuth client ID/secret, exact `https://<host>/auth/google/callback`, admitted user
emails, owner emails and one stable generated pairing pepper. Set these paths:

```text
ARTOO_DATA_DIR=/var/lib/artoo
ARTOO_HOST=127.0.0.1
ARTOO_PORT=4000
ARTOO_TRUSTED_PROXIES=127.0.0.1
ARTOO_DESKTOP_CORS=1
ARTOO_DESKTOP_CORS_ORIGINS=null
```

Do not leave a separate `.env` in the release directory. Keep DB/artifacts under
the service data directory; alternate locations need explicit systemd write
permission. `StateDirectory` creates `/var/lib/artoo` with service ownership.
Keep OAuth and pairing secrets in restricted external storage for disaster
recovery. Database backups contain team data and should be encrypted at rest.

Copy `deploy/artoo-preview.service` to `/etc/systemd/system/`. Copy the Caddyfile
into the host's Caddy configuration and replace `artoo.example.com` with the
team's actual DNS name. Allow public ports 80/443 for TLS; keep 4000 bound to
loopback and closed externally. Caddy automatically proxies both client
`/api/v1/ws` and execution-node WebSocket upgrades, authorization and cookies.

`ARTOO_TRUSTED_PROXIES` names the exact proxy IPs allowed to supply forwarded
client addresses. The same-host Caddy template connects from `127.0.0.1`; this
setting keeps device-pairing limits separate for different client IPs. Existing
deployments must add it to their server environment before restarting. With no
value, forwarded headers are ignored. Only comma-separated literal IPv4/IPv6
addresses are accepted; hostnames, CIDR ranges, hop counts and blanket trust are
rejected before the database opens. For another proxy, name its actual peer IP
and keep the server port private. The proxy must replace or safely append
forwarded headers using the actual connection source, as Caddy does by default.
Never configure an untrusted client's address as a proxy.

```bash
sudo systemd-analyze verify /etc/systemd/system/artoo-preview.service
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl daemon-reload
sudo systemctl enable --now artoo-preview
sudo systemctl reload caddy
curl --fail https://your-team-host/health/ready
```

Validate the actual hostname/callback before distributing it: real Google login,
unauthenticated API rejection, Windows pairing and message receipt in two signed-in
Web sessions over WebSocket. Interrupt and restore connectivity,
restart the server, and verify message catch-up and daemon reconciliation.
An HTTP health response alone does not verify WebSockets or Google login.

## Backup, upgrade and recovery

Use the existing offline storage CLI; it refuses a live database owner and
checks backup contents on restore. Do not copy a live PGlite directory. Create
a restricted backup directory writable by `artoo`, then during maintenance:

```bash
sudo systemctl stop artoo-preview
sudo -u artoo /usr/bin/node --env-file=/etc/artoo/artoo.env /opt/artoo/current/scripts/storage.mjs backup /var/backups/artoo/2026-09-29
sudo systemctl start artoo-preview
```

Every backup destination must be new. Verify a restore periodically into a new
directory with `storage.mjs restore <backup> <new-data-dir>`; this does not switch
the live server. For disaster recovery, stop the service, set `ARTOO_DATA_DIR`
to the verified restored directory, update `ReadWritePaths` if outside
`/var/lib/artoo`, retain its ownership and original OAuth/pairing configuration,
then validate login, history and artifact downloads before reopening access.

For upgrades: stop, back up, switch to the built release, then start. Migrations
are journaled and append-only. Roll back with the matching old code and a new
directory restored from its backup; never point old code at an upgraded DB.
After a crash, the exclusive lock may block automatic restart. Inspect the
service log, stop restart attempts and run the existing `storage.mjs unlock`
with the same environment; it only removes a lock whose owner is confirmed dead.
See [preview operations](preview-operations.md) for legacy adoption and details.

## Automated gates and their evidence

Install with `npm ci`; install the Playwright Chromium browser using
`npx playwright install chromium` from `apps/web`. Run from repository root:

```text
npm run verify:preview
npm run verify:desktop
```

- `verify:preview`: TypeScript, production preview build, unit/integration tests,
  browser workflows, local test-provider auth E2E,
  production dependency audit and whitespace. It runs on Windows CI.
- `verify:desktop`: installed NSIS/Electron smoke. Requires a logged-in Windows
  desktop and `ARTOO_DESKTOP_INTERACTIVE=1`. It is an explicit local/operator
  gate; a headless hosted runner is not claimed to verify installation/UI.

Windows CI runs `windows-browser-exit.test.ts`,
`windows-browser-native-retry.test.ts` and
`windows-browser-observer-request.test.ts` as complete files on a dedicated
Windows runner, with one worker and no file parallelism. Their original
subprocess deadlines, assertions and platform guards remain unchanged.
The rest of the Vitest inventory runs in two shards, each with two workers.
All three jobs retain the 75-minute job limit. This separates execution
conditions; it does not establish the cause of earlier process-observation failures.

The local shared suite includes Vitest; `shared-checks` runs the other checks,
including host/runtime packaging, browser workflows and the production audit.
Packaging fixtures do not qualify native runtime execution. The aggregate
`shared` check requires all three Vitest jobs and `shared-checks` to succeed,
then compares their actual JSON reporter file sets with complete
`list --filesOnly` discovery. Missing files, duplicates, overlapping lanes and
mismatched commits fail the aggregate. Discovery alone is not evidence of
shard execution; existing skipped or opt-in cases remain skipped. Local
`npm run verify:preview` and `npm test` still run the complete inventory once.

Use `node scripts/preview-gate.mjs --suite=shared-checks --list` for the current inventory.
Available suites are `shared`, `shared-checks` and `desktop`; results are written to
`artifacts/preview-gate`. Main pushes and pull requests run the shared Web/Windows
checks. Installed Windows smoke requires a separate manual dispatch with
`windows_desktop: true` and a logged-in, isolated runner labeled `artoo-desktop`.
A passing shared check does not attest to an installed-desktop run.

CI uses deterministic subprocess fixtures. Separate local real Codex conversation
and discussion gates passed through Aerial's GitHub Copilot route, as described
below. Those initial checks use fixture authentication and in-process node
transport. At `bd0ee48`, additional installed Windows checks verify UI-saved
provider settings, encrypted-key persistence across restart, and real model
sessions over authenticated node WebSocket. Two chat turns passed in the first
attempt, which then failed during discussion for an undetermined reason. A
discussion-only retry with the same installer passed all three contributions,
plan-card review and human acceptance. This is evidence from two attempts, not
one passing five-turn run. The owner cookie is still test-provisioned and the
server is on loopback. See [Windows verification](windows-copilot-verification.md)
for the procedure and [the acceptance record](cross-client-sync.md) for exact
source, hashes and hosted results.
Live Claude execution, real Google OAuth, public TLS/WebSockets and Windows
distribution signing remain separate checks. Deployment templates still require
an actual host run.

### Optional live conversation gate

`apps/server/src/claude-conversation-smoke.test.ts` is skipped unless
`ARTOO_CLAUDE_CHAT_SMOKE=1`. It uses the real local Claude CLI configuration and
model allowance in a temporary workspace, with customizations disabled and
the normal unattended permission policy. It does not enable permission bypass.
On PowerShell, after the normal build/typecheck:

```powershell
$env:ARTOO_CLAUDE_CHAT_SMOKE = '1'
npx vitest run apps/server/src/claude-conversation-smoke.test.ts --maxWorkers=1
Remove-Item Env:ARTOO_CLAUDE_CHAT_SMOKE
```

The gate checks two actual model answers, prior-answer context in the follow-up,
exactly-once message persistence, provider token measurements and no model-written
workspace files. It writes `artifacts/live/claude-conversation.json`; a new live
attempt replaces any old success before invoking the CLI. The server/node
transport and identity are test fixtures, so success would not prove public
deployment, Google login, the configured model's vendor, multi-agent discussion
or task-writing permissions. A working provider/model configuration is required;
the local 2026-09-29 attempt failed at the proxy, as recorded in
[the collaboration milestone record](cross-client-sync.md).

`apps/server/src/codex-conversation-smoke.test.ts` provides the corresponding
opt-in gate for the Codex CLI with `ARTOO_CODEX_CHAT_SMOKE=1`. Its command uses
an ephemeral session and a read-only filesystem sandbox. The filesystem sandbox
does not disable inherited MCP servers or plugins; the gate is a conversation
verification, not a capability-isolation certification.

By default the gate uses the operator's existing Codex configuration. For a
Responses-compatible proxy, these optional environment variables apply only
to that invocation:

- `ARTOO_CODEX_CHAT_BINARY`: an explicit CLI executable path if needed.
- `ARTOO_CODEX_CHAT_MODEL`: the proxy's model identifier.
- `ARTOO_CODEX_CHAT_PROVIDER_URL`: the API base URL, including `/v1`.
- `ARTOO_CODEX_CHAT_PROVIDER_KEY`: the local proxy credential. Load it into the
  test process from the operator's existing secret helper; do not place it in
  source, command arguments or committed configuration.

Run `npx vitest run apps/server/src/codex-conversation-smoke.test.ts --maxWorkers=1`
in that process after enabling the gate. Its report is
`artifacts/live/codex-conversation.json`. The gate passes history through actual
Artoo context packs and checks two provider answers and recorded usage, while
the server/node transport and identity remain in-process fixtures. It does not
change persistent CLI settings or configure the installed Windows worker.

For a separate real planning discussion, enable
`ARTOO_CODEX_DISCUSSION_SMOKE=1` and run
`npx vitest run apps/server/src/codex-discussion-smoke.test.ts --maxWorkers=1`.
It accepts the same `ARTOO_CODEX_CHAT_*` provider settings and spends three
provider turns: two distinct agent instances contribute, then the first
synthesizes their discussion into a plan. The gate checks actual prior answers
in each context, zero child tasks before human acceptance, and the accepted
tasks' criteria/dependency. It writes `artifacts/live/codex-discussion.json`.
Authentication and node transport remain fixtures; task implementation and
physical-device interaction are outside this gate.

Both Codex gates passed locally on 2026-09-29 through Aerial 0.3.3's GitHub Copilot
route with requested model `gpt-5.4-mini`: two actual conversation answers and
three discussion turns across two distinct agent instances. The discussion used
three independent provider sessions, verified actual prior-answer context, and
created the expected tasks, criteria and blocking dependency after acceptance.
Both reports record successful cleanup and provider token usage; costs remain
unknown. These results establish model conversation and planning through Artoo's
dispatcher/process adapter, with the fixture and deployment limits above.

For that local Aerial route, the base URL is `http://127.0.0.1:18181/v1`. The
observed catalog exposes Responses-compatible models but no `/v1/messages`
model route. Claude CLI uses the latter protocol, and Aerial's messages handler does not translate
it to Responses; changing only the Claude model name cannot fix that mismatch.
The Codex custom-provider fields follow the
[official configuration reference](https://developers.openai.com/codex/config-advanced/).
Provider availability may change; exact evidence and its limits belong in
[the collaboration milestone record](cross-client-sync.md).
