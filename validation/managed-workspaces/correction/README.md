# Closed journal correction12 repository port

This is source preparation only. No dependency installation, product build, harness bundle, typecheck, test, fixture CLI, SQLite worker, or GUI was run. A clean AST parse is not runtime acceptance.

All product imports use the existing canonical compiled graph: `apps/artood/dist/managed/`, `apps/artood/dist/process-adapter.js`, `apps/artood/dist/process-adapter-owned-receipts.js`, `apps/artood/dist/owned/`, and `packages/{domain,protocol}/dist/`. No shadow implementation or product test-only interface is copied.

The root Vitest include is `{apps,packages}/**/*.test.{ts,tsx}`, so these validation entries are excluded from ordinary `npm test`. The family config selects exactly its one historical 12-case entry and does not inherit root source aliases.

The owned integration must first build the one repository graph, then run this directory's `build-child.mjs` in an owned build phase. It bundles only `journal-child.ts` and `physical-run.fixture.ts`; canonical product imports are absolute external paths and the real compiled journal spawns its own `dist/managed/journal-worker.js`. It refuses extra bundled inputs/runtime imports and writes a bundle-input receipt. The generated child is `dist/journal-child.mjs`, its bundle-input receipt is `dist/child-bundle-inputs.json`, and the Vitest cache is `vite-cache` inside the existing `ARTOO_JOURNAL_REPORT_DIR`. The repository globally ignores `dist/`; the attempt report directory keeps caches outside source inventories and outside the complete before/after harness runtime pins. The bundle has not been executed or generated during preparation.

The test phase requires the matching absolute owned temporary prefix and `.validation-owner` marker, plus an existing absolute `ARTOO_JOURNAL_REPORT_DIR`. Keep the preserved fixture owner marker/inode check, independent child/group absence observations, failed-fixture retention, exact expected process exits, source Git checks, and genuine producer receipt cleanup. Existing command budgets remain 15 seconds (physical command: 60 seconds); test/hook budgets remain 90/20 seconds. The real writer retains its original 15-second termination bound. No hidden retry is added.

The owned outer phase must collect reports and process/fixture evidence before actual build/typecheck/runtime acceptance. `tsconfig.json` is provided for that later explicit typecheck; it has not been run.

Temporary prefix: `/private/tmp/artoo-journal-correction-validation-`. Entry: `correction.git.test.ts`.

The original 12 titles, actual 30-second windows, three-attempt budgets, restart/late-ACK ordering, rollback, clock-continuity latch, int32 reserve and cleanup assertions are preserved. The explicit policy remains: the first durable send claim starts one persisted receipt deadline; persisting an outbox row does not start a pre-claim scheduling timer.

Current-signature adaptations:

1. Every closed attempt-failure helper and abrupt-exit command now carries the original claim's `event.sequence` alongside its attempt ID and reason. The negative invented-attempt probe supplies a real sequence but an invalid attempt, so it still exercises the product's exact-claim rejection boundary.
2. Borrowing a retention attempt ID for the unclaimed terminal now fails with `no exact durable claimed attempt`, because the current worker first selects the specified sequence. A separate disposable client submits a wrong hash for the genuinely claimed retention event and still asserts `Receipt identity differs`. Both invalid clients are closed before subsequent successful operations.
3. The removed `markEventCommitted` bypass assertion remains. Genuine physical settlement is unchanged; the fixture does not synthesize closure or accepted delivery attempts. Existing SQL fault/capacity fixtures seed only uncommitted output rows or explicit failure/clock/sequence conditions.

Expected physical invocations remain 14, with real producer closure checked for each, derived from source only. The family does not claim socket/server acceptance; receipts are the original local outcome fixtures. The two real original/correction deadline waits remain intact.

See the formal [managed-workspace foundation plan](../../../docs/superpowers/plans/2026-10-03-managed-workspace-foundation.md). `title-inventory.json` preserves the 12 exact historical case titles for the owned runner. One-off preparation evidence is archived outside this validation source directory.

The historical owned test phase budget is 600 seconds with a separate 10-second outer cleanup limit. The owned runner must carry those limits into its new phase wiring; no budget changes were made here. Parent removal remains conditional on marker/inode identity, marker-only contents, and confirmed owned process closure; a failure retains its evidence.

Build, module resolution, sidecar packaging, runtime behavior and timing remain unverified. Static source and AST review does not constitute runtime acceptance.
