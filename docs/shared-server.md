# Shared preview server and repeatable gates

One server is the authority for Web, iOS and paired Windows workers. This
template targets one trusted team on one Linux host running Node 24+, npm 11+,
systemd and Caddy 2. PGlite permits one server process per data directory;
replicas, shared network storage and rolling concurrent instances are unsupported.
The repository supplies configuration; it does not provision a host, register
accounts, configure DNS, deploy credentials or prove a live deployment.

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

```bash
sudo systemd-analyze verify /etc/systemd/system/artoo-preview.service
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl daemon-reload
sudo systemctl enable --now artoo-preview
sudo systemctl reload caddy
curl --fail https://your-team-host/health/ready
```

Validate the actual hostname/callback before distributing it: real Google login,
unauthenticated API rejection, Windows pairing, iOS pairing, and simultaneous
Web/iOS message receipt over WebSocket. Interrupt and restore connectivity,
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
npm run verify:ios
npm run verify:desktop
```

- `verify:preview`: TypeScript, production preview build, unit/integration tests,
  native API static contracts, browser workflows, local test-provider auth E2E,
  production dependency audit and whitespace. It runs on Windows CI.
- `verify:ios`: production server/Web build, native contracts, XcodeGen,
  simulator build/XCTest, and a Release-app XCUITest against the shared server
  with an independent Chromium client. The UI flow pairs through onboarding,
  exchanges channel/thread messages with the Web composer, reconciles a reply
  written while backgrounded and restores Keychain/history after app relaunch.
  Requires macOS, full Xcode with an installed iOS simulator, and XcodeGen.
  The script selects an available iPhone; `ARTOO_IOS_SIMULATOR_UDID` can select
  another installed iPhone. Simulator tests use ad-hoc signing with local
  Keychain entitlements; no Apple account or developer certificate is required.
- `verify:desktop`: installed NSIS/Electron smoke. Requires a logged-in Windows
  desktop and `ARTOO_DESKTOP_INTERACTIVE=1`. It is an explicit local/operator
  gate; a headless hosted runner is not claimed to verify installation/UI.

The unified script also accepts `--suite=shared|ios|desktop` and `--list`.
It writes the selected suite's pass/fail record to `artifacts/preview-gate`;
native runs retain `.xcresult` bundles and UI evidence under `artifacts/ios`. A passed suite
does not imply that another suite ran. `.github/workflows/preview.yml` runs the
shared and macOS suites on main pushes and pull requests. Installed Windows
smoke is opt-in on a separately configured isolated interactive self-hosted
runner labeled `artoo-desktop`; no such runner is provisioned by these files.

The hosted Windows shared gate and macOS simulator build/XCTest gate passed on
2026-09-29; exact revisions, test totals and CI links are recorded in
[the collaboration milestone record](cross-client-sync.md). The installed
Windows smoke also passed locally. Deployment templates still require an actual
host run. CI uses deterministic local providers; real Codex/Claude credentials,
real Google OAuth, deployed TLS and WebSockets, simulator UI walkthroughs,
physical iOS device behavior, distribution signing, provisioning and TestFlight
remain separate checks.

The native UI fixture runs an isolated persistent server on loopback with
production authentication, no development credentials and no model execution.
Only the fixture Web owner's session is provisioned directly; the native app
claims its credential through the normal one-time pairing screen. Temporary
codes, API peer credentials and test-runner manifests are removed after the
run. No fixture endpoint or authentication shortcut is added to the app/server.
On Windows, `node scripts/ios-ui-e2e.mjs --self-check` checks only this fixture
and the real Web composer using an API peer. It does not execute or certify iOS.
