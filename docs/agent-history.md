# Agent history

The history belongs to an Agent identity and includes executions from all its
instances, including deleted instances. Reads require the existing authenticated
organization context. History is read-only and uses the existing durable runs,
immutable context packs and event log; it does not depend on a live WebSocket.

## Delivery plan and acceptance

1. **History API and indexes.** List executions by Agent, optionally filtered by
   instance, project and status. Cursor pagination orders equal timestamps by ID.
   Execution details expose the original task request and paginated durable events.
   Review scope isolation, old records, tombstones and pagination before merging.
2. **Operation capture.** Versioned tool activity records carry a provider call ID,
   operation name, phase, bounded request/response and error details. Normalize
   Codex and Claude JSONL at the node, redact before transport, and retain the
   existing per-run receipt/dedup path. Activity never authorizes verification.
3. **History UI and acceptance.** Agent and instance links open reloadable history,
   execution filters and expandable requests/events. Verify empty/error/loading
   states, paging, refresh, terminal failures and narrow screens, then run all
   required checks and Web E2E.

Each implementation step is reviewed, validated and merged to main separately.

The history indexes exposed an existing unordered task-snapshot query. Task
snapshots now explicitly retain their established oldest-first run order, with
ID tie-breaking, so consumers selecting the last run keep working. Agent history
uses its separate newest-first pagination. A regression assertion reproduced
the reversed snapshot before this compatibility fix.

## API v1

- `GET /api/v1/agents/:id/history`: `instance_id`, `project_id`, `status`,
  `before_run_id`, `limit` (1–100, default 20). Newest executions first.
- `GET /api/v1/agents/:id/history/:runId`: `before` (exclusive event position),
  `limit` (1–100, default 50). Newest events first. `request` is the task section
  of the original context pack; absent/invalid legacy packs return null, never
  the current task description presented as the original request.

Event positions are server commit order; node sequences retain their original
meaning. Names and list titles describe current resources, while `request`
retains the execution's original task text. No full context pack, credential,
policy or internal provider reasoning is intentionally exposed by this API.
Existing output may contain provider tool logs; older runs without structured
activity cannot retroactively gain missing tool details. Plain/custom runtimes
provide output unless they explicitly emit the supported activity contract.

## Operation capture

`run.output.payload.activity` is optional and versioned (`version: 1`). Its
`operations` array contains up to 64 observations, each with a provider `call_id`,
`name`, `phase` (started, updated, completed or failed), optional request/response
text and exit code. Request/response limits are 16,000/32,000 characters, with
explicit truncation flags. `omitted_operations` reports an oversized batch.
Provider-reported tool failure does not itself mean the overall run failed.

Codex command, MCP, file-change and search items and Claude tool_use/tool_result
blocks are normalized. Results retain their original call IDs even when the
start record is missing. Plain/custom JSONL may explicitly emit
`{ "type": "run.activity", "payload": { "version": 1, "operations": [...] } }`.
Unrecognized formats retain their ordinary output; internal reasoning is not
normalized as activity. This is diagnostic history, not provider API tracing.

The configured provider key is redacted before bounding structured fields and
before log transport, reusing the process adapter's existing credential handling.
Do not deliberately include other credentials in tool inputs or output. The
feature does not promise generic secret detection. Normal node output transport,
receipt identity, reconnect replay and server deduplication apply to activity.
Older nodes omit it; older servers can retain output without structured activity.
Update server and nodes together to obtain structured history.

Local validation uses controlled provider JSONL and real local subprocesses;
it does not claim live-provider or native product-development acceptance.

## Browser use

Open **Agents → View history**, or **Instance history** on an instance card.
Filter executions by instance, project or status, then select a run. The URL
retains filters and the selected run across reload. Expand tool activity to see
its request, response, call ID and exit code; raw output remains separately
expandable. Use **Load older events/executions** for pagination and **Refresh
history** for newly committed records. Reads work while the execution node is
offline. Direct history URLs remain readable after resource deletion.

The original request is labeled unavailable when a legacy context pack cannot
establish it. Final answers use current message moderation. Truncated tool
details and omitted batch observations are labeled explicitly. The page never
substitutes current task text for a missing original request.

Migration 0059 adds indexes only and changes no historical rows. Existing storage
backup/restore procedures apply; application rollback can leave these indexes in
place. This feature does not execute destructive data migrations or deploy Artoo.

## Validation record (2026-11-13)

The API and activity capture were delivered in PRs
[#53](https://github.com/Xiejiayun/artoo/pull/53) and
[#54](https://github.com/Xiejiayun/artoo/pull/54). The browser and compatibility
fix are in [#55](https://github.com/Xiejiayun/artoo/pull/55), runtime code
`01322ef`.

| Check | Result |
| --- | --- |
| Workspace typecheck | Passed |
| Workspace build | Passed; existing large-chunk advisory remains |
| Task review, snapshot consistency and Agent history regression suites | 12 passed |
| Agent history UI states, paging, filters, retry and refresh | 6 passed |
| Complete Web E2E | 39 passed, 0 failed (8.1 minutes) |
| Complete workspace Vitest in CI, two parallel partitions plus the existing Windows process lane | 8,664 passed, 90 skipped, 0 failed; all 592 files accounted for |
| npm lockfile validation | Passed; the already-used artood workspace package is explicitly declared as a Web test dependency |

Web E2E uses the actual local server/PGlite, authenticated device pairing, the
production WebSocket node client and process adapter, and an actual child process
emitting controlled Codex JSONL. It checks success/failure, original request,
operation input/output, final answer, event pagination, reload, instance filters,
deleted identity/instance access and 1440/390/320 px layouts. Screenshots were
reviewed. It does not invoke an external model, test signed native distribution,
or establish deployment acceptance.

Local evidence is retained under `artifacts/preview-gate/agent-history/`. The
passing browser report is
`apps/web/playwright-report/workflows-2026-11-13T03-00-08-515Z/index.html`.
The earlier complete run (`workflows-2026-11-13T02-46-49-656Z`) retained 33 passes
and 6 failures, then led to the explicit snapshot ordering and stable project
inventory fixes. `snapshot-before-fix.log` preserves the failing ordering
assertion; `snapshot-after-fix.log` records all 12 related cases passing. The
initial standalone case's failure-reason expectation was also corrected from
assumed wording to the actual `exit 1` contract; its original report remains in
`workflows-2026-11-13T02-30-44-557Z`.

The separately launched local full-suite diagnostic began before the snapshot
ordering fix and is not the final coherent-code gate. It recorded slow failures
in two imported-runtime cases, a GoalRunner case and storage startup/restore.
The two runtime cases passed an unchanged focused rerun; all 62 runtime cases,
all 21 GoalRunner cases and the ordinary four-case storage integration suite
passed in the final runtime CI run. Original local output is retained rather
than relabeled as passing. No timeout or platform guard was widened.

At runtime code `01322ef`, GitHub's shared-checks and Windows process gates passed.
The complete Vitest coverage record in
[run 43355864133](https://github.com/Xiejiayun/artoo/actions/runs/43355864133)
binds all three lanes to merge commit `6c5bd2625d6cb2b1945b823877e0b0f2cf92d8e0`,
whose parents are main `6d1db54` and feature commit `01322ef`. Reporter JSON and
the verified `coverage.json` are retained in the local evidence directory.
The Mac gate failed waiting for the hidden `Goal title` field, matching baseline
main run `43259718939`; the current failure is in run `43355864133`. Other remote
partitions are tracked separately; local Web E2E success is not a claim that every
native CI gate passed.
