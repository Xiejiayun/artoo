# Mac and iOS end-to-end verification

Use Node 24 or newer. Install workspace dependencies with `npm ci` and browser
dependencies with `npx playwright install chromium`. iOS additionally needs
Xcode, XcodeGen and an available iPhone simulator. The clients connect to
disposable, persistent local servers with production authentication enabled.

## Run the gates

From the repository root on a Mac with a graphical session:

```sh
npm run verify:mac
npm run verify:ios
npm run verify:recovery
```

`verify:mac` builds a fresh unsigned DMG and ZIP, verifies the DMG checksum,
mounts it read-only, and copies its real `.app` into an isolated installation.
It verifies the renderer and daemon bytes and detaches the image before
launching the installed app. Distribution guardrails and real POSIX worker
regressions run first. The gate does not replace a user's app or reuse their
saved account. `verify:desktop` retains the directory-app smoke on macOS and
the interactive installed NSIS suite on Windows. The standalone Mac directory
check is `npm run smoke:mac --workspace @artoo/desktop`.

Select a specific native device with `ARTOO_IOS_SIMULATOR_UDID`. It must be an
available iPhone simulator listed by `xcrun simctl list devices available`.
Without an override, the gate selects an available iPhone runtime at or below
the selected Xcode's iPhoneSimulator SDK version. Reports retain the SDK,
runtime and selection mode; the script does not switch Xcode or create devices.
Set `ARTOO_CHROMIUM_CHANNEL=chrome` to use an installed Chrome for browser
peers when the bundled browser is unavailable. Reports record the actual
browser version; the Mac client under test remains packaged Electron.

To run the already-built native UI fixture independently:

```sh
npm run build:preview
node scripts/ios-ui-e2e.mjs
```

`--self-check` on that script tests the browser/server fixture without native
UI. It is explicitly labeled as harness evidence and cannot pass an iOS gate.
Run the shared browser and authentication workflows with:

```sh
npm run test:e2e --workspace @artoo/web
npm run e2e:auth
```

## Reports and screenshots

| Run | HTML location | Evidence |
| --- | --- | --- |
| Mac DMG installation | `apps/desktop/release/mac-dmg-smoke-artifacts/macos-dmg-desktop-smoke.html` | Fresh DMG and ZIP manifest, read-only install and detach, exact app bytes, and the full packaged-client business/restart/cleanup checks. Timestamped attempts are in the adjacent `history/` directory. |
| Mac packaged app | `apps/desktop/release/mac-smoke-artifacts/macos-desktop-smoke.html` | Pairing, packaged renderer and bridge, worker lifecycle, approved execution, artifact bytes/review, restart recovery and cleanup. |
| Every Mac attempt | `apps/desktop/release/mac-smoke-artifacts/history/` | Timestamped, self-contained HTML and JSON, including build and cleanup failures. |
| iOS build/XCTest | `artifacts/ios/Artoo-<timestamp>.html` | Full asset build, Keychain-enabled simulator signing and executed unit tests. This is not UI evidence. |
| iOS UI | `artifacts/ios/native-ui-<timestamp>.html` | Real pairing, approval recovery across relaunch, explicit goal cancellation, daemon state, discussion/plan acceptance, cross-client threads, and native task creation through approved execution, uploaded artifact preview and human acceptance. |
| Native UI runner | `artifacts/ios/ArtooUI-<timestamp>.html` | Xcode command results and approved named XCTest screenshots. |
| Browser and authentication | `apps/web/playwright-report/<suite>-<timestamp>/index.html` | Test results, deliberate workflow screenshots and browser/source metadata. |
| Local backup/restore | `artifacts/recovery/<timestamp>/report.html` | Production persistent server, real worker artifact upload, offline CLI backup/restore, credential continuity, exact bytes, idempotency and restored Web download. |

Mac and native reports embed screenshots so later attempts cannot replace
their evidence. Reports include the source commit, dirty-tree indicator,
tracked diff hash and untracked-source hash. A failed run remains failed;
checks completed before the failure remain visible. A failure before any UI
launch explicitly says that no screenshots or visual verification are available.

Raw XCTest bundles and automatic failure attachments remain in the local
`artifacts/ios` directory for diagnosis. They can contain disposable fixture
credentials and are not the shareable report. CI uploads HTML, summary JSON
and deliberate browser screenshots; it does not automatically upload raw
XCTest bundles or attachment exports. Public HTML accepts only reviewed
workflow screenshot names, excluding onboarding failure screenshots.

The Mac harness owns its browser process. Cleanup waits for actual process
exit and Playwright profile cleanup, and records whether graceful or forced
closure was needed. Browser names are never used to terminate unrelated apps.
An incomplete cleanup prevents a passing result.

The recovery gate rebuilds the production packages, then uses only isolated
temporary storage. It checks online-backup refusal, offline backup hashes,
restoration into a new directory, corrupt-backup/overwrite rejection, and
removes the original database and workspace artifact before testing recovery.
Screenshots show the actual authenticated workspace before and after restore.
This does not prove off-site storage, deployed TLS/OAuth or physical host recovery.

## What these gates establish

Native pairing and authorization, persistence, REST/WebSocket transport and
local execution use production code. The owner web session is provisioned by
the fixture, and agent output comes from deterministic CLI subprocesses. These
gates therefore do not prove Google login completion or live provider inference.

The preview Mac directory app, DMG and ZIP are unsigned. Their manifest records
the final artifact hashes; see [Mac distribution](../apps/desktop/MAC-DISTRIBUTION.md)
for the separate Developer ID/notarization gate. Simulator execution does not certify
physical iPhones/iPads, TestFlight or the App Store. Signing, notarization,
real deployment, provider behavior, data policy and distribution decisions
remain separate gates in [Apple release readiness](apple-release-readiness.md).

The native task scenario also disconnects the selected executor, verifies that
rejection retains the assignment form without consuming approval, and retries
after reconnection. The next coverage priorities are member enrollment and
permission failures, and a compact/iPad layout matrix. Each
report's actual result determines which scenarios passed; a failed six-scenario
run does not certify the entire native task flow.
