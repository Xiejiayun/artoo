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

## Readable assignment and planning, 2026-10-01

Native assignment now presents the agent, computer, runtime and exact workspace
path. Visually colliding choices additionally show their full instance IDs;
selection and execution still use the original IDs. Coordinator instructions
receive a short summary and an explicit original-text disclosure on both
clients. Recognition requires the exact system actor and valid discussion,
turn and step metadata. The Web request list uses the same strict display
helper. Stored messages and the context received by agents are unchanged.
Seventy-one related Web component tests and Web typechecking passed.

The first new Mac attempt failed during DMG creation when the builder could
not detach disk16 (`Resource busy`), before client launch. Its HTML contains
no client photos. A subsequent read-only `hdiutil info` showed no disk16; the
outer cleanup flag alone does not establish cleanup of a builder-owned mount.
The second attempt completed eleven existing checks, then exposed a missing
test precondition: after the restart check, the worker was stopped. Planning
waited with zero contributions. Its seven real captures and all six cleanup
flags are retained. The new flow now starts the worker through Settings and
verifies the exact paired computer is connected and advertising Codex before
starting planning. That failure's log also exposed a duplicate full prompt in
the Web request list; the shared display helper fixes that presentation.

| Retained Mac attempt | Result | HTML SHA-256 |
| --- | --- | --- |
| `apps/desktop/release/mac-dmg-smoke-artifacts/history/macos-dmg-2026-09-30T21-12-30-046Z.html` | Packaging failed before launch, no photos | `16d8fb64c0f425848e7ece386995c18dd3ced568152dec025e521fc2dda43d52` |
| `apps/desktop/release/mac-dmg-smoke-artifacts/history/macos-dmg-2026-09-30T21-18-30-755Z.html` | Eleven checks passed; planning failed; seven photos | `25681eaec7ec322fb303df82a5025a6a561ff91b01aabfb9e854838cc8b67fe9` |
| `apps/desktop/release/mac-dmg-smoke-artifacts/history/macos-dmg-2026-09-30T21-33-48-067Z.html` | All thirteen installed-client checks passed; ten photos | `4f5dfd4ae969c6564cee93af6187c382e1d34c091fe23350f8ff58f28af4bb26` |

The successful full `verify:mac` invocation built a fresh x64 DMG/ZIP, installed
from the hashed read-only image and detached it before launch. In addition to
the existing task, approval, artifact and restart workflows, the installed UI
selected two planning instances, started a discussion, and obtained three
answers through the bundled worker and actual deterministic subprocesses.
Private receipts establish exact turn/run/instance identity and prior-answer
context. All three original instructions expanded and collapsed without text
changes. No plan or task existed before proposal; only UI acceptance created
two tasks with the reviewed criteria and dependency. Usage counters are
explicitly synthetic and establish ingestion only, not provider billing.

All ten embedded images were inspected, including the four new planning
captures at full size. The final image shows the accepted plan; exact created
tasks and their dependency are verified by read-only server records. All six
cleanup checks passed. The gate also passed 15 planning-fixture, 11 provider
entry/report, 46 worker and eight distribution regressions. The optional tiny
filesystem fixture mount test was skipped; the actual product DMG was mounted
and exercised. The report records `c7aacc2` plus the dirty source hashes, not
a clean hosted verification of a later commit.

Hosted run `36774913543` at clean `c7aacc2` finished with shared and Mac success
and iOS failure. Its 85 native unit tests and Release UI build passed, but no
UI case started. The logs point to a parent readiness GET timing out during
Xcode startup; parent cleanup then interrupted Xcode. The exact environmental
reason for that timeout is unestablished. The parent failed HTML is retained at
`artifacts/apple-ci/36774913543/ios/native-ui-2026-09-30T20-51-58-612Z.html`
(SHA-256 `d21a61a1dd8966197178ca821dfd33c5200baad1b6b9f398ebec67fcb20614e2`).
It contains one actual browser capture and complete parent cleanup. The child
UI report's unfinished `Running` label is stale evidence, not a live run or a
passed UI suite. The harness now preconnects a separate owner Web page before
Xcode starts, waits for the exact native readiness message through realtime UI,
then performs the unchanged strict device and credential revocation checks.
Fresh local and hosted validation of that change are recorded separately.

The integrated native gate then passed from `2026-09-30T21:37:39.852Z` to
`21:53:26.343Z` on iPhone 16 / iOS 18.2. The retained xcresult summaries
confirm 100 unit and all seven Release UI cases passed, with no failures,
skips or expected failures. Exact UI method IDs were also independently
checked against the seven-case core contract. Twenty-two native screenshots
and two browser screenshots were inspected; the new original-instruction,
collapsed-summary, colliding-executor and preserved-selection images were
reviewed at full size.

The native driver verified all three coordinator messages' identity, intent,
step and turn linkage, and compared the expanded synthesis instruction's
exact UTF-8 body and hash before collapsing it again. Two otherwise identical
executor choices displayed distinct full IDs simultaneously; after an actual
offline refusal and recovery, the real run retained the originally selected
instance. The preconnected owner page successfully observed the member
readiness message and completed real Settings revocation, same-credential
200 → 401 verification and fresh member pairing. Both parent cleanup checks
passed. This validates the revised harness locally; hosted validation of the
new source remains separate from the earlier failed `c7aacc2` run.

Native HTML:
`artifacts/ios/native-ui-2026-09-30T21-37-39-852Z.html`
(SHA-256 `47133bdb6e39af2e0ae0572373f97cdbd6656393fc4351dcd4aeb6ec9708106c`).
The unit and UI bundles are `artifacts/ios/Artoo-1790804213922.xcresult` and
`artifacts/ios/ArtooUI-1790804342446.xcresult`. No native product source was
changed during this run or before the matching development archive.

The matching signed Release arm64 development archive passed at
`2026-09-30T21:53:41.133Z`, including certificate/profile/Team, embedded app
identity, compiled assets and privacy manifest verification:
`artifacts/ios-device/2026-09-30T21-53-41-133Z/report.html`
(SHA-256 `e47ee560ca8926e1e150b51bcdb811712a7bd125b9298e8275cb328d5d9af28e`).
This is build/signature evidence only; no physical-device installation,
distribution export or upload was performed.

A final Mac assertion refinement checks the installed request list's three
short visible titles and exact accessible names, with an additional real
request-list capture. Its first fresh-DMG attempt again failed before launch
with the builder's `disk16 Resource busy` detach error. Read-only mount
inventory afterward contained neither disk16 nor an Artoo image; no force
detach or unrelated disk operation was performed. This attempt contains zero
client captures and is retained at
`apps/desktop/release/mac-dmg-smoke-artifacts/history/macos-dmg-2026-09-30T21-56-00-672Z.html`
(SHA-256 `ffd78cbb3dfdd779ad1b2f11ea106030bd12118391736d5f8ea6ae00f9aabcea`).
The specific cause of the intermittent builder failure remains unestablished;
its outer cleanup flags alone do not prove the builder's mount lifecycle.
The immediate retry also failed at that same pre-launch boundary, again with
no matching mounted image afterward:
`apps/desktop/release/mac-dmg-smoke-artifacts/history/macos-dmg-2026-09-30T21-57-46-466Z.html`
(SHA-256 `4fa95f3cadfef2e27219be8ea8e2bd6cf7e6347b093b57e4c63b8c7ffab7775f`).
Vendor inspection confirms that its five normal-detach retries are followed
by a forced-detach attempt and an error even if that final cleanup succeeds.
This explains why a failed build can leave no mounted disk without proving
what held the volume busy. No client behavior was exercised in either attempt.

One bounded experiment used the installed tool's supported
`CUSTOM_DMGBUILD_PATH` override and `--detach-retries 10`, with no vendor or
system modification. Its maximum retry sleep budget is about 170 seconds
instead of the default 19.8 seconds, plus `hdiutil` execution time. The vendor
binary and temporary wrapper hashes are recorded in
`artifacts/preview-gate/dmg-diagnostics/experiment.json`; the distribution
build log confirms that the override was used. This invocation successfully
built and installed a new DMG and passed all 13 client checks, including the
three request titles and accessible names. All 11 embedded client captures
were inspected, and all six cleanup checks passed.

Final refined Mac HTML:
`apps/desktop/release/mac-dmg-smoke-artifacts/history/macos-dmg-2026-09-30T22-02-26-613Z.html`
(SHA-256 `882347882dfed80415df755f32dcde6c3e2e68287f45754158127f17a714d9f6`).
It ran from `22:02:26.613Z` to `22:04:35.899Z`. The successful override is a
reproducible mitigation experiment, not proof of the cause or a permanent fix
for default-builder reliability. The earlier full Mac gate passed without
this override on the same product source; only the later UI assertions and
capture were added. A clean hosted run of the committed source remains a
separate check.

Hosted run `36783627020` at `d61af1e53f8fdb8eea0087482531ce32e2d67b92`
subsequently completed successfully: iOS, Mac and shared gates passed; the
optional Windows desktop job was skipped. Completed iOS logs independently
contain 100 distinct passing unit cases and all seven passing UI methods,
with zero failures. The native parent retains 24 captures; Mac retains eleven
and recovery two. All 37 images were inspected, with no functional visual
blocker. Some broad browser/task captures do not show the entire message or
Done header within the crop; the exact assertions and other retained captures
remain separate evidence rather than being inferred from those crops.

The hosted Mac built fresh arm64 preview DMG/ZIP artifacts, installed the
hashed read-only image, detached before launch, passed 13 installed checks
and the eight-check recovery drill, and completed cleanup. Its workflow uses
the default unsigned-preview configuration, with no package reuse or local
detach-retry wrapper. This is an additional successful default-builder run;
it does not establish the cause of the earlier local intermittent failures.

Byte-identical self-contained report copies and their original downloaded
artifacts are retained under `artifacts/apple-ci/36783627020/`:

| Hosted report | HTML SHA-256 |
| --- | --- |
| `native-core.html` | `edee16feb66aa682002681e09f5f65d738ff59db7622735298a06fa71dbccd75` |
| `mac-arm64.html` | `b08de1fb53fa49c3a86a764944735e3b80ade244bbdaade473a0d6da6d62303b` |
| `recovery-arm64.html` | `dd17772d757da8ae835e91e258ef13b38f05270b53a5859d6360279ea4a26d2e` |

Both artifact ZIP hashes match GitHub's published digests. The detailed
verification record is `verification-summary.json` with `SHA256SUMS` and
`verification-notes.md`. Unit, Mac and recovery report clean `d61af1e`;
the UI report records that commit with tracked worktree hash
`61717b07761f860b4d2e2d918a2d13b4d502100b6ccf1d10e611bb95c2c8c377`
after the build's generated configuration. The hosted upload does not include
original xcresult bundles or DMG/ZIP binaries; case counts are corroborated
by the completed job logs, while distribution checksums come from its manifest
and installation report. These results certify the preceding milestone, not
the following uncommitted direct-agent changes.

## Direct-agent workflow verification attempts

The first independent assistant run built the Release app and successfully
selected the original of two identically named instances through its complete
identity. It then failed before reaching the waiting-state UI assertion: the
test waited for an offscreen lazy List row before attempting to scroll. The
retained connected-page screenshot also exposed repeated selected-agent
details occupying most of the viewport. No waiting/retry/cancellation success
is inferred from this attempt. Its single approved screenshot, failure result,
unchanged source fingerprint and complete fixture/process-group cleanup are
retained in
`artifacts/ios/attempts/2026-09-30T22-36-40-402Z-assistant/native-assistant-2026-09-30T22-36-41-255Z.html`
(SHA-256 `9948b3d02d863162c9887f1c21f50f3b86b7d04cf3955b2a76ebf4f781b16fb8`).
The aggregate is `artifacts/ios/native-suites-2026-09-30T22-36-40-402Z.html`;
the same attempt's `failure-review/report.html` contains the inspected
credential-free failure screen. The waiting helper and duplicate selected
display are being corrected before a new isolated run.

The second assistant attempt verified the compact selection UI, waiting-state
visibility, relaunch with an unsent draft, automatic worker recovery and the
real failed follow-up followed by explicit Retry. It then failed an overly
strict screenshot condition requiring both answers to fit in one phone
viewport. The actual feed includes intervening run events; its retained image
and accessibility frames show the first answer and later event rows, rather
than both answers at once. The test now scrolls to and compares each answer's
exact visible text separately and retains two answer captures. No product
messages or run events were removed to satisfy the test.

Second failed HTML, with three approved captures, stable source and complete
cleanup:
`artifacts/ios/attempts/2026-09-30T22-50-40-153Z-assistant/native-assistant-2026-09-30T22-50-41-007Z.html`
(SHA-256 `d1b8cfd8e682d0da40278e6f9fb636cb4e73de906bce6b98e8994bf8c692b1c2`).
Its aggregate is `artifacts/ios/native-suites-2026-09-30T22-50-40-153Z.html`.
Cancellation was not reached, so this is not a passed direct-agent scenario.

The third attempt separately verified and captured both exact answer bodies,
then started the real held process and opened its linked task in Running state.
It failed when waiting for that task's fourth run row before scrolling to it.
The retained task image and accessibility hierarchy show the first older run
at the lower viewport edge and the held run further down. The test is being
corrected to reveal the exact full-ID row before checking uniqueness and
tapping it; linked-run identity and UI cancellation remain required.

Third failed HTML, with five approved captures, stable source and complete
cleanup:
`artifacts/ios/attempts/2026-09-30T23-00-39-043Z-assistant/native-assistant-2026-09-30T23-00-39-944Z.html`
(SHA-256 `fdb41c5b4785e2e1093fb52c22ac5f886f1dd9114a4db2a06f030c2ca4e5ecfb`).
Its aggregate is `artifacts/ios/native-suites-2026-09-30T23-00-39-043Z.html`.
The held process was stopped during cleanup, not through the unexecuted UI
Cancel action; no cancellation success is claimed for this attempt.

The fourth attempt reached and tapped the exact, uniquely identified Running
run row. Its expected Run Summary did not appear; the retained failure image
shows the linked Task back at its top. Native navigation and refresh behavior
are being investigated before another attempt. All five earlier captures,
the stable source fingerprint and complete cleanup are retained:
`artifacts/ios/attempts/2026-09-30T23-15-51-454Z-assistant/native-assistant-2026-09-30T23-15-52-418Z.html`
(SHA-256 `eaae8776a4f3fa266c1ac2eef57d57cc966511b2f9f1cc09cd1075243dd405ea`).
The aggregate is `artifacts/ios/native-suites-2026-09-30T23-15-51-454Z.html`.
Its `failure-review/report.html` includes the inspected credential-free screen
and explicitly represents review of that original failure, not a new E2E.
UI cancellation remains unverified. Review of recording frames at 292–299
seconds confirms the correct running row followed by a new Task loading page
and a return to the task header. The Task's run link now directly constructs
`RunSummaryView`, matching the run-history entry, instead of mixing a local
value destination with the surrounding view-based navigation. The exact
Run Summary and cancellation assertions remain unchanged; this correction
still needs a fresh run to establish its effect.

The fifth independent assistant attempt passed after that navigation change.
Its one exact Release UI case and production-record verifier confirm three
logical requests, four distinct real CLI processes/runs, two context-linked
answers, explicit failed-request Retry, the exact linked Run Summary, and
UI cancellation with no remaining owned PID or redispatch. The failed and
cancelled states were each observed unchanged for at least 3.1 seconds.
Relaunch preserved the selected same-name instance and unsent draft. All seven
approved captures were inspected, including full-size run identity/cancelled
screens; all source and cleanup checks passed.

Assistant subset HTML:
`artifacts/ios/attempts/2026-09-30T23-32-23-707Z-assistant/native-assistant-2026-09-30T23-32-24-426Z.html`
(SHA-256 `96ef1a62141176d32f168eb1c0f8c524e0debe41e386943ac3865b012165a2b3`).
Its exact-case aggregate is
`artifacts/ios/native-suites-2026-09-30T23-32-23-707Z.html`.
This subset does not replace the pending full native or installed-Mac gate.
Long-request disclosure remains model-test/review evidence because these
three UI requests do not trigger that disclosure. Deterministic subprocesses
and synthetic usage counters do not establish model quality or provider cost.

The first installed-Mac direct-agent gate passed all 14 functional checks,
including the shared exact-record/context verifier and four terminated CLI
PIDs. Its source fingerprint stayed unchanged and all seven cleanup flags
passed. Fifteen images were reviewed in
`apps/desktop/release/mac-dmg-smoke-artifacts/history/macos-dmg-2026-09-30T23-41-23-104Z.html`
(SHA-256 `57eb843d7833132caba427027e944d951d573fd5d413d54b54749d920e21b99f`).
The run used the supported local `dmgbuild --detach-retries 10` wrapper.
Visual review found that the long message-list screenshot shows the first
answer and intervening events, while its scroll container clips the second
answer. Both bodies were checked against server records, but that image does
not show both replies. The helper is being refined to reveal and capture each
complete answer separately before a fresh installed run; the original report
is retained unchanged.

## 2026-10-01: direct-agent recovery and native run navigation

The completed local milestone adds readable native request summaries with
exact original-text disclosure, a compact agent-selection entry with full
identity details in its destination, and a fix for opening Run Summary from a
conversation's linked task. The latter replaces mixed value/view navigation
with the existing direct destination pattern. Request identity, original
content and existing run events are preserved.

Both clients now exercise three logical direct-agent requests through four
real CLI launches: offline waiting and automatic recovery, a failed follow-up
and explicit Retry using the first actual answer, then a held process stopped
by UI Cancel. Read-only verification binds all task/turn/message/run/computer/
instance identities and four independently captured context-file hashes.
Native relaunch additionally preserves the chosen colliding instance and an
unsent draft. These are deterministic subprocess fixtures, with synthetic
usage measurements and no inference-quality or real-provider-cost claim.

| Final local gate | Verified result |
| --- | --- |
| Mac | The full gate passed its fixture/provider/planning/distribution tests and 46 worker regressions. After the screenshot-only refinement and 17 focused tests, a fresh DMG repeated all 14 installed-client checks with 16 inspected captures. Both complete answer rows are pictured separately. All seven cleanup flags and the final source comparison passed. |
| iOS unit | 110 distinct XCTest cases passed, zero failed/skipped/duplicates, independently counted from the original xcresult. |
| iOS Release UI | Exact seven-case core and one-case assistant suites passed; eight total, zero failed/skipped/expected failures/unknown results. The aggregate retains all 31 inspected captures. All fixture and owned process-group cleanup passed. |
| Source consistency | Unit, core, assistant, aggregate, final Mac and development archive preserve the same original source fingerprint. Source remained frozen during the runs. Only evidence documentation and restoration of the generated UI-test plist followed verification. |
| Signed development archive | Release arm64 archive passed certificate, Team, embedded profile, asset and privacy-manifest verification. All 35 native source/resource files byte-match its isolated snapshot. No physical-device run, distribution export or upload was performed. |

Final immutable evidence:

| Report | HTML SHA-256 |
| --- | --- |
| `artifacts/ios/native-suites-2026-09-30T23-52-07-720Z.html` | `243700951d00b1a4015eac54d1058cbd93cc91d3e3a454c9f1c1798b4bf5c3c9` |
| `artifacts/ios/attempts/2026-09-30T23-52-07-720Z-core/native-ui-2026-09-30T23-52-09-386Z.html` | `2f0d4680763dab2e81cac4748bdb3c94ad9c69fcab659f55db519fd019eb64c3` |
| `artifacts/ios/attempts/2026-09-30T23-52-07-720Z-assistant/native-assistant-2026-10-01T00-05-31-912Z.html` | `ce63ab055c6a679cf69f6b858cbb94979d92d6783c3209cc82a88b611743a06d` |
| `apps/desktop/release/mac-dmg-smoke-artifacts/history/macos-dmg-2026-09-30T23-47-31-330Z.html` | `e60a977d088d721484e798490c01dfbb907998aaa8f4915d12901e20a707c585` |
| `artifacts/ios-device/2026-10-01T00-14-24-654Z/report.html` | `80fc98f11f319ee958d1204bf1405afb45be826c1075e2eaef7e677ad863f835` |

Both local Mac attempts used the previously documented supported detach-retry
wrapper. The final package was freshly built and installed; this does not
establish default packaging reliability or Developer ID trust. Hosted results
for the newly committed milestone remain a separate gate.

The core visual-review notes retain specific boundaries: its broad browser
capture does not show the individual thread replies, the expanded instruction
capture contains only the upper part of the original, and executor options
abbreviate their paths (the selected-instance capture shows the full path).
The suggested-plan title is slightly cropped at the top; its tasks, criteria
and dependency remain visible. Three non-failing frame-dimension warnings are
also retained. These limits are not expanded into unobserved visual claims.

The report infrastructure now verifies exact XCTest case identities, preserved
source boundaries, bounded owned-process-group cleanup and complete static PNG
pixel streams. PNG checks cover framing, CRC, decompression and scanline shape,
not colour/palette semantics. Interrupted or incomplete evidence cannot pass
the aggregate. Failed attempts remain independently available above.

The next confirmed product gap is native mention navigation to a project
created after pairing: cached bootstrap can leave the global project selector
on the previous project. An isolated fix has focused tests and review but is
not included in this milestone; real native/installed-Mac mention workflows
remain the next validation stage. Commercial release gates in the readiness
document remain open.

Hosted follow-up for `81c27deb17cb255085178efcbbd89661d515c57c`, run
`36795780467`, completed with Mac and shared success but iOS failure. The iOS
logs contain 110 distinct passing unit tests and all seven passing core UI
cases. The independent assistant case failed its full-text visibility check
after sending the second request; it had not reached the failed-request Retry
assertion. This was not a core failure or a workflow timeout.

The retained three artifact ZIPs match GitHub's published digests. Actual
image coverage is 44 unique inspected captures: 24 from core (22 native and
two browser), two earlier assistant captures, 16 installed-Mac captures and
two recovery captures. No xcresult, attachment directory, failure screenshot
or failure hierarchy was uploaded for the assistant failure. The logs locate
the failed assertion, but do not prove whether its immediate cause was product
behavior or test navigation. Original artifacts and independent audit notes
remain under `artifacts/apple-ci/36795780467/`.

Independent source review confirmed that the short request body is also the
request-card title, making the test's first exact-label match ambiguous during
lazy-list scrolling. The current follow-up strengthens that test to obtain
the real persisted user-message ID, reveal `message.<id>` and compare it with
the subsequent turn's `userMessageId`. Its original visibility, Retry and
Cancel requirements remain. New explicitly guarded failure-caption names
retain a screenshot only when known credential controls are absent; legacy
and automatic failure captures remain excluded. These changes still require
fresh local and hosted results and do not retroactively make run `36795780467`
successful.

## Cross-project mention verification attempts

The first native mention subset built the Release client and paired the phone,
then failed before publication of project B. The actual captured More screen
shows project A (`artoo`) correctly selected. Its accessibility tree represents
the Picker as a button labeled `Project, artoo`, with a selected `artoo` child
and no value property. The test had incorrectly required `value == artoo`.
Only that assertion is being corrected to accept the exact full label or exact
value, preserving the complete name, visibility and original timeout.

The failed report contains the inspected credential-excluded failure scene:
`artifacts/ios/attempts/2026-10-01T01-07-33-023Z-mentions/native-mentions-2026-10-01T01-07-34-503Z.html`
(SHA-256 `330832f180747e6c6d6257f3f0178d8af529fa5d0c16fc56d3b2da117caef561`).
Source remained stable; all four fixture/process/browser cleanup flags passed.
The publication stage remained Waiting for recipient readiness, so this
attempt establishes no historical-mention or read-retry success.

The second subset passed initial selection and typed draft A, then its
publication control returned 500 while capturing the first independent sender
message. All four cleanup flags and the source boundary passed. The original
report is
`artifacts/ios/attempts/2026-10-01T01-15-36-370Z-mentions/native-mentions-2026-10-01T01-15-37-719Z.html`
(SHA-256 `0ee60865ad8b54e340b458a571313005a7b221a1aadb0224a8e6003b8cb06734`).
It does not establish recipient mention or Retry coverage.

A separate real-Web sender self-check reproduced the publication failure:
the padded list item had viewport ratio 0.9975903630256653 while the assertion
required 1. Its failure picture shows the complete body, sender and mention.
The fixture now closes the people chooser through UI and checks the full body,
sender and mention individually at ratio 1 before capturing their article.
The repeated self-check passed and both actual sender images were inspected;
all four cleanup checks passed. This is fixture-only evidence with an
API-paired observer, not native or installed-Mac recipient coverage.

| Sender self-check | Report | HTML SHA-256 |
| --- | --- | --- |
| Failed original | `artifacts/preview-gate/mentions-debug/2026-10-01T01-23-30-072Z/report.html` | `50f4b59dfb2dd211b6dd0f7b2234ac94b6ae7c6f9e849b6ce3caeb74d41f95d0` |
| Passed after capture correction | `artifacts/preview-gate/mentions-debug/2026-10-01T01-29-54-221Z/report.html` | `a21bf99b89f3556960fd928b5c2821f9c1ef312748bd7fddb92bc8ed7ec6ffab` |

The third native subset reached both historical targets, the actual 503 and
explicit Retry, unread counts 3 → 2 → 1 and selected project B. Returning to A
then failed a test assumption that the Channels tab must show its inventory.
The guarded failure frame instead shows the correct retained A thread and
complete unsent A draft. The helper now permits that retained stack, while
still requiring the exact A root ID and full body. This attempt does not prove
the later relaunch assertion or final independent verifier. Its ten embedded
images (eight native, including the diagnostic, and two sender) were reviewed;
all four cleanup flags and source consistency passed.

Report:
`artifacts/ios/attempts/2026-10-01T01-31-07-827Z-mentions/native-mentions-2026-10-01T01-31-09-232Z.html`
(SHA-256 `abc6bd73e3a247675766e55ecd8851dd332152de52eb12b1e706ce5052bc4839`).

The first Mac mentions gate passed 46 worker regressions and reached the new
scenario after successful task, planning and direct-agent checks. Project B,
the full historical target and the injected read failure rendered correctly,
but the sender still appeared as its internal ID. Its guarded failure image
and accessibility output confirm the stale member cache. Refreshing members
only when recovering an unknown project misses a project already loaded by a
separate bootstrap query. The fix moves that refresh to each newly verified
room navigation. A regression first reproduced the missing sender name; the
corrected focused suite passes all 28 tests and Web typechecking. Fresh UI
verification is still required. All seven cleanup flags and source consistency
passed in the failed Mac attempt.

Mac report:
`apps/desktop/release/mac-dmg-smoke-artifacts/history/macos-dmg-2026-10-01T01-33-23-097Z.html`
(SHA-256 `7c9e15e507e05a6778ace35556a6824e09942bdde1b57df3827aa392e949896c`).
Its failure screenshot was inspected at full size; the 20-image contact sheet
is retained under `artifacts/preview-gate/mac-mentions-attempt1-review/`.

Independent review also found that a delayed workspace Refresh could overwrite
a newer mention's authorized project list and selection within the same
session. AppContainer now orders accepted bootstrap outcomes and mention
selections, including cache hits. Old successes and failures cannot replace
newer accepted state; cancelled, unpublished mentions do not invalidate a
useful pending refresh. A still-visible superseded mention offers its existing
explicit open Retry. Eleven added regressions exercise these interleavings
against the actual production AppContainer in an isolated Swift package:
30 focused tests reproduced six failing methods before the change and all
30 passed afterward. Full Xcode and native UI verification remains pending.

The fourth native subset compiled the new Release source, then failed while
typing draft B before read Retry. Its guarded screenshot and hierarchy show
the composer at y738.7–781 behind the persistent bottom error/Retry area;
XCTest nevertheless reported it hittable. The tap established no keyboard
focus. The helper now requires the entire composer inside the unobscured List
viewport and a keyboard after tapping, and uses that same visibility check
for draft captures. This keeps the original read failure and draft assertions.
All four cleanup flags and source consistency passed in the failed attempt:
`artifacts/ios/attempts/2026-10-01T01-49-23-101Z-mentions/native-mentions-2026-10-01T01-49-24-592Z.html`
(SHA-256 `9cf4e9407e3599cc9b0315c0730605c9b87f677909ac5a9a996cb958f9d81bdf`).

The second Mac attempt failed before app launch: even the supported ten-retry
wrapper ended with `dmgbuild`'s Resource busy detach error. It completed all
six applicable cleanup checks, retained stable source and left no Artoo image
mounted. It contains no client screenshots because installation never began:
`apps/desktop/release/mac-dmg-smoke-artifacts/history/macos-dmg-2026-10-01T01-50-22-084Z.html`
(SHA-256 `ddaa7467e7b890def452153a053323db9c5693b72dbcd13276979d1cbf3c5967`).
The next packaging attempt will observe only its own temporary image and
device to identify the blocking process; the packaging issue remains open.

The fifth native subset exposed an error in that helper change: reading the
composer's `identifier` before its lazy row exists causes XCTest's snapshot
lookup to fail. It stopped before draft B and read Retry. The two composer
call sites now explicitly request an unobscured List viewport, so the helper
can scroll using existence checks before reading any element property. This
retains full visibility and keyboard-focus requirements. Source was stable
and all four cleanup flags passed in the preserved failed report:
`artifacts/ios/attempts/2026-10-01T01-58-38-747Z-mentions/native-mentions-2026-10-01T01-58-40-025Z.html`
(SHA-256 `da2c8f2cf5686982b0a45d2a3366275554523fe1acd713a2e8d70341fbe17d15`).

The third Mac gate passed all 15 installed-client checks, including the full
mentions verifier, and all seven cleanup checks with unchanged source:
`apps/desktop/release/mac-dmg-smoke-artifacts/history/macos-dmg-2026-10-01T02-02-55-201Z.html`
(SHA-256 `8e5a4e2fe6853dcbfbe3358ec17cd947e25b2b467f23d2ceacc12ab4a5687b8d`).
Its 26 captures are under independent visual review. The supported detach
wrapper was still used. A read-only watcher observed this attempt's writable
and final read-only images attach and detach; it found no confirmed cause for
the earlier intermittent busy error. Normal backing-image and installation
reader file descriptors are not evidence of the earlier failure's cause.
After this Mac gate, only native UI-test helper and evidence documentation
changes are planned before complete native verification; preserved per-file
hashes will identify any additional differences.

## 2026-10-01: verified cross-project historical mentions

Native mention navigation now resolves an authorized project before exposing
the conversation or acknowledging the notification. Accepted bootstrap
responses and project selections prevent older same-session responses from
replacing newer state, while a failed opening retains explicit Retry. Web/Mac
uses the actual room's project and an account-matched bootstrap response;
entering a verified room refreshes member names independently of the project
cache. Existing thread drafts remain scoped to their actual conversations.

Both clients now complete the independent-sender scenario: project B is
created after recipient readiness, two real Web UI mentions are pushed beyond
the latest 50 replies by 55 ordinary messages, and the full first body exceeds
the notification preview. One exact recipient-device read is rejected before
the production handler with 503. The failed state remains unchanged for at
least 3.1 seconds before UI Retry, then unread changes 3 → 2 → 1 while A's
sentinel remains unread. A/B drafts survive project changes and native
relaunch or installed-renderer reload, and neither becomes a server message.

| Final local verification | Result |
| --- | --- |
| Mac | Full gate passed, including 46 worker regressions and 15 installed-client checks. Fresh DMG/ZIP and copied installed bytes were verified; all seven cleanup checks passed. All 26 capture entries were inspected (25 unique images; two captions show the same read-failure screen). |
| iOS unit | 133 unique Debug XCTest cases passed; zero failed, skipped, expected failures or unknown results, independently counted from the original xcresult. |
| iOS Release UI | Exact core 7 + assistant 1 + mentions 1 cases passed. All fixture checks, source boundaries and owned-process cleanup passed. The aggregate contains 42 unique inspected images: 24 core, 7 assistant and 11 mentions. |
| Signed development archive | Release arm64 archive passed certificate, Team, embedded profile, executable, asset and privacy checks; independent strict code-signature verification passed. All 35 product source/resource files byte-match the isolated snapshot. No physical-device UI, distribution export or upload occurred. |

The corrected assistant test also passed in the complete native gate. It uses
the exact persisted user-message ID and verifies each turn references that
message; the original full-text, failure Retry, context-linked answers and
running-process Cancel assertions remain. This local result does not change
the earlier failed hosted run `36795780467`; new hosted acceptance is pending
the milestone push.

| Immutable report | HTML SHA-256 |
| --- | --- |
| `artifacts/ios/native-suites-2026-10-01T02-28-26-800Z.html` | `addf7164f527453874221466599d4779581178fbadccaccc1a7e183af2692292` |
| `artifacts/ios/Artoo-2026-10-01T02-26-09-120Z.html` | `9d8e05ee0be906326cd2051112320e2a3f3b4105bd348c370916fa6bda0dcb45` |
| `apps/desktop/release/mac-dmg-smoke-artifacts/history/macos-dmg-2026-10-01T02-02-55-201Z.html` | `8e5a4e2fe6853dcbfbe3358ec17cd947e25b2b467f23d2ceacc12ab4a5687b8d` |
| `artifacts/ios-device/2026-10-01T03-08-18-923Z/report.html` | `c552e7fc33c7e7ffc2d220c0ea017038abaf8d8b4aad551bec0bd3438d60d381` |

The earlier successful mentions-only report is also retained at
`artifacts/ios/attempts/2026-10-01T02-09-28-715Z-mentions/native-mentions-2026-10-01T02-09-29-952Z.html`
(SHA-256 `e76ef1f5e122f8c0d98ff73d8f6001e8e8cc79c3a1b292c9832ed0c0f6ad6b1d`).
It was followed by the complete gate above; no subset substitutes for a full
result. Every failed attempt remains independently documented and retained.

Source stayed frozen through each test and the archive. The complete native
UI suites, unit report's original source and archive share one fingerprint.
The unit runner retains its original metadata in HTML, without a separate
original JSON or finish fingerprint; independent exports confirm its cases.
Between the final Mac run and complete native verification, exactly four
native test-helper lines and milestone documentation changed. A 678-file
inventory proves all other 676 entries,
including every product file, remained byte-identical. The two overall source
fingerprints therefore differ and are not represented as equal. The generated
UI-test plist was restored only after all Xcode work ended; final evidence
documentation followed verification. Detailed comparisons and the aggregate
image mapping are in `artifacts/preview-gate/mentions-final-source-boundary/`.

Known limits remain explicit. Raw xcresults contain non-failing SwiftUI frame
dimension warnings; inspected photos show no associated blocking layout issue.
The long expanded planning instruction exceeds a single screenshot, the broad
browser sync image does not show its individual reply bodies, and the native
Done page still shows an internal assignee ID. The Mac report retains the first
two raw read attempts; its final verifier checks subsequent request identities
but reports their count rather than retaining every later raw record. The
final Mac run used the supported local detach-retry wrapper, and intermittent
packaging reliability remains unproven. Model execution is deterministic; the real-provider,
physical-device, trusted distribution, deployed identity and operator-policy
requirements in the release-readiness document remain open.

The next implementation stage is task correction and safe stopping: durable
review feedback, delivery of that feedback to later execution, readable artifact
versions, confirmation bound to the actual run, and preservation of work after
failure/cancellation. Isolated fixes have focused tests but are not included in
this mentions milestone and have no new client E2E acceptance yet.

## 2026-10-01: durable correction feedback and safe stopping

Validation was recorded against base
`e2f25ce2978da27b8e5ae98923056ad6abec30fc` plus the recorded working-tree changes.
The owning commit packages these validated changes. Reviews retain their original
comments, actor IDs, event times and the artifact inventory recorded at the
review decision. Current account names are display metadata; missing legacy
attribution remains unknown. Task state, related records and the version cursor
are read in one consistent transaction. Web and native clients preserve rejected
or conflicting drafts, submit the loaded version, and require explicit
resubmission after a conflict. Later ordinary executions receive the real
requested-change comments in their context.

Artifact cards identify the actual filename, originating run and creation time.
Stop binds confirmation to the captured run and provides an explicit Keep
running choice. Native Stop and goal cancellation use alerts so both choices
remain present. Both clients expose a default-off isolated Git worktree option.
Failed, cancelled, undelivered and materialized startup-failure work retain their
files. **Successfully delivered worktrees are still deleted.** Preserving or
explicitly transferring every successful implementation change is a remaining
product requirement, and the isolated next-stage implementation is unapplied.

| Completed verification | Actual result and scope |
| --- | --- |
| Shared and focused tests | Final shared Vitest rerun: 1,329 passed, 23 skipped, zero failures; its preceding run retained one editor timing failure. Typecheck and preview build passed. Web correction 58/58, real-process protocol 17/17, report/suite contracts 52/52 and Mac template regressions 32/32 retain their own source/time boundaries. |
| Installed Mac, attempt 5 | All 21 checks passed after the Review history layout fix. The report retains 38 caption entries/37 unique images, independently reviewed process/file evidence, stable source and all nine cleanup checks. |
| Earlier correction-only subset, session 87248 | Exact correction case passed in 1603.578 seconds on iPhone 16 / iOS 26.5. All 15 unique original captures were inspected; independent retained-data audit passed 181/181. Source and all three cleanup checks passed. |
| Current full 64710, units | Exactly 144 unique cases passed with zero failures, skips or expected failures; independently audited from the closed raw summary/tree. The report retains original source metadata but no separate finish fingerprint. |
| Current full 64710, core | All seven exact cases passed; case durations total 1203.737 seconds. All 24 originals (22 native and two browser) were inspected, with 17 retained-workflow cross-checks. Source and all three cleanup checks passed. |
| Current full 64710, assistant | Exact case passed in 639.622 seconds. Seven unique originals and 19 retained-workflow cross-checks were audited. Three logical turns, four real runs/launches, two answers and zero live owned processes were recorded; failure/cancellation stayed stable for 3289/3123 ms. Source and all three cleanup checks passed. |
| Current full 64710, mentions | Exact case passed in 608.657 seconds. All eleven unique originals (nine native and two peers) were inspected; 98 data/byte/contract checks passed. Read failure persisted for 3272 ms; exact historical targets and separate unsent A/B drafts agree. Source and all four cleanup checks passed. |
| Current full 64710, correction | Exact case passed in 1551.643 seconds with 15 individually inspected unique originals. Image provenance passed 238 checks; the independent data audit passed 27 correction-record and 54 raw/per-attempt comparisons. Four runs/launches/approvals, two reviews/artifacts, two retained failed/stopped worktrees and zero live owned processes reconcile. Source and all three cleanup checks passed. |
| Complete current native gate | **PASSED.** The invocation completed 144 unit tests and all ten exact Release UI cases (core 7, assistant 1, mentions 1, correction 1), with no failures/skips/expected failures/unknowns or missing/duplicate cases. All 57 distinct aggregate images were individually reviewed through the suite audits; aggregate bytes, links and captions match. All 13 recorded parent cleanup flags and all source checks passed. |
| Matching development archive | **PASSED.** Signed Release arm64 iPhoneOS archive passed strict signature, certificate/Team/profile and source checks. All 704 repository entries, 65 iOS snapshot files and 39 product inputs match before/after archive and its isolated snapshot. No physical-device UI or upload occurred. |

The correction scenario uses one UI-created task, four separately approved
executions, two durable reviews and two immutable artifacts. The failed second
execution and stopped fourth execution preserve modified/new files. Retry only
returns the task to Ready; it neither starts a process nor overwrites the retained
root. Each execution uses a different pre-provisioned instance/worktree, so
same-instance recovery and repeat execution are not established.

In current full 64710, Keep running preserved the same held PID with zero cancel
requests or new launches across an 18.470832961-second observation gap. Nineteen
run-output events advanced the cursor while the task/run/approval/review/artifact
records stayed unchanged. One Stop addressed the captured run; its PID was absent
when the actual cancel HTTP response completed. This does not establish PID exit
before the canonical cancellation event. Stopped and stopped-stable evidence
remained identical across 3.380175036 seconds. This forced-stop path has no
graceful-exit receipt. The scenario declared no write leases: zero held leases
is verified, but acquired-lease release is not exercised. Evidence copies preserve
the failed/stopped bytes before fixture cleanup; they are not live worktrees left
behind after teardown.

Every earlier failed report remains failed. The retained history includes four
original correction attempts (three failed and one passed), five Mac attempts,
four failed full native attempts, the post-touch-fix crash, six failed
matched-runtime correction attempts and the assistant-only pre-focus failure.
The successful fourth original correction subset predates the final native alert and helper changes. The detailed
[attempt history](apple-execution-correction-attempts.md) retains outcomes and
immutable report hashes, including both recent assistant failures.

The core timeout was increased only in three native harness files: 30 minutes
for XCTest execution, 40 for its parent and 42 for aggregation. The later assistant
helper change aligns the composer before focus and after keyboard appearance,
using measured navigation/tab/toolbar bounds. Original recordings and accessibility
geometry justify the composer bounds; the timeout change follows the actual
20-minute harness cutoff. Select All/Delete/type and business assertions remain
intact. These changes do not retrospectively pass failed attempts.

The verified 704-file inventory is
`artifacts/preview-gate/execution-correction/final-source-boundary/matched-runtime-assistant-prefocus-source-files.json`
(SHA-256 `a25550606a631879944e45f8a1a6309826cfabae15997857ea57f800d93c0376`).
Against the final Mac inventory, two native product views, four UI-test files and
three native harness files differ; the other 695 entries, including Mac product
inputs, are byte-identical. The completed full native gate and matching archive
share this recorded source boundary; earlier correction 87248 and core 55771
retain their own older inventories. Mac and final native whole-tree fingerprints
are not equal. Archive verification is retained in
`artifacts/preview-gate/execution-correction/archive-verification-2026-10-01T14-24-42-791173Z/verification.json`.

| Principal immutable report | HTML SHA-256 |
| --- | --- |
| `apps/desktop/release/mac-dmg-smoke-artifacts/history/macos-dmg-2026-10-01T06-15-18-211Z.html` | `51b78f38146be595dab80f5b466c8c2bcb25d5ae0e30e5ec93dd56249ba918d3` |
| `artifacts/ios/native-suites-2026-10-01T10-34-07-147Z.html` | `6a9b5fc8cf9094b04bc027c3185ab53d1f6b75fcabd6573e8e0dcf9868faa62f` |
| `artifacts/ios/Artoo-2026-10-01T13-08-32-909Z.html` | `50ec272433cf4c2eac1c0a0c40674032d5aec46a8b0d95cac12a7b0eec2b6ebd` |
| `artifacts/ios/attempts/2026-10-01T13-09-07-283Z-core/native-ui-2026-10-01T13-09-09-226Z.html` | `18ef8657d8fa53b3cc01007e2055ac9cdcbd4b6b73573b1a0a6b611fb4765ac6` |
| `artifacts/ios/attempts/2026-10-01T13-09-07-283Z-assistant/native-assistant-2026-10-01T13-30-59-627Z.html` | `e40ae9ac2f9571163add7ac00d7c00b0876456948343bde7453fd231e0284289` |
| `artifacts/ios/attempts/2026-10-01T13-09-07-283Z-mentions/native-mentions-2026-10-01T13-43-03-442Z.html` | `7f6154ff8e1e6c402f3b58033fbd2855f18783e12de28a93364ed838288d4154` |
| `artifacts/ios/native-suites-2026-10-01T13-09-07-283Z.html` | `8cdd0d92ea850eab0ca6e94db93ba06f4ea8e264da2cc30ed62a31daf8cdc20e` |
| `artifacts/ios-device/2026-10-01T14-24-42-929Z/report.html` | `9a27d603e88d602c48986ab6cd35f2578b6e55c98c97717dbeba4ca78f5a929a` |

Current full 64710 retains six nonfatal frame-dimension warnings: three in core
and one each in assistant, mentions and correction. Earlier warnings remain in
their original reports. No cause or fix is claimed.
Inspected viewports have documented scroll/chrome limits; screenshots do not
independently establish process or server state. These deterministic local-process
results do not establish live-provider quality, physical-device/TestFlight
acceptance, Developer ID/notarization/trusted updates, deployed TLS/Google OAuth,
operator policy or multi-connection PostgreSQL acceptance.

The closed unit report from current session 64710 independently contains exactly
144 unique passed cases, with zero failures, skips or expected failures. Its
original source metadata is retained, but it has no separate finish fingerprint.
The completed suite/aggregate source guards and archive before/after comparisons
retain the matching boundary. Current audit directories under the execution-correction
evidence directory are `native-full-prefocus-{unit,core,assistant,mentions}-audit/`,
`native-full-prefocus-correction-visual-audit/` and
`native-full-prefocus-final-data-audit/`. The final data audit maps all ten case IDs
and 57 images; its 5,098 protected originals remained unchanged.

After all native and archive work finished, the generated
`apps/ios/Configuration/UITests-Info.plist` was restored. At that boundary the
other 703 entries matched. Applying the final five existing documentation updates
and the new attempt-history companion leaves all implementation and test sources
unchanged; the final comparison records 698 matching original inventory entries.
See `artifacts/preview-gate/execution-correction/delivery-source-reconciliation.json`.
This milestone packages the validated implementation and its delivery documents.
Exact-commit hosted acceptance is tracked separately and is not claimed here.
Earlier hosted run `36810183573` remains failed.

## 2026-10-03: successful-work retention and recovery locally verified

Branch-backed executions now preserve their complete owned worktree after
success, including partial-artifact and zero-artifact runs. Reserved worker-owned
`run.workspace.retained` events supply durable run/computer/root/branch/outcome
and reported time; clients show exact Copy controls after cold reload/relaunch.
The displayed report does not assert current disk availability. Ordinary workspace
semantics remain unchanged, and no automatic destructive cleanup is added.

The current native and archive proof share source26's complete **795-file** frozen
inventory, SHA-256 `23014e90ef6983160770aeef8742c4e864a3a8bb049fe9d1fd286f8de4e45b90`.

| Local verification | Result and evidence boundary |
| --- | --- |
| Fresh source26 native units | **159 passed**, zero failed/skipped; 13 independent console/HTML-metadata checks. This is a closed-console inventory, without a new raw xcresult inventory export. [Unit audit](/Users/jeremy/workspace/artoo-retention-verification/artifacts/preview-gate/retention-main/focused-client-validation-20261003T041156Z/native-units-independent-data-audit/README.md). |
| Genuine source26 native `--suite=all` | **11/11 raw cases passed**: core 7, assistant 1, mentions 1, correction 1, retention 1. The independent aggregate audit passed **44/44**, with 94 original and 39 derived inputs unchanged. [Aggregate audit](/Users/jeremy/workspace/artoo-retention-verification/artifacts/preview-gate/retention-main/native-all-20261003T043953Z/all-independent-data-audit/README.md). |
| Correction and zero-artifact recovery | Correction **89/89** data checks, four retained worktrees/18 files, two reviews/artifacts and one exact Stop; Retention **35/35**, one retained worktree/four files and zero artifacts/reviews after cold relaunch. Fresh visual/data correlations passed **10/10** and **6/6**. [Correction](/Users/jeremy/workspace/artoo-retention-verification/artifacts/preview-gate/retention-main/native-all-20261003T043953Z/correction-independent-data-audit/README.md), [Retention](/Users/jeremy/workspace/artoo-retention-verification/artifacts/preview-gate/retention-main/native-all-20261003T043953Z/retention-independent-data-audit/README.md). |
| Current original-image and HTML audit | **71 individually inspected originals** (67 native + four browser); aggregate **71/71** image/link/caption/alt instances, each original once; **138/138** across ten parent/native reports, **209/209** total across eleven original runtime HTML reports. All 125 cross-suite inputs remained unchanged. Correction's **21** and Retention's **7** original photos were individually inspected. [Full-all visual audit](/Users/jeremy/workspace/artoo-retention-verification/artifacts/preview-gate/retention-main/native-all-20261003T043953Z/all-independent-visual-audit/index.html). |
| Historical installed Mac, source10 | **22 checks**, **55 original captures**, **22 exact UI Copy values** and **14 cleanup flags** passed for the unsigned x64 DMG/ZIP and installed worker. [Retained audit](/Users/jeremy/workspace/artoo/artifacts/preview-gate/retention-main/mac-dmg-20261002T120910Z/independent-data-audit/audit.json). |
| Historical shared regression, source13 | **1,537 passed, 30 skipped**, zero failed; typecheck exited 0. [Shared receipt](/Users/jeremy/workspace/artoo-retention-verification/artifacts/preview-gate/retention-main/sequential-validation-20261002T132809Z/vitest-result.json), [typecheck](/Users/jeremy/workspace/artoo-retention-verification/artifacts/preview-gate/retention-main/sequential-validation-20261002T132809Z/typecheck-result.json). |
| Matching development archive | Release arm64 iPhoneOS archive passed strict signature, Team/certificate/profile and source checks: **795 repository / 84 iOS inventory / 72 snapshot / 41 product inputs**. No physical-device UI or upload occurred. [Verification](/Users/jeremy/workspace/artoo-retention-verification/artifacts/preview-gate/retention-main/archive-verification/runs/20261003T072402.909117Z-557f855c/verification.json), [HTML](/Users/jeremy/workspace/artoo-retention-verification/artifacts/ios-device/2026-10-03T07-24-07-927Z/report.html). |

Actual aggregate HTML SHA-256 is
`e2d5c2acfadefa9bd0bb3d56f6542d3bfc758ca948246eaf3e4930950cc6cfdb`.
Archive verification SHA-256 is
`b948f59bc0450764563271edf1665ce329ea87e779de0215b183dc150cf88a3a`;
archive HTML SHA-256 is
`187fa70d0297f6ab67515fb5304135efd40c001fdc91603e0757d26a52bf49ec`.
The [source26 reuse addendum](/Users/jeremy/workspace/artoo-retention-verification/artifacts/preview-gate/retention-main/source26-reuse-addendum/README.md)
matches **554** Desktop/Web/worker/server/package component paths to the prior
applicability review. It supports the historical Mac/shared results with their
original limits; it is neither a fresh source26 run nor compiled-binary equality.

All **11** nonfatal frame-dimension warnings remain recorded. The archive retains
`All interface orientations must be supported unless the app requires full screen.`
and the skipped AppIntents metadata-extraction warning. No cause or fix is inferred.
The [source24 timeout](/Users/jeremy/workspace/artoo-retention-verification/artifacts/preview-gate/retention-main/native-all-20261003T020718Z/core-independent-data-audit/README.md)
and [source25 Assistant failure](/Users/jeremy/workspace/artoo-retention-verification/artifacts/preview-gate/retention-main/native-all-20261003T025859Z/assistant-independent-data-audit/README.md)
remain failed; earlier attempts stay in the [retained local evidence](/Users/jeremy/workspace/artoo-retention-verification/artifacts/preview-gate/retention-main/).
Focused passes do not replace any of this invocation's eleven cases.

Safe repeated execution still needs administrator-approved per-run allocation and
an explicit continuation policy; a fresh run does not silently resume earlier
uncommitted work. Receiver, WebSocket, allocation and UI-heading candidates remain
unapplied and commercially unqualified. Native UI gaps, live-provider quality,
physical devices/TestFlight, trusted Mac distribution/updates, deployed identity,
operator policy and deployment recovery remain [release gates](apple-release-readiness.md).
Final source/generated-plist reconciliation, commit/push and exact-new-commit
hosted CI are tracked separately from this local verification.
