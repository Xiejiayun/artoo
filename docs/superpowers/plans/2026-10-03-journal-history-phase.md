# Journal History Phase Implementation Plan

> **For agentic workers:** Root owns application and runtime scheduling. Use the available collaboration tools for independent source review; the template's superpowers execution skills are unavailable. This proposal is external source preparation only while iOS Core 30239 is active.

**Goal:** Preserve all twelve original journal contracts while giving the 10,000-event history workload its own bounded, honestly reported phase.

**Architecture:** Move the existing history case into a separately selected entry in the same journal family. Its parent calls the existing `append`, `live-claim`, and `live-receipt` fixture commands sequentially; each child command performs one product operation. Keep the shared compiled child, actual producer boundary, exact receipts, durability and cleanup policies. Require both successful phase reports with identical full source inventories and full runtime inventories (compiled output, dependencies and harness) before journal-family acceptance.

**Tech Stack:** Node 24.19.0, TypeScript, Vitest, Python 3.10+, existing SQLite journal worker and owned phase helper.

## Global Constraints

- Write proposed files only beneath this external directory. Do not edit the checkout or old reports; do not run source parsers, tests, builds, simulators, database queries, process probes or network requests during preparation.
- Preserve `attempt-20261003T133254Z-journal-19b2711d` as zero passed / one failed / eleven unrun and `attempt-20261003T134819Z-journal-8a38125f` as eight passed / one failed / three unrun.
- Root's closed-attempt read-only diagnosis found 162 committed rows, sequence 0–161, after about 31.8 seconds. This rough observation is not a benchmark or a performance SLA. Merely splitting commands does not accelerate durable SQLite work.
- Retain exactly 10,000 actual `appendEvent` → `claimNextLiveDelivery` → `recordLiveEventReceipt` triplets with exact event/hash/attempt assertions. No SQL seeding, workload reduction, retries, duplicate execution or production-code changes.
- Keep each ordinary fixture command at 15 seconds, physical commands at 60 seconds, and the product facade at its existing 5-second default. Do not change fullfsync, synchronous EXTRA, DELETE mode, the 1000ms SQLite contention policy, identity or unavailable-state rules.
- Select `journal` for eleven original titles and `history` for the remaining original title. No skipped title counts as passing. Both phases use the existing journal child build and report environment.
- History case budget: 3600 seconds. History test-phase budget: 3720 seconds. Outer cleanup: 10 seconds. Other phases retain all supplied budgets, including journal's 420-second phase and 90-second cases, and every family's 20-second hooks.
- Stop issuing work at one monotonic deadline 60 seconds before the history case limit. Check it between actual requests; do not race an abandoned background loop against a timer. Existing per-command timeout and serialized cleanup remain authoritative.
- Keep only the existing raw reply array; do not add duplicate command/body arrays or embed those replies in HTML. Write compact progress checkpoints and link the original JSON.
- Actual program-entry counts remain `null`. Ready-wait counts are source expectations, not measured entries.

## Proposed file map

All destination paths below are represented as complete files beneath `proposed/`.

- Modify `validation/managed-workspaces/journal/journal.git.test.ts`: remove only the moved history case, leaving eleven exact titles and assertions.
- Create `validation/managed-workspaces/journal/history.git.test.ts`: the one original history title, genuine physical preparation, parent-driven API requests, progress and original final assertions.
- Modify `validation/managed-workspaces/journal/journal-child.ts`: remove the obsolete monolithic history command and its now-unused `assert` import; all existing request handlers remain.
- Create `validation/managed-workspaces/journal/history.vitest.config.ts`: copy the existing journal config's guards, compiled aliases, one-worker/cache/report policy; select only the history entry with a 3600-second case budget.
- Modify `validation/managed-workspaces/journal/title-inventory.json`: split the exact original title multiset into `journal: 11` and `history: 1` without dropping or renaming a title.
- Modify `validation/managed-workspaces/run.py`: add the explicit history phase, config selection, exact physical profiles, compact history qualification and separate family-acceptance boundary.
- Modify `validation/managed-workspaces/support/owned_phase.py`: permit a phase deadline up to 4500 seconds; retain the existing cleanup ceiling, default and all observer/identity/signalling logic.
- Modify the two validation READMEs: document selection, budgets, original failures, raw evidence and the combined acceptance requirement.

### Task 1: Separate the workload and make cleanup reachable

**Interfaces:** Consume the existing `FixtureClient.send<T>(op, input)` and the existing `append`, `live-claim`, `live-receipt`, `pending`, `lookup` and `physical` commands. Produce one history observation plus one compact progress observation; do not invent a new child protocol.

- [ ] Review the complete proposed history entry. It must retain the same genuine unsettled physical run and exact request fields:

  ```ts
  const event = await owner.send<StoredEvent>("append", {
    runId: request.runId,
    eventId: `acknowledged-fixture-${sequence}`,
    event: output(`committed fixture history ${sequence}`),
  });
  const claim = await owner.send<LiveDeliveryClaim>("live-claim", query(request.runId));
  const result = await owner.send("live-receipt", {
    runId: request.runId, sequence: claim.event.sequence,
    hash: claim.event.contentSha256, attemptId: claim.attemptId, status: "accepted",
  });
  ```

- [ ] Verify every event is sequence-equal, every claim is `claimed` with the exact appended event, and every actual receipt returns `{ state: "pending", abort: null }`. Counters advance only after these assertions.
- [ ] Verify the monotonic guard runs before each request. On any deadline, rejection or assertion failure, stop issuing requests and enter the original serialized `Fixture.close` cleanup. Record successful closure even when the workload fails; stop workload timing before cleanup and preserve the original failure. Do not retry an uncertain append/claim/receipt.
- [ ] Verify one compact progress snapshot is atomically replaced after every 100 verified receipts and on exit, preserving actual partial counters and stage on failure. Progress never carries a duplicate top-level `physical` field.
- [ ] Verify original end assertions: counters all 10,000; no pending events; next appended sequence 10,000; that event alone is pending; journal still has its genuine `started`/accepted receipt and no final outcome.
- [ ] Verify the original raw `FixtureClient.replies` are retained once in `journal-observations.json`. No generic abstraction, synthetic test, duplicate raw array or resumable child state machine is added.

### Task 2: Wire exact independent phases and bounded reports

**Interfaces:** `run.py journal` selects eleven titles; `run.py history` selects one. Both use directory `journal`, its existing `build-child.mjs`, `ARTOO_JOURNAL_REPORT_DIR`, temporary prefix, canonical compiled products and complete harness pins.

- [ ] Review phase limits and config selection:

  ```python
  "journal": {"counts": [11], "tests": 11, "directory": "journal", "test_timeout": 420},
  "history": {"counts": [1], "tests": 1, "directory": "journal",
              "test_timeout": 3720, "case_timeout": 3600,
              "vitest_config": "history.vitest.config.ts"},
  ```

- [ ] Verify exact source-derived profiles:

  | Phase | Fixture cleanups | Physical boundaries | CLI/guardian pairs | Ready-wait paths | Durable settlements |
  |---|---:|---:|---:|---:|---:|
  | journal | 11 | 5 | 4 | 3 | 2 |
  | history | 1 | 1 | 1 | 1 | 0 |
  | correction, unchanged | 12 | 14 | 14 | 14 | 14 |

  Journal's physical modes remain two genuinely started/unsettled, one normal settlement, one post-spawn cancellation and one not-spawned negative. History is one genuinely started, physically closed, durably unsettled run. Preserve exact fixture membership, passive closure, PID/role, startup and settlement checks for each phase.

- [ ] Verify history qualification requires the actual aggregate counts, final assertions and retained raw append/claim/receipt result counts. It must fail on incomplete progress, not reinterpret a timeout as completion.
- [ ] Review the helper's sole timeout-ceiling change: phase maximum 4500; cleanup maximum still 600 and supplied cleanup still 10. No observer, identity, priority, signalling, deadline-accounting or other phase limits change.
- [ ] Verify history HTML links progress and original raw JSON but embeds only the compact result summary. Each journal-family phase states that it alone does not establish combined acceptance.

### Task 3: Root source application; runtime qualification after the native gate closes

**Interfaces:** The proposal manifest maps destination paths to before/after hashes. Root may apply independently reviewed source to the idle managed worktree while iOS Core 30239 runs in its separate checkout with its unchanged copied helper. This agent remains restricted to external proposal files. Parsing, builds, no-emit checks, tests and runtime qualification must await closure of 30239 and root's serialized allocation.

- [ ] Compare `proposal.diff` and all complete proposed files against the recorded baseline; apply only after independent review. Keep product files and all old reports unchanged.
- [ ] After iOS Core 30239 closes and root authorizes this allocation, run the ordinary journal phase through the existing owned wrapper:

  ```sh
  PATH=/Users/jeremy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/usr/bin:/bin:/usr/sbin:/sbin nice -n 10 /Library/Frameworks/Python.framework/Versions/3.10/bin/python3 validation/managed-workspaces/run.py journal
  ```

  Require all eleven cases and clean owned closure. In particular, persistent-lock rejection and committed-but-late reply rejection were unrun in the failed twelve-case attempt and still require actual passing evidence.

- [ ] Under a separate serialized allocation, select the full history phase:

  ```sh
  PATH=/Users/jeremy/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/usr/bin:/bin:/usr/sbin:/sbin nice -n 10 /Library/Frameworks/Python.framework/Versions/3.10/bin/python3 validation/managed-workspaces/run.py history
  ```

  Require the one original case, all 10,000 real triplets, final backlog assertions, matching raw results, original process/fixture cleanup and complete before/after pins. Retain partial counters, raw results and failed HTML if it does not finish.

- [ ] Before family acceptance, compare the actual two attempt directories using a read-only check equivalent to:

  ```python
  from pathlib import Path
  import json, sys
  a, b = map(Path, sys.argv[1:3])
  read = lambda p: json.loads(p.read_text())
  ra, rb = read(a / "result.json"), read(b / "result.json")
  assert (ra["phase"], rb["phase"]) == ("journal", "history")
  assert ra["passed"] is True and rb["passed"] is True
  assert all(ra["checks"].values()) and all(rb["checks"].values())
  assert read(a / "source-before.json") == read(a / "source-after.json") == read(b / "source-before.json") == read(b / "source-after.json")
  assert read(a / "runtime-before.json") == read(a / "runtime-after.json") == read(b / "runtime-before.json") == read(b / "runtime-after.json")
  assert (ra["counts"]["numPassedTests"], rb["counts"]["numPassedTests"]) == (11, 1)
  assert all(r["counts"][k] == 0 for r in (ra, rb) for k in ("numFailedTests", "numPendingTests", "numTodoTests"))
  ```

- [ ] Report the measured workload and case durations with their machine/source scope. Do not claim a 15-second, 90-second or commercial throughput SLA from eventual completion. Continue the already planned correction and refreshed downstream qualification independently.

**Preparation boundary:** No proposal file has been applied or executed by this agent. A source review is not parser, build, timing, cleanup or runtime acceptance.

## Root source application

Root reviewed the complete diff, the independent entry review and final reporting correction, then applied the nine declared validation files on 2026-10-03. This is source application only. Native Core session30239 uses a separate frozen checkout and copied helper; parsing, builds and all managed runtime remain pending until it closes. The original failed attempts remain unchanged.
