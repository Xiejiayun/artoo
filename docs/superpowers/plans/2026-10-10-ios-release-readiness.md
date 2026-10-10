# iOS Release Readiness Implementation Plan

> Execute inline in this thread. The user authorized implementation, verification and milestone commits/pushes to main. Preserve the entire release objective across milestones.

**Goal:** Resolve the observed iOS failures and qualify the actual shipping build for distribution and App Store submission.

**Architecture:** Preserve the native SwiftUI app, authenticated team server and existing independent execution assertions. Use current-source native E2E, a distribution-signed device archive, App Store Connect validation and physical-device evidence as separate gates. Publisher policy and review access must describe the real service.

**Tech Stack:** SwiftUI, XCTest, Xcode 26 or later / iOS SDK 26 or later, XcodeGen, Node 24, GitHub Actions and Apple distribution signing.

## Global Constraints

- Baseline main: `4882c155b423aeaeb0b73253653ca4119e7f0d7e`.
- Every client E2E attempt retains HTML, actual available photographs and explicit failure/cleanup/source boundaries.
- Do not reduce the eleven-case UI contract, weaken business assertions, substitute mocks for provider acceptance or infer device acceptance from a simulator.
- Keep the six unrelated untracked files, original stash and unrelated PureRun processes/devices intact.
- Do not invent operator identity, policy addresses, retention promises, review credentials or App Store registration.
- Use normal pushes. Complete required verification before promoting a milestone. Compilation, upload and review approval are distinct results.

## Task 1: Recover and resolve the current failure

**Files:** `apps/ios/UITests/SharedServerChatUITests.swift`, `apps/ios/UITests/NativeAssignmentInput.swift`; product `TaskDetailView.swift` only if original evidence establishes a product defect.

- [ ] Recover run `37964647342`, job `113935837869` logs, JSON and original photos; verify published archive hashes and produce an HTML review. The failed case is `testTaskExecutionApprovalArtifactPreviewAndAcceptance`; identify the exact missing control before editing.
- [ ] If the evidence shows Auto still selected after tapping Manual, use the existing `NativeAssignmentInput.selectManual(in: app)` before the instance picker. Preserve exact instance collision, offline rejection, approval and artifact acceptance assertions.
- [ ] Run `node --test scripts/e2e-report.test.mjs apps/ios/scripts/ui-suite-contract.test.mjs scripts/ios-ui-suite-evidence.test.mjs` and a semantic UI build. Run all native suites against the repaired source and inspect its reports/photos.

## Task 2: Qualify the release toolchain

**Files:** `.github/workflows/preview.yml`, iOS release documentation and toolchain guard script if shared by local distribution builds.

- [ ] Select an installed stable Xcode 26 or later for the iOS CI job, verify its device and simulator SDK versions, and retain the exact selection in CI output. The hosted job owns its runner's selection; do not change the local Mac's global Xcode selection.
- [ ] Confirm the entire native gate on that toolchain; retain failures separately from old Xcode 16.4 results.
- [ ] Commit and normally push the verified repair/toolchain milestone; inspect the exact published commit's CI.

## Task 3: Distribution archive and export

**Files:** `apps/ios/scripts/archive-device.mjs`, a separate `apps/ios/scripts/archive-distribution.mjs` with selection/export tests, `package.json`, `docs/apple-development-archive.md` and release documentation.

- [ ] Reuse development archive verification patterns without relabeling a development build as distribution. Require an explicit team and exact application ID, a valid distribution signing identity/profile, version/build metadata and SDK 26+.
- [ ] Verify the signed arm64 archive and exported IPA: code signature, team/application identity, compiled assets/privacy manifest and `get-task-allow` false. Reject development, ad hoc and enterprise profiles for App Store export.
- [ ] Validate App Store Connect registration and upload access, create a concrete distribution build, upload for TestFlight and retain processing/validation results. No success claim before the service confirms it.

## Task 4: Publisher privacy and review access

**Files:** `apps/ios/Sources/Views/PrivacyView.swift`, release metadata/configuration, related model tests and publisher documentation.

- [ ] Obtain the real publisher name/contact, policy/support HTTPS addresses and public-vs-private/free-vs-paid distribution decision. Questions were sent on 2026-10-10; unanswered facts remain open.
- [ ] Add accessible policy/support links in onboarding and connected settings, validated against release configuration. Verify URLs and actual policy coverage of identifiers, messages, agents/providers, retention, deletion and backups.
- [ ] Reconcile privacy manifest and App Store labels with the real service; implement any necessary account-deletion or provider-consent flow for the chosen model.
- [ ] Prepare shipping-build screenshots, description, age rating, export compliance answers and reviewer instructions using a reachable server and review account. Never store credentials in source or public reports.

## Task 5: Device and release acceptance

- [ ] Add `ReleaseReadinessUITests.testPublisherPolicyAndSupportBeforePairing` as a separate release UI check. Use fresh, owned iPhone/iPad simulators; open the native privacy page and actual public policy/support websites, retain XCTest PNGs and HTML, and remove only simulators created by this check. This supplements the eleven business cases and cannot replace physical-device/TestFlight acceptance.
- [ ] Run the distribution build on supported iPhone/iPad sizes through pairing, real-provider execution, approval, artifacts, cancellation/recovery and privacy links. Retain an HTML/photo report for each attempt and distinguish simulator from physical hardware.
- [ ] Verify the deployed HTTPS/authentication service and review environment, including recovery and relevant server/worker release requirements.
- [ ] Perform TestFlight internal testing and resolve observed regressions before public submission. Track Apple processing/review separately from local checks.
- [ ] Audit every preceding requirement against the actual candidate. Keep the overall goal active until release readiness is established; external unknowns cannot be replaced with passing fixture tests.
