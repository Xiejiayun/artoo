# Mixed bootstrap journal-failure validation — prepared source

This family is source preparation only. No build, typecheck, test, worker,
process or GUI execution is claimed. It is separate from the existing M01/M02
mixed-writer phase and is not collected by ordinary `npm test`.

The two exact titles in `title-inventory.json` define the intended checks:

- F01 starts the real lazy managed bootstrap with a prepared journal,
  `allowNewAllocations: false`, allowed roots and no worktree repository. After
  the real qualified WebSocket session becomes ready, an actual idle journal
  worker failure must trigger automatic session closure without a run or an
  explicit test-initiated Stop.
- F02 starts one ordinary and one allocated task through real authenticated
  routes on different instances. Both genuine CLI/guardian pairs must be live
  before the journal fault. All two CLI and two guardian lifetimes, including
  exit, stdio close and PID/process-group absence, and session closure must be
  observed automatically before the test explicitly joins bootstrap Stop.

The module-loader observer forwards the native Worker constructor and its
arguments unchanged and returns the actual native worker. It selects only the
owned journal open worker by its canonical compiled worker URL and exact
fixture directory, excluding the separate provisioning worker. The fault is
the native `terminate()` operation on that captured handle. The fixture must
retain the actual worker ready/exit observations and termination outcome; it
must not manufacture an error event, failure promise, durable receipt or
producer-closure authority. Private worker control keys are not report data.

All product imports use one freshly compiled repository graph, including the
real journal worker and `managed-bootstrap.js`. The child-process observation
layer delegates to actual native spawn, preserving canonical process-adapter
authority. Real journal failure is expected to keep bootstrap Stop rejected;
that rejection is distinct from physical cleanup observations. An unexpected
cleanup error or unknown process lifetime remains a failure. Read-only SQLite
observations must not turn legacy identity rows or physically observed closure
after journal loss into invented durable managed settlement.

Execution requires the root-owned serialized runtime slot, frozen inputs,
macOS, Node 24.19.0, Python 3.10 or newer, and already installed dependencies.
The outer wrapper owns the forced complete repository
build, this family's no-emit check, input inventories, finite phase/cleanup
deadlines and HTML/JSON reporting for both success and failure. It must supply:

- `ARTOO_MANAGED_VALIDATION_PHASE=mixed-failure`.
- An existing absolute `ARTOO_NODE_PHYSICAL_REPORT_DIR`.
- An owned temporary parent under
  `/private/tmp/artoo-ws-journal-validation-` with its `.validation-owner`
  marker, selected as the child's temporary directory.

After root releases the runtime slot and reviews this source, run one attempt:

```sh
nice -n 10 python3 validation/managed-workspaces/mixed-failure/run.py --execute
```

The wrapper reuses the unchanged shared orchestrator and `support.owned_phase`,
including the checkout lock, full source/dependency/runtime inventories,
600-second build/typecheck bounds and 10-second owned cleanup budget. Its
single test phase has a 240-second bound. There is no retry, installation,
generated harness bundle, automatic next phase or change to M01/M02 counters.
Every attempt writes `report.html`, including failures before a case starts.

Inside that owned preparation, the selected commands are:

```sh
node node_modules/typescript/bin/tsc -p validation/managed-workspaces/mixed-failure/tsconfig.json
node node_modules/vitest/vitest.mjs run --config validation/managed-workspaces/mixed-failure/vitest.config.ts
```

The config selects only `mixed-failure.test.ts`, with one worker, no file
parallelism, 90-second tests, 20-second hooks, bail 1 and no retries. Existing
compiled files alone are not freshness evidence. Exact titles, actual
observations, owned cleanup and unchanged inputs must all qualify the attempt.

`tests/mixed-failure-observations.json` preserves the two case outcomes, exact
provision/open worker identities and ready/exit observations, native terminate
results, first-failure/automatic-closure/explicit-join ordering, original errors,
actual HTTP/wire records and command hashes, program-entry/context hashes,
CLI/guardian lifetimes, before/after read-only SQLite rows and source checks.
Successful injected failure remains a rejected product Stop. Only its expected
journal errors are accepted, and only after independent physical closure;
additional errors or uncertain resources retain the fixture and fail the gate.
Reported process/entry/termination counts come from actual observations.

This family covers the real journal-failure notification, bootstrap and mixed
producer cleanup within a test process. It does not exercise `main`'s correlated
desktop IPC, an OS daemon child's nonzero exit, desktop controller status, the
installed Electron executable or packaged sidecar bytes. The receiver uses
PGlite and local OIDC/provider fixtures; independent production PostgreSQL and
live model providers are outside this scope. Reports use `photos: []`: there
are no GUI screenshots or Mac/iOS client E2E, signing/notarization or commercial
acceptance claims.
