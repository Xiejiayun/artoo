# Managed workspace validation

This wrapper is prepared source. Its repository build, phase execution and
exceptional cleanup still require root-owned runtime qualification. It does not
inherit results from the earlier artifact candidate.

## Preparation and execution

Use macOS, Python 3.10 or newer, Node **24.19.0** available as `node` on `PATH`,
and the project's already installed TypeScript/Vitest dependencies. The wrapper
does not install dependencies. Run exactly one phase from the repository root:

```sh
nice -n 10 python3 validation/managed-workspaces/run.py live
nice -n 10 python3 validation/managed-workspaces/run.py ws
nice -n 10 python3 validation/managed-workspaces/run.py journal
nice -n 10 python3 validation/managed-workspaces/run.py history
nice -n 10 python3 validation/managed-workspaces/run.py correction
```

These are separate invocations. The wrapper never chains phases or retries a
failed command. Ordinary `npm test` only collects `apps` and `packages` and does
not include this directory. Root must serialize this work with other native or
physical validation; a checkout-local lock prevents two instances of this wrapper
from rebuilding the same outputs concurrently.

Each invocation performs the following sequence:

1. Record the current Git HEAD, tracked/unignored source content and installed
   runtime/tool inputs. Provider credentials and inherited fixture selectors are
   excluded from child environments.
2. Run the complete project build with `tsc -b --force`, then the selected
   family's separate no-emit TypeScript check. Each owned command has a
   600 second budget and a 10 second cleanup budget.
   Journal, history and correction then run their existing `build-child.mjs` as a
   separate owned command with the same limits. It bundles only the two
   harness sources and keeps the canonical product graph external.
3. Record the newly built `dist` graph and installed runtime inputs. An existing
   file alone cannot qualify as a fresh build: successful forced-build and
   no-emit receipts, unchanged source and runtime pins are all required.
   Journal, history and correction also pin every file and link in their complete
   family `dist` tree before and after tests, including the generated child and
   bundle-input receipt. Their Vitest cache goes to the attempt's existing
   report directory, so no part of family `dist` is silently excluded as cache.
4. Run only the chosen phase through its dedicated Vitest config, using the
   same compiled graph. Live/WS/correction tests have a 600 second budget;
   journal tests retain 420 seconds; the separately selected history phase has
   3720 seconds. All phases keep a 10 second cleanup budget, one worker and
   20 second hooks. Only history has a 3600 second case, with its parent work
   deadline reserving the final 60 seconds for cleanup; other cases stay 90 seconds.
5. Compare exact per-file title multisets and passed statuses; verify actual
   process and fixture evidence, source/runtime stability and owned cleanup.
   Write JSON and HTML for both success and failure.

The wrapper resolves its repository root from its own location and resolves
Node from `PATH`; it contains no development-machine path or artifact imports.
It creates a private home/cache inside the attempt and a private fixture parent
under `/private/tmp`, with a unique marker and directory identity. The parent
is removed only after every acceptance check succeeds and only its marker
remains. Failures retain that parent for inspection. The wrapper never recurses
through a failed fixture directory to delete it. Successful fixtures retain
their original ownership checks and cleanup code.

## Results and scope

Each attempt writes `artifacts/managed-workspaces/attempt-<UTC>-<phase>-<id>/`.
Open its `report.html`; `result.json`, command logs/receipts, input inventories,
the original Vitest JSON and physical observations are available beside it.
Reports are generated output; stage only the validation source intentionally.

Live requires 20 exact cases, 18 genuine CLI/guardian pairs, 17 required program
entries and one real startup cancellation permitting zero or one entry, plus
two cases that must not launch a writer. Its receipt channel and uploads are
local fixtures; it does not use a real WebSocket receiver.

WS requires 26 exact cases: 10 transport cases and 16 physical writer cases.
The writer cases use real local HTTP auth/device/admin/assignment routes and
the actual WebSocket receiver, with 16 CLI/guardian pairs and 16 program entries.
OIDC, uploads and the scripted transport peers remain labelled fixtures.

Journal selects eleven exact original titles, eleven confirmed fixture cleanups,
five physical boundaries and four genuine CLI/guardian pairs. The separately
selected history phase preserves the twelfth original title and all 10,000
actual append/claim/exact-receipt triplets, with one fixture, one physical boundary
and one CLI/guardian pair. Parent-driven existing commands keep the 15 second
per-command bound and allow serialized cleanup; no long child loop, SQL seeding,
workload reduction or new product operation is introduced. The output-replay and history workloads use
the original genuine owner after physical closure without durable settlement.
Actual raw replies remain in JSON once; HTML contains compact progress and links.

Journal-family acceptance requires BOTH successful journal11 and history1 reports
with identical complete source inventories and identical complete runtime
inventories (compiled output, dependencies and harness), before/after each phase
and across both phases. Individual reports leave combined acceptance unassessed.
No skipped history counts as passed. The original failed twelve-case reports
remain failed; workload duration is observed evidence, not a performance SLA.

Correction requires its 12 exact titles, 12 confirmed fixture cleanups, 14 real
physical settlements and 14 CLI/guardian pairs. The two explicitly labelled
settlement-policy fixtures retain failed/cancelled outcomes. The first durable
claim starts the original 30 second receipt window; no pre-claim scheduling
deadline is introduced.

For all journal-family phases, physical results must match replies from the owned
fixture clients, and nonempty passive closure snapshots must cover their actual
PID/role lifetimes. Exact titles and counts do not replace those ownership and
cleanup checks. The fixtures do not independently retain ready-marker or
program-entry receipts: actual `program_entries` is `null`. Three journal paths, one history path
and 14 correction paths are required by source to wait for ready; those are
separately labelled source expectations, not measured entry counts.

Live/WS retain their existing `managed` configs, title inventory and report
environment. Journal/history/correction use their own configs and title inventories,
`ARTOO_JOURNAL_REPORT_DIR`, and matching private temporary-parent prefixes. The
shared inventory function interfaces remain available to the PostgreSQL runner.

These reports contain backend/Node evidence, with no GUI screenshots. They do
not qualify packaged clients, production providers, Mac/iOS GUI flows or
commercial readiness. Native E2E reports and photographs remain separate work.

The owned-phase helper keeps sticky observer failures and exact identity checks
before signalling. Running observations allow at most 5 seconds per `ps` call;
cleanup observations allow at most 2 seconds within the same 10 second budget.
Unknown or reused identities are not signalled. The new wrapper's exception,
timeout, observer-failure and cleanup paths must still be exercised by root;
source preparation is not evidence that those paths have run successfully.

The helper accepts phase budgets up to 4500 seconds for the explicit history phase. Its cleanup ceiling and all supplied non-history limits, priority, observer and identity policies remain unchanged.
