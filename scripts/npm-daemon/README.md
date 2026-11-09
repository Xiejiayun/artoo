# Artoo agent daemon

Connect a Windows, macOS or Linux computer to an Artoo Web platform. One npm tarball contains the daemon, its JavaScript dependencies and the self-contained Windows x64 process host. Users need **Node.js 24 or later and npm 11 or later**, but do not need a repository checkout or .NET.

| Operating system | Supported architecture |
| --- | --- |
| Windows | x64 |
| macOS | Intel x64, Apple Silicon arm64 |
| Linux | x64, arm64 |

Windows arm64 is not supported. npm's separate OS/CPU fields cannot express that exclusion, so the daemon checks the exact platform/architecture pair before starting. The Windows native host is carried in the same tarball on every platform; ordinary macOS/Linux execution does not load it.

```sh
npm install --global {{PACKAGE_NAME}}@{{PACKAGE_VERSION}}
artood --version
artood --help
```

Always install an explicit version. Prereleases use `next`; do not rely on an unversioned install or assume that `latest` points to the current candidate. Published `0.1.0-rc.1` was Windows x64 only; the universal candidate begins with `0.1.0-rc.2` and is a separate artifact.

Linux pairing and enrollment require the matching server/Web upgrade and its new ordered database migration. Back up the existing server data before upgrading; installing this npm package alone does not add Linux support to an older server. Follow the server runbook for migration and recovery, and keep each computer's own credentials.

## Connect a computer

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

macOS/Linux shell example:

```sh
export ARTOO_NODE_URL='wss://artoo.example.com/api/v1/node?token=<your-node-token>'
export ARTOO_NODE_ID='<computer_id>'
export ARTOO_ALLOWED_ROOTS='/absolute/path/to/ArtooWorkspaces'
export ARTOO_RUNTIMES='codex'
export ARTOO_CODEX_BINARY='/absolute/path/to/codex'
artood start
```

The values above are placeholders. Keep tokens out of shell history, screenshots and shared scripts: read them interactively or supply the environment from a local secret store. If an operator uses Node's `--env-file`, restrict that file to the operator and administrators and never commit it. The CLI does not print, save, rotate or claim credentials. It does not provide a `pair` command.

The daemon makes an outbound WebSocket connection. No inbound computer port or router forwarding is required. Production connections should use `wss://`; never disable TLS certificate validation. In Web, confirm the computer and runtime are online, then register an agent workspace using an owner/admin account.

Press **Ctrl+C** for graceful shutdown. This is a foreground CLI; npm installation does not silently install a background service, register a scheduled task or change local permissions.

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

Use fresh output/install directories. The `npm-daemon-cross-platform.yml` workflow builds one tarball on Windows and distributes those exact bytes to Windows x64, macOS Intel/Apple Silicon, and Linux x64/arm64 runners. Every runner verifies the SHA-256, rejects unexpected package metadata or install scripts, installs with npm without `--force` or `--ignore-scripts`, tests the actual installed CLI shim, and runs the manifest and fixture-authenticated connection/task/normal-stop checks. POSIX real-process verification runs in a separate step against built repository modules, not as a claim about a live model or native Windows qualification.

PR artifacts validate that PR's merge checkout. For a deliverable release candidate, use the successful `push` run on `main` or dispatch the workflow on `main`, and retain its exact source commit, tarball hash and all five platform reports. Do not publish a PR merge-ref build as though it came from main. This build/check workflow has read-only GitHub permissions, no npm credentials and no publication step.

Individual installation checks can also use `scripts/npm-daemon/package-smoke.mjs` with `--tarball`, `--sha256`, `--name`, `--version`, `--platform`, `--source-commit` and a new absolute `--evidence-directory`. Build `@artoo/server` and its TypeScript references first for the connection fixture. The safe evidence directory excludes the test database, package installation, cache and credentials.

The historical Windows-only registry check in `registry-smoke.mjs` remains pinned to published `0.1.0-rc.1`; it is not the universal-candidate check. For publication, use the separate staged-publishing runbook and verify the final registry version after approval. A five-platform fixture run does not establish production OAuth, a real provider, browser acceptance, Windows native-supervisor admission or deployed-product health.

The complete runtime remains in `runtime/`, including its nested `node_modules`. The outer npm manifest has no private workspace dependencies or install lifecycle scripts. Neither the runtime manifest nor the private internal package manifest is rewritten for npm.
