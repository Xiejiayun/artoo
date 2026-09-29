# Artoo Windows trusted-team preview

The Electron app provides the Web workspace and a managed local `artood`
execution worker. It connects to a separately deployed Artoo server; the
installer does not include a local server or database.

## Connect and execute work

1. Sign in to the Web app and generate a Windows pairing code in Settings.
2. Install the app and enter the server origin, device name, and single-use code.
   Remote origins must use HTTPS; loopback HTTP is supported for local testing.
3. Install and authenticate the Codex or Claude Code CLI on the Windows computer.
4. In desktop Settings, save absolute allowed workspace folders and the installed
   runtimes. Start the worker, then register its runtime and workspace on the
   Computers page.
5. Create a task, mark it ready, optionally request execution approval, and assign
   it. Download the resulting artifacts and accept or request changes after review.

Paired credentials are encrypted with Electron `safeStorage`. Control requests
use the device credential instead of browser cookies. A separate node credential
authenticates the worker. Revocation removes server access; sign-out clears local
credentials and stops the managed worker. Changing servers clears the paired
identity and resets the local trusted-execution opt-in.

### Use Aerial with GitHub Copilot

In Aerial, sign in to GitHub Copilot and start its local Responses API. In Artoo
Settings, stop the worker and choose **Aerial or another Responses API** under
**Model connection**. Enter the API address (normally
`http://127.0.0.1:18181/v1`), the exact model name offered by Aerial, and its local
API key. **Choose Codex program** locates the installed `codex.exe` or npm
`codex.cmd` when it is absent from the desktop's PATH. No program location or
model is hardcoded into Artoo. Save, then start the worker.

The model connection applies to both tasks and read-only discussions. It is
local to this computer and does not modify global Codex configuration. The
default **Use existing Codex settings** mode remains available. **No API key**
supplies no provider credential and removes any saved key; use it only for an
API that explicitly allows unauthenticated requests. Remote APIs require HTTPS;
HTTP is accepted only for loopback addresses.

Keys are encrypted with OS `safeStorage`, never returned by the settings status
API, and supplied through a private worker environment variable rather than
command arguments. Saving a different API address requires a new key. Switching
to existing CLI settings, choosing no API key, signing out, or changing the
Artoo server clears the saved provider key. Restarting the app with the same
connection preserves it. Runtime output redacts the active key before sending
logs, answers or failure details to the server.

Saving validates the local configuration and an explicitly chosen program's
existence. It does not contact Aerial or verify inference. A running worker and
an available CLI likewise do not prove that a model API is authenticated or
supports the selected model; a completed assistant reply is separate evidence.

The worker is bundled at `resources/app.asar.unpacked/daemon/artood.mjs` and runs
through the packaged Electron executable in Node mode. Settings exposes its
status, start, stop, and restart controls. A second app launch uses the existing
instance, preventing another worker for the same app data directory.

Codex uses its workspace-write sandbox. Claude denies unattended permission
requests by default; the local trusted-execution setting permits broader
execution. Allowed workspace roots govern admission, and runtime permissions
govern the commands inside a run. Task execution approval gates one assignment;
it does not intercept arbitrary commands in a running CLI. See the
[operations guide](../../docs/preview-operations.md) for approval, cancellation,
goal, backup, and deployment behavior.

## Build and verify

Run from the repository root on Windows:

```powershell
npm ci
$env:VITE_AUTH_ENABLED = 'true'
npm run pack:win --workspace @artoo/desktop
npm run dist:win --workspace @artoo/desktop
npm run smoke:win --workspace @artoo/desktop
```

`pack:win` writes `release/win-unpacked/Artoo.exe`. `dist:win` produces the NSIS
installer at `release/Artoo Setup <version>.exe`. Both build the renderer and
bundle the daemon. To repeat the smoke against an existing installer:

```powershell
$env:ARTOO_SMOKE_SKIP_BUILD = '1'
npm run smoke:win --workspace @artoo/desktop
```

The smoke uses an isolated installation, desktop data directory, server data
directory, and workspace. It starts the production server with authentication
enforced and development routes disabled. A test owner cookie provisions access
to the Web pairing UI; native device claims and all task mutations use real UI
and production endpoints.

The execution fixture is a temporary npm-shaped `codex.cmd` shim selected by
absolute path through desktop Settings, with the app's PATH empty. The same UI
saves a synthetic Responses connection and OS-encrypted test key. The shim
asserts that the selected key reaches the process, writes a deterministic patch,
and emits the test key in stderr to verify that runtime output redacts it. This proves
packaged execution and transport without claiming real model quality or a live
Google OIDC login.

The smoke checks:

- Anonymous API rejection, Web pairing-code generation, native pairing and
  enrollment, authenticated REST and realtime, and encrypted stored credentials.
- Worker settings, start/stop/restart, and rejection of duplicate app launches.
- Local model settings, explicit program selection without PATH, encrypted test
  key persistence across restart, output redaction, and key removal on sign-out.
- Agent registration, task creation, execution approval, assignment, the actual
  bundled worker, and a layout check using real generated identifiers.
- Authenticated artifact download with byte-for-byte verification and task review.
- App/server restart preserving identity, settings, task state, and artifact bytes.
- Sign-out revocation and silent NSIS uninstall.

Evidence is written to `release/smoke-artifacts`: a JSON result with installer
SHA-256 and timestamp, a desktop screenshot, and downloaded patches before and
after restart. Electron's actual `will-download` event supplies the automated
save destination; the renderer initiates the normal authenticated download.
The final result also records whether the app, browser and server closed,
uninstall completed, and the temporary data directory was removed. Cleanup
failure makes the gate fail.

The optional installed-worker verification runs two real chat turns and a
three-contribution planning discussion through Aerial / GitHub Copilot after
the deterministic fixture succeeds. See the
[Windows Copilot verification guide](../../docs/windows-copilot-verification.md)
for the explicit opt-in settings, credential-file handling, evidence and limits.

## Release boundary

This is an internal preview for one trusted team per server. The installer is
unsigned unless the operator configures signing credentials. Public release
still requires a signing/distribution policy and an update channel. Build logs
mentioning a signing tool do not establish that a trusted signing identity was
used.

The native shell uses context isolation, disabled renderer Node integration,
sandboxing, restricted IPC senders, and server-enforced explicit desktop CORS.
`ARTOO_DESKTOP_CORS=1` allows the packaged `file://` origin, represented as `null`;
wildcard desktop origins are rejected.

macOS packaging, signing and notarization require a Mac and have not been proved
by these Windows tests. iOS is a separate native client under `apps/ios`.

## Toolchain notes

The desktop package has no production dependencies; `npmRebuild: false` prevents
the builder from pruning workspace tools. The smoke invokes npm through Node
and `npm-cli.js`, avoiding Windows `spawnSync("npm.cmd")` failures. Keep the
authentication-enabled renderer when sharing a server deployment directory with
desktop builds.
