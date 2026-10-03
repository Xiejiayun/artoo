# Successful execution work retention and recovery

Base delivery: `56f5a37ea00de1c535ecd4650353ba3eb310fb08`, pushed to main with a clean working tree. Previous milestone passed installed Mac (21 checks, 38 captures), local iOS (144 unit tests and ten exact UI cases, 57 captures), and a matching development-signed archive. Hosted run `36880563455` has Mac success but cancelled shared/iOS jobs; their recorded cancellation was caused by the newer main concurrency request and does not count as acceptance. The parallel trusted-proxy fix `ef4a8fd40ea21f7f693a4df028de9e0d846dc249` was subsequently integrated by fast-forward with local retention edits preserved; its replacement hosted run is `36881187470`.

Local retention implementation and verification are complete at source26. The
[current milestone](../../apple-client-milestones.md#2026-10-03-successful-work-retention-and-recovery-locally-verified) records
159 fresh native unit passes, all eleven actual UI cases, the matching archive,
historical Mac/shared applicability, warnings and retained failures. Documentation
and source/generated-plist reconciliation are complete. Commit/push and
exact-new-commit hosted CI remain separate delivery steps.

## Required outcome

Every branch-backed execution preserves its complete owned worktree, including successful runs that upload only a partial patch or no artifact. Clients show durable worker-reported recovery identity after cold reload/relaunch, without claiming current disk availability. Ordinary workspaces retain their existing semantics. No automatic destructive cleanup is added.

## Implementation

- [x] Apply the reviewed isolated server/domain/protocol, node, Web/native, fixture and driver patches individually; preserve the latest assistant input helper and delivery documentation. Verify each prepared patch hash before applying it.
- [x] Persist a reserved node-owned `run.workspace.retained` event and bounded optional Run projection, with exact worker/task/root/branch identity and replay validation. Process text and adapter-returned events cannot impersonate it.
- [x] Negotiate typed retention support via `run.start`, use bounded committed-receipt waiting, and require metadata persistence before successful completion. Keep Stop acknowledgement independent and handle start-ack failure without a queued orphan or leaked owned process.
- [x] Show reported time, computer, root, branch and outcome in both clients; support exact Copy operations and honest planned/unavailable fallback. Historical retrieval uses the Run projection, not transient output text.
- [x] Update the existing four-run correction fixture to retain all four worktrees, verify ignored binary bytes and export 18 original files before disposable cleanup. Preserve its exact four runs/approvals, two reviews/artifacts and one confirmed Stop.
- [x] Add a separate zero-artifact task and exact UI case on each platform. Keep one run/approval, zero reviews/artifacts and one retained worktree. The prepared real-CLI/protocol fixture is not client E2E evidence.

## Verification and delivery

- [x] Review integrated changes and complete focused/process/build checks at their retained source boundaries. Source13 shared regression passed 1,537 tests with 30 skips and typecheck; the source26 554-component-path reuse addendum establishes historical applicability, without a fresh shared/Mac runtime or binary claim.
- [x] Complete historical source10 installed unsigned x64 DMG/ZIP E2E: 22 checks, 55 original captures, 22 exact Copy values and 14 cleanup flags, including actual installed-worker partial/zero-artifact success and cold renderer reload.
- [x] Complete fresh source26 native verification: 159 units and actual all11 UI cases; Correction 89/89 and Retention 35/35 data checks, 10/10 and 6/6 visual correlations, plus 44/44 aggregate checks. Correction 21 and Retention seven original photos were inspected; the linked milestone retains the full HTML/image inventory.
- [x] Preserve the frozen 795-file source boundary through the final native run and matching development-signed arm64 archive. Archive signature/Team/profile/source checks passed across 84 iOS inventory, 72 snapshot and 41 product inputs; no physical-device UI or upload.
- [x] Audit original process/filesystem/server data, exact case inventory, original captures, source fingerprints and owned cleanup. Keep eleven frame-dimension warnings, the archive warnings and all failed attempts. Zero-lease scenarios do not prove acquired-lease release; forced Stop does not imply a graceful-exit receipt.
- [x] Restore the generated UI-test plist in main only after native/archive Xcode activity is closed; the restoration was recorded on 2026-10-03 at 07:37:53 UTC.
- [x] Review/apply the five documentation updates and reconcile all 795 frozen entries: only those five documents and the restored generated UI-test plist differ; implementation/test source bytes remain matched. Preserve all six unrelated files and the recovery stash.
- [ ] Commit and push the coherent milestone to main, verify the actual remote SHA, and assess hosted CI for that exact new commit. Local verification does not complete this delivery step.

## Scope that remains after this milestone

Retaining work exposes the existing same-instance exact-root collision. A separate explicit administrator-approved per-run base allocation must preserve legacy/ordinary roots, transactional ContextPack/transport/root consistency, logical lease semantics, node-local containment/topology checks and mixed-version behavior. Isolated receiver, durable-journal/WebSocket, allocation and UI-heading candidates remain unapplied and commercially unqualified; their bounded tests do not establish current-main integration or same-instance client E2E. Fresh runs must not silently claim to continue earlier uncommitted work; continuation needs an explicit user choice and policy.

Real-provider quality, physical devices/TestFlight, trusted Mac signing/notarization/updates, deployed TLS/OAuth, operator privacy/support/deletion and deployment recovery, and production database/concurrency acceptance remain commercial release gates. Isolated PostgreSQL results cover the recorded candidate and test adapter; production integration and concurrency acceptance remain pending. No inherited credential is sent to a guessed provider endpoint. The previously blocked auth-to-registry revocation probe is outside this work and will not be retried.
