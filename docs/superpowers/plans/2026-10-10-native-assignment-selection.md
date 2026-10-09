# Native assignment mode selection implementation plan

**Goal:** Exercise the real manual assignment control reliably and verify its selected state before searching for a specific execution instance.

**Evidence:** Candidate `ebef45d0fe2b9ab3b7d4b27a4cc1cd97aa772a35`, hosted run `37950454220`, passed all 171 native units (including the 12 snapshot cases), Core 7, assistant and mentions. Correction failed before its first execution at `task.assignment.instance`; retention was unstarted. The exact failure PNG and accessibility tree show Auto selected, Manual unselected and the worktree toggle on. The log records one Manual tap followed by fourteen scroll searches. That proves the expected mode was not retained at failure; it does not establish why the first tap did not produce a lasting selection.

**Architecture:** A small shared XCTest helper performs only the idempotent Manual selection. Check the unique segmented control and its two buttons, tap Manual, and wait for its public selected state. If Auto is still explicitly selected, allow one measured center tap of that same enabled, hittable, fully onscreen Manual button, then require the mode change. Do not search or submit while the mode is wrong.

**Files:** Add `apps/ios/UITests/NativeAssignmentInput.swift`; update the identical Manual-selection sequences in `ExecutionCorrectionUITests.swift` and `SuccessfulWorkspaceRetentionUITests.swift`. Product views, assignment requests, exact instance identity checks and Stop/retention assertions stay unchanged. The already passing Core scenario is not edited.

**Interface:** `NativeAssignmentInput.selectManual(in app: XCUIApplication) throws`. Its caller still reveals the actual Manual button first. The helper verifies foreground/Assign Task context and records action/state/geometry diagnostics without credentials.

- [x] Implement the bounded native action and selected-state verification; ambiguous controls, unavailable controls and persistent Auto remain failures.
- [x] Replace each existing `manual.tap()` with the shared helper, preserving the following actual picker/option interactions and all business assertions.
- [x] Compile the Release UI test target and run existing native suite/report contracts; preserve all unsuccessful checks separately.
- [ ] Push the new candidate normally and run the native correction/retention paths as part of the existing full hosted gate. Require actual correct instance selection, all four correction runs and Stop, plus the independent retention workflow.
- [ ] Download actual HTML/PNG results, correlate them with source and case identities, and only promote an honestly qualified milestone to main.

This is a test-interaction correction backed by an observed unselected mode. No API call, synthetic state write, relaxed selector or repeated assignment submission can substitute for the native action. Work proceeds inline under the user's existing authorization.

The generic-simulator Release UI build and 67 existing report/suite checks passed. The new Manual-selection interaction has not yet run in a native app; its measured retry and unchanged business flows require hosted qualification. The product app source remains unchanged.
