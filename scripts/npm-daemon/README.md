# Artoo Windows agent daemon

Connect a Windows x64 computer to an Artoo Web platform. This package includes the daemon, its JavaScript dependencies and the self-contained Windows native process host. Users need **Node.js 24 or later**, but do not need a repository checkout or .NET.

```powershell
npm install --global {{PACKAGE_NAME}}@{{PACKAGE_VERSION}}
artood --version
artood --help
```

## Connect a computer

1. Sign in to your Artoo Web platform as the person who will operate this computer. In **Settings → Connect a device**, create a Windows pairing code and claim it using the platform's device pairing API. An owner/admin must **Enroll computer** for the paired device.
2. Record this computer's `computer_id` and its own node token. The `device_id` is not the computer ID. Never reuse another computer's token.
3. Install and sign in to the local Codex or Claude CLI. Create a workspace directory outside this npm installation.
4. Configure the existing daemon environment, then run `artood start`:

```powershell
$env:ARTOO_NODE_URL = 'wss://artoo.example.com/api/v1/node?token=<your-node-token>'
$env:ARTOO_NODE_ID = '<computer_id>'
$env:ARTOO_ALLOWED_ROOTS = 'C:\ArtooWorkspaces'
$env:ARTOO_RUNTIMES = 'codex'
# Use the actual installed executable, particularly for supervised Windows mode.
$env:ARTOO_CODEX_BINARY = 'C:\Tools\codex.exe'
artood start
```

The values above are placeholders. Keep tokens out of shell history, screenshots and shared scripts: read them interactively or supply the environment from a local secret store. If an operator uses Node's `--env-file`, restrict that file to the operator and administrators and never commit it. The CLI does not print, save, rotate or claim credentials. It does not provide a `pair` command.

The daemon makes an outbound WebSocket connection. No inbound Windows port or router forwarding is required. Production connections should use `wss://`; never disable TLS certificate validation. In Web, confirm the computer and runtime are online, then register an agent workspace using an owner/admin account.

Press **Ctrl+C** for graceful shutdown. This is a foreground CLI; npm installation does not silently install a background service, register a scheduled task or change local ACLs.

## Windows supervised execution

```powershell
artood start --windows-supervised
```

This selects the existing native supervisor and automatically supplies the packaged native-helper location and release-pinned bundle hashes when no explicit helper pair is configured. It still requires `ARTOO_RUNTIMES=codex`, an absolute `ARTOO_CODEX_BINARY`, paired identity, allowed roots, protected verifier/release profiles, and a qualified `ARTOO_PRODUCT_SOURCE_CONFIG_FILE`. Package files must remain outside all agent write roots and satisfy the existing NTFS/ACL checks. No protection or qualification check is bypassed.

Ordinary connection, protected execution, autonomous product acceptance and production publication are separate capabilities. An npm installation or online computer alone does not qualify all of them. A stopped supervised session cannot reopen its retained source workspace simply by starting a new supervisor; follow the existing recovery rules and never remove owner fences to force reuse.

The package includes the Playwright libraries. Browser acceptance additionally requires an operator-provisioned supported browser and the corresponding protected profiles. Model CLI credentials remain local; they are not included in this package or sent to npm.

## Maintainer release checks

From a validated repository checkout, build a **fresh** Windows native process host, then run:

```powershell
node scripts/npm-daemon/build.mjs --name {{PACKAGE_NAME}} --version {{PACKAGE_VERSION}} --output-directory C:\ArtooRelease\package --windows-process-bundle C:\ArtooRelease\native --windows-process-manifest-sha256 sha256:<recorded-native-manifest-hash>
npm pack C:\ArtooRelease\package --pack-destination C:\ArtooRelease
npm install --prefix C:\ArtooPackageSmoke --ignore-scripts --no-audit --no-fund C:\ArtooRelease\<package-tarball>.tgz
node scripts/npm-daemon/verify.mjs --package-directory C:\ArtooPackageSmoke\node_modules\<package-name>
```

Use fresh output/install directories. `verify.mjs` verifies every runtime file against the original pinned manifest, checks local Playwright resolution, and imports the installed daemon. Also run the installed CLI's help/version and a real connection/normal-stop smoke before publishing the exact tarball. For prerelease versions use an explicit npm dist-tag such as `next`; do not move `latest` unintentionally. Publication requires an authorized npm account and any account-required authentication.

The complete runtime remains in `runtime/`, including its nested `node_modules`. The outer npm manifest has no private workspace dependencies or install lifecycle scripts. Neither the runtime manifest nor the private internal package manifest is rewritten for npm.
