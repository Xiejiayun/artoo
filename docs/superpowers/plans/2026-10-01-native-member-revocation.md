# Native Member Revocation Implementation Plan

> **Execution:** Bounded parallel tasks with independent review; root owns integration, E2E verification and commits.

**Goal:** Verify that an owner can revoke a member's active iPhone from the real Web Settings UI, that the native client clears its connection across relaunch, and that a fresh member pairing restores access without administrator privileges.

**Architecture:** Extend the existing production-authenticated iOS fixture with a provisioned member, a member peer, and one unregistered member Mac. The member sends a readiness message through native UI; a separate owner browser page observes it and revokes only that phone through Settings. Native pairing, messages and relaunch remain UI operations; fixture APIs only prepare disposable resources or read evidence.

**Tech Stack:** SwiftUI, XCTest/XCUITest, Node.js 24, Playwright, existing production authentication and device APIs.

## Isolated implementation stage constraints

- Base commit: `85eb8cd`; branch: `user/jiaxie/native-member-revocation`.
- The implementation agent works only in `/Users/jeremy/workspace/artoo-native-member-revocation`; root subsequently integrates and verifies the patch in the primary workspace.
- No permission semantics, server-state shortcuts or Keychain reads. The fixture may observe only the exact member phone's production HTTP claim response and keep that issued credential in private memory for read-only session checks.
- The isolated implementation agent does not run Xcode, simulators, builds, commits or pushes, and does not use primary-workspace artifacts. These limits do not apply to root's authorized integration, full E2E verification, commits and pushes.
- Public HTML may include new native screenshots only after pairing inputs have been verified empty; do not publish an onboarding screenshot.

---

### Task 1: Member fixture and owner browser flow

**Files:** create `scripts/ios-ui-member-revocation.mjs`, `scripts/ios-ui-member-revocation.test.mjs`, `scripts/ios-ui-member-claim-observer.mjs`, and `scripts/ios-ui-member-claim-observer.test.mjs`; modify `scripts/ios-ui-e2e.mjs`.

**Interfaces:** `createMemberRevocationFixture({ request, memberSession, memberUserId, ownerDeviceId, suffix })` returns `{ fields, unchangedDevices }`; `findMemberMessage(messages, body, userId)` validates unique root-message attribution; `selectMemberDevice(devices, fields, name)` validates a unique member-owned iOS device; `verifyMemberRevocationResults({ fixture, unchangedDevices, request })` performs only reads and returns public metadata.

The fixture-only `observeMemberClaim(server, { origin, displayName, memberUserId })` returns `verifyActive(deviceId)`, `verifyRevoked(deviceId)` and `stop()`. It transparently observes bounded private copies of raw claim-response chunks. Before the owner UI action, the captured credential must identify the same member and device with HTTP 200. After the UI action, that same credential must receive HTTP 401. Tokens never enter fixture files, logs, attachments or HTML; public evidence contains only device ID and status codes.

- [x] Add focused pure Node tests for duplicate/wrong-owner devices, incorrectly attributed readiness messages, unchanged sentinels and changed identity after recovery.
- [x] Provision the member with `provisionUser` and `createSession`, then create peer/pending Mac with production pairing and claim routes.
- [x] Run the owner page concurrently with the existing browser/native flows; after the member readiness message, use `article → Revoke device → Confirm revoke` and require a successful response closing a live connection.
- [x] Verify the exact old native credential before and after owner revocation; reject mismatched identities, still-valid tokens, duplicate claims, redirects and observer invalidation during an in-flight check. Release private memory on completion, failure or stop.
- [x] Skip the member UI flow under `--self-check`; never count fixture checks as native UI verification.

### Task 2: Native member failure and recovery workflow

**Files:** modify `apps/ios/Sources/Views/TeamViews.swift`, `apps/ios/Sources/App/ArtooApp.swift`, `apps/ios/UITests/SharedServerChatUITests.swift`, and `apps/ios/scripts/test-macos.mjs`.

**Interfaces:** add fixture fields `member_user_id`, `member_name`, `member_peer_control_token`, `member_native_device_name`, `member_recovery_device_name`, `member_pending_mac_id`, `member_pending_mac_name`, `owner_device_id`, `member_revocation_ready_message`, `member_recovery_message`. Extend `pairNative(name:pairingToken:)` with an optional runner-only peer token.

- [x] Add stable device, status, revoke, enrollment-hint and connection-error identifiers without changing authorization checks.
- [x] Add `testMemberDeviceRevocationRequiresFreshPairingAfterRelaunch`: verify member controls including enabled own-device revocation, send readiness through native channel UI, wait for real owner revocation, verify disconnected state after relaunch and saved-connection retry, re-pair with a fresh member code, and send a recovery message attributed to the same member.
- [x] Before allowed member screenshots, check pairing inputs do not exist and the Devices pairing-code element does not exist; do not capture onboarding for the public report.
- [x] Independently read device ownership/trust and exact message attribution, without accessing the app's credential store.

### Task 3: Static delivery gate

**Files:** modify `scripts/e2e-report.mjs` and its tests for reviewed workflow screenshot names; add the fixture tests to `scripts/preview-gate.mjs`'s shared and iOS gates.

- [x] Run `node --test scripts/ios-ui-member-claim-observer.test.mjs scripts/ios-ui-member-revocation.test.mjs scripts/e2e-report.test.mjs` and `node --check` on changed JavaScript.
- [x] Run `swiftc -frontend -parse` on changed Swift sources and `git diff --check`.
- [x] Export a single base-relative patch and report pure checks separately from pending XCUITest/browser verification. Parent owns integration, full E2E, HTML results, commits and pushes.


## Delivery validation

- Node.js 24.19.0: `node --test scripts/ios-ui-member-claim-observer.test.mjs scripts/ios-ui-member-revocation.test.mjs scripts/e2e-report.test.mjs` passed 30 tests. Observer tests use a disposable built-in loopback HTTP server; they do not claim production auth or real UI execution.
- All changed JavaScript files passed `node --check`; shared/iOS preview gates include the new fixture integrity check.
- The three changed Swift files passed `swiftc -frontend -parse`; this does not establish Swift type checking or UI correctness.
- Full production fixture execution, Xcode/XCTest, simulator UI and screenshots remain for the parent's next milestone. No builds or simulator runs occurred in this worktree.
- A later test's native Sign out revokes only the control session (`/auth/logout`); final verification still strictly requires the newly paired device to be active with no `revoked_at` value.

## Parent integration evidence

- The integrated Pro gate passed 85 unit tests and all seven real native UI scenarios. Same-credential HTTP 200 → 401, owner Settings revocation and distinct member recovery identity were verified; approved native/browser captures were inspected and cleanup completed. Report: `artifacts/ios/native-ui-2026-09-30T19-28-39-263Z.html`.
- Both subsequent compact runs passed the member scenario. They retained their other failures: first a selectable-text activation-point error plus keyboard-obscured controls; then the new text helper's premature viewport assertion during proposal navigation. The second compact run passed all keyboard workflows, full task/artifact review and six of seven UI cases.
- Root added focus-aware Done actions to task creation, task approval/review and conversation input. The selective text helper preserves server-content checks and keeps actual controls on strict hittability. Final compact rerun and matching signed archive are tracked in `docs/apple-client-milestones.md`; the earlier Pro result does not certify later product binaries.
- Final compact `verify:ios` passed all 85 unit and seven Release UI cases, zero failures/skips. Report: `artifacts/ios/native-ui-2026-09-30T20-25-32-344Z.html`; 21 captures inspected, exact old credential rejected after revocation, distinct recovered identity and complete cleanup. The matching development-signed arm64 archive passed at `artifacts/ios-device/2026-09-30T20-40-52-918Z/report.html` without device installation or upload.
