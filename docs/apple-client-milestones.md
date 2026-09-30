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
