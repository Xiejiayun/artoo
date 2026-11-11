# Artoo agent daemon

Connect a Windows or Linux computer to an Artoo Web platform. One tarball contains the daemon, its JavaScript dependencies and the self-contained Windows x64 process host. macOS implementation is included, but its release qualification is deferred and is not guaranteed by this release. The GitHub installer provisions a private Node.js 24 runtime when needed; npm installation requires **Node.js 24 or later and npm 11 or later**. No repository checkout, administrator access or .NET installation is needed.

| Operating system | Implemented architecture | Release validation scope |
| --- | --- | --- |
| Windows | x64 | Required |
| Linux | x64, arm64 | Required |
| macOS | Intel x64, Apple Silicon arm64 | Deferred; optional CI evidence only |

Windows arm64 is not supported. npm's separate OS/CPU fields cannot express that exclusion, so the daemon checks the exact platform/architecture pair before starting. The Windows native host is carried in the same tarball on every platform; ordinary macOS/Linux execution does not load it.

## Connect with one command

In Web, open **Machines → Connect Local Node**, select this computer's platform and copy its connection command. Run it in your local terminal as the same user who runs Codex/Claude. The command downloads the fixed GitHub release, checks its package SHA-256 and size, claims the short-lived pairing code, enrolls the computer, saves its credentials and starts Artoo in the background. The matching server/Web release must be deployed first.

The release assets use this PowerShell form on Windows x64:

```powershell
& ([scriptblock]::Create((irm 'https://github.com/Xiejiayun/artoo/releases/download/artood-v{{PACKAGE_VERSION}}/install.ps1'))) -Server 'https://your-artoo-site' -Code 'XXXX-XXXX'
```

Linux x64/arm64 (requires curl, tar and a glibc-based distribution):

```sh
curl -fsSL --proto '=https' --tlsv1.2 'https://github.com/Xiejiayun/artoo/releases/download/artood-v{{PACKAGE_VERSION}}/install.sh' | sh -s -- --server 'https://your-artoo-site' --code 'XXXX-XXXX'
```

Replace the example address and code with the command from your own Web session. `-Workspace` (PowerShell) or `--workspace` (shell) selects an absolute directory; the default is `ArtooWorkspaces` in your user home. Workspaces cannot include Artoo's credentials or installed package. The GitHub installer uses immutable release assets and does not contact the npm registry.

If the exact package version is also published to npm and Node/npm are already installed:

```sh
npx --yes {{PACKAGE_NAME}}@{{PACKAGE_VERSION}} connect --server https://your-artoo-site --code XXXX-XXXX
```

An owner/admin is enrolled automatically. A member's device is saved while it waits for an administrator to enroll it in Web; run `start` afterward. An interrupted enrollment resumes the same saved identity. Repeating `connect` for the same website reuses that identity and leaves the new code unused.

After startup, Web should show this computer online and its allowed workspace roots. Select an existing agent on the computer to create an instance. Install and sign in to a local Codex or Claude CLI before running model tasks. If no CLI is found, the computer connects with no registered model runtimes; stop/start Artoo after installing one to refresh detection. A computer being online does not establish that its model credentials work.

## Start, status and stop

The verified package is retained outside npm's disposable cache. The command prints a durable local launcher:

```powershell
& "$env:USERPROFILE\.artoo\daemon\artood.cmd" status
& "$env:USERPROFILE\.artoo\daemon\artood.cmd" stop
& "$env:USERPROFILE\.artoo\daemon\artood.cmd" start
```

```sh
"$HOME/.artoo/daemon/artood" status
"$HOME/.artoo/daemon/artood" stop
"$HOME/.artoo/daemon/artood" start
```

`start --foreground` uses the saved connection in the current terminal; Ctrl+C stops it. Background `stop` requests the daemon's normal task shutdown and retains its configuration. The authenticated loopback management port is local to this user. An unresponsive or mismatched process is never force-killed. Concurrent managed starts cannot create duplicate daemons.

Windows protects saved credentials with DPAPI CurrentUser and a private directory ACL. POSIX uses mode 0600 files in a mode 0700 directory. Long-lived node credentials are not passed as command arguments or inherited by model subprocesses in this managed flow. Do not copy the state directory between users or computers. `ARTOO_HOME` can select an absolute private state directory for advanced isolated installations.

This is a background process, not an operating-system service: it does not register auto-start at login or boot. Run the printed `start` command after reboot. `npx` and the GitHub installer do not put a global `artood` command on PATH. An optional explicit `npm install --global {{PACKAGE_NAME}}@{{PACKAGE_VERSION}}` provides that command when the version is available on npm.

Always install an explicit version. Prereleases use `next`; do not rely on an unversioned install or assume that `latest` points to the current candidate. Published `0.1.0-rc.1` was Windows x64 only; the universal candidate begins with `0.1.0-rc.2` and is a separate artifact.

Linux pairing and enrollment require the matching server/Web upgrade and its new ordered database migration. Back up the existing server data before upgrading; installing this npm package alone does not add Linux support to an older server. Follow the server runbook for migration and recovery, and keep each computer's own credentials.

## Configure a managed node for Agent Team

After connecting, an operator can save explicit local research and verification settings with the durable launcher:

```powershell
& "$env:USERPROFILE\.artoo\daemon\artood.cmd" configure --file 'C:\ArtooControl\team.json'
```

The JSON must contain only these version 1 fields. All paths must already exist, use physical absolute paths without links, and stay outside every allowed agent workspace root:

```json
{
  "version": 1,
  "research_receipts_directory": "C:\\ArtooControl\\research-receipts",
  "verification_profiles_file": "C:\\ArtooControl\\verification-profiles.json",
  "initialize_repository": true
}
```

The three settings after `version` are optional. A receipts directory enables public HTTPS research fetch; this interface does not configure a search-provider key. Repository initialization applies only to empty autonomous product directories. A verifier selection enables existing node-owned verification; it does not provision its profile, browser or evidence directories. Prepare those using the [Agent Team guide](https://github.com/Xiejiayun/artoo/blob/main/docs/agent-team-development.md). On POSIX, restrict the input JSON to its owner (mode 0600). Keep the selected profiles, verifier programs and evidence directories protected from agent writes.

An optional `codex` object selects a model and a Responses API provider for this daemon without editing the user's global Codex configuration:

```json
{
  "version": 1,
  "codex": {
    "model": "your-provider-model",
    "provider_url": "http://127.0.0.1:18181/v1",
    "provider_key_file": "C:\\ArtooControl\\private\\provider-key"
  }
}
```

Add this object to the same JSON as the research/verifier settings; `configure` replaces the saved selections. The model name and URL above are examples, not defaults. A provider URL requires an explicit model and HTTPS or loopback HTTP without embedded credentials, query or fragment. The optional key file requires an explicit URL and must be an existing physical single-link file outside every agent workspace, contain one nonempty ASCII token (at most 4096 bytes), and have private permissions. POSIX requires current-user ownership and mode 0600; Windows inspects the owner and DACL, trusting the current user, SYSTEM, Administrators and TrustedInstaller, and rejects unsafe parent permissions. Artoo does not change the source key file's ACL. Prepare a private operator-owned copy if the original application's file is shared with other users.

Only the key file's path is saved. `configure` checks its metadata and permissions without reading the key or contacting the provider. The worker reads it on each start and passes the selected credential through `ARTOO_CODEX_PROVIDER_KEY` for the existing runtime's environment-key authentication and output redaction. The key is never a command argument or part of the task context; it is cleared from the daemon environment after startup failure or normal/failed shutdown. Node connection credentials remain outside the model environment. Missing or invalid selected credentials fail startup. With no `codex` object, the local CLI keeps its existing login, model and provider configuration; `codex login status` alone does not establish whether a custom provider is authenticated.

`configure` validates the selections and the runtime's local helper/profile configuration before saving a private `team-config.json` alongside the existing connection. It does not connect, start a model, change the machine identity or restart a running daemon. Stop and start Artoo to apply the saved settings; both background and `--foreground` starts use them. A JSON containing only `{"version":1}` clears these optional selections on the next start. Invalid or missing configured resources fail startup; Artoo does not silently drop verification or research. Inherited `ARTOO_*` settings do not override the saved choices, and this interface accepts no inline credential, environment map, command arguments, `CODEX_HOME`, release profile or source-recovery configuration.

On Windows x64, selecting verification uses the current package's pinned native helper and retains all native installation/profile admission checks. This is ordinary paired execution and does not select `--windows-supervised` or managed journal execution. A static-Web profile must invoke this worker's actual Node executable, the retained package's `runtime\web-acceptance-cli.js`, and its protected browser JSON. The browser JSON must opt into `windows_browser_process: { "version": 1 }`; the profile subject must cover `product` and `.artoo/product`. Pin the actual installed paths when preparing the profile. After a package or Node upgrade, review and refresh those profile paths and their protected bindings before restarting; old profiles are not silently redirected to a different verifier version.

An online configured node still requires an authorized project, two distinct Agent identities, matching project/workspace/profile bindings, AI data-sharing consent and authenticated model runtimes. Successful configuration alone does not establish a completed real-model team task or product publication.

## Existing manual installations

The explicit environment interface below remains supported and runs in the foreground. Before switching an existing daemon to managed connection, stop it through its original launcher and confirm it is offline. The new installer does not inspect arbitrary private configuration files, kill old processes or revoke devices. To preserve an existing computer identity, an operator must migrate its protected device/computer IDs, node token and workspace roots into the new protected connection format. Otherwise revoke the old device in Web before creating a replacement, and reassign agent workspaces to the new computer. Never run two daemons using the same node credential.

1. Sign in to your Artoo Web platform as the person who will operate this computer. Create a pairing code for the computer's platform (`windows`, `macos` or `linux`) in **Settings → Connect a device**, then claim it using the platform's device pairing API. An owner/admin must **Enroll computer** for the paired device.
2. Record this computer's `computer_id` and its own node token. The `device_id` is not the computer ID. Never reuse another computer's token.
3. Install and sign in to the local Codex or Claude CLI. Create a workspace directory outside this npm installation.
4. Configure the existing daemon environment, then run `artood start`.

Windows PowerShell example:

```powershell
$env:ARTOO_NODE_URL = 'wss://artoo.example.com/api/v1/node?token=<your-node-token>'
$env:ARTOO_NODE_ID = '<computer_id>'
$env:ARTOO_ALLOWED_ROOTS = 'C:\ArtooWorkspaces'
$env:ARTOO_RUNTIMES = 'codex'
# Use the actual installed executable, particularly for supervised Windows mode.
$env:ARTOO_CODEX_BINARY = 'C:\Tools\codex.exe'
artood start
```

Linux shell example (macOS uses the same implemented interface, with release qualification deferred):

```sh
export ARTOO_NODE_URL='wss://artoo.example.com/api/v1/node?token=<your-node-token>'
export ARTOO_NODE_ID='<computer_id>'
export ARTOO_ALLOWED_ROOTS='/absolute/path/to/ArtooWorkspaces'
export ARTOO_RUNTIMES='codex'
export ARTOO_CODEX_BINARY='/absolute/path/to/codex'
artood start
```

The values above are placeholders for the advanced manual interface. Keep tokens out of shell history, screenshots and shared scripts: read them interactively or supply the environment from a local secret store. If an operator uses Node's `--env-file`, restrict that file to the operator and administrators and never commit it. Use `connect` for automatic protected persistence; there is no separate `pair` subcommand.

The daemon makes an outbound WebSocket connection. No inbound computer port or router forwarding is required. Production connections should use `wss://`; never disable TLS certificate validation. In Web, confirm the computer and runtime are online, then register an agent workspace using an owner/admin account.

Press **Ctrl+C** for graceful shutdown of a manual foreground run. `connect` and saved-configuration `start` use the managed background process described above.

## Windows supervised execution

```powershell
artood start --windows-supervised
```

This mode is available only on Windows x64. It selects the existing native supervisor and automatically supplies the packaged native-helper location and release-pinned bundle hashes when no explicit helper pair is configured. It still requires `ARTOO_RUNTIMES=codex`, an absolute `ARTOO_CODEX_BINARY`, paired identity, allowed roots, protected verifier/release profiles, and a qualified `ARTOO_PRODUCT_SOURCE_CONFIG_FILE`. Package files must remain outside all agent write roots and satisfy the existing NTFS/ACL checks. No protection or qualification check is bypassed.

Ordinary connection, protected execution, autonomous product acceptance and production publication are separate capabilities. An npm installation or online computer alone does not qualify all of them. A stopped supervised session cannot reopen its retained source workspace simply by starting a new supervisor; follow the existing recovery rules and never remove owner fences to force reuse.

The package includes the Playwright libraries. Browser acceptance additionally requires an operator-provisioned supported browser and the corresponding protected profiles. Model CLI credentials remain local; they are not included in this package or sent to npm.

## Maintainer release checks

From a validated repository checkout, build a **fresh** Windows x64 native process host with the stable .NET 10 SDK. The package builder still runs on Windows x64 even when the resulting tarball will also run on macOS and Linux:

```powershell
node apps/artood/scripts/build-windows-process-host.mjs --out-dir C:\ArtooRelease\native
node scripts/npm-daemon/build.mjs --name {{PACKAGE_NAME}} --version {{PACKAGE_VERSION}} --output-directory C:\ArtooRelease\package --windows-process-bundle C:\ArtooRelease\native --windows-process-manifest-sha256 sha256:<recorded-native-manifest-hash>
npm pack C:\ArtooRelease\package --pack-destination C:\ArtooRelease
```

Use fresh output/install directories. The `npm-daemon-cross-platform.yml` workflow builds one tarball on Windows and distributes those exact bytes to required Windows x64 and Linux x64/arm64 jobs, plus separate optional macOS Intel/Apple Silicon jobs. Every runner uses the same SHA-256, package metadata, npm installation without `--force` or `--ignore-scripts`, installed CLI shim, manifest and fixture-authenticated connection/task/normal-stop checks. POSIX real-process verification runs separately against built repository modules. The required aggregate waits for Windows and Linux only; optional Mac results never turn that three-platform summary into five-platform qualification.

PR artifacts validate that PR's merge checkout. For a deliverable release candidate, use a `push` run on `main` or dispatch the workflow on `main`, and require its build, all three Windows/Linux jobs and **Required Windows/Linux aggregate** to succeed for the exact source and tarball. Retain the three required reports, POSIX logs, metadata, summary and raw run/attempt-specific job facts. The overall run may remain pending or fail because of optional Mac jobs; record that status separately. Do not publish a PR merge-ref build as though it came from main. This build/check workflow has read-only GitHub permissions, no npm credentials and no publication step. The package's five platform tuples describe implemented startup interfaces, not five qualified release targets.

Individual installation checks can also use `scripts/npm-daemon/package-smoke.mjs` with `--tarball`, `--sha256`, `--name`, `--version`, `--platform`, `--source-commit` and a new absolute `--evidence-directory`. Build `@artoo/server` and its TypeScript references first for the connection fixture. The safe evidence directory excludes the test database, package installation, cache and credentials.

The historical Windows-only registry check in `registry-smoke.mjs` remains pinned to published `0.1.0-rc.1`; it is not the universal-candidate check. For publication, use the separate staged-publishing runbook and verify fresh registry installations on the three required Windows/Linux targets after approval. Candidate checks do not prove npm publication, production OAuth, a real provider, browser acceptance, Windows native-supervisor admission or deployed-product health.

The complete runtime remains in `runtime/`, including its nested `node_modules`. The outer npm manifest has no private workspace dependencies or install lifecycle scripts. Neither the runtime manifest nor the private internal package manifest is rewritten for npm.
