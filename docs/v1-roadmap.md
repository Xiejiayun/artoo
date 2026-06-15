# Artoo v1 Roadmap

This document is the v1 coordination source of truth. It turns the accepted
v0.1 MVP into a release plan for the full "agent team operating system" loop
described in `design.md` section 12.13.

## Baseline

Accepted v0.1 is on `origin/main` at `eec68d8`.

Current v1 integration head is `origin/main` at `962596a`:

- #11 Task DAG is done: dependency CRUD, ready unlock, blocked propagation,
  aggregate review, and evidence gates are merged.
- #12 Concurrency is in progress: Phase A focuses on pure path/lease contracts,
  file lease storage/service, and integration queue records.
- #13 Skill registry is in progress with a pure `skill.yaml v1alpha1`
  manifest/permission/capability contract slice.
- #14 Memory is ready to claim for a pure lifecycle/retrieval/ContextPack
  selection contract slice.
- #15 Scheduler/runtime is in progress: multi-runtime presets are merged; the
  next contract is heartbeat runtime capabilities plus scheduler consumption.
- #16 Web product surface has the nav shell and backed Board merged; rich pages
  wait for #12-#15 and #17 contracts.
- #18 iOS source is done as native SwiftUI source, but first macOS/Xcode build,
  run, and test verification remains pending outside this Windows environment.

The v0.1 path proves that a task can be created in the web UI, assigned through
the server to a node/runtime adapter, executed by a mock or real `codex exec`
process, streamed back as run events, reviewed in the UI, and marked done.

Known v0.1 limitation: browser realtime through the Vite dev proxy can still hit
a dev-only WebSocket upgrade `ECONNRESET`. Production same-origin WebSocket and
direct server WebSocket paths are valid. The current E2E path reloads when it
needs to observe the final review state.

## v1 Release Definition

v1 is complete only when all of these are true:

- The full `design.md` section 12.13 chain works with real behavior, not only
  schema placeholders.
- Task DAGs can be created, unlocked, blocked, reviewed, and audited.
- Scheduler decisions use task capabilities, model profiles, effort profiles,
  computer/agent availability, and registry input.
- ContextPack generation retrieves accepted project/task memories and records
  which memory ids were injected.
- Concurrent task execution is protected by file leases, per-task workspaces or
  worktrees, and an integration queue for produced artifacts.
- Skill registry validates `skill.yaml`, records permissions/capabilities,
  participates in scheduling, and includes at least one MCP/tool proof.
- Web exposes the v1 product surfaces for board/sprint, computers, agents,
  skills, memory, runs, and audit without inventing client-only contracts.
- Security, audit, replay, docs, and demo gates are strong enough for an
  external user to self-host and evaluate the system.

## Task Map

| Task | Lane | Primary Output | Suggested Owner |
| --- | --- | --- | --- |
| #10 | Architecture/review gate | v1 contracts, review, integration, release decision | `@codex_architect` |
| #11 | Task DAG | dependency semantics, auto-unlock, blocked propagation, aggregate review | `@claude_engineer` |
| #12 | Concurrency | file lease enforcement, worktree/branch allocation, integration queue | `@claude_engineer` + `@claude_sde` |
| #13 | Skill registry | `skill.yaml` validation, permission summary, capability matching, MCP PoC | `@claude_engineer` |
| #14 | Memory | propose/curate/accept memories, ContextPack retrieval/injection | `@claude_engineer` + `@claude` |
| #15 | Scheduler/runtime | model-effort routing, registry input, second runtime adapter | `@claude_sde` + `@claude_engineer` |
| #16 | Web product surface | board/sprint, computers, agents, skills, memory, runs/audit UX | `@claude` |
| #17 | Release hardening | audit/replay bundles, policy/secrets, CI/docs/demo gates | split later |

## Phase Rules

1. Phase A freezes contracts first. Each lane starts with domain/API/event
   schemas and failing tests before broad behavior changes.
2. Phase B implements storage/server/node behavior behind those contracts.
3. Phase C integrates web surfaces against stable APIs and adds Playwright
   coverage for user-visible workflows.
4. Phase D hardens audit, security, docs, CI, demo scripts, and release gates.

Every merge must keep `main` demoable. Direct pushes to `main` were used during
v0.1 only because PR auth was unavailable on the machine; restore PR review when
GitHub auth/integration is available.

## Contract Boundaries

### Task DAG (#11)

Existing primitives:

- `tasks.parent_task_id` defines hierarchy.
- `task_dependencies` defines dependency edges.
- v0.1 dependency types are `blocks` and `artifact_required`; v1 expands the
  domain/API/DB contract to the full design set: `blocks`,
  `artifact_required`, `contract_required`, `review_required`, and
  `soft_context`.

v1 semantics to freeze:

- `from_task_id` is the prerequisite task; `to_task_id` is the dependent task.
- Dependencies must stay inside one organization and project.
- Cycles are rejected.
- `blocks`: the dependent cannot become `ready` while the prerequisite is not
  `done`.
- `artifact_required`: the dependent cannot become `ready` until the prerequisite
  is `done` and has at least one accepted/eligible artifact.
- `contract_required`: the dependent cannot become `ready` until the
  prerequisite has produced and passed review for the relevant API/schema/data
  contract.
- `review_required`: the dependent cannot become `ready` until the prerequisite
  has passed human/agent review.
- `soft_context`: the dependent can become `ready`, but ContextPack generation
  should include the prerequisite context when available.
- A blocked prerequisite propagates to dependent tasks that are not terminal.
- Retrying or completing a prerequisite recomputes dependent readiness.
- Parent aggregate review is derived from child task outcomes; parent `done`
  requires child acceptance or an explicit aggregate review action.
- The enum expansion must update `DependencyTypeSchema`, DB CHECK constraints,
  migrations, API schemas, and web types in one reviewed slice.

Expected API/event surface:

- Create/list/delete dependency endpoints.
- Read task graph endpoint for a project or root task.
- Events for dependency creation/removal, dependent ready unlock, dependency
  block, and aggregate review.

Minimum tests:

- Domain contract tests for cycle rejection and unlock rules.
- Storage/API tests for same-org/project constraints and idempotent dependency
  creation.
- Lifecycle tests for ready unlock, blocked propagation, retry recomputation, and
  aggregate review.

### Concurrency (#12)

v1 must prevent concurrent agents from corrupting one workspace.

Contract to freeze:

- File lease identity uses `lease_*` ids.
- Lease scope is organization, project, task/run, workspace root, path pattern,
  mode, holder, expiry, and status.
- Write leases conflict on overlapping path patterns. Read leases can coexist
  unless a write lease overlaps.
- Assignment or run start must reserve required write scope before process spawn.
- Lease release happens on run terminal states and on timeout recovery.
- Per-task worktree/branch allocation is recorded and included in ContextPack.
- Integration queue records produced artifacts that require merge/rebase/review.

Minimum tests:

- Path normalization and workspace escape tests.
- Conflicting lease acquisition tests.
- Run cancellation/failure releases leases.
- Two independent tasks can run concurrently when scopes do not overlap.

### Skill Registry (#13)

v1 introduces governed skills without making all tools first-class products.

Contract to freeze:

- `skill.yaml` version starts as `v1alpha1`.
- A skill declares id, version, capabilities, compatible runtimes, permissions,
  input/output schemas, approval risks, and optional MCP binding.
- Validation is pure and deterministic.
- Enabled skills contribute capabilities to scheduler matching.
- Permission summary is stable enough for web display and approval policy.

Minimum tests:

- Manifest validation success/failure fixtures.
- Capability matching from enabled skills.
- Permission/risk summary generation.
- One MCP/tool adapter proof using a fake or local MCP fixture.

### Memory and ContextPack (#14)

Existing primitives:

- `context_packs.payload`
- `context_packs.source_memory_ids`
- `ContextPack.memory.task_summary`
- `ContextPack.memory.project_notes`

Contract to freeze:

- Memories have propose -> curated -> accepted/rejected lifecycle.
- A memory has scope (`task`, `project`, `organization`, or `code`), source,
  author actor, confidence, text/payload, and timestamps.
- Only accepted memories can be injected into a run by default.
- Context builder records injected memory ids in `source_memory_ids`.
- Memory curation events are auditable and visible in task/project rooms.

Minimum tests:

- Propose/curate/accept state machine.
- ContextPack retrieval filters by project/task/scope and accepted status.
- Injected `source_memory_ids` round trip through DB and run start.

### Scheduler and Runtime (#15)

Existing primitives:

- `model_profiles`
- `effort_profiles`
- `agent_instances.model_profile_id`
- `agent_instances.effort_profile_id`
- `scheduler_decisions`

Contract to freeze:

- Scheduler scores capability match, runtime availability, computer health,
  queue depth, task priority, preferred model profile, preferred effort, and
  permission risk.
- A scheduler decision records candidates and selected model/effort profile.
- Runtime adapters expose enough detection metadata for registry matching.
- The second runtime adapter must pass the same process-adapter lifecycle
  contract as Codex: start, stream output, stop, collect artifacts, failure.

Minimum tests:

- Fast/standard/deep model-effort routing.
- Capability mismatch rejection.
- Manual override still records a scheduler decision.
- Second runtime fixture smoke through node transport.

### Web Product Surface (#16)

The web lane must follow server contracts instead of creating client-only
schemas.

First backed slice:

- Board/Sprint read model over existing `tasks(project)` data.
- Navigation shell for future Computers, Agents, Skills, Memory, Runs, and Audit
  pages.

Deferred until contracts land:

- DAG editing/viewing waits for #11.
- Lease/conflict visualization waits for #12.
- Skills page behavior waits for #13.
- Memory view waits for #14.
- Runtime/agent routing controls wait for #15.

Minimum tests:

- Component tests for each new backed surface.
- Playwright coverage for at least one real board/task workflow.
- No page should require fake server-only fields once its backing lane lands.

### Release Hardening (#17)

This lane starts after the core contracts stabilize.

Required gates:

- `npm run typecheck`
- `npm run build`
- full `npm test`
- Playwright E2E suite covering happy path, change-request/retry, approval gate,
  and one DAG unlock path
- cross-process mock runtime smoke
- gated true runtime smoke
- self-hosted dev runbook
- v1 demo script or documented manual demo path
- audit/replay bundle proof for a completed task

## Review Checklist

No v1 lane is mergeable until:

- Contract tests prove the new public behavior.
- Existing v0.1 happy path still passes.
- Event types are documented and forward-compatible.
- Idempotency and retry behavior are explicit for every write endpoint.
- Security-sensitive paths have negative tests.
- Web changes have stable dimensions, no invented contracts, and targeted tests.
- The task thread contains the implementation summary and exact gates run.
