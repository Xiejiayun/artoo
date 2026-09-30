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
isolated fixture server and deterministic CLI, with no model-provider request
or live Google sign-in claim. It never installs into `/Applications`, replaces
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
node --test apps/desktop/scripts/mac-distribution.test.mjs
ARTOO_TEST_REAL_DMG=1 node --test apps/desktop/scripts/mac-distribution.test.mjs
```

The opt-in second command creates only a small filesystem fixture DMG and
checks real mount/detach behavior. It is not product installation evidence.

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
