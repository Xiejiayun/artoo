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

Migration 0059 adds indexes only and changes no historical rows. Existing storage
backup/restore procedures apply; application rollback can leave these indexes in
place. This feature does not execute destructive data migrations or deploy Artoo.
