# macOS distribution and DMG installation evidence

Run these commands from the repository root with Node.js 24+ and installed npm
dependencies. Packaging requires macOS. The DMG smoke additionally requires an
interactive desktop session and a Playwright Chromium installation or an
explicit `ARTOO_CHROMIUM_CHANNEL` such as `chrome`.

## Unsigned preview artifacts

```sh
npm run dist:mac:preview --workspace @artoo/desktop
```

Each invocation builds the production renderer and daemon, then creates a new
directory under `apps/desktop/release/mac-distribution/preview-<timestamp>`.
It writes the current architecture's `.dmg`, `.zip` and `distribution.json`
with artifact SHA-256 values and source provenance. The renderer uses production
authentication. An existing cached Electron binary with the wrong architecture
is rejected rather than relabeled.

Preview explicitly disables Developer ID signing, notarization and publishing.
An ad-hoc signature needed by Apple Silicon is not a Developer ID signature.
These artifacts do not establish Gatekeeper trust or public release readiness;
the script does not change Gatekeeper settings or strip quarantine attributes.

### DMG build detach policy

Both distribution modes default to the repository's executable
`scripts/mac-dmgbuild.mjs`, selected through electron-builder's supported
`CUSTOM_DMGBUILD_PATH`. It passes `--detach-retries 10` to the unmodified vendor
CLI. All original argument boundaries, stdout/stderr, nonzero exits and signal
termination are preserved through Node.js 24's POSIX `process.execve` API
(currently experimental in Node).
The launcher checks that this API is available; it does not introduce another
child process or a separate retry loop.

The launcher follows electron-builder → app-builder-lib → dmg-builder, then
uses `downloadBuilderToolset` from that vendor's own dependency tree. This
resolves the same `dmg-builder@1.2.5` toolset and archive checksums as
installed dmg-builder 26.15.3, selecting the host's x64/arm64 tool. It never
guesses a user cache directory. A changed dependency version or toolset constant
requires review instead of silently retaining stale vendor pins. The existing
builder holds its global temporary toolset lock around the launcher; the
launcher does not reacquire that lock.

Ten attempts allow about 170 seconds of vendor backoff sleeps if every normal
detach fails; actual disk commands add time and the existing 600 second builder
command timeout still applies. This gives transient busy volumes more time,
without establishing the cause or guaranteeing a successful build. The launcher
adds no force detach or global mount cleanup. The unmodified vendor may perform
its own forced cleanup after normal retries are exhausted, but still exits with
failure; that remains a failed distribution and produces no accepted artifacts.

An explicit nonblank `CUSTOM_DMGBUILD_PATH` continues to select the caller's
executable, resolved relative to `apps/desktop`. Missing paths, directories and
non-executable files fail. The manifest records the selected path and SHA-256;
its `dmgbuild.clean_detach_attempts` is 10 for the repository default and null
for an external override whose policy is unknown. Duplicate or abbreviated
retry flags are rejected by the repository launcher so its declared policy
cannot be silently overridden. No signing, notarization, Gatekeeper, fresh
artifact or installation checks are relaxed by this build policy.

## Repeatable DMG installation E2E

The root Mac release gate and the Mac CI job run distribution configuration and
mount tests, the focused execution/worker-shutdown regressions, and then the DMG
installation flow:

```sh
npm run verify:mac
```

To invoke the same smoke directly:

```sh
npm run smoke:mac:dmg --workspace @artoo/desktop
```

This command always builds a **new DMG and ZIP in the same invocation** and
rejects `ARTOO_SMOKE_SKIP_BUILD=1`. It verifies the DMG hash, mounts only that
image with `hdiutil -readonly -nobrowse`, verifies the mount is read-only, and
copies its `Artoo.app` into a fresh temporary installation directory. The copied
renderer and daemon hashes must match the mounted image. The image is detached
before launching the installed copy, so the running client cannot depend on
the mounted package.

The installed app then uses the existing packaged smoke's complete pairing,
authenticated realtime, worker lifecycle, task approval/execution, artifact
download, review, app/server restart, sign-out and removal checks. It uses an
isolated fixture server and deterministic CLI by default. Optional real Codex
discussion verification requires explicit opt-in and provider configuration;
see [installed Mac provider verification](../../docs/mac-live-provider-verification.md).
The fixture does not establish live Google sign-in. It never installs into `/Applications`, replaces
an existing user app or uses a directory package as DMG evidence.

The HTML report, actual app screenshots, JSON result, package hashes and cleanup
status are written under `apps/desktop/release/mac-dmg-smoke-artifacts`, with
timestamped HTML/JSON copies in `history`. Cleanup attempts to detach even after
mount validation/copy failure, and a failed detach makes the E2E fail. A hard
process kill or machine shutdown can prevent cleanup; a retained mountpoint is
always a unique `artoo-mac-dmg-*` temporary directory recorded in diagnostics.

Each distribution directory also contains `build.log`, with bounded stdout and
stderr tails from each command. Diagnostics use the report's credential
redaction and remove known sensitive environment values without dumping the
environment or command arguments. Both streams remain available when a failed
tool writes its explanation only to stdout.

CI retains these reports, the distribution manifests, builder diagnostics and
the console log at `artifacts/preview-gate/mac-dmg.log`. Its upload paths select
these evidence files; the large `.app`, `.dmg` and `.zip` packages are not
automatically uploaded. The separate `npm run smoke:mac --workspace
@artoo/desktop` directory-package check remains available and writes to
`release/mac-smoke-artifacts`; it does not satisfy the DMG installation gate.

Lightweight tests do not launch Artoo or build an Electron package:

```sh
node --test apps/desktop/scripts/mac-dmgbuild.test.mjs apps/desktop/scripts/mac-distribution.test.mjs
ARTOO_TEST_REAL_DMG=1 node --test apps/desktop/scripts/mac-distribution.test.mjs
```

The opt-in second command creates only a small filesystem fixture DMG and
checks real mount/detach behavior. It is not product installation evidence.
The launcher tests use temporary executable subprocess fixtures and simulated
builder commands; they do not download a toolset, create a disk image or launch
the app. A fresh real DMG and the full installed-client E2E remain required to
accept a packaging change.

## Signed release gate

Use a Developer ID Application certificate with its private key in the
operator's Keychain. Configure:

- `ARTOO_MAC_SIGN_IDENTITY`: the full `Developer ID Application: Name (TEAMID)` identity.
- `ARTOO_APPLE_TEAM_ID`: its matching ten-character Apple team identifier.
- `ARTOO_NOTARY_KEYCHAIN_PROFILE`: an existing `notarytool` Keychain profile.

The default release command fails before building or uploading when any field,
the installed signing identity, or notarization access is unavailable. It also
requires an explicit upload opt-in:

```sh
npm run dist:mac:release --workspace @artoo/desktop -- --submit-notarization
```

This explicit flag authorizes submitting the signed app archive and DMG to
Apple's notarization service. It does not publish to a release host or store.
Electron-builder publishing and automatic notarization remain disabled. The
script checks the exact Developer ID/team signature, requires Apple to return
`Accepted`, staples and validates the app, assesses the app with Gatekeeper,
then creates DMG/ZIP from that stapled app. It separately signs, notarizes and
staples the DMG, and records final artifact hashes only after those checks pass.
Any failure remains a failed distribution manifest; there is no unsigned
fallback. Credentials are referenced through Keychain and are not put in the
manifest or committed configuration.

The signed flow still needs verification with the real publishing team's
credentials and clean-Mac installation/upgrade testing. No signed or notarized
release is claimed by the unsigned DMG E2E or the lightweight tests.
