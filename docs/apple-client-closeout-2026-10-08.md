# Apple clients and managed execution — closeout, 2026-10-08

This is the user-requested consolidation of the current work into one main commit. It preserves implemented code, tests and the unfinished iOS candidate. It is a development snapshot, not commercial-release acceptance. Earlier milestone reports retain their original source and environment boundaries.

## Included implementation

- Per-run workspace allocation contracts, migrations 0022/0023, administrator configuration, assignment and receipt identity checks.
- SQLite worker journal, bounded delivery, real process ownership/closure checks and closed-run recovery.
- One mixed NodeClient/WebSocket for ordinary and allocated runs, immutable journal identity fences, retained Stop handles and failure-aware bootstrap.
- Private Mac journal preparation, correlated ready/stopped IPC, durable profile storage, opt-out continuity and per-agent workspace controls.
- Bundled journal worker and installed-smoke preparation/byte checks; updated UI automation respects disabled Start/Stop controls.
- iOS safe-area Done control, bounded focus reveal and passive input-visibility assertions. The latest hosted UI gate remains failed.
- Independent real mixed-writer and journal-worker failure harness source. These new physical harnesses have not been executed.

## Verification boundary

| Source / gate | Observed result |
| --- | --- |
| Frozen foundation, journal/history/correction/live/WebSocket | 11 + 1 + 12 + 20 + 26 passed. History used 10,000 real append/claim/receipt triplets; no throughput SLA is claimed. |
| Frozen foundation, PostgreSQL 17.11 | Receipt 15, administrator 10 and assignment 4 passed with independent backend connections and owned cluster cleanup. |
| Frozen foundation, complete ordinary repository regression | 1,834 passed, 30 skipped across 227 files; completed in one uninterrupted 1,444-second Vitest invocation. The earlier 600-second outer timeout is retained separately as failed. |
| Frozen foundation, production preview build | Passed. |
| Initial mixed focused regression | 556 passed, 15 failed, 12 skipped. All 15 failures came from a test helper assuming renderWithProviders returned a queryClient. The closeout correction explicitly creates and passes its QueryClient; the original failed report is retained. |
| Final integrated closeout checks | Passed: forced full TypeScript build; 571 focused tests passed / 12 skipped; 37 desktop/report contract tests passed; production preview build and daemon/SQLite-worker bundle passed. Source stayed unchanged during the complete check. |
| Hosted candidate b2eceb7827dccb56c65b8111a13ebfa4df3b6853, run 37728674201 | Mac and shared jobs passed; iOS failed; installed Windows skipped. This run predates the managed product integration in this commit. |
| Hosted Mac | 22 client checks, 14 cleanup checks, 56 captures / 55 distinct client PNGs; recovery added 8 checks and 2 PNGs. Fresh unsigned arm64 preview, with full artifact ZIP SHA/CRC checks. Planning DOM/PNG measured 1024×654; no requested/before/after native-size receipt was recorded. |
| Hosted iOS | 159 unit tests passed; all 7 Core UI cases failed at the passive input-visibility gate. Two failed before the caret tap, five after it. The four later suites did not start. The field was visible in recorded geometry, while after-tap Form viewport selection was inconsistent; the cause remains unqualified. |

The final integrated checkout has not completed installed Mac or native iOS E2E. Foundation acceptance and the earlier Mac candidate do not certify the new mixed implementation.

## Reports

[Hosted run 37728674201](https://github.com/Xiejiayun/artoo/actions/runs/37728674201) retains its original CI artifacts. Local reports are retained under:

- `artifacts/preview-gate/apple-ci-fixes-delivery-prep/finalized/hosted-37728674201/mac-review/report.html`
- `artifacts/preview-gate/apple-ci-fixes-delivery-prep/finalized/hosted-37728674201/ios-review/reviews/20261008T051355Z-79d097e2/report.html`
- `artifacts/preview-gate/closeout-20261008/checks-20261008T051103Z/report.html`
- The separate frozen worktree, `artoo-managed-workspaces/artifacts/managed-workspaces/20261008T044026Z-ordinary/report.html` and `20261008T050615Z-preview/report.html`.
- `artifacts/preview-gate/mac-managed-integration-20261008/foundation-verified-gates-20261008.json` indexes the eight accepted foundation gates and their original hashes.

Reports and raw media remain generated artifacts, outside Git. Each actual client attempt retains its own HTML and available real screenshots; missing native PNGs and derived video frames are labelled explicitly. No older photo is substituted for a new attempt. The final iOS failure review has one original browser PNG and one redacted frame derived from the exact failed native case video; it has zero original native PNG attachments. The selected raw database/video members were checked independently, without claiming a full raw-archive hash verification.

## Remaining work, preserved for resumption

- Diagnose and qualify the iOS passive viewport checks and rerun the full native suites.
- Execute the new real mixed-writer and idle/active journal-failure harnesses on the integrated source.
- Qualify actual installed Electron journal operation, prepared ordinary workflows, allocated UI assignment/Stop/restart and iOS remote control. The proposed four-run installed-allocation module was only designed, not implemented.
- Resolve the prepared-worker fatal-failure recovery path: the current conservative cleanup lock can prevent sign-out/re-pairing until app restart. Do not infer clean shutdown merely from a failed child exit.
- Retain the documented upgrade rule for old NULL receipt identities: drain active work or explicitly Stop it before migration 0022; migration does not manufacture historical receipt identities.
- Live providers, production HTTPS/OIDC, release signing/notarization, physical devices/TestFlight and commercial acceptance remain open.

No simulator was erased, no unrelated process was intentionally terminated, and the six pre-existing unrelated files and original stash were preserved during consolidation. New feature work stopped at the user's closeout request.
