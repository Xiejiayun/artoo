# Installed Mac planning fixture implementation plan

> **For agentic workers:** Implement the bounded tasks below in this isolated worktree. The parent owns integration and the actual installed-app E2E run.

**Goal:** Extend the Mac packaged smoke with UI-created, process-backed planning and exact coordinator-instruction disclosure before human plan acceptance.

**Architecture:** Keep the existing artifact CLI branch and Windows smoke intact. A Mac-only fixture emits Codex JSONL from the real worker's context pack; a UI helper registers participants, creates the goal, reviews instructions and accepts the proposal. Read-only API/receipt checks bind all three turns to the installed computer, original messages and accepted tasks. Captures register immediately in the enclosing immutable HTML report.

**Tech Stack:** Node 24, Playwright Electron, production Artoo server/worker, existing HTML writer.

## Global constraints

- Base `c7aacc2`; no commits, pushes, build, package, Xcode or E2E in this worktree.
- Root supplies the separate planning-instruction-summary product patch.
- No edits to existing iOS scripts or fixtures; no API-created tested messages, discussions, runs or plans.
- Keep approval, artifacts, restart, sign-out, cleanup and real-provider opt-in behavior.

### Task 1: CLI and evidence checks

Files: `apps/desktop/scripts/mac-planning-fixture.mjs`, `mac-planning-fixture.test.mjs`.

- [x] Implement `runMacPlanningFixture({ contextPath, configurationPath, emit })`, validating read-only policy, project/room/participants and exact earlier answers before JSONL emission.
- [x] Record private turn/context receipts outside the workspace, with PID and identity/hash fields only.
- [x] Implement `verifyMacPlanningTurns(...)` to reject incorrect run owners, missing replies, incorrect coordinator metadata, missing context or invented usage.
- [x] Exercise planner/reviewer/synthesis and mutated negative fixtures with `node --test apps/desktop/scripts/mac-planning-fixture.test.mjs`.

### Task 2: Installed UI flow and smoke integration

Files: `apps/desktop/scripts/installed-mac-planning.mjs`, `packaged-e2e-smoke.mjs`.

- [x] Register two Codex instances through Computers UI in an independent workspace; create a goal and start one discussion round through Goals UI.
- [x] Read the resulting discussion/turns/messages/runs/usage and bind them to actual subprocess receipts.
- [x] Require three collapsed Planning instruction regions, expand each exact original coordinator message and collapse it; inspect the suggested plan and its original reply.
- [x] Verify no goal tasks before proposal/acceptance; use the UI for both actions, then verify two tasks and the blocks dependency.
- [x] Register real screenshots as they are captured, and embed the helper evidence object in the parent report before any failure can occur.
- [x] Preserve the original artifact fixture branch, add only a Mac conversation branch and Mac helper invocation before optional live-provider verification.

### Task 3: Delivery

- [x] Run focused Node 24 tests, syntax checks and `git diff --check`; no actual E2E claim.
- [x] Export the complete patch relative to `c7aacc2` plus a SHA-256 delivery record.
- [x] Parent applies product+test patches together and runs the real installed Mac E2E, retaining HTML and screenshots for success or failure.

## Delivery validation

Implemented tasks 1 and 2. Node 24.19.0 passed all 15 focused tests, including
actual temporary CLI subprocesses, receipt tampering rejection, and execution
of the embedded Mac/Windows CLI source expressions. Node syntax checks and
`git diff --check` passed. No installed-app run, build or package was started.

The Mac flow requires the separate product change that renders coordinator
messages as `Planning instruction` regions with `Show agent instructions`.
Without that change the UI assertion intentionally fails. It never changes
messages through the API to make the display test pass.

The enclosing report retains `macPlanning` checks/receipts and four actual
captures as they complete. A later failure keeps earlier captures; parent
sign-out and cleanup still determine the overall smoke result. The fixture
reports synthetic counters for ingestion verification; it measures no provider
usage or billing.

## Root integration result

Full `verify:mac` passed at `2026-09-30T21:33:48.067Z`: 13 installed-client
checks, 10 inspected screenshots, three subprocess contributions and complete
cleanup. The helper explicitly starts the restored worker through Settings
before planning. Earlier packaging and stopped-worker failures are retained
with their own HTML reports in the milestone ledger. This remains deterministic
preview evidence; real-provider and signed-release gates are separate.

The final refinement directly verifies the three AssistantTurns visible titles
and accessible names, and adds a fifth planning capture. The fresh DMG run at
`2026-09-30T22:02:26.613Z` passed all 13 checks with 11 inspected images and
complete cleanup, using a supported temporary detach-retry override after
two pre-launch default-builder failures. See the milestone ledger for the
exact retry conditions, failed reports and the remaining packaging limitation.
