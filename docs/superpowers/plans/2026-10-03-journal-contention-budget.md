# Journal Contention Budget Implementation Plan

> **For agentic workers:** Root owns runtime scheduling and delivery. Use the available collaboration tools for independent source review; the template's superpowers execution skills are unavailable.

**Goal:** Allow short legitimate SQLite lock contention between independent journal clients without granting duplicate execution authority.

**Architecture:** Configure SQLite's bounded native busy wait when opening each connection, before its first metadata read. Preserve the existing transaction, durability, sticky failure and facade deadline behavior. Do not retry an entire operation after an uncertain commit.

**Tech Stack:** Node.js 24.19.0, node:sqlite, TypeScript, actual independent-process journal fixtures.

## Global Constraints

- Preserve the failed `attempt-20261003T133254Z-journal-19b2711d`: zero passed, one failed, eleven unrun. Both fixture clients were ready; one returned fresh and the other reported `database is locked`. The exact failing SQL statement is unknown.
- Keep DELETE journal mode, synchronous EXTRA, fullfsync, foreign keys, trusted-schema restrictions, exact owner identity, no duplicate launch and permanent-error unavailability.
- Keep the default 5000ms facade operation deadline, late-reply rejection, fixture budgets, exact twelve case titles and physical cleanup assertions.
- SQLite's busy wait applies to each contended statement. It is not a new whole-command deadline or permission to return a late permit.
- Keep the accepted old live/WS results tied to their original bytes. A new worker needs fresh relevant runtime evidence.

### Task 1: Bound contention before the first query

**File:** `apps/artood/src/managed/journal-worker.ts`.

**Interface:** Existing provision/open and command APIs stay unchanged.

- [x] Preserve and inspect the original failed report and independent-client receipts.
- [x] Add `const busyTimeoutMs = 1000`; pass `timeout: busyTimeoutMs` to both `new DatabaseSync` calls. Apply and verify the same value in `configure()`.

  ```ts
  // Wait only inside SQLite; never replay a transaction after an uncertain commit.
  const busyTimeoutMs = 1000;
  new DatabaseSync(databasePath, { allowExtension: false, timeout: busyTimeoutMs });
  ```

- [x] Independently review the diff for unchanged ownership, durability and deadline logic.

### Task 2: Validate actual contention and the retained failure boundaries

**Existing tests:** `validation/managed-workspaces/journal/journal.git.test.ts`.

- [ ] Run the repository journal phase under the existing owned wrapper, with full build and noEmit first:

  ```sh
  PATH=/Users/jeremy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/usr/bin:/bin:/usr/sbin:/sbin nice -n 10 /Library/Frameworks/Python.framework/Versions/3.10/bin/python3 validation/managed-workspaces/run.py journal
  ```

- [ ] Require the first concurrent admission case to return exactly one fresh and one unknown result. Keep copied/foreign permit and changed-payload rejection checks intact.
- [ ] Require the independent persistent SQLite lock case to reject without a permit, remain unavailable after lock release and show no admitted run when reopened.
- [ ] Require the committed-but-late response case to return no permit, stay unavailable and reopen the committed record as unknown.
- [ ] Retain all twelve outcomes, original HTML, process receipts and unrun cases on failure. Do not adjust the separate 10000-event workload to hide a later failure.
- [ ] Continue correction, ordinary regressions, production build, real PostgreSQL and refreshed live/WS qualification before foundation delivery. This plan alone establishes no client or commercial acceptance.
