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

The execution fixture is a temporary npm-shaped `codex.cmd` shim resolved by the
ordinary Codex adapter. It writes a deterministic patch and exits. This proves
packaged execution and transport without claiming real model quality or a live
Google OIDC login.

The smoke checks:

- Anonymous API rejection, Web pairing-code generation, native pairing and
  enrollment, authenticated REST and realtime, and encrypted stored credentials.
- Worker settings, start/stop/restart, and rejection of duplicate app launches.
- Agent registration, task creation, execution approval, assignment, the actual
  bundled worker, and a layout check using real generated identifiers.
- Authenticated artifact download with byte-for-byte verification and task review.
- App/server restart preserving identity, settings, task state, and artifact bytes.
- Sign-out revocation and silent NSIS uninstall.

Evidence is written to `release/smoke-artifacts`: a JSON result with installer
SHA-256 and timestamp, a desktop screenshot, and downloaded patches before and
after restart. Electron's actual `will-download` event supplies the automated
save destination; the renderer initiates the normal authenticated download.

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
