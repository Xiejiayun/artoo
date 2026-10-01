# Execution correction and retained work implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. The current session uses its available collaboration tools with explicit file ownership and root review.

**Goal:** A Mac or iOS user can request changes, read the submitted feedback after reload, retry failed execution, identify old and corrected artifacts, and dismiss or confirm stopping the exact running execution without losing its failed or stopped execution files. Successful-work preservation is a separate remaining requirement.

**Architecture:** Keep reviews as durable task-level decisions in the existing event log. Expose that history in the task snapshot and include real requested-change comments in subsequent ordinary execution context. Exercise one task through four actual executions, using distinct task-owned Git worktrees so retained failed work cannot be overwritten by another attempt.

**Tech Stack:** TypeScript, Zod, Drizzle/PGlite, React/TanStack Query, SwiftUI/XCTest, production NodeClient/process adapter, Playwright installed Electron client.

## Global constraints

- Base main is `e2f25ce2978da27b8e5ae98923056ad6abec30fc`. Hosted run `36810183573` is terminal: Mac/shared passed; iOS failed in a caret-dependent test input replacement. Its original ZIPs and screenshot diagnosis are retained at `artifacts/preview-gate/ci-36810183573/AUDIT.md`. Assistant-only session 14262 and the later closed assistant suite within current full 64710 validate real UI Select All/Delete and the complete assistant scenario on their recorded source. The complete local native gate and matching archive now pass; new-commit hosted acceptance remains pending.
- User authorized implementation, verification, commits and direct pushes to main. Commercial acceptance remains the full goal, not this single scenario.
- Every client E2E attempt retains HTML and actual credential-safe screenshots, including failures. No API writes may replace the tested recipient UI actions.
- Use Node 24. Freeze all main source, documentation and Git state during native E2E and final Mac E2E. Restore only the generated UI-test plist after all Xcode work ends.
- All Git repositories, worktrees, processes, credentials and servers in the new scenario are disposable and task-owned. Never operate on a user's real repository to produce fixture evidence.
- Preserve exact comments and actual task/run/approval/artifact identities. Historical arrays have no guaranteed ordering; track new runs by identity, never `runs[0]`.
- Old review events have no artifact/run attribution or manual/automatic source. Expose unknown history honestly instead of deriving ownership from timestamps.

## Task 1: Integrate the reviewed safety corrections

**Files:**
- `apps/artood/src/node-client.ts`, `workspace-binding.ts`, two workspace-retention test files.
- `packages/domain/src/context-pack.ts` and its tests; ordinary server context builder and feedback-context tests.
- `apps/web/src/components/CancelRun.tsx` and its tests.

- [x] Verify and apply the three isolated patches once: workspace-retention v2 (`3a26bfeaae101dcacb7711ffc68678b5c9ff9a3145ebe4d419dc3dc081ccc504`), review context (`04898aa1c27c194113a103d477c98950f5aaeff82b70238b18a1eb1bdc9d08f2`), and Stop identity (`e7892b8bf542c2507d7b49f5070695e3856d7d78c665c2d8ecca0d248df83952`).
- [x] Preserve modified/new worktree files on failed/cancelled or undelivered execution. Successful delivery still cleans its worktree. Retention diagnostics use the existing run-output channel.
- [x] Keep the same-root reuse boundary explicit: retained worktrees require deliberate recovery/archival or another root; never delete them to make Retry pass.
- [x] Bind Stop confirmation to the exact run ID. A changed/ended run invalidates its confirmation; dismissing does not cancel anything.
- [x] Run the focused Node, real-Git/process, server context, React and type checks before client E2E. Results retain their own source/time boundaries in the milestone ledger.

## Task 2: Durable task review and artifact presentation

**Files and ownership:**
- Server/domain owner: shared `TaskReview` schema/export, `services/lifecycle-service.ts`, `services/task-service.ts`, review-history service/tests and the context builder.
- Web owner: API snapshot type, `TaskDetailPanel.tsx`, `ArtifactReview.tsx`, review/artifact display tests and existing Stop control.
- Native owner: `Models.swift`, `TaskDetailViewModel`, `TaskDetailView.swift`, small display helpers and focused decoding/model tests.

**Wire contract:** `GET /api/v1/tasks/:id` adds `reviews: TaskReview[]`, ordered by real event position. Old servers without this field remain readable by clients.

```ts
type TaskReview = {
  event_id: string;
  position: number;
  task_id: string;
  outcome: "accepted" | "changes_requested";
  comment: string | null;
  actor: { type: "user" | "agent" | "system"; id: string };
  actor_name: string | null;
  occurred_at: string;
  artifact_ids: string[] | null;
};
```

New `review.completed` events record `artifact_ids`, the exact task/organization artifact inventory inside the review transaction. This is task-level review provenance, not a claimed single reviewed run. Legacy absent attribution returns `null`. Historical IDs never refer to newly uploaded artifacts. Existing `base_version` concurrency checking remains authoritative.

The ordinary context retains `review_feedback.version = 1` and ordered real nonblank changes-requested entries, with original event/actor/task/comment metadata. Include recorded `artifact_ids` where known; preserve legacy unknowns. Assistant/discussion context stays on its existing conversation path. Rebuild domain, server and workers together; an old worker's schema can discard this new optional field, so no mixed-version compatibility claim is made.

- [x] Test actual Review API → durable snapshot history with exact body, actor/name, ordering and artifact inventory; exclude other task/org records and keep legacy attribution unknown.
- [x] Test a stale review command cannot annotate a newer task snapshot or create another review.
- [x] Render submitted feedback after Request changes and reload/relaunch, separately from the editable draft. Clear only a successfully submitted draft; preserve it on errors and keep the old submitted feedback visible in later states.
- [x] Native snapshots decode optional `version_cursor`; review requests send the loaded version. Refresh on 409 while preserving the draft. Return the accepted command outcome independently of a later refresh failure.
- [x] Show each artifact's actual `metadata.filename` when present, originating run identity and created time; keep exact download/preview IDs and immutable bytes. Do not infer filenames from opaque server storage paths.
- [x] Native Stop dialog identifies the captured run and explains that its task will also be cancelled, with an explicit Keep running action. Retain or strengthen identity protection when the snapshot refreshes.
- [x] Expose the existing `branch_backed: true` assignment capability through a
  default-off "Use an isolated Git worktree" checkbox/toggle in both clients.
  Enabled assignment sends that field through the real command; disabled
  assignment omits it and preserves the ordinary-workspace path. Explain the
  configured Git repository and unused workspace requirements. Preserve choice
  on failure and test both payloads. Native stable ID is `task.assignment.worktree`.

## Task 3: Shared four-run real-process scenario

Root owns the shared process program, task-owned Git workspace setup, read-only observers/verifier, suite registration, contracts and reports. The native suite is `correction`, with exact case `ExecutionCorrectionUITests/testTaskCorrectionRetainsWorkAndConfirmsExactStop`; the installed Mac driver is `installed-mac-correction.mjs`. Native and Mac drivers keep all product mutations in their actual UI.

The scenario uses one UI-created standalone task and four pre-provisioned instances on the same actually paired computer. Each instance has its own fresh worktree root and branch from one disposable Git base. Creation/enrollment/instance setup is fixture setup; the user actions below are exclusively UI.

Each assignment explicitly enables the real worktree toggle. Server-generated
branches must equal `artoo/run-<actualRunId>`. The Mac baseline continues to
prove its absolute CLI works with empty PATH; the later Git-dependent stage
restarts only its owned app with the normal system-tool PATH and configures
the Git repository through Settings UI. The report distinguishes these stages
and makes no claim that Git worktrees operate without an installed Git tool.

| Step | UI action and real process | Required boundary |
| --- | --- | --- |
| R1 | Create/Ready, request and approve G1, manually choose instance 1, Assign | Process writes A1 and completes; task Review; one run/receipt/artifact. G1 consumed by R1. Successful worktree removed. |
| C1 | Enter multiline feedback and Request changes; reload/relaunch and read history | Exact durable review/comment/actor and A1 inventory; task Ready; no new run; old G1 cannot authorize another execution. |
| R2 | New G2 and instance 2, Assign | Actual process reads C1 from its real context, modifies a tracked file and creates a new file, then exits nonzero. Task Blocked, run Failed, no new artifact; files and worktree remain. |
| Retry | Tap Retry | Ready only; unchanged run/launch/artifact sets and preserved failed work. New G3 is still required. |
| R3 | Approve G3, select instance 3, Assign | Process reads real C1 and writes corrected A2 from its context. Task Review; three runs/fresh receipts and two immutable artifacts. Both reports remain distinguishable/downloadable. |
| C2/R4 | Request changes C2, new G4, choose instance 4, Assign | Actual process receives ordered C1/C2, writes recoverable tracked/new files and stays alive. Four exact launches; no new uploaded report. |
| Keep running | Open Stop for R4 and choose explicit Keep running | No cancel POST; same run/task Running, PID alive and no extra launch for at least 3.1 seconds. |
| Confirm stop | Reopen and confirm Stop | Exactly R4's cancellation POST; its held PID is absent when the actual cancel HTTP response completes, task/run are Cancelled, and worktree files/old artifacts remain. No redispatch or file change for at least 3.1 seconds. Zero leases are declared and no held leases remain at finish; acquired-lease release and a graceful-exit receipt are not claimed. |

The CLI must derive feedback text/event identity/hashes from its production context file. Never pass C1/C2 as hidden expected output or fabricate terminal events/artifact bytes. Startup receipts, per-run context copies and observed filesystem hashes are immutable evidence outside the worktrees. Uploaded report paths can be the same filename across instances; downloaded A1/A2 bytes must remain different and bound to the correct runs.

Read-only verification binds task/project, all four run/instance/computer/runtime/context identities, four approvals and real PID receipts, two artifact byte hashes, review history and context provenance, failed/cancelled retained files, successful cleanup, base repository integrity and exact HTTP Stop attempts. Wrong historical failures do not abort waits for a newer expected run.

## Task 4: Client E2E and delivery

- [x] Implement a separate native correction suite and installed-Mac helper using the same shared scenario/observer contract. Retain guarded diagnostic screenshots when a step fails.
- [x] Capture initial report, durable C1 after reload, failed R2/Retry, two distinguishable artifacts, C2 and Stop confirmation, Keep running, and final Cancelled/history/retained-work evidence; native previews must show the actual report bytes.
- [x] Pass bounded fixture/unit/model tests, then freeze main. Run new native subset and fresh installed-Mac E2E, inspect all actual images, and fix real defects without weakening assertions.
- [x] Complete the full native gate on frozen source. Session 64710 passed all 144 units and ten exact UI cases, with 57 distinct original images, completed independent data/visual audits and all source/cleanup checks. Earlier failed aggregates remain failed.
- [x] Produce and verify the matching signed development archive after the full gate. The Release arm64 archive passed strict signature/certificate/Team/profile checks; all 704 repository entries, 65 snapshot files and 39 product inputs match before/after archive and its isolated snapshot. No physical-device UI or upload occurred.
- [x] Restore only generated UI-test configuration after all native/archive Xcode work finished. Reconciliation records exactly that one expected difference against the verified inventory; the other 703 entries still match and product source is unchanged.
- [ ] Apply the final evidence documentation and commit/push the coherent milestone to main, preserving exact report hashes/limits. The prior hosted run is terminal.
- [ ] Follow the exact new commit's hosted CI and retain its actual HTML/images. Continue remaining commercial release gates rather than treating deterministic fixtures as real-provider or distribution approval.

## Integrated pre-E2E findings (2026-10-01)

- The independent real-Git startup regression proved the CLI can write files before its guardian startup fails. Adapter startup rejection now retains an already materialized worktree and includes its actual recovery location in the rejection; it must not assume no process ever started.
- Task snapshots now read task, runs, approvals, artifacts, reviews and version in a single read-only repeatable-read transaction. A real interleaving regression reproduced the previous old-state/new-version mismatch. PGlite's one-connection scope is documented; this is not a multi-connection PostgreSQL load claim.
- Missing, malformed or duplicate legacy artifact inventory is unknown (`null`), never a partly filtered or inferred review attribution.
- The protocol integration reached all four real executions and rejected 16 altered evidence cases. These are API integration tests, not client UI certification. Two preceding failed attempts remain in logs: the initial harness wrongly expected a SIGTERM-handler receipt. Production POSIX cancellation uses process-group SIGKILL; verification now observes the held PID absent at the real HTTP response, retained file hashes and a stable terminal state. The production await ordering supports process stop before database cancellation; the passive observer itself timestamps the HTTP response boundary.
- Current assignment UI does not declare `write_paths`. This correction scenario checks no held leases remain and explicitly reports zero declared leases; it does not claim to exercise lease release. Existing lease/recovery tests retain that separate coverage.
- The shared CI job is Windows. Only the POSIX graceful signal-handler unit case is explicitly skipped there, with a separate forced-termination test available on every host. Mac executes the complete CLI suite. Disposable Git repositories disable autocrlf and use owned empty hooks/configuration.
- Every correction client attempt retains process/context receipts, checkpoint observations, actual artifact bytes and failed/cancelled work files before cleanup. HTML admits the 15 named native correction captures plus guarded failure scenes, and the installed Mac driver's named captures. Raw failed hosted xcresults and original tests/summary exports are retained separately for diagnosis.


## Completed local gate and archive outcome

Final Mac attempt 5 passed 21 checks, with 38 caption entries/37 unique images,
independent image/data audits and nine cleanup checks. Native correction 87248
passed the exact case in 1603.578 seconds, with 15 unique images and 181 audited
data checks. Both exercise four runs/approvals, two reviews, two artifacts, two
retained failed/stopped worktrees and zero live owned processes at finish.

Full native 55771 failed after 144 units and all seven core cases passed; its
assistant stage failed before follow-up replacement. Subsequent assistant probe
63804 failed before draft entry. Their preserved geometry/video evidence grounds
the current composer alignment before focus and after keyboard appearance;
Select All/Delete/type and all business assertions remain. The later assistant
14262 passed in 781.689 seconds with seven audited images/21 data checks. Mentions
82561 passed in 763.587 seconds with all eleven expected images and complete
cleanup; its eleven unique originals and retained-data/report consistency were
independently audited. These earlier subsets remain separately scoped.

Full invocation 64710 passed all 144 units and ten exact UI cases: core 7/7 in
1203.737 seconds/24 originals, assistant 1/1 in 639.622 seconds/seven originals,
mentions 1/1 in 608.657 seconds/eleven originals, and correction 1/1 in 1551.643
seconds/fifteen originals. All 57 distinct aggregate images were individually
reviewed through the suite audits, and aggregate byte/caption/link mappings match.
All source checks and 13 recorded parent cleanup flags passed. The correction data
audit reconciles four runs/launches/approvals, two reviews/artifacts, two retained
failed/stopped worktrees and zero live owned processes, with 27 record and 54 raw/
per-attempt checks. Keep and stable-Stop observation gaps are 18.470832961 and
3.380175036 seconds; PID absence is established at cancel HTTP completion only.
The matching Release arm64 development archive passed strict signing and source
checks. Completed audits include `native-full-prefocus-final-data-audit/`,
`native-full-prefocus-correction-visual-audit/` and the recorded archive verification;
the milestone ledger and companion preserve their report hashes.

The verified 704-file inventory has SHA-256
`a25550606a631879944e45f8a1a6309826cfabae15997857ea57f800d93c0376`.
Compared with final Mac, two native product views, four UI tests and three native
harness files differ; 695 other entries, including Mac product inputs, match.
The matching archive preserved all 704 entries, 65 iOS snapshot files and 39
product inputs. After all Xcode work finished, the generated UI-test plist alone
was restored; the other 703 inventory entries match. Final documentation application,
commit/main push and exact-commit hosted acceptance remain pending. No future
commit SHA is assigned.

Successful-work preservation, typed recovery records, same-instance safe repeat
execution, start-ack cleanup and next-device changes in the isolated ignored copy
remain unapplied. Their isolated tests do not count as current-main coverage.
The milestone does not establish live-provider quality, physical-device/TestFlight,
trusted Mac distribution/updates, deployed identity, operator policy or
multi-connection PostgreSQL acceptance.
