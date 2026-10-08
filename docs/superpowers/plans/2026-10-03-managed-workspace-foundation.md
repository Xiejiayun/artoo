# Managed Workspace Server Contract Implementation Plan

> **For agentic workers:** Use the available collaboration tools for implementation and independent review of each task. The writing-plans template's superpowers execution skills are not installed in this session.

**Goal:** Move the reviewed allocation and event-receipt server contracts into normal repository source, retaining ordinary clients and leaving managed execution disabled until its packaged client gate passes.

**Architecture:** The server validates allocation identity, current node capabilities and full event receipts. The node owns actual process/worktree authority and durable local delivery; those modules are a separate component in the same integration branch. Source relocation does not inherit the artifact candidate's runtime acceptance.

**Tech Stack:** Node.js 24, TypeScript, Fastify, Zod, Drizzle, PostgreSQL/PGlite, Vitest.

## Global Constraints

- Relocation was prepared at `3f297a4e2e169cb37c37a49a662baaeb0dc342b6`; the foundation branch now includes delivered `a1968a450b21f31f224dfd23e0a863218f57abdb` through verified fast-forwards with all candidate files preserved.
- Native execution has closed. Keep actual builds and physical validation serialized; freeze this worktree's source and Git state during each runtime attempt.
- Final candidate manifest is `206159bc9e9185cb7b6c83be3a570f81727bdf5dcdafdf133d26c137d5323c10`. Its fresh live20 and WS26 passed independently, but that acceptance does not qualify repository relocation.
- Preserve all migrations through0021; append receipt0022 and allocation0023. Preserve historical NULL receipt identity and original roots/branches.
- Before upgrading across receipt0022, drain or explicitly stop active executions and pending legacy deliveries. Old NULL-identity receipts remain unqualified and their wire replays are rejected; preservation of fresh ordinary execution does not promise lossless replay across that migration.
- No product imports from artifacts, shadow checkouts, revision directories or absolute developer paths.
- Existing clients retain ordinary execution. Managed support requires explicit local opt-in, an accepted session feature and later packaged/client verification.
- Stage only reviewed paths; milestone commits and normal main pushes follow actual tests and independent review.

---

### Task 1: Port composed server, domain, protocol and database changes

**Files:**
- Modify: `apps/server/src/app.ts`.
- Modify: `apps/server/src/auth/request-auth.ts`.
- Modify: `apps/server/src/context.ts`.
- Modify: `apps/server/src/mappers.ts`.
- Create: `apps/server/src/node-binding-allocation.test.ts`.
- Modify: `apps/server/src/node-binding.ts`.
- Create: `apps/server/src/persisted-allocation-start.ts`.
- Modify: `apps/server/src/resource-routes.ts`.
- Create: `apps/server/src/run-event-receipts.test.ts`.
- Modify: `apps/server/src/services/execution-state.ts`.
- Modify: `apps/server/src/services/lifecycle-service.ts`.
- Create: `apps/server/src/services/run-event-receipt.test.ts`.
- Create: `apps/server/src/services/run-event-receipt.ts`.
- Modify: `apps/server/src/services/run-service.ts`.
- Modify: `apps/server/src/services/scheduler.ts`.
- Create: `apps/server/src/workspace-allocation-assignment.test.ts`.
- Modify: `apps/server/src/ws/node-ws.ts`.
- Modify: `apps/server/src/ws/ws-node-transport.ts`.
- Modify: `packages/domain/src/index.ts`.
- Modify: `packages/domain/src/node-payloads.ts`.
- Modify: `packages/domain/src/schemas.ts`.
- Create: `packages/domain/src/workspace-allocation.ts`.
- Modify: `packages/protocol/src/index.ts`.
- Modify: `packages/protocol/src/node-messages.ts`.
- Modify: `packages/protocol/src/run-messages.test.ts`.
- Modify: `packages/protocol/src/transport.ts`.
- Create: `packages/protocol/src/workspace-allocation-runtime.d.ts`.
- Create: `packages/protocol/src/workspace-allocation.ts`.
- Create: `packages/db/migrations/0022_run_event_body_identity.sql`.
- Create: `packages/db/migrations/0023_workspace_allocation.sql`.
- Modify: `packages/db/src/schema.test.ts`.
- Modify: `packages/db/src/schema.ts`.

**Interfaces:**
- `ServerContext.supportsExecutionFeature?: (computerId: string, feature: string) => boolean` queries the accepted current node session.
- `requireAdministrator(ctx: ServerContext, tx?: DrizzleDb): Promise<void>` checks the actor and can hold its row in the configuring transaction.
- `qualifyRunEventMessage` in `services/run-event-receipt.ts` qualifies the complete wire event before the existing run service commits it.
- `validatePersistedAllocationStart` in `persisted-allocation-start.ts` binds persisted allocation, workspace and ContextPack before dispatch.

- [ ] Verify every source in `source-delta-and-bundle-closure.json` against its pinned SHA before copying only its32 declared target paths into this isolated worktree. Refuse overwriting any non-base local bytes.
- [ ] Review each resulting diff, especially administrator authorization, actor locking, current-session capability checks, unchanged legacy assignment and the receipt migration order.
- [ ] Preserve all existing assertions in the six declared test files. Run their actual repository versions once the native GUI slot closes:

```sh
npm test -- --maxWorkers=1 apps/server/src/node-binding-allocation.test.ts apps/server/src/run-event-receipts.test.ts apps/server/src/services/run-event-receipt.test.ts apps/server/src/workspace-allocation-assignment.test.ts packages/protocol/src/run-messages.test.ts packages/db/src/schema.test.ts
```

- [ ] Port the corresponding already-written administrator, allocation, migration and PostgreSQL regressions from the exact accepted source inventory. Keep distinct embedded and real PostgreSQL evidence; a mock or PGlite pass cannot replace multi-connection PostgreSQL coverage.
- [ ] Run repository typecheck, preview build and ordinary server/domain/protocol/database tests after engine composition; preserve failure logs and fix actual regressions before acceptance.

### Task 2: Compose the canonical node engine without enabling it

**Files:** `apps/artood/src/node-client.ts`, `apps/artood/src/process-adapter.ts`, `apps/artood/src/process-adapter-owned-receipts.ts`, `apps/artood/src/node-allocation-identity.ts`, `apps/artood/src/owned/`, `apps/artood/src/managed/`, and the existing `apps/artood/src/index.ts` exports.

**Interfaces:** Preserve `createNodeClient`, `createProcessAdapter` and all existing ordinary call sites. Add the candidate's `openLocalJournal`, `provisionLocalJournal`, `createManagedWebSocketTransport` and `createManagedNodeRunner` through relative repository `.js` imports. The exact interfaces and invariants remain those in the pinned candidate; relocating files must not redesign them.

- [ ] Use the62-source bundle map plus its type-only closure supplement to select the actual canonical producer, owned Git and worktree modules. Remove re-export shims and rewrite imports to one authority instance.
- [ ] Keep `main.ts` and client configuration opt-in unchanged for this foundation. Opening/provisioning a journal is not invoked by ordinary startup.
- [ ] Port the corresponding tests using repo-local fixtures and report paths. Replace hardcoded developer directories and candidate bundle paths without weakening actual-writer, terminal-at-exposure, source or cleanup assertions.
- [ ] Reproduce live20 and WS26 against relocated modules, and run existing node-client/process-adapter/runner/WebSocket regressions. Verify the built bundle has exactly one canonical producer, reservation and owned Git authority.

### Task 3: Validate the foundation and deliver the milestone

The first repository attempt (`attempt-20261003T113935Z-live-815ffa62`) stopped
at TypeScript build: the newly relocated DB migration test self-imported its
package's absent `dist` output. The original failed HTML and exit-2 receipt are
retained; no live cases ran. The test now imports the same function from
`./migrations.js`, matching existing DB tests. Emitted DB `dist` and build-info
files were archived before the next forced build, so that attempt starts cold
for the affected package. No assertions, exports or compiler checks changed.

- [ ] Require current candidate live20 and WS26, then fresh repository-native runtime evidence after relocation, strict typecheck, production build, migration compatibility and legacy client regressions.
- [ ] Record exact source, case inventory, process closure, report paths and original failures. This engine/server stage produces backend HTML evidence; later Mac/iOS E2E stages require their own real screenshots.
- [ ] Review the full diff independently, stage explicit source/test/plan paths and commit the accepted foundation. Integrate the completed Apple CI fix commit before the normal main push, preserving unrelated files and the recovery stash.
- [ ] Keep the packaged Mac journal worker/bootstrap, Mac settings, iOS remote configuration and screenshot gates as the next feature milestone. Foundation acceptance does not claim those user flows or commercial readiness.

## Qualification follow-up, 2026-10-03

The relocated live20 attempt passed. The relocated WS26 assertions all passed, but its outer priority observation failed; that original result remains mixed. The first journal runtime failed concurrent admission under a 50ms SQLite lock wait. After the reviewed 1000ms connection policy, eight cases passed, including concurrent admission, before the 10000-event command and queued close exceeded their fixture deadlines. Three later cases were unrun. The owned outer closed the remaining fixture client; no full journal acceptance is claimed.

The reviewed [history split plan](2026-10-03-journal-history-phase.md) now retains the twelve original titles as journal11 plus a separate history1. Both phases must pass with identical complete source and runtime inventories. The full10000 real append/claim/receipt workload remains required; its duration is measured separately from the unchanged product deadlines. Source application is complete, and all new runtime qualification remains pending.
