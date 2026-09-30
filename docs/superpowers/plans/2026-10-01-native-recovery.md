# Native Recovery and Release Gates Implementation Plan

> **For agentic workers:** Use bounded parallel tasks and independent review. The root owns simulator execution and final integration.

**Goal:** Keep nonterminal approvals reachable, require explicit goal cancellation, and verify native task creation through approved execution, actual artifact preview and human acceptance against an authenticated server. Exercise real Mac installation and worker process ownership alongside operational recovery.

**Architecture:** Preserve server authority and the existing approval/goal state machines. Extend the native Inbox read model and cancellation UI, then add isolated production-API fixtures and XCUITest interactions with read-only server assertions. In parallel, fix the clean-checkout Mac packaging gate and exercise persistent backup/restore.

**Tech Stack:** SwiftUI, XCTest, Node 24, Fastify/PGlite, Playwright Electron, existing storage CLI.

## Global Constraints

- Native approval and cancellation commands must be performed through UI; API calls provide setup and independent verification only.
- Every E2E attempt retains a timestamped HTML report with reviewed actual screenshots and an accurate pass/fail result.
- Do not change or delete a user's app, database, browser or simulator state; use the task's isolated fixtures.
- Signing, physical devices and deployed services retain separate acceptance gates.

### Task 1: Native approval and cancellation recovery

**Files:** `apps/ios/Sources/ViewModels/ViewModels.swift`, `Views/InboxView.swift`, `Views/WorkspaceViews.swift`, and the corresponding `ViewModelsTests.swift` / `ApiClientTests.swift`.

- [x] Merge pending and needs-more-information approvals by ID, excluding superseded execution gates; retain risk grouping.
- [x] Add destructive cancellation confirmation with a Keep goal action that changes only presentation state.
- [x] Add regressions for reopening, final resolution, read failure, deduplication, failed cancellation and explicit retry.
- [x] Run `node apps/ios/scripts/test-macos.mjs` with the isolated simulator UDID; 82 XCTest passed.

### Task 2: Real UI evidence

**Files:** `scripts/ios-ui-workflows-fixture.mjs`, `scripts/ios-ui-e2e.mjs`, `apps/ios/scripts/test-macos.mjs`, `apps/ios/UITests/SharedServerChatUITests.swift`, `scripts/e2e-report.mjs`.

**Interfaces:** New fixture fields `approval_id`, `approval_summary`, `approval_task_id`, `cancellation_goal_id`, `cancellation_goal_title` pass through the matching `ARTOO_UI_*` runner environment variables. `verifyWorkflowResults` accepts `verifyNativeActions` for native-only assertions; the browser harness self-check does not claim native coverage.

- [x] Create a ready task and pending execution approval, plus an independent cancellable goal, using production authenticated APIs.
- [x] Use native UI to request information, leave/relaunch, find the retained approval, and approve it without executing the task automatically.
- [x] Use native UI to dismiss cancellation and verify no server change, then confirm and verify cancelled state.
- [x] Add only reviewed, named screenshots to the report allowlist; run the full native suite and inspect images.

### Task 3: Repeatability and operational recovery

**Files:** Mac packaging scripts and a new `scripts/recovery-e2e.mjs`.

- [x] Fix the observed hosted Mac failure from absent Electron distribution after clean `npm ci`; use official installation with checksum verification. Pushed as `5725204`; the next hosted Mac job passed.
- [x] Exercise production local storage stop/backup/verify/restore/restart with independent byte and data checks and browser screenshot evidence. Eight checks passed; pushed with the verified development signing gate in `d1df1e6`.
- [x] Update milestone documentation and prepare verified changes for the authorized milestone commit and push to main.

### Task 4: Full native task execution and Mac installer

**Files:** `scripts/fixtures/ios-ui-execution.mjs`, native fixture/UITest/report files, desktop distribution/DMG smoke scripts, worker shutdown and scheduler code/tests.

- [x] Add an independent paired executor using the real process adapter and artifact uploader. The fixture must not precreate the task or approval being tested.
- [x] Add native UI creation, criteria, Ready, approval request, Inbox decision, manual assignment, Quick Look body/filename and Accept actions; independently verify downloaded bytes, checksum, context/task/run binding and review audit.
- [x] Fix observed approval-form keyboard focus, preserve error drafts, and keep approval badges readable.
- [x] Correct Quick Look's observed navigation-bar locator; retain strict background-state confirmation with bounded Home retries and state diagnostics.
- [x] Preserve the native assignment sheet and selection after server rejection, prevent duplicate submission, and distinguish command acceptance from later refresh failure. All 85 XCTest passed after integration.
- [x] Add a real disconnected-node rejection and same-sheet retry to the full native execution scenario; keep task/run/approval assertions before and after retry.
- [x] Match the default simulator to the selected Xcode SDK, with an explicit-UDID override and nine pure selection regressions.
- [x] Reproduce and fix IPC-owner loss, daemon-group termination and CLI-exit orphan writers; 46 focused tests passed, including seven real POSIX process scenarios.
- [x] Reject fresh runtime status `missing` in automatic/manual scheduling while retaining the existing absent-row fallback. Fourteen scheduler regressions passed.
- [x] Build fresh preview DMG/ZIP commands with SHA manifests, read-only mount/install/detach checks, signed release preconditions, and bounded build diagnostics.
- [x] Run Mac distribution guardrails and real POSIX regressions in the hosted Mac gate before DMG E2E; retain reports/manifests/logs in CI.
- [x] Pass the complete six-scenario native gate and inspect its actual screenshots. Final report: `artifacts/ios/native-ui-2026-09-30T18-31-11-883Z.html`; all 85 XCTest and six UI cases passed.
- [x] Pass the rebuilt DMG installation/business/restart gate and inspect its actual screenshots. Final report: `apps/desktop/release/mac-dmg-smoke-artifacts/history/macos-dmg-2026-09-30T18-10-58-898Z.html`; all 11 client checks passed.

The first full native execution attempt exposed the approval keyboard issue;
the next reached and rendered the uploaded artifact but failed an incorrect
Quick Look title selector. Both failed HTML reports remain retained. The first
DMG attempt failed obtaining the official `dmgbuild` tool before app launch;
its report explicitly has no app screenshots. A separately downloaded official
GitHub release archive passed the published SHA-256 check before being placed
in electron-builder's supported archive cache; no extracted-tool completion
markers, mount checks or signing requirements were bypassed.

## Starting evidence

- Previous turn changed authoritative state: three verified commits pushed through `9f152fb`; this is progress, not a no-progress or blocked turn.
- Hosted Mac job `109987944468` failed on the missing Electron distribution. Shared and native jobs were still running at the first inspection of run `36744744299`.
- The isolated native recovery patch was re-read, applied to main, and passed `git diff --check`; its new XCTest and UI evidence remain to execute.
