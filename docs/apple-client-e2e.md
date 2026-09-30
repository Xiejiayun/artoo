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
```

`verify:desktop` also selects the Mac suite on macOS. On Windows it retains the
installed NSIS suite and its interactive-session requirement. The Mac gate
builds and copies a real packaged `.app`, including its renderer, daemon and
application icon, into an isolated installation. It does not install over a
user's existing app or reuse their saved account.

Select a specific native device with `ARTOO_IOS_SIMULATOR_UDID`. It must be an
available iPhone simulator listed by `xcrun simctl list devices available`.
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
| Mac packaged app | `apps/desktop/release/mac-smoke-artifacts/macos-desktop-smoke.html` | Pairing, packaged renderer and bridge, worker lifecycle, approved execution, artifact bytes/review, restart recovery and cleanup. |
| Every Mac attempt | `apps/desktop/release/mac-smoke-artifacts/history/` | Timestamped, self-contained HTML and JSON, including build and cleanup failures. |
| iOS build/XCTest | `artifacts/ios/Artoo-<timestamp>.html` | Full asset build, Keychain-enabled simulator signing and executed unit tests. This is not UI evidence. |
| iOS UI | `artifacts/ios/native-ui-<timestamp>.html` | Real pairing, server-backed daemon state, agent discussion/plan acceptance and native/browser thread synchronization. |
| Native UI runner | `artifacts/ios/ArtooUI-<timestamp>.html` | Xcode command results and approved named XCTest screenshots. |
| Browser and authentication | `apps/web/playwright-report/<suite>-<timestamp>/index.html` | Test results, deliberate workflow screenshots and browser/source metadata. |

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

## What these gates establish

Native pairing and authorization, persistence, REST/WebSocket transport and
local execution use production code. The owner web session is provisioned by
the fixture, and agent output comes from deterministic CLI subprocesses. These
gates therefore do not prove Google login completion or live provider inference.

The Mac directory app is unsigned. Simulator execution does not certify
physical iPhones/iPads, TestFlight or the App Store. Signing, notarization,
real deployment, provider behavior, data policy and distribution decisions
remain separate gates in [Apple release readiness](apple-release-readiness.md).

The next native coverage priorities are task execution/approval/artifact
review, recovery of approvals needing more information, cancellation
confirmation, member enrollment and permission failures, and a compact/iPad
layout matrix. Existing chat/plan evidence must not be presented as coverage
of these additional workflows.
