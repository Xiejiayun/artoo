# Managed workspace validation: provisional source port

This directory is prepared source, with no build or runtime acceptance. The
latest source candidate's Stop revision still awaits its own live 20/WS 26 gate;
earlier results do not qualify these relocated tests or the repository graph.
No dependency installation, compilation, server, worker or process test was run
while preparing this directory.

## Port plan and scope

- Copy `live.git.test.ts`, `managed-transport.test.ts`, `managed-writer.test.ts`
  and their three fixtures with import-specifier changes only.
- Import all product code from the same compiled repository graph. The process
  adapter, node client, journal, owned receipts and workspace helpers must not
  be split between source modules and compiled modules.
- Preserve all exact titles, Stop-claim gates, assertions, physical spawn and
  closure observations, local fixture labels and cleanup behavior.
- Use only this explicit Vitest configuration, one worker, 90 second cases and
  20 second hooks. Root owns preparation, source/output pins, outer process
  ownership, exact-title/count acceptance, cleanup and phase HTML reports.

The repository's normal `npm test` include pattern is limited to `apps` and
`packages`; it does not collect this directory. No product configuration or
interface is changed by this port.

## Build before running

The normal complete TypeScript project build must finish successfully before
this config can be used. From the repository root:

```sh
node node_modules/typescript/bin/tsc -b
```

The root project references cover every package alias required by this config,
including `packages/client`, which is outside the server/daemon reference
closure. Root must use its reviewed owned build wrapper and preserve exact
source/output hashes. This command is documented, not executed by these files
or this preparation.

The journal's production worker URL is `./journal-worker.js` beside the
compiled journal. The complete `apps/artood/dist/managed/` output, including
`journal-worker.js`, must exist. The server test support/auth helpers and
workspace package `dist` outputs must come from the same build. The config
checks required files exist; existence alone is not a freshness receipt.

All product imports in the six tests/fixtures use repository-relative compiled paths.
The config also resolves transitive `@artoo/*` imports to those same `dist`
entrypoints and inlines workspace dist modules in Vitest. This keeps the real
`node:child_process` observation mock in the same transformed module graph as
the actual process adapter and its WeakMap authority. The mock still delegates
every spawn to the actual built-in; no process or receipt is synthesized.

Root should also run the separate validation TypeScript check after building:

```sh
node node_modules/typescript/bin/tsc -p validation/managed-workspaces/managed/tsconfig.json
```

The dedicated configuration does not inherit the root Vitest source aliases.
Do not import `apps/artood/src` or mix a source process adapter with a compiled
node client/journal. No loader shim, copied private authority or product test
bypass is provided here.

## Explicit owned phases

Root's outer wrapper must set `ARTOO_MANAGED_VALIDATION_PHASE` to exactly
`live` or `ws`, and supply an existing fresh absolute
`ARTOO_NODE_PHYSICAL_REPORT_DIR`. It must create the matching task-owned
temporary parent and its `.validation-owner` marker before Vitest starts:

| Phase | Existing fixture parent prefix | Exact selected files/cases |
| --- | --- | --- |
| `live` | `/private/tmp/artoo-live-journal-validation-` | `live.git.test.ts`: 20 |
| `ws` | `/private/tmp/artoo-ws-journal-validation-` | `managed-transport.test.ts`: 10; `managed-writer.test.ts`: 16 |

The config refuses a missing/unknown phase, missing ownership marker/report
directory or incomplete compiled graph before starting a fixture. The inherited
physical fixtures still require Darwin and Node 24.19.0. Root supplies nice 10,
finite outer phase/cleanup deadlines, isolated environment, exact before/after
source and build inventories, and actual process-group closure checks.

The phase command, after those prerequisites, is:

```sh
node node_modules/vitest/vitest.mjs run --config validation/managed-workspaces/managed/vitest.config.ts
```

It does not chain phases or retry tests. `title-inventory.json` preserves exact
per-file full-name multisets. Counts alone do not qualify a run; root must also
check all passed statuses and no missing, duplicate, skipped, pending or todo
cases, owned cleanup and unchanged inputs.

## Retained semantics and evidence limits

Live 20 uses a real compiled NodeClient, canonical CLI/guardian/Git and SQLite
worker; its session/receipt channel and upload callbacks are labelled local
fixtures. It requires 18 physical writer fixtures, 17 mandatory program entries,
one genuine spawned startup cancellation allowing 0 or 1 entry, and two zero-writer
cases. The actual total program-entry count is therefore 17 or 18, not assumed.

WS 26 retains the 10 transport and 16 real-writer cases. W cases use actual local
HTTP auth/device/admin/assignment routes, the receiver and transparent WebSocket
proxy, 16 CLI/guardian pairs and 16 actual entries. External OIDC, uploads and
scripted T peers remain fixtures. The real user-Stop gates and constructor/
fixture cleanup code are byte-preserved outside import specifiers.

The fixtures write their original JSON observations into the supplied report
directory. Vitest writes `vitest.json` there. These are backend/Node results,
not packaged-daemon, real-provider, Mac/iOS GUI or commercial acceptance. Root
must create the phase HTML and preserve failures; this directory does not run
an outer harness or claim any previous result as a new pass.
