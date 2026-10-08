# Mac mixed per-run execution implementation plan

> **For agentic workers:** Execute the tasks below in order with source review between milestones. The parent agent owns implementation and all runtime work. This is a bounded source/design handoff, not a test result or permission gate.

**Goal:** One Mac worker continues ordinary assistant, planning and task runs, and executes explicitly allocated task runs through the qualified managed journal/physical process path.

**Architecture:** Keep one NodeClient, runtime registry and WebSocket per enrolled computer. Use the qualified managed session when a journal binding exists, but route events by an immutable local per-run mode: ordinary runs retain their existing receipt/replay stream; allocated runs retain the journal's claimed one-shot delivery. Never convert an allocated run to ordinary execution to make it pass.

**Tech stack:** TypeScript, existing Node 24 runtime, Electron 44.4.3 as Node, worker-thread `node:sqlite` journal, existing PostgreSQL receiver, React desktop renderer.

## Global constraints and evidence scope

- Source inspected in `/Users/jeremy/workspace/artoo-managed-workspaces`, Git HEAD `a1968a450b21f31f224dfd23e0a863218f57abdb` plus its uncommitted managed foundation. `source-pins.json` records the files actually read; it is not a full frozen runtime inventory.
- No source, main, tracked document, test, build, process probe or GUI change was made for this handoff. This plan supersedes the managed-only product choice in the 2026-10-03 bootstrap design.
- Keep genuine launch permits, full immutable start identity, unknown-owner rejection, run-wide Stop fences, exact event/attempt receipts, original delivery deadlines and producer-closure checks. Managed frames never enter the ordinary replay map.
- Preserve existing trust consent, runtime/provider configuration, allowed roots and all foundation physical/transport/journal/correction gates. No mock receipt can qualify a physical boundary.
- The new path remains Mac-only until another platform has independent physical/journal qualification. An absent journal binding retains today's ordinary constructor.
- Every client E2E attempt, including startup failures, gets an HTML report with its actual available screenshots; zero-photo startup failure must explicitly say zero.

## Verified incompatibilities to fix

| Current source | Consequence | Required change |
| --- | --- | --- |
| `node-client.ts:390–393` asserts a managed session and rejects every start without `workspace_allocation`. | Ordinary assistant/planning commands fail when the worker is globally switched. | Permit explicit ordinary admission only in the new mixed option; retain managed-only fixture default. |
| `managed-ws-transport.ts:274–278` rejects every `transport.send(run.event)`. `streamStartedRun` sends ordinary output, artifacts, typed retention and lifecycle through that API. | Deleting only the start rejection still stops normal workflows. | Add an ordinary event lane to the same qualified socket, selected only by a locally bound run mode. |
| `ws/node-registry.ts:17–18` stores one binding per computer. The receiver checks the current binding before business frames. | A second ordinary socket would replace the managed connection. | Do not compose two existing socket factories or advertise two workers with the same ID. |
| The current ordinary start path does not consult the journal. Existing journal `admitStart` already accepts `mode: legacy` and atomically conflicts with `per-run`. | After restart, removing allocation from a previously managed run could bypass its durable identity/fence if the guard is merely removed. | In a journal-bound worker, admit **both** modes before filesystem or adapter side effects. Only a fresh ordinary admission can execute ordinary code. |
| `onRunStop` already durably fences unknown IDs, but `onRunResume` treats any durable nonclosed row as unknown. | Ordinary mode cannot be inferred solely from `physicalStarts`, especially after reconnect/restart. | Bind and remember per-run mode before dispatch; handle current ordinary handles first, then durable recovery. Never infer a stopped producer from a legacy journal row. |
| `main.ts` only constructs `createArtoodNode`; runner fatal errors only set a getter; idle journal-worker failure has no public notification. | A failed worker can remain alive and look healthy until another operation. | Add lifecycle failure notification and a bootstrap owner that stops producers before closing the journal and exits nonzero on fatal failure. |
| Desktop reports stopped on any requested-stop exit; `daemonStatus` promotes state from server heartbeat alone. | An uncertain managed cleanup or stale/wrong readiness can be presented as success. | Correlated child ready/stopped messages plus exit evidence; preserve the active handle on the existing 12-second observation timeout. |
| Bundler emits only `artood.mjs`; journal loads `new URL('./journal-worker.js', import.meta.url)`. | Packaged journal cannot open yet. | Bundle a CJS worker beside the daemon and prove installed sidecar bytes and actual Electron-as-Node operation. |
| Allocation setting has PATCH/DELETE server routes, but web API client/agent forms have no controls. | Enabling the local worker alone never configures a user-accessible allocated assignment. | Add a small per-agent workspace setting using those routes, then exercise normal and allocated work in one installed worker session. |

## Concrete interface choices

These are new local interfaces, not wire fields. Keep `RunStartCommand`, managed receipt contract and PostgreSQL schema unchanged for mixed routing.

```ts
type RunDeliveryMode = "legacy" | "managed";

// New trusted local option on ManagedJournalOptions. Absent preserves the
// existing managed-only foundation fixture behavior.
interface MixedRunRouting {
  readonly allowNewAllocations: boolean;
  bindRun(runId: string, mode: RunDeliveryMode): void;
}
// ManagedJournalOptions gains: readonly mixed?: MixedRunRouting
// ManagedWebSocketOptions gains: readonly allowLegacyRuns?: boolean
// ManagedWebSocketTransport gains: bindRun(runId, mode): void
// ManagedNodeRunnerOptions gains: readonly mixed?: { allowNewAllocations: boolean }

interface ManagedBindingV1 {
  readonly version: 1;
  readonly serverOrigin: string;
  readonly nodeId: string;
  readonly directory: string;
  readonly controllerScope: string;
  readonly expectedNamespace: string;
}
// ArtoodConfig gains: managedJournal?: ManagedBindingV1
//                    allowNewAllocations?: boolean
// Journal gains: readonly failed: Promise<Error>
// ManagedNodeRunner gains: readonly failed: Promise<Error>
// ArtoodNode gains: readonly failed?: Promise<Error>
```

`failed` resolves once with the first unexpected failure; it does not reject unobserved. Intentional successful close never resolves it. Calls still reject on failure as today. Resolve it synchronously when failure is latched, before awaited cleanup. Multiple cleanup errors are retained in an `AggregateError`, not substituted for the initiating failure.

`bindRun` is monotonic within one worker: absent → selected mode; same mode is idempotent; another mode throws. Only NodeClient's admitted start or checked recovery path calls it. Socket reconnection never clears these mode tombstones. In mixed mode `channel.exposeOnce` requires `managed`, and ordinary `transport.send(run.event)` requires `legacy`; both reject an unbound ID. In managed-only mode existing behavior remains valid without new caller plumbing.

## Task 1 — Mixed NodeClient admission and routing

**Modify:** `apps/artood/src/node-client.ts`, `managed/managed-delivery.ts`, `managed/managed-node-runner.ts`. Add focused tests in `node-client.test.ts` and a real mixed writer case beside `validation/managed-workspaces/managed/managed-writer.test.ts`.

- [ ] Add the local option/interfaces above and retain the existing managed-only default. Product bootstrap alone supplies `mixed`.
- [ ] For an allocated start keep `allocationStartBinding`, the detached full payload identity, genuine journal admission and producer bridge unchanged. Refuse fresh allocated admission when `allowNewAllocations` is false. Known physical/replay/recovery records must still receive Stop/resume handling.
- [ ] For an ordinary start with a journal, use `journal.admitStart({ expectedNamespace: journal.namespace, runId, idempotencyKey: command.idempotency_key, payload })` before any materialization or adapter invocation. It already freezes/parses the full payload and computes a legacy launch key. Only `kind === 'fresh'` permits the ordinary path; use `admitted.payload`, bind `legacy`, and retain the returned key for duplicate comparison. `conflict`, `fenced`, `unknown`, and a pending/replay row without this process's recorded attempt never authorize another start.
- [ ] Install the ordinary admission/start record synchronously before the first journal await, as physical starts already do. Matching duplicates join that record's settled startup outcome, including admission rejection. Changed payload or mode rejects; do not use the present unconditional accepted ACK for a duplicate whose mixed admission failed. Keep only mode, key and startup outcome after completion, not the ContextPack or handle.
- [ ] After fresh admission, ordinary workspace materialization, adapter selection, stream transformation, artifact upload, retention sequencing and cancellation stay on the existing ordinary methods. The legacy journal row is a **durable identity fence only**. Do not call `startOwnedProcess`, `recordStarted`, fabricate a closure receipt, append managed events or label that row physically closed. It remains retained; a restart cannot adopt its old process. Current live handles continue to use existing Stop/resume behavior.
- [ ] Check Stop after each new admission await and immediately before ordinary adapter start. Unknown Stop persists the existing run-wide fence before its accepted ACK. A Stop racing ordinary admission must not allow adapter start after the ACK. Current ordinary handles get their normal confirmed `adapter.stop` behavior; old legacy rows without a handle reject as unknown, not `process_exited` or a fake clean Stop.
- [ ] In recovery, bind `managed` only after the exact durable per-run row/physical receipt is checked. Drain only eligible closed delivery; reject unknown producers. A legacy row can never enter `ManagedDelivery`.

**Necessary tests and exact assertions:**

1. Same worker executes ordinary assistant-shaped and planning-shaped commands, then an allocated task and another ordinary task. Ordinary adapter starts exactly once each; allocated owned bridge starts exactly once; only the allocated run has managed outbox/physical receipt rows.
2. Simultaneous identical ordinary starts wait for admission/start completion and return the same outcome. Failed admission gives two rejected ACKs and zero starts.
3. Ordinary → allocated and allocated → ordinary mode changes reject both before and after journal reopen. Modified ordinary ContextPack under the same run ID rejects. No filesystem change, permit reuse or second writer.
4. Stop before either mode's first start, Stop during ordinary admission and Stop just before invocation result in zero subsequent starts. Stop after invocation joins the actual producer stop; its ACK is not a journal-only proof.
5. Fresh run IDs work after restart. Previous ordinary rows do not respawn; unknown managed rows stay unknown. A closed managed row can deliver its exact saved events and cannot invoke the adapter.

The retained legacy row is an explicit limit of this minimum integration: it does not add durable ordinary output recovery or certify a legacy producer after a worker crash. Do not sell it as either. Implementing authenticated durable execution for non-worktree tasks is a separate requirement, not a reason to downgrade managed proof today.

## Task 2 — Ordinary events on the qualified socket

**Modify:** `apps/artood/src/managed/managed-ws-transport.ts`. Add `managed-transport` tests and reuse the established ordinary `ws-transport.test.ts` behavior assertions. Keep the ordinary socket implementation itself unchanged unless extracting a truly identical queue helper makes the patch smaller.

- [ ] Add the monotonic run-mode map and route only locally bound legacy events into a private ordinary pending-event map. Use a copied, schema-validated frame so later caller mutation cannot change replay bytes.
- [ ] Retain ordinary behavior: required events resolve only on accepted committed receipts; rejected receipts reject; `run.output` with `best-effort` drops while disconnected and never occupies required-event capacity; typed retention has its original 30-second first-enqueue deadline; replays never reset that deadline. Retain the existing 1,000 pending-entry bound and add an 8 MiB total encoded pending-byte bound. Apply the managed body's 1 MiB per-event limit and frame's 4 MiB limit to copied ordinary frames; release exact byte counts on settle/close. Capacity rejection must flow through existing stream failure/physical Stop handling, never drop a required event silently.
- [ ] Replay ordinary pending entries only after a new generation's qualified ready + first matching pong. An ACK is eligible only if this exact entry was actually sent on the current usable generation. Old socket ACKs and unsolicited ACKs never settle it. On final close/fatal reject all ordinary pending promises so shutdown can join them.
- [ ] Managed `exposeOnce` retains its own map, original attempt/deadline/hash checks, capacity limits and **no automatic replay**. The run-mode guard prevents tuple collisions with the ordinary map. ACK dispatch chooses exactly one lane by the bound run ID, never broadcasts to both.
- [ ] Control frames still use the current qualified session. Keep the existing 30-second connection-loss grace and fatal close for the whole journal-bound worker; no hidden fallback to an ordinary socket on incompatible ready, timeout or journal failure.

**Necessary tests and exact assertions:** interleave legacy and managed sequence 0 on different run IDs; both ACK independently. Attempt both lanes for the same run ID and reject the wrong lane before a socket write. Drop the connection after one event of each mode: only legacy bytes replay automatically, and only after first pong; managed retry occurs only from a newly journal-authorized claim with the original deadline. A stale generation receipt, wrong run/sequence, duplicated receipt, best-effort output receipt and mutated frame do not clear another pending event. Capacity pressure in either lane cannot reclassify a frame or grant a new attempt.

## Task 3 — Journal/bootstrap lifecycle and prepared-profile continuity

**Modify:** `apps/artood/src/managed/journal-types.ts`, `journal.ts`, `managed-node-runner.ts`, `main.ts`, `main.test.ts`. **Create:** `apps/artood/src/managed/managed-bootstrap.ts` and its focused lifecycle test.

- [ ] Expose `failed` from journal worker failure and runner failure. Bootstrap watches both immediately after creation; any failure synchronously latches shutdown and stops all current ordinary and managed runs before journal close.
- [ ] Keep `createNodeFromConfig(config): ArtoodNode` synchronous. If no binding exists, return today's ordinary node. If a binding exists, return a lazy bootstrap owner: `start()` opens **exactly** that binding, constructs the mixed runner from the existing registry/hello/heartbeat/uploader/workspace arguments, then awaits ready + first pong. Do not import `main.ts` from the helper.
- [ ] Implement one coalesced start and one coalesced stop. Stop sets its latch before any await, joins in-progress open/start, prevents a late open from connecting, awaits producer/stream cleanup, closes link, then closes journal. Startup failure uses the same cleanup path. A journal error never removes captured physical stop authority.
- [ ] `installShutdownHandlers` observes `node.failed`; fatal or failed cleanup exits 1 even when cleanup later physically succeeds. Successful requested shutdown exits 0 only after all owned cleanup joins. Do not exit while `stop()` is still unresolved merely to satisfy the desktop timer.
- [ ] Parse complete binding plus a boolean new-allocation choice. Suggested envs: `ARTOO_MANAGED_EXECUTION`, `ARTOO_JOURNAL_DIRECTORY`, `ARTOO_JOURNAL_NAMESPACE`, `ARTOO_JOURNAL_CONTROLLER_SCOPE`; node ID/server origin come from the existing enrollment/URL and must match the saved binding. A partial or malformed binding rejects before connecting.
- [ ] **After a profile has been provisioned, disabling new allocations keeps opening the same journal and qualified socket**, with `allowNewAllocations: false` and the allocation execution feature omitted. This preserves fences and pending delivery. It must not switch that profile back to an unguarded ordinary worker. First-use profiles without a binding remain ordinary. A prepared profile whose journal cannot open fails visibly rather than bypassing history.

**Tests:** stop before open; stop during open; late open success after Stop; ready failure; journal failure while idle and while both run modes are active; simultaneous signal/IPC/fatal notifications; both runner and journal close fail; failed stop does not exit 0. Each test asserts exact create/connect/stop/close/exit counts and order. These are lifecycle tests, not substitutes for the real writer gates.

## Task 4 — Explicit preparation and truthful desktop status

**Modify:** `apps/desktop/connection-store.cjs`, `desktop-controller.cjs`, `main.cjs`, `preload.cjs`, related tests; `apps/web/src/vite-env.d.ts`, `components/DesktopSetup.tsx` and its tests. Add a narrow provision command path to `apps/artood/src/main.ts` before normal env parsing.

- [ ] Add `prepareManagedWorkspace()` IPC, Mac-only and allowed only while the worker is stopped. It takes no renderer-supplied path/namespace. Canonical desktop user-data plus normalized origin and enrolled node ID select a versioned private profile. Use a deterministic SHA-256 profile key and a stored random controller scope. Token rotation reuses the same binding.
- [ ] Persist a preparation intent containing profile identity, unique attempt/request ID and exclusive journal leaf before launching `[daemonEntry, '--provision-managed-journal']`. The child receives only the fixed local location and correlation identity, calls `provisionLocalJournal`, returns `{type:'journal.provisioned', requestId, namespace}`, disconnects and exits. This branch must not read provider keys, open WebSocket or build adapters. Observe matching reply **and** successful owned child exit before persisting the completed binding.
- [ ] Store bindings and incomplete intents privately outside the renderer-editable daemon object. Write with mode 0600, sync file, rename and sync parent directory; the current connection-store save has rename but no fsync. Keep prepared bindings/intents across opt-out, logout, server changes and re-pairing. Never reset, create a replacement for a failed same-profile intent, adopt a marker or read raw SQLite from desktop code.
- [ ] On a different origin/node select its distinct existing profile or require its explicit preparation. Preserve old files. On successful same-profile preparation show “Ready for separate task workspaces”; failed/interrupted preparation shows retained incomplete setup and no enabled execution feature. Save remains separate from Start.
- [ ] Every worker launch explicitly clears or overwrites all managed env keys, as it already does for Codex provider keys. A persisted binding is supplied even when new allocations are disabled. Inherited shell settings cannot enable this feature.
- [ ] Pass a fresh launch ID over owned IPC. The child emits `{type:'worker.ready', launchId}` only after journal open and first pong, and `{type:'worker.stopped', launchId}` only after successful joined cleanup. Desktop accepts only its current child/generation. For journal-bound workers “running” requires this reply plus a fresh matching server heartbeat; “stopped” requires the stopped reply and exit 0. A nonzero requested-stop exit is failed; a missing reply is uncertain, never clean.
- [ ] Retain the current 12-second desktop observation budget. Timeout leaves the child handle and stopping/uncertain state, blocks reconfiguration/start and lets eventual owned cleanup finish. `before-quit` already keeps the app open on stop failure; preserve it. Do not add a kill-all or mask cleanup by increasing the budget.

**Tests:** repeated Prepare cannot launch two provisioners; a mismatched/late reply cannot enable a profile; reply without exit 0 fails; exit 0 without reply fails; preparation crash leaves intent/files; restart reuses exact namespace; opt-out still passes binding but removes new feature; origin/node changes cannot reuse another binding; unprepared ordinary launch clears inherited keys. A Stop exit 1, IPC error, stale ready, stale heartbeat and 12-second timeout cannot report clean stopped/running.

## Task 5 — Packaged sidecar and user-accessible allocation setting

**Modify:** `apps/desktop/scripts/bundle-daemon.mjs`, `packaged-e2e-smoke.mjs`; `apps/web/src/api/client.ts`, `components/InventorySetup.tsx`, `InventoryPages.tsx` and tests. Existing `daemon/**` include/unpack rules need no new glob.

- [ ] Add this second esbuild output alongside the existing main build:

```js
await build({
  entryPoints: [fileURLToPath(new URL("../../artood/src/managed/journal-worker.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("../daemon/journal-worker.js", import.meta.url)),
  bundle: true, platform: "node", format: "cjs", target: "node24",
});
```

- [ ] Verify daemon and sidecar bytes in the unpacked installed application, and run actual provision/open/close under **that installed Electron executable** with `ELECTRON_RUN_AS_NODE=1`. Check `node:sqlite`, CJS worker loading, boot-session clock, private local boundary and full owned process closure; stock Node or a test-only worker cannot qualify this.
- [ ] Add API methods `setAgentWorktreeBase(id, {version:1,strategy:'per-run',basePath})` and `clearAgentWorktreeBase(id)` using existing PATCH/DELETE `/agent-instances/:id/worktree-workspace-base`. Add one owner/admin-only form in an agent's existing workspace configuration area: “Separate workspace for each task” plus an absolute base folder. Render the saved `instance.config.worktree_workspace_base`; do not require people to edit JSON.
- [ ] Preserve server validation of current feature session, Mac OS, active/unconfirmed runs and administrator role. Display the server's real conflict message and retain form input. Do not claim saved until the API commits and bootstrap reloads. Local allowed-root configuration remains a distinct requirement, not a grant created by this form.
- [ ] Do not add allocation settings to the room composer or planning prompt. Existing `assignTask` allocates only branch-backed runs from the selected instance's saved setting. Ordinary branchless assistant/planning commands remain ordinary. iOS uses the same assignment API and displays existing task/retention results; its full device flow still requires its own E2E.

**UI tests:** role gating; render saved/absent setting; exact PATCH/DELETE payload; unchanged input after 409/offline; no optimistic saved badge; accessible labels; ordinary agent registration unchanged. Keep these tests focused on decisions the user can observe.

## Task 6 — Acceptance sequence and milestone commits

- [ ] Qualify Tasks 1–2 with the current managed foundation suites plus mixed routing tests, ordinary NodeClient/WebSocket regressions and a real same-worker mixed writer scenario. Commit a reviewable internal capability milestone, still not selected by product startup until lifecycle/package gates are ready.
- [ ] Qualify Tasks 3–4 lifecycle/persistence tests, forced TypeScript build and noEmit. Check the normal browser production build still excludes Node-only implementation. Commit the bootstrap/desktop setup milestone only with honest pending packaged acceptance.
- [ ] Run a fresh installed Mac E2E using one worker child: configure/prep → normal conversation → team planning → normal task → allocated branch-backed task → per-run Stop → another normal conversation → restart same binding → closed delivery recovery → another allocated task. Assert real command payload modes, distinct allocated roots, retained worktree bytes, committed typed retention before successful terminal state, one process start per run, exact receipt identity, unchanged source inventories and actual owned closure. Capture Settings, ordinary response, accepted plan, task progress, allocated path/result, stopped task and restarted worker as original PNGs in the HTML report.
- [ ] Run iOS task assignment/Stop/result viewing against that Mac worker on the same server, alongside the existing native ordinary assistant/planning/task workflows. Capture real native screenshots; do not use web screenshots to claim native acceptance.
- [ ] Include failure cases in a separate bounded installed attempt: unavailable/mismatched journal, missing sidecar, incompatible receiver, lost ACK plus reconnect, worker restart with unknown owner and Stop timeout. Each must retain data, avoid second writers, show an honest product state and produce its own HTML report. Do not mutate a user's journal; use owned fixture profiles.
- [ ] Independent review reconciles HTML photos, actual producer/receipt events and package/source pins before each main fast-forward/normal push. A green mocked lifecycle suite alone does not accept the installed graph.

No approval or new external configuration is needed to implement this plan. Live-provider, signing/notarization, physical-device/TestFlight and general commercial acceptance remain separate evidence requirements of the full project goal.

## Root implementation allocation

Root copied the frozen foundation source delta into the clean reused checkout `/Users/jeremy/workspace/artoo-mac-planning-scroll`, on `user/jiaxie/mixed-managed-execution` at documentation head279af8c. The source foundation remains unchanged and frozen for journal/history qualification. Tasks1–2 may be implemented here; all runtime remains serialized by root. This copy does not inherit acceptance for new mixed behavior.
