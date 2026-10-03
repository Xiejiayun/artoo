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

The full iOS gate builds and runs unit tests, then runs separate core,
direct-agent, mentions, execution-correction and successful-work-retention UI
suites. Each uses its own fixture, XCTest selection and evidence directory.
To run one UI subset while diagnosing it:

```sh
npm run verify:ios:core
npm run verify:ios:assistant
npm run verify:ios:mentions
npm run verify:ios:correction
npm run verify:ios:retention
```

The complete native contract is 11 cases: seven core plus one each for
assistant, mentions, correction and retention, alongside the unit gate. A
terminal failed aggregate remains failed even when earlier suites passed.
Core and correction use 60/70/72 minute XCTest/parent/aggregate budgets;
assistant uses 25/35/37 minutes and mentions/retention use 20/30/32 minutes.
Exact workflow and case-inventory assertions still determine success.
Common XcodeGen preparation precedes the aggregate source fingerprint because
it can rewrite the tracked UI-test plist. Freeze external inventories after
generation too; retain original runtime evidence before later delivery cleanup.

Subset success does not certify the full gate. Keep source files, documentation
and Git state unchanged during each run: original source fingerprints are
checked after build, fixture cleanup and suite aggregation. The core fixture's
`node scripts/ios-ui-e2e.mjs --self-check` tests its browser/server harness
without native UI and cannot pass an iOS gate.
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
| Native suite aggregate | `artifacts/ios/native-suites-<timestamp>.html` | Exact selected case IDs, independent fixture results, original matching source and cleanup; combines the actual approved screenshots. |
| iOS core UI | `artifacts/ios/attempts/<timestamp>-core/native-ui-<timestamp>.html` | Real pairing, approval recovery across relaunch, explicit goal cancellation, daemon state, discussion/plan acceptance, cross-client threads, and native task creation through approved execution, uploaded artifact preview and human acceptance. |
| iOS direct-agent UI | `artifacts/ios/attempts/<timestamp>-assistant/native-assistant-<timestamp>.html` | Agent choice, offline waiting/relaunch/draft, automatic dispatch, explicit failed-request Retry, prior-answer context, linked run details and running-request Cancel. Read the actual result: failed attempts do not establish the whole scenario. |
| iOS mentions UI | `artifacts/ios/attempts/<timestamp>-mentions/native-mentions-<timestamp>.html` | Late-created project, two exact historical replies sent by an independent Web peer, device-scoped pre-handler 503, explicit read retry, unread sentinel and A/B drafts across project changes/relaunch. Nine native and two sender captures are required; implemented scope is not a claim of a successful run. |
| iOS execution correction | `artifacts/ios/attempts/<timestamp>-correction/native-correction-<timestamp>.html` | UI-created task, four approved isolated-worktree executions, two durable reviews, artifact provenance, retained success/failure/stopped work, Retry and exact-run Stop/Keep running. 21 named captures and independent process/file observations are required. |
| iOS successful-work retention | `artifacts/ios/attempts/<timestamp>-retention/native-retention-<timestamp>.html` | One approved execution with zero artifacts; exact workspace/branch Copy values and recovery after cold relaunch. Seven named captures and independent retained-file evidence are required. |
| Native UI runner | `artifacts/ios/attempts/<timestamp>-<suite>/ArtooUI-<timestamp>.html` | Xcode command results, exact selected-case contract and approved named XCTest screenshots. Earlier single-suite reports remain at the original top-level paths. |
| Browser and authentication | `apps/web/playwright-report/<suite>-<timestamp>/index.html` | Test results, deliberate workflow screenshots and browser/source metadata. |
| Local backup/restore | `artifacts/recovery/<timestamp>/report.html` | Production persistent server, real worker artifact upload, offline CLI backup/restore, credential continuity, exact bytes, idempotency and restored Web download. |

Mac and native reports embed screenshots so later attempts cannot replace
their evidence. Reports include the source commit, dirty-tree indicator,
tracked diff hash and untracked-source hash. A failed run remains failed;
checks completed before the failure remain visible. A failure before any UI
launch explicitly says that no screenshots or visual verification are available.

Raw XCTest bundles and automatic failure attachments remain in the local
`artifacts/ios` directory for diagnosis. They can contain disposable fixture
credentials and are not the shareable report. CI uploads HTML, summary JSON,
deliberate screenshots, test-result exports and correction evidence. Failed raw
XCTest bundles are a separate diagnostic artifact for trusted recipients under
the repository's artifact access rules. Public HTML accepts only reviewed
workflow screenshot names, excluding onboarding failure screenshots.
The assistant and mentions helpers also retain their newly named guarded
failure scene after checking that credential controls are absent. These
diagnostics never satisfy a required successful-workflow capture; legacy
unguarded and automatic failure images remain excluded.

The Mac harness owns its browser process. Cleanup waits for actual process
exit and Playwright profile cleanup, and records whether graceful or forced
closure was needed. Browser names are never used to terminate unrelated apps.
An incomplete cleanup prevents a passing result.

The direct-agent fixtures use three logical requests, four real CLI launches
and exactly two answers. The first request waits with no run while its worker
is offline, then dispatches automatically. The follow-up fails once and only
retries after the request's UI action; that distinct run reads the first
process's actual answer. A held fourth process is cancelled through the UI,
with its PID gone and no answer or redispatch. Server reads independently bind
turn, message, run, task, computer and instance identities. Context-file hashes
are captured before the next execution can overwrite the shared workspace.
Usage counters in these fixtures are synthetic and prove ingestion only.

The installed Mac task flow also checks pending, needs-information, rejected
and replacement execution approvals. Every decision and replacement comes
from the UI. Independent API reads verify that the task remains Ready with
zero runs until a user assigns it, and that the actual run consumes only the
approved current request. Screenshots show the disabled assignment explanation
and its enabled state after approval. Expired, previously consumed and malformed
approval snapshots additionally have focused component regressions.

The real POSIX worker tests compile their temporary child bundle directly from
the current daemon, domain and protocol sources. They require no existing
package `dist` directories; a clean-checkout regression verifies that this
gate cannot accidentally test stale shared code from a previous build.

The correction fixtures use four independent executions of one task. The first
produces an artifact; the second reads the actual requested changes, writes
files and fails; explicit Retry returns the task to Ready; a separately approved
third execution produces a new artifact. A second review leads to a held fourth
process. Keep running sends no cancellation; Stop targets that exact run and
retains written files. Read-only verification binds actual context packs,
approvals, artifact hashes, worktrees and process identities to each run. The
normal UI supplies no declared write paths, so this proves zero held leases,
not release of an acquired lease. Failed, cancelled, undelivered and materialized startup-failure isolated
worktrees are retained. Successfully delivered branch-backed worktrees are
also retained, including files absent from the artifact list; the separate
retention suite verifies the zero-artifact case after cold relaunch. Each correction execution uses a different instance/root, so this scenario
does not establish same-instance recovery or safe root reuse. Its forced-stop
path has no graceful-exit receipt: retained observations show the held PID absent
when the real cancel HTTP response finishes. Evidence copies are saved before
fixture teardown; they are not live worktrees retained after cleanup.

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

The member-device scenario provisions a separate member identity, pairs the
phone through native UI, and uses a separate owner Settings page to revoke that
exact phone. It verifies restricted device controls, forced disconnection,
disconnected relaunch and fresh member pairing. A fixture-only observer retains
the matching claim credential privately in memory, proves the same member and
device receive HTTP 200 before revocation and HTTP 401 afterward, then releases
it. The observer forwards the original HTTP bytes unchanged and exposes no
credential through its API or reports. Recovery messages must retain the
member actor, and sentinel device ownership/trust must remain unchanged.

The optional [Mac live-provider extension](mac-live-provider-verification.md)
requires explicit configuration and opt-in. A passing default smoke and a
failed missing-configuration check do not establish live model inference.

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


## Historical execution-correction environment and evidence

The current matching simulator is the task-owned iPhone 16 named
`iPhone Artoo Correction E2E 26.5`, UDID
`F5CC9868-D23E-424B-8ADA-A917EF84DDFD`, running iOS 26.5 with Xcode/SDK 26.5.
It was selected explicitly with `ARTOO_IOS_SIMULATOR_UDID`; earlier iOS 18.2 data
was preserved and diagnostics remain enabled. This local choice does not change
the gate's supported-runtime selection rule or prove physical-device coverage.

Final Mac evidence is
`apps/desktop/release/mac-dmg-smoke-artifacts/history/macos-dmg-2026-10-01T06-15-18-211Z.html`.
The earlier audited correction-only pass is
`artifacts/ios/native-suites-2026-10-01T10-34-07-147Z.html`.

Current full invocation 64710 has these independently audited closed results:

| Stage | Closed evidence |
| --- | --- |
| Unit | `artifacts/ios/Artoo-2026-10-01T13-08-32-909Z.html`: 144 unique passes. Original source metadata is retained, without a separate finish fingerprint. |
| Core | `artifacts/ios/attempts/2026-10-01T13-09-07-283Z-core/native-ui-2026-10-01T13-09-09-226Z.html`: seven cases, 1203.737 seconds, 24 inspected originals. |
| Assistant | `artifacts/ios/attempts/2026-10-01T13-09-07-283Z-assistant/native-assistant-2026-10-01T13-30-59-627Z.html`: one case, 639.622 seconds, seven inspected originals. |
| Mentions | `artifacts/ios/attempts/2026-10-01T13-09-07-283Z-mentions/native-mentions-2026-10-01T13-43-03-442Z.html`: one case, 608.657 seconds, eleven inspected originals. |
| Correction | `artifacts/ios/attempts/2026-10-01T13-09-07-283Z-correction/native-correction-2026-10-01T13-54-29-598Z.html`: one case, 1551.643 seconds, fifteen inspected originals. |
| Complete UI aggregate | `artifacts/ios/native-suites-2026-10-01T13-09-07-283Z.html`: all ten exact cases passed with 57 distinct, reviewed original images. |
| Matching development archive | `artifacts/ios-device/2026-10-01T14-24-42-929Z/report.html`: Release arm64 archive, strict signature/certificate/Team/profile and matching source verified. |

The completed full gate, all UI parent/child source boundaries and archive
before/after source agree with the verified `a255…` inventory. All 13 recorded
parent cleanup flags passed. Archive checks match all 704 repository entries,
65 iOS snapshot files and 39 product inputs. This is development-archive evidence,
with no physical-device UI or upload.

Independent audits are under `artifacts/preview-gate/execution-correction/`:
`native-full-prefocus-{unit,core,assistant,mentions}-audit/`,
`native-full-prefocus-correction-visual-audit/`, `native-full-prefocus-final-data-audit/`
and `archive-verification-2026-10-01T14-24-42-791173Z/verification.json`.
The [milestone ledger](apple-client-milestones.md) records hashes, source differences,
retained failures and six unresolved nonfatal frame warnings. After all Xcode work
ended, only the generated UI-test plist was restored; 703 other inventory entries
still match. Final documentation application, commit/main push and hosted acceptance
for the actual new commit remain pending.


## Current CI repair evidence, 2026-10-03

The [latest milestone](apple-client-milestones.md#2026-10-03-ci-portability-and-mac-dmg-verification-repairs)
records the failed hosted 3f run, local 83-case parser/protocol validation and the
new unsigned installed Mac run: 22 checks and 55 captures (54 unique PNG payloads). Its 1280×800 window produced
six single-frame planning captures. The oversized sequential branch has seven
browser-fixture scenarios/eight Node results and still needs hosted small-window
acceptance. The new native Core XCTest/parent/aggregate passed all seven cases
with 24 original photos, while its stricter external wrapper remains failed:
an owned Xcode helper required TERM/KILL before confirmed closure. The earlier
observer-timeout failure is also retained. No new full-all or archive pass is
claimed. Mac distribution now defaults to ten normal vendor detach attempts;
see [the exact policy](../apps/desktop/MAC-DISTRIBUTION.md#dmg-build-detach-policy).

On iOS failure, CI additionally retains exported attachment manifests, PNGs and
text diagnostics for seven days. These raw files may contain disposable fixture
credentials and are for trusted recipients; approved workflow HTML still uses
its existing screenshot allowlist. Preserve every failed HTML/JSON/xcresult.
