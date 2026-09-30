# Apple client verification milestones

## 2026-10-01: packaged Mac and native iOS baseline

Work began from `06276d6`. This milestone adds repeatable Mac packaging and
real-client E2E with self-contained screenshot reports, account-scoped member
pairing, administrator computer enrollment, iOS privacy disclosures/manifest,
and a fix for reconnect-time WebSocket callbacks crashing the renderer.

Verification ran on macOS (Darwin 25.6.0), Intel x64, Node 24.19.0 and Xcode 26.5
(17F42). Native tests used an isolated iPhone 16 Pro simulator running iOS 18.2,
with full assets and simulator Keychain entitlements. The successful Mac and
native UI reports record system Chrome 154.0.8037.58 as the independent Web
peer; the packaged Mac client itself is Electron 44.4.3.

| Gate | Result and boundary |
| --- | --- |
| TypeScript and production preview build | Passed. |
| Shared unit/integration suite | 1,172 passed, 20 skipped, 2 timed out during concurrent simulator/cache/build activity. The two affected files were rerun with one worker: all 10 tests passed in 37.52 seconds. The original failed run is retained and is not labeled a single uninterrupted successful gate. |
| Pairing and authorization regression | 35 passed across native auth, device service and device routes. |
| Desktop connection lifecycle | 13 passed, including member control pairing and administrator-authorized execution enrollment. |
| Device-management Web/API regression | 28 passed. |
| Reconnect regression | 19 passed across realtime client/provider tests; four new cases reproduced the old CONNECTING-state send failure before the fix. |
| Report integrity and process cleanup | 3 report tests and 4 actual child-process cleanup tests passed. |
| Native static contracts | 22 request fixtures and 51 endpoint declarations checked. |
| Native XCTest | 78 passed, including enrollment failure/retry; Debug simulator build passed. |
| Native Release UI | All 3 scenarios passed: daemon offline/recovery, discussion/proposal/human acceptance with dependent tasks, and native/browser chat/thread/background/relaunch synchronization. Seven native screenshots plus a browser screenshot retained. |
| Mac packaged E2E | All 9 checks passed, including real .app assets/bridge, pairing, encrypted credentials, worker lifecycle, approved task execution, artifact bytes/review, app/server restart, revocation and complete cleanup. Four screenshots retained. |
| Web E2E | All 14 workflows passed after the reconnect fix. |
| Authentication E2E | All 6 passed; login gate and OAuth initiation, not a completed live Google login. |
| Production dependency audit | Zero reported vulnerabilities. |

The final Mac run started at `2026-09-30T16:20:57.704Z` and finished at
`16:22:37.941Z`. The final native run started at
`2026-09-30T16:14:33.146Z` and finished at `16:21:23.371Z`. Their report source
fields retain the start-of-run commit and working-tree fingerprints; the
checks above include the subsequently added WebSocket regression. The native
application product source did not change during the successful native run.

Local HTML evidence:

| Report | SHA-256 |
| --- | --- |
| `apps/desktop/release/mac-smoke-artifacts/macos-desktop-smoke.html` | `d5daa42fcb00ff2d53db3dc07c7a4374cdbd8e69dd15bb8d313d7ba19dc70a98` |
| `artifacts/ios/native-ui-2026-09-30T16-14-33-146Z.html` | `58f61f35ec772f3358cf04beff15994e200d440dd18712bfd52359b38d52285d` |

The HTML files are generated artifacts, excluded from Git to avoid repeatedly
committing embedded image binaries. Mac history and native timestamped reports
retain failed attempts locally; CI retains reports for each workflow run.
See [the E2E guide](apple-client-e2e.md) for all report paths and commands.

Failures discovered and resolved during this milestone:

- Mac packaging downloaded Electron again and timed out; the Mac build now
  packages the verified Electron already installed by npm.
- Chrome's detached crash reporter kept stderr open after the real browser
  exited, preventing Playwright cleanup. The harness now releases only its
  own stream handles after actual exit, and still waits for profile cleanup.
  The final run closed gracefully without forced termination.
- iOS 18 exposes a Stepper's parent as non-hittable while its actual buttons
  are visible. Tests now target the real buttons and still assert each value
  change. Onboarding switch automation only retries an observed off state.
- A stale WebSocket callback could redirect unsubscribe traffic to a new
  CONNECTING socket and crash the UI. Socket generation and ready-state checks
  now protect callbacks, timers, and subscription replay.

This is a verified local functional baseline, not commercial release
acceptance. Deterministic CLI fixtures do not prove live model quality;
unsigned packages and simulators do not prove signed distribution or physical
devices. Remaining gates are tracked in
[Apple release readiness](apple-release-readiness.md). The next implementation
milestone restores approvals needing information to Inbox and adds explicit
goal-cancellation confirmation, followed by broader native business-flow E2E.

## 2026-10-01: approval recovery, execution ownership and installation

The next milestone retains approvals needing more information across native
relaunch, adds explicit goal-cancellation confirmation, and expands native
coverage through task creation, execution approval, actual uploaded artifact
preview and human acceptance. Approval submission dismisses the keyboard only
as part of the real request flow; a successful request clears and collapses its
form, while failure preserves the draft. Approval status/risk badges now keep
their full labels on narrow rows.

Assignment now waits for the server response before dismissing its native
sheet. A rejection preserves the selected mode/instance and shows the server
error. Submission disables editing, cancellation and duplicate actions; a
successful POST followed by a failed status read is still treated as an
accepted command. The status refresh path cannot resend that command.

Worker ownership fixes are committed in `374e7fc`: loss of the desktop IPC
owner shuts down the node, the independent guardian survives termination of
the daemon's process group, and a CLI leader's exit no longer declares a run
terminal while its owned descendants continue writing. Automatic and manual
scheduling also reject a fresh runtime explicitly reported as `missing`,
without creating a run; the existing absent-runtime-row fallback remains.

| Gate | Current evidence |
| --- | --- |
| Mac distribution guards | Eight passed; one opt-in tiny filesystem-DMG test skipped. The subsequent real product DMG was built and exercised. |
| Worker process regressions | All 46 passed, including seven real POSIX cases: IPC loss, daemon PID/group termination, three parent-exit/stdio cases and standalone SIGTERM. Protection is for the owned process group, not deliberate `setsid` escape. |
| Runtime eligibility | All 14 passed, including fresh `missing` rejection for auto/manual assignment and successful retry after runtime recovery. |
| Mac DMG installation | All 11 checks passed. Fresh x64 DMG/ZIP, exact checksums, read-only install, copied renderer/daemon bytes, detach before launch, paired execution/artifact/review, restart, revocation and complete cleanup. Four screenshots visually inspected. |
| Persistent recovery | All eight checks passed in `d1df1e6`; original storage/output removed before restored credentials, data, artifact bytes and Web download were verified. |
| Native execution fixture / development signing selection | All 17 Node tests passed (12 fixture and five signing-selection cases). |
| Simulator selection | Nine pure regressions passed. Defaults exclude runtimes newer than the selected Xcode SDK; explicit available iPhone UDIDs retain priority and record their override. |
| Current native XCTest | All 85 passed, including assignment rejection/retry, duplicate-submit prevention and accepted-command/status-read failure distinction. |
| Development-signed iOS archive | Current native product source passed Release arm64 archive, exact certificate/profile/Team verification, compiled assets and privacy-manifest checks. No device installation or store upload. |
| Current native UI | All six Release scenarios passed: approval recovery, daemon reconnect, cancellation confirmation, discussion/plan acceptance, cross-client/background/relaunch chat, and full task execution with offline assignment rejection/retry, artifact preview and human acceptance. Seventeen native screenshots plus one browser screenshot retained; native scenes visually inspected. |

The successful DMG report is
`apps/desktop/release/mac-dmg-smoke-artifacts/history/macos-dmg-2026-09-30T18-10-58-898Z.html`
(SHA-256 `02e4e8756b22f26edb9f1cea4a100edc9bdae35f7762d89b71ce5dcb84a4efe1`).
The DMG and ZIP are unsigned previews; release signing, Apple notarization,
clean-Mac upgrades and Apple Silicon execution remain separate acceptance.
The matching native development archive report is
`artifacts/ios-device/2026-09-30T18-32-09-609Z/report.html`
(SHA-256 `f08195fa67cd547ae179f427c0744d3c52cbe5d84a1dd5da5bf6d003265327f1`).
The full native UI run started at `2026-09-30T18:31:11.883Z` and ended at
`18:41:46.145Z`, with complete fixture cleanup. Its self-contained report is
`artifacts/ios/native-ui-2026-09-30T18-31-11-883Z.html`
(SHA-256 `8c74bc44c01f754ca9ddf95d1cd02bfb32794864448c69d9ec06f5f67bd7ba27`).
The root `verify:ios` gate passed all stages, including the SDK selector,
production build, static API contracts, 85 XCTest and all six Release UI cases.

Failures retained during this milestone include an official DMG-tool download
failure, an approval keyboard-focus issue, a Quick Look title selector that
assumed a static text instead of the observed navigation bar, and a review
field lookup before scrolling its virtualized list row into view. The official
DMG tool was downloaded through GitHub's release-asset API and matched its
published SHA-256 before entering electron-builder's normal archive cache.
Build errors now retain bounded stdout/stderr diagnostics in each distribution
directory rather than losing stdout-only failures.

Hosted source `d1df1e6` passed shared and Mac/recovery gates but failed iOS while
launching the first UI case: a system background assertion timed out and the
test runner exited. The later planning and chat cases passed. Its default
selection paired an iOS 18.5 SDK with iOS 26.2. The new SDK selection gate
removes that automatic mismatch without claiming that it proves the runner
failure's deeper cause. The prior hosted Home-transition failure now has
bounded state-aware retries and actual state diagnostics; background entry
remains mandatory before testing catch-up.

## 2026-10-01: desktop execution approval feedback and clean-checkout CI

The Mac/Web assignment button now follows the same current/unconsumed approval
rules as the server. Pending, needs-information, rejected, expired and consumed
requests disable assignment and explain how to proceed. The existing no-gate
path and ordinary member permissions remain unchanged. The detail panel uses
the approvals from the same authoritative task snapshot.

Thirty focused React tests and the Web TypeScript check passed. The freshly
built x64 DMG run starting `2026-09-30T18:55:00.096Z` passed all 12 client checks,
with six screenshots inspected and complete cleanup. It drove pending → Need
info → Reject → replacement request → Approve through the actual installed UI.
Read-only production API checks verified zero runs before assignment, preserved
superseded history, and the final run's binding to only the current approval.
The task then completed artifact download/review and app/server restart checks.

Report:
`apps/desktop/release/mac-dmg-smoke-artifacts/history/macos-dmg-2026-09-30T18-55-00-096Z.html`
(SHA-256 `c0fb66587d1294fbd49ebd3a4e76a4509c7652dc8c7d1f30613f334114eb3b4e`).
The Mac gate also passed all 46 process regressions and eight distribution
checks, with the separate tiny-DMG opt-in test skipped.

Hosted run `36760737412` exposed a clean-checkout failure before its Mac UI
could launch: the POSIX test bundle followed domain/protocol package exports
into missing `dist` directories. An independent worktree at `85eb8cd` reproduced
the exact four resolution errors after its own `npm ci`. Applying only the
seven-line source-alias change made all seven real process cases pass while
domain, protocol, server and daemon dist directories remained absent. Cleanup
confirmed zero added fixture directories and processes. This verifies the
local clean-checkout fix; the subsequent hosted run remains separate evidence.

## 2026-10-01: member revocation and explicit Mac provider verification

Native E2E now pairs an ordinary member's phone and verifies that its own
Revoke action is enabled, another account's Revoke action is absent, and
computer enrollment still requires an administrator. An independent owner
browser revokes that exact phone through Settings. The same phone credential
returns HTTP 200 before this action and 401 after it; the fixture observes only
the matching claim response in private memory and never publishes its token.
Native saved-connection retry and relaunch cannot restore the revoked session.
Fresh member pairing creates a different device, restores history and sends a
new message attributed to the same member. Other devices remain unchanged.

The full Pro simulator gate passed 85 XCTest and all seven Release UI cases.
The member permissions, recovered conversation and owner revoked-device card
were visually inspected. Cleanup completed. The report is
`artifacts/ios/native-ui-2026-09-30T19-28-39-263Z.html`
(SHA-256 `b83e4e029c650c00a95147f6f659ccf8e78a0578ff7db2e637554acfc9fe2854`).
This report precedes the subsequent task-form keyboard change; it does not
certify that later binary. Thirty focused Node regressions passed for claim
observation, device/message identity, response transparency, in-flight cleanup
and report image selection.

The installed Mac smoke now supports an explicit real-provider extension.
Its default remains the deterministic CLI fixture. Exact live opt-in is
required before loading the provider helper or reading provider configuration;
Mac defaults to three discussion turns and Windows keeps its existing five-turn
scope. Real model execution still needs working operator configuration.
See [the provider verification guide](mac-live-provider-verification.md).

Before the later report-retention correction, the default Mac gate passed all
12 DMG checks, 46 worker regressions and eight distribution checks. Six real
client screenshots were inspected and cleanup completed. Its report is
`apps/desktop/release/mac-dmg-smoke-artifacts/history/macos-dmg-2026-09-30T19-18-02-483Z.html`
(SHA-256 `1cca74c1e7193ab2dc9d3047894bc20f5f00ffdb7ea0b5c640d62477194401f7`).
An opted-in run with missing provider configuration correctly failed before
inference, retained seven client screenshots and cleaned up completely:
`apps/desktop/release/mac-dmg-smoke-artifacts/history/macos-dmg-2026-09-30T19-22-59-434Z.html`
(SHA-256 `42362936fecb1160d9d45297999ff3693a060e70a6771924286899a716a3dced`).
It records `liveVerified: false` with no provider measurements and is negative
configuration evidence only.

Hosted run `36762899822` at `2db6a98` passed shared and Mac gates, including
fresh DMG and recovery verification. Its iOS SDK/runtime selection was correct
(Xcode 16.4, SDK/iPhone runtime 18.5). All 85 unit and five of six UI cases
passed, but the task capabilities field was not hittable after multiline
criteria input on iPhone 16. The task form now offers a keyboard Done action
with explicit focus state; the UI case must actually use it, verify keyboard
disappearance and still submit the original criteria/capabilities. Fresh
compact-screen and hosted verification remain separate from the earlier Pro
result.

The first compact iPhone 16/iOS 18.2 attempt passed all 85 unit tests and four
of seven UI cases. The new creation-form Done action and keyboard disappearance
were exercised successfully. Later failures exposed two more multiline-input
screens without a Done action (chat and execution approval), plus a selectable
plan label that was visibly rendered while XCTest could not compute its tap
activation point. Raw screenshots and accessibility frames confirmed these
three boundaries. The failed run and complete cleanup remain recorded in
`artifacts/ios/native-ui-2026-09-30T19-45-48-336Z.html`
(SHA-256 `362f2fbd268844eca109d17c6dd79d2828f3195f68f4c63b6196e8dc192a2fc6`).
The reviewed, connected-page failure images are also retained in
`artifacts/ios/compact-failure-2026-09-30T19-45-48-336Z/report.html`
(SHA-256 `fcab53579b35f20e564891a8864445476785a8519fd97626969cfa5f0678dfd3`).

Chat, task approval and review fields now provide explicit Done actions and
interactive keyboard dismissal. UI tests must tap the actual Done control and
wait for the keyboard to disappear. Selectable message text checks require visible
geometry outside navigation/tab bars and still compare the exact server
content. Text that fits the viewport must be entirely visible; text taller
than the viewport must occupy at least half of it. All action buttons retain
strict hittability checks. The resulting full compact rerun is recorded
separately below when complete.

The second compact run passed all 85 unit tests and six of seven UI cases,
including the complete task/artifact acceptance case (210 seconds), chat
synchronization (99 seconds) and member revocation/recovery (155 seconds).
Suggested-plan contents and original-reply expansion/collapse also passed.
The new geometric helper then failed by assuming an immediately available
list viewport while navigating to an asynchronously loaded proposal page.
The helper is now confined to selectable message content; ordinary proposal
labels and author metadata keep the original reachability helper. This was a
test-boundary correction, with no further product changes after the keyboard
fix. Failed evidence and complete cleanup are retained in
`artifacts/ios/native-ui-2026-09-30T20-05-53-406Z.html`
(SHA-256 `c0a60bcc900a4e211a8c0b82ce85964c827639897c29952f9f3e0643e9ef2e8c`).
The reviewed failure capture is in
`artifacts/ios/compact-failure-2026-09-30T20-05-53-406Z/report.html`
(SHA-256 `b7deca5458b883d8069ca1934fcff394b1241c9ea1d0562016d974590e3761bf`).

Independent review also found that the next Mac run replaced the companion
provider JSON referenced by earlier history. The enclosing JSON/HTML now embed
a finalized, redacted snapshot including provider measurements, failure stage
and cleanup. Eleven routing/retention regressions passed. A new missing-config
DMG attempt retained this snapshot and seven inspected client images, with
eleven ordinary checks completed before the expected validation failure and
complete cleanup. It performed no model inference:
`apps/desktop/release/mac-dmg-smoke-artifacts/history/macos-dmg-2026-09-30T20-01-46-032Z.html`
(SHA-256 `2c6287b0267ce2c0869c923fedb824ec45f3fe63a84339286e5469dfae9b1ea7`).
The Mac provider-entry/report milestone is committed and pushed as `be05d1b`.

Hosted run `36771998339` independently passed the Mac job at clean source
`be05d1bd841fda69924afc58c87ecfe3199ca1c3`. Its runner was arm64 macOS 15
(Darwin 24.6.0, Node 24.20.0). It built new arm64 preview DMG/ZIP files,
installed from the exact hashed DMG, and passed all 12 client checks plus the
eight-check persistent recovery drill. All cleanup completed. Six installed
client screenshots were visually inspected. Together with the local x64 runs,
this establishes functional preview evidence on both Mac architectures;
release signing, notarization, Gatekeeper and signed upgrades remain open.

Downloaded, self-contained CI reports are retained locally:

| Report | SHA-256 |
| --- | --- |
| `artifacts/apple-ci/36771998339/mac-arm64.html` | `7be75a0cb6d35aae73db8e6cc49bb30e417792566a67937ee353668794c8622a` |
| `artifacts/apple-ci/36771998339/recovery-arm64.html` | `a082582e5df9ea0cd52a91993da6675351862758a99e9c505b0cc2d55ee7d5fb` |

The arm64 DMG hash is
`b6ea3d43b963094cef4905fb2a38712c843e263732335ecfe10d1bb675d75d63`;
the ZIP hash is
`8d832c05d5d149677d25748f0426d902d7f5a0c3868c4bd6b13891ab55f9184a`.
The distribution manifest is retained beside the reports. This hosted commit
contains the Mac milestone only; the later native member/keyboard changes
must be assessed with their own source and reports.

The final compact run, starting `2026-09-30T20:25:32.344Z` and finishing
`20:39:54.285Z`, passed the complete `verify:ios` gate. The exact XCTest
summaries report 85 unit and seven Release UI tests passed, with zero failures
or skips. Nineteen native captures and two browser captures were visually
inspected. The report confirms the original phone credential's 200 → 401
transition, one closed live connection, a distinct recovered member device,
correct message attribution and unchanged sentinel devices. Fixture resources
and temporary directories were cleaned up.

Successful compact HTML:
`artifacts/ios/native-ui-2026-09-30T20-25-32-344Z.html`
(SHA-256 `bd2865bc0d04c1f10fb5ae92a56b810b1054e66ec12110f398ca774bfa896666`).
The result bundles are `artifacts/ios/Artoo-1790799880704.xcresult` and
`artifacts/ios/ArtooUI-1790799985524.xcresult`. Native product source stayed
unchanged during this successful run and the following archive.

The matching development-signed Release arm64 archive also passed at
`2026-09-30T20:40:52.918Z`: certificate/profile/Team and embedded app identity,
compiled assets and privacy manifest all verified. The archive report is
`artifacts/ios-device/2026-09-30T20-40-52-918Z/report.html`
(SHA-256 `994ebbb7428f1fa38f5fcf42f7c428d670bcc2a35fc03bc8be73007f49e976bd`).
No physical-device installation, distribution export or upload is claimed.

The [coverage inventory](apple-client-workflow-coverage.md) records the
remaining existing UI paths. Direct-agent conversations, cross-project mentions
and execution correction/stopping are the next coverage priorities; isolated
assignee-label and coordinator-instruction display changes are not part of
the successful binary above.
