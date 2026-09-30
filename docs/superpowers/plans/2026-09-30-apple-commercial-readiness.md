# Apple Client Commercial Readiness Implementation Plan

> **For agentic workers:** Use parallel, bounded implementation tasks with independent review and validation. The requested execution skills are unavailable in this workspace; the current task uses the provided collaboration tools.

**Goal:** Establish repeatable Mac and iOS E2E evidence, close verified workflow and release gaps, and deliver tested milestones on main.

**Architecture:** Keep the native SwiftUI iOS app and the packaged Electron Mac workbench on the existing authenticated server. Exercise real client interfaces against disposable persistent servers, with deterministic CLI subprocesses for reproducible execution tests. Separately record provider, deployment, physical-device and distribution evidence.

**Tech Stack:** Node 24, TypeScript, Fastify/PGlite, React, Electron, Playwright, SwiftUI, XCTest, XcodeGen.

## Global Constraints

- Every E2E attempt must retain an HTML report with actual screenshots, source revision, environment, result and evidence scope, including failures.
- Commit and push coherent, verified milestones to main; never mark the commercial release complete on simulator or unsigned package evidence alone.
- Production clients use real authentication and server authority; fixtures must be explicitly labeled and disposable credentials excluded from reports.
- Preserve existing Windows behavior while adding Mac support.

### Task 1: Repeatable Apple E2E and visual reports

**Files:** `scripts/e2e-report.mjs`, `scripts/ios-ui-e2e.mjs`, `apps/ios/scripts/test-macos.mjs`, `apps/desktop/scripts/*e2e-smoke.mjs`, client package scripts, `scripts/preview-gate.mjs`, `.github/workflows/preview.yml`.

**Interfaces:** `writeE2EReport({outputPath,title,report,screenshots:[{path,caption}]})`; `npm run verify:mac`; existing `npm run verify:ios`.

- [x] Add a shared self-contained HTML report writer and escaping/status/image regression coverage.
- [x] Integrate native xcresult screenshots and browser screenshots without reusing stale images.
- [x] Adapt packaged desktop smoke to Mac: real .app assets/bridge, pairing, worker execution and restart, artifact download/review, session restoration and revocation.
- [x] Run Node 24 shared tests/build and native XCTest; execute each Apple E2E and inspect captured images.
- [x] Update CI artifact retention and save milestone evidence before commit/push.

### Task 2: Account-safe self-service pairing

**Files:** server request authorization/device service and regressions; `apps/desktop/desktop-controller.cjs`; `apps/web/src/components/DesktopSetup.tsx`, `SettingsPage.tsx`; `apps/ios/Sources/App/ArtooApp.swift`, `Views/TeamViews.swift`.

**Interfaces:** pairing creator is always the authenticated principal; claiming preserves that identity; compute enrollment requires administrator authorization.

- [x] Cover member pairing, preserved member identity, rejected administrator actions, organization isolation and owned-device revocation.
- [x] Permit members to pair their own control clients; retain administrator control of compute enrollment.
- [x] Keep desktop member pairing successful without unauthorized node enrollment.
- [x] Correct Mac platform instructions and direct every user to create their own pairing code.
- [x] Run relevant API/controller/client regressions, then Apple E2E.

### Task 3: Release metadata and remaining acceptance ledger

**Files:** `apps/ios/Resources/PrivacyInfo.xcprivacy`, Apple readiness documentation and CI evidence.

- [x] Declare the existing app-local UserDefaults draft use with reason CA92.1 and accurately describe server-transmitted user content.
- [x] Verify the manifest is valid and included in the built app.
- [x] Record unresolved external release requirements separately: actual deployed TLS/OAuth, real provider execution, physical devices, Apple distribution identity, notarization/TestFlight and operator-specific privacy/support information.
- [x] Prioritize the next bounded feature milestone from observed failures and uncovered existing workflows.

## Execution record

- Baseline `06276d6`; clean main matched origin/main at start.
- Local Xcode 26.5 and iOS 26.5 runtime available. Node 24.19.0 selected from the bundled runtime because the login shell defaults to Node 22.
- Current native suite already has three UI scenarios; historical planning documents understate implemented native features and cannot substitute for fresh evidence.

- Verification results, failed attempts and successful reruns are recorded in `docs/apple-client-milestones.md`. This plan completes the first functional baseline; the broader commercial-release goal remains active.
