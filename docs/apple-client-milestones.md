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
