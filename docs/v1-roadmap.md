# Artoo v1 Roadmap

This document is the v1 coordination source of truth. It turns the accepted
v0.1 MVP into a release plan for the full "agent team operating system" loop
described in `design.md` section 12.13.

## Baseline

Accepted v0.1 is on `origin/main` at `eec68d8`.

Current v1 status:

- This status snapshot includes implementation changes through `75726a5`
  (#23 gated assign-to-server-to-node real-git branch worktree smoke).
- #11 Task DAG is done: dependency CRUD, ready unlock, blocked propagation,
  aggregate review, and evidence gates are merged.
- #12/#20 Concurrency Phase A+B server work is done: file lease contracts,
  lease storage/service, run-start reservation, terminal release, workspace root
  recording, and patch/pull_request integration queue enqueue are merged.
  #23 branch-backed worktree activation is also merged with a gated real-git
  server-to-node seam smoke.
- #13 Skill registry Phase A is done with pure `skill.yaml v1alpha1`
  validation, permission summary, runtime-aware capability contribution, and
  fake/local MCP descriptor contracts.
- #14/#21 Memory is done: pure lifecycle/retrieval contract, durable memory
  storage, curation APIs, supersession, accepted-only context retrieval, and
  assign-time ContextPack persistence with exact `source_memory_ids` are merged.
- #15 Scheduler/runtime is in progress: multi-runtime presets, heartbeat
  runtime capabilities, server persistence, and scheduler consumption of
  `agent_runtimes` are merged. Gated true Claude runtime smoke and future
  `compatible_runtimes` scheduler refinement remain open.
- #16 Web product surface has the nav shell and backed Board merged; Memory can
  now build against #21 APIs, while richer Computers/Agents/Skills/Runs/Audit
  pages still need backed contracts.
- #17 Release hardening has its first audit-bundle contract merged:
  `GET /api/v1/tasks/:id/audit-bundle` exports deterministic task evidence and
  redacts credential-shaped values at the public evidence boundary. A v1alpha1
  export envelope now provides a deterministic SHA-256 over the redacted bundle,
  with cryptographic signing explicitly deferred until key management exists.
  A local v1 demo script now drives create -> ready -> assign -> mock run ->
  accept -> audit export verification. Broader CI/release gates remain. A local
  v1 gate script and release runbook live in `docs/v1-release-gates.md`.
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
| #13 | Skill registry | `skill.yaml` validation, permission summary, capability matching, MCP PoC | `@claude` for Phase A; storage/API review by `@claude_engineer` |
| #14 | Memory | propose/curate/accept memories, ContextPack retrieval/injection | `@claude_engineer` + `@claude` |
| #15 | Scheduler/runtime | model-effort routing, registry input, second runtime adapter | `@claude_sde` + `@claude_engineer` |
| #16 | Web product surface | board/sprint, computers, agents, skills, memory, runs/audit UX | `@claude` |
| #17 | Release hardening | audit/replay bundles, policy/secrets, CI/docs/demo gates | split later |
| #18 | iOS app | native SwiftUI mobile control surface | `@claude` |
| #19 | Concurrency node | artood workspace root/worktree materialization | `@claude_sde` |
| #20 | Concurrency server | run-start lease reservation/release and integration queue flow | `@claude_engineer` |
| #21 | Memory server | durable curation APIs and ContextPack source-memory evidence | `@claude` |
| #22 | Memory web | memory curation and source traceability UI | `@claude` after #21 API |

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

Merged contract:

- File lease identity uses `lease_*` ids.
- Lease scope is organization, project, task/run, workspace root, path pattern,
  mode, holder, expiry, and status.
- Write leases conflict on overlapping path patterns. Read leases can coexist
  unless a write lease overlaps.
- Lease paths are canonical lowercase workspace-relative keys; real filesystem
  workspace roots preserve source case.
- Assignment reserves declared `write_paths` as run-held write leases before
  dispatch. A conflict aborts the whole assignment and leaves the task `ready`.
- Lease release happens on completed, failed, cancelled, and rejected
  `run.start` recovery.
- Runs record `workspace_root` and `workspace_branch`; branch remains `null` in
  the ordinary-workspace path until true worktree activation is explicitly
  enabled.
- Integration queue records `patch` and `pull_request` artifacts that require
  merge/rebase/review. Other artifact types are not enqueued.

Remaining:

- Gate branch-backed worktree activation on artood `worktreeBaseRepo`, server
  `workspace_branch`, and a true git worktree smoke on a real base repo.
- Add product UI for lease conflicts and integration queue state only after the
  queue worker/product contract is defined.

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

Merged contract:

- Memories have proposed, accepted, rejected, and superseded lifecycle states.
- A memory has scope (`task`, `project`, `organization`, or `code`), source,
  author actor, confidence, text/payload, and timestamps.
- Only accepted memories can be injected into a run by default.
- Superseding an accepted memory atomically creates the replacement as accepted,
  links old/new ids, transitions the old memory to superseded, and makes the old
  memory non-retrievable.
- `GET /api/v1/memories/context` returns accepted-only memories and exact
  `source_memory_ids` using the pure selector order.
- Code memories are project-bound, never organization-global.

Remaining:

- Assign builds and persists a ContextPack in the same transaction as run
  creation, records exact `context_packs.source_memory_ids`, and sets
  `runs.context_pack_id`.
- ContextPack policy write scope dedupes by canonical lease key while preserving
  source-case filesystem paths for runtime policy.
- Web Memory curation/source-traceability UI should build against the merged
  #21 API rather than fake memory behavior.

### Scheduler and Runtime (#15)

Existing primitives:

- `model_profiles`
- `effort_profiles`
- `agent_instances.model_profile_id`
- `agent_instances.effort_profile_id`
- `scheduler_decisions`

Current contract:

- Scheduler scores capability match, runtime availability, computer health,
  queue depth, task priority, preferred model profile, preferred effort, and
  permission risk.
- A scheduler decision records candidates and selected model/effort profile.
- Runtime adapters expose enough detection metadata for registry matching.
- The second runtime adapter must pass the same process-adapter lifecycle
  contract as Codex: start, stream output, stop, collect artifacts, failure.
- artood registry heartbeats report runtime capability tags, and the server
  persists them in `agent_runtimes`.
- Scheduler consumption should LEFT JOIN `agent_runtimes` by
  `(organization_id, computer_id, runtime)`: missing rows fall back with
  `runtimeCaps=[]`; disabled rows are excluded; rows with null/stale
  `last_seen_at` are excluded; fresh non-disabled rows contribute runtime caps.
  Runtime staleness is strict `serverNow - last_seen_at > 30_000` ms by default,
  and version is non-gating.
- Seeded `runtime_mock` must have `last_seen_at = now` so existing mock flows
  remain schedulable.

Minimum tests:

- Fast/standard/deep model-effort routing.
- Capability mismatch rejection.
- Manual override still records a scheduler decision.
- Second runtime fixture smoke through node transport.
- Runtime-only capability routing, disabled/stale/null-row exclusion, missing
  row fallback, capability subset mismatch, and strict staleness boundary.

### Web Product Surface (#16)

The web lane must follow server contracts instead of creating client-only
schemas.

First backed slice:

- Board/Sprint read model over existing `tasks(project)` data.
- Navigation shell for future Computers, Agents, Skills, Memory, Runs, and Audit
  pages.

Deferred until contracts land:

- DAG editing/viewing can now build against #11.
- Lease/conflict visualization can now build against #12/#20 read surfaces, but
  integration queue actions still need a product/server contract.
- Skills page behavior can build the Phase A manifest/permission contract, with
  storage/API work still required for a true product page.
- Memory view can now build against #21 curation/context APIs.
- Runtime/agent routing controls wait for #15 scheduler consumption and richer
  Computers/Agents APIs.

Minimum tests:

- Component tests for each new backed surface.
- Playwright coverage for at least one real board/task workflow.
- No page should require fake server-only fields once its backing lane lands.

### Release Hardening (#17)

This lane is active. The first merged slice is a deterministic task audit bundle
endpoint that exports task, room, messages, runs, artifacts, approvals,
scheduler decisions, and ordered event log evidence.

Required gates:

- `npm run typecheck`
- `npm run build`
- full `npm test`
- `npm run verify:v1`
- Playwright E2E suite covering happy path, change-request/retry, approval gate,
  and one DAG unlock path
- cross-process mock runtime smoke
- gated true runtime smoke
- self-hosted dev runbook
- v1 demo script or documented manual demo path. `npm run demo:v1` now provides
  a build-backed API demo with audit export verification.
- audit/replay bundle proof for a completed task. v1alpha1 export now provides
  a deterministic SHA-256 over the redacted bundle.
- signed/exportable audit bundle format, or a documented decision to defer
  signing from v1. v1 now documents the signing deferral decision; signed
  archives still require a future key-management slice.
- policy/secrets negative tests for filesystem scope, branch worktree roots,
  credential handling, and approval-gated operations. Credential-shaped values
  in public audit bundles now have automated redaction coverage; branch worktree
  roots now have a gated real-git smoke; broader policy coverage still remains.

## Review Checklist

No v1 lane is mergeable until:

- Contract tests prove the new public behavior.
- Existing v0.1 happy path still passes.
- Event types are documented and forward-compatible.
- Idempotency and retry behavior are explicit for every write endpoint.
- Security-sensitive paths have negative tests.
- Web changes have stable dimensions, no invented contracts, and targeted tests.
- The task thread contains the implementation summary and exact gates run.
