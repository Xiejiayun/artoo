# Journal foundation: eleven ordinary cases and one history case

This split is source preparation, not runtime acceptance. Preserve both prior
failed attempts: the 50ms contention attempt passed zero cases; the 1000ms
attempt passed eight before its monolithic history command and queued close
timed out. Root observed 162 committed rows after about 31.8 seconds in the latter
closed attempt. That observation is not a formal benchmark.

The exact original twelve titles are split between two explicitly selected
entries. `journal.git.test.ts` contains eleven; `history.git.test.ts` contains the
original 10,000-event history title. Run one phase at a time:

```sh
nice -n 10 python3 validation/managed-workspaces/run.py journal
nice -n 10 python3 validation/managed-workspaces/run.py history
```

Both use this family's existing `build-child.mjs`, `tsconfig.json`, canonical
compiled product imports, `dist/journal-child.mjs`, child-bundle receipt, owned
temporary prefix `/private/tmp/artoo-journal-validation-`, and existing absolute
`ARTOO_JOURNAL_REPORT_DIR`. The history config selects its own file directly;
no skipped test is counted as passing. Ordinary `npm test` still excludes these
validation entries.

The history parent performs all 10,000 actual append → durable live claim → exact
accepted receipt triplets with the original event IDs/content/sequence checks.
It sends the existing `append`, `live-claim` and `live-receipt` requests, one
product operation per child command. The obsolete monolithic history command is
removed. There is no SQL seeding, smaller workload, new journal API, concurrent
dispatch, retry or resumable child state machine. The fresh owner has genuinely
started its writer and observed actual physical closure without durable
settlement; the workload does not pretend that writer is still running.

Each ordinary command remains bounded at 15 seconds, physical preparation at
60 seconds, and the product facade at its existing 5-second default. The history
case has a reviewed 3600-second budget; its parent stops issuing work at one
monotonic deadline 60 seconds before that limit. The guard runs before every
request, including final assertions. An in-flight request is awaited normally;
no abandoned background loop keeps sending after timeout. Existing serialized
fixture cleanup handles failure. Other cases retain 90-second limits and every
config retains 20-second hooks. Outer test-phase limits are 420 seconds for
journal and 3720 seconds for history, each with the same 10-second outer cleanup.
The shared helper permits a phase ceiling of 4500 while its cleanup ceiling and
all observer/identity/signalling policies stay unchanged.

Progress replaces `history-progress.json` after every 100 verified receipts and
on exit, retaining actual partial counters, stage, elapsed time and failure.
The existing fixture records every actual reply once in
`journal-observations.json`; no second body array is added. HTML shows compact
progress and links the raw JSON. Completion still requires no pending events,
the next append at sequence 10,000, only that event pending, and the genuine
historical started/accepted receipt with no final outcome.

Expected independent inventories:

| Phase | Fixtures | Physical boundaries | CLI/guardian pairs | Ready-wait paths | Durable settlements |
|---|---:|---:|---:|---:|---:|
| journal | 11 | 5 | 4 | 3 | 2 |
| history | 1 | 1 | 1 | 1 | 0 |

Journal retains two genuinely started/unsettled runs, one normal settlement,
one post-spawn startup cancellation and one not-spawned negative. The persistent
SQLite lock and committed-but-late reply cases remain in journal11 and still
need actual passing evidence after the prior bailout. History is one genuinely
started, physically closed, durably unsettled run. Existing ownership markers,
inode checks, failed-fixture retention, exact physical replies, passive PID/role
closure and expected process exits remain required. Actual program-entry counts
are `null`; ready-wait counts are source expectations only.

Journal-family delivery requires BOTH successful reports with identical full
source-before/source-after inventories across both attempts AND identical full
runtime-before/runtime-after inventories (compiled output, dependencies and
harness) across both attempts. Each phase reports combined acceptance as not
assessed. Neither a skipped history nor one passing phase qualifies the family.
Preserve the reports separately and compare the entire inventories; HEAD alone
is insufficient.

The reported workload and case durations are observations under the recorded
machine/source, not a 15-second, 90-second or commercial throughput SLA. No
durability or production deadline policy was weakened. Receipt outcomes remain
local fixtures, not server, GUI, provider or commercial acceptance.
