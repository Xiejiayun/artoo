# Installed Mac provider verification

The ordinary Mac DMG smoke uses a deterministic CLI fixture. Setting exactly
`ARTOO_DESKTOP_LIVE_CODEX=1` adds real Codex inference through the installed
worker after those checks. Without that opt-in, the provider helper is not
loaded and no live provider settings or API-key file are read.

Mac defaults to `discussion`: three logical model turns by two registered
agent instances, followed by plan review and acceptance. Set
`ARTOO_DESKTOP_LIVE_SCOPE=all` to include two conversational replies before the
discussion, for five logical turns. Failed runs can stop earlier and still
consume provider usage; a logical turn can involve multiple provider requests.
Use an operator-authorized Responses API, model and existing key file.

## Run from an interactive Mac session

Follow the Node.js, Playwright and DMG prerequisites in
[Mac distribution](../apps/desktop/MAC-DISTRIBUTION.md). Install a compatible
Codex CLI, and supply its absolute executable path. This example uses
placeholders; replace them with the selected provider's configuration:

```sh
ARTOO_DESKTOP_LIVE_CODEX=1 \
ARTOO_DESKTOP_LIVE_BINARY='/absolute/path/to/codex' \
ARTOO_DESKTOP_LIVE_MODEL='provider-model-name' \
ARTOO_DESKTOP_LIVE_URL='https://provider.example/v1' \
ARTOO_DESKTOP_LIVE_KEY_FILE='/absolute/path/to/existing/api-key' \
npm run smoke:mac:dmg --workspace @artoo/desktop
```

The address must use HTTPS, or HTTP on `localhost`, `127.0.0.1` or `::1`, and
contain no embedded credentials, query or fragment. The key value is read only
inside the opted-in test process, entered through the installed app's password
field, and stored using Electron safeStorage. Do not put the key value in
command arguments or source files. Playwright tracing remains disabled.

Every invocation builds a fresh DMG, installs its app into a temporary
directory, and runs the ordinary deterministic installation flow first. The
live extension then saves the explicit Responses settings through the UI,
restarts the app, restores the child app's normal PATH and starts its real
Codex worker. Sign-out, removal and cleanup finish the enclosing smoke.
`ARTOO_SMOKE_SKIP_BUILD=1` is rejected by the DMG flow.

The default discussion verifies:

- UI-saved provider settings and encrypted key survive an app restart.
- The installed worker executes through authenticated node WebSocket.
- Three completed contributions use distinct provider sessions and record
  positive input/output token usage.
- The reviewer receives the planner's actual answer, and synthesis retains
  the same generated marker, task criteria and dependency.
- The UI displays a validated suggestion; viewing it or creating its proposal
  creates no tasks. Human acceptance creates exactly the two specified tasks.
- The isolated live workspace contains no work files beyond its context pack.

The `all` scope additionally checks that two chat answers persist once and the
follow-up receives and repeats the actual prior answer. The shared Windows
entrypoint retains its `all` default and existing `windows-live-copilot-*`
evidence filenames; see [Windows verification](windows-copilot-verification.md).

## Evidence and validation status

The DMG report directory is
`apps/desktop/release/mac-dmg-smoke-artifacts`. The enclosing
`macos-dmg-desktop-smoke.html` embeds actual workflow captures, including the
live suggested-plan card and, for `all` runs, the live conversation. Captures
completed before a later failure remain in the failed HTML report.
The companion `macos-live-provider.json` records scope, completed checks, usage
and cleanup status. Its images are `macos-live-provider-plan.png` and the
optional `macos-live-provider-chat.png`. Top-level evidence is replaced by the
next invocation. The enclosing HTML/JSON reports now retain the finalized,
redacted companion result as `liveEvidenceSnapshot`, including measurements,
failure details and cleanup status. Their immutable copies in `history` retain
that snapshot and the HTML's embedded images after top-level files are removed
or replaced. The existing `liveEvidence` path remains for current-run tools.

A live pass requires the enclosing report to pass with `liveVerified: true`,
the live report to contain `result: "pass"`, and cleanup to complete. A
requested live run or a captured image alone is not a successful result.
Failures retain a fixed stage and sanitized state categories; raw provider
errors and submitted secrets are omitted from diagnostics.

Eleven unit checks passed, including companion deletion/replacement and
sanitized snapshot retention for both Mac and Windows. The full default Mac DMG
flow passed on
`2026-09-30T19:18:02.483Z`, with six actual app screenshots and complete cleanup.
A separate opted-in run with intentionally missing provider configuration
stopped at `validate local live configuration`, retained seven client images,
reported `liveVerified: false`, and cleaned up the app, server and installation.
Its failed result is expected negative-path evidence, not a model validation.

The self-contained reports are in `mac-dmg-smoke-artifacts/history/`:

- `macos-dmg-2026-09-30T19-18-02-483Z.html`: default product flow passed.
- `macos-dmg-2026-09-30T19-22-59-434Z.html`: missing live configuration failed.
- `macos-dmg-2026-09-30T20-01-46-032Z.html`: after the snapshot-retention fix,
  the same missing-configuration boundary failed before inference. Eleven
  ordinary installation/workflow checks completed first, seven client images
  were inspected, and cleanup completed. The historical HTML/JSON now contain
  the failure stage, empty measurements and cleanup in `liveEvidenceSnapshot`.

No successful Mac real-provider run is claimed yet; it requires a reachable
provider and valid operator configuration. The routing unit tests use explicitly
labeled synthetic images in temporary directories and never produce a passing
live report. They can be run without a provider or production build:

```sh
node --test apps/desktop/scripts/installed-live-provider.test.mjs
```

Even a successful live run uses a loopback server and a test-provisioned owner
cookie. It verifies native pairing, provider settings, model execution,
discussion and plan acceptance through product paths. It does not certify
public TLS deployment, Google sign-in, task implementation by the model,
package signing, App Store distribution or physical iOS devices.

## Existing Codex settings mode

The product already offers **Use existing Codex settings** in Desktop Settings.
`DesktopSetup.tsx` selects `mode: "default"`; `codex-settings.cjs` retains the
optional binary/model while clearing the stored provider key. The desktop
controller removes inherited `ARTOO_CODEX_*` overrides and supplies no custom
provider URL or key in this mode. `codexRuntime` then leaves provider/auth
selection to the installed CLI's own configuration.

This E2E helper deliberately exercises the explicit Responses/API-key path.
It does not select default mode, inspect CLI login/configuration, or establish
that an existing CLI login works. Covering default mode remains a separate
operator-authorized validation path.
