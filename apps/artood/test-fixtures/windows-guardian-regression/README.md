# Native Guardian concurrency regression harness

Status: build r4 and all nine native regression cases passed on Windows. The original Supervisor HANDLE wait, stream EOFs and lifetime Job closure were confirmed. The three earlier failed attempts remain retained; this source-linked fixture does not establish exact-production-bundle or live-product acceptance. Do not execute while another acceptance workload still pins the source/build/dependency state.

The first run failed with `Native frame missing: guardian_result`; the original Supervisor Job, HANDLE waits and EOF cleanup were confirmed. That failed attempt is retained at `artifacts/windows-closure-repair-2026-11-07/validation/guardian-regression-run-r1/result.json`.

Update: the stdin repair compiled in r2, whose run reached the wire sequence but failed a helper's required zero-exit assertion (`2 !== 0`). Its server evidence includes the legacy reserve timeout and already-expired request rejection, and the original Supervisor Job/HANDLE/EOF cleanup was confirmed. The report's empty `cases` array reflects that `RunCases` returns its list only after all checks complete; it does not identify the failing case. This remains a failed run, retained at `artifacts/windows-closure-repair-2026-11-07/validation/guardian-regression-run-r2/result.json`.

R3 compiled and failed the `expired` wire probe. It reported the exact original `connection_dispose` failure: `IOException`, `io_error`, `nativeError: null`, with both original managed owners still open (`pipeClosed: false`, `guardianClosed: false`, `observedBeforeExit: true`). The same helper had reported peer EOF without a client timeout and then actually exited/closed with code 2 and both stream EOFs. The original Supervisor Job/HANDLE/EOF cleanup was also confirmed. R3 remains a failed run at `artifacts/windows-closure-repair-2026-11-07/validation/guardian-regression-run-r3/result.json`; neither process exit nor later Supervisor cleanup makes those earlier unclosed owners acceptable.

R4 passed against the resource-cleanup repair. The expired, unknown-version and negative-deadline probes still exited 2 after their expected rejection, but both original managed owners were now closed before helper exit. Each rejection retained its matching server nonce, expected cause, no-mutation evidence and unchanged roster. The legacy success and bounded timeout cases also passed. The retained result is `artifacts/windows-closure-repair-2026-11-07/validation/guardian-regression-run-r4/result.json`. Whole-fixture teardown used the recorded forced termination of controlled descendants; this is not normal product shutdown evidence.

This dedicated C# executable links the four actual production native source files. It does not copy the Guardian state machine, introduce a production environment switch, or add a production CLI bypass. The independent startup object supplies test coordination. Production relay, qualifier, stdio process host, Guardian server, Supervisor server, full qualification, state dispatch and lifetime cleanup functions still execute.

The self-contained executable is necessary: the native authority checks require the same image and the exact single-argument `--daemon-supervisor-v1`, `--guardian-v1`, `--guardian-client-v1` and host modes. Running its DLL through `dotnet` does not satisfy those checks.

## What the three cases establish

1. The real Supervisor gate is held behind an acknowledged `ManualResetEventSlim` barrier. A request using an actual daemon-child relay process reaches production `Handle` and `Require`; the existing production trace is observed at `supervisor_qualification`. While that request remains pending and the Supervisor gate remains held, a registered native host's real target is released through a named event. Its terminal, ACK receipt, original host/root HANDLE waits, stdout/stderr EOF and Node child close must complete first. Checking that the request is still pending prevents a false pass where its timeout merely released the old Guardian lock.
2. The same request then expires through its original cancellation/timeout path. It must finish with no mutation and unchanged authoritative roster before the Supervisor barrier is released. Releasing that barrier cannot create a later slot. No timeout message alone counts as evidence.
3. During another real pending qualification, the test replaces the Guardian's daemon-owner object with a newly opened owner of the same live PID and creation time, then disposes the old managed owner. The production snapshot must keep the original native HANDLE waitable. After full qualification returns, production snapshot validation must reject the changed original object at `commit_gate`, without a new reservation. This is a deliberate test-only state invalidation, not a supported recovery operation.

Reflection is limited to finding the original private server methods, state gate, current state/roster, and the controlled owner replacement. The Guardian and Supervisor states are constructed normally and execute their original authority checks. No uninitialized object, fabricated process object, always-valid verifier or copied authorization decision is used. Node's small `daemon.mjs` provides only the genuine Supervisor → Node daemon → Guardian/host/relay topology and bounded transport collection.

The pending reserve is an internal production-method test with an actual peer object. It does not itself test the new deadline wire decoding or replace the production named-pipe transport matrix. The host/terminal path does use the original production server and protocol. The third case has a 5-second internal test budget to permit an actual full qualification; it is not a claim that the server's 2.5-second processing bound changed.

This focused fixture pins the real Node binary, its worker script and its configuration. It does not supply a packaged daemon runtime manifest, so runtime-manifest inventory mutation remains part of the separate production-bundle matrix. The explicit held Supervisor gate is the causal delay; no duration or large-file hashing guess supplies that condition.

## Six additional deadline wire cases

The original three cases remain separate. Six more checks use real daemon-child relay processes and the actual production Guardian `Client`, `GuardianWire.Decode`, budget and `Handle` path:

- A valid old status request with the deadline field physically absent succeeds.
- An old reserve request with that field absent, blocked by the acknowledged real Supervisor gate, expires at the server's own processing limit.
- An already expired v1 deadline is rejected without a mutation.
- An unknown deadline version and a negative tick value are rejected by the server, not a sender-side validator.
- A `long.MaxValue` future cutoff cannot extend the server processing limit. C# serializes this Int64 directly, avoiding JavaScript number precision loss.

Ordinary single-argument `--guardian-client-v1` helpers go directly to production `Program.Main(args)` before any fixture stdin read or console encoding change. The earlier fixture consumed stdin and installed a `Console.SetIn` replay; production `MainRelay` resets input encoding, which can discard that replay and leave EOF. The fixture no longer pre-consumes or replays ordinary stdin.

Only the dedicated test assembly recognizes `ARTOO_GUARDIAN_REGRESSION_RAW_WIRE=v1`. The fixed Node worker sets it only for the six raw wire cases, retaining the exact single-argument native mode. That explicit selector enters the `fixtureWireCase` stdin parser; missing selectors use production directly and unsupported selector values fail. The wire probes use the production `GuardianConnection` constructor to authenticate the exact server and then write through its original reader/writer, deliberately bypassing only `Send`'s automatic deadline insertion/clamping. No production environment switch, entry point or option is added.

Missing-frame failures retain at most three valid `native_failure_diagnostic` stderr records, projected to bounded `phase`/`code` identifiers and a null or bounded numeric `nativeError`. Arbitrary stderr, exception text, paths and other payload fields are omitted. The original combined 1 MiB output bound and all actual child exit/close/EOF checks remain; a diagnostic alone cannot authorize a pass or replace closure evidence.

The probe retains one bounded `fixture_wire_failure` with a fixed scenario/stage, the original request's nonce digest, a `resultEmitted` flag, safe exception type/category and native error number. `resultEmitted` becomes true only after the complete result write returns. The exact original `GuardianConnection.Dispose()` call is marked `connection_dispose`; every exception is rethrown, and the helper still exits 2. Its catch observes `IsClosed` on the same original pipe and Guardian managed-owner objects before that helper exits. It does not duplicate, reopen, AddRef or independently dispose their handles. These managed flags are not kernel close confirmation or Job/EOF evidence.

Both the Node collector and the outer C# case runner enforce the raw helper outcome. Ordinary production relays and the successful legacy wire request still require exit 0. Only the five fixed negative wire scenarios may take either of these paths:

- Exit 0, with no helper failure diagnostic, after an exact nonce-bound error reply or exact `guardian_peer_eof` result.
- Exit 2 with exactly one `connection_dispose` / `IOException` / `io_error` / `nativeError: null` diagnostic. It must match the scenario and nonce digest of the completely emitted result, whose shape must be `replyKind: null`, `nonceBound: false`, `peerClosed: true`, `transportError: "guardian_peer_eof"`, `clientTimeout: false`. All three original-owner observations must be true: `pipeClosed`, `guardianClosed`, and `observedBeforeExit`.

Both paths require the actual helper's spawn, exit, close, null signal and stdout/stderr EOF observations. The worker preserves the exit code and bounded failure evidence in the returned case facts; it does not turn a failed child into a successful production operation. It rejects duplicate or malformed failure frames instead of assuming a truncated one-element array proves uniqueness. Oversized or invalid-JSON raw-probe diagnostics also fail. An unexpected native failure diagnostic, other exception/phase/native error, missing original owner, client timeout, partial result or other exit code fails. In particular, R3's real false/false owner observation still fails the new strong assertions in both layers.

Each rejection still requires an actual server diagnostic with the exact request nonce digest, the expected server error code and `mutationStarted=false`, plus an unchanged original roster after the qualification barrier is released. C# independently checks that the diagnostic is the same request's real Handle/parser rejection before checking its cause. The legacy-timeout and far-future cases also require the server's own `supervisor_qualification` stage and elapsed clock near its 2.5-second maximum (2.0–3.5 seconds, with a 4-second wire envelope). An outer client timeout, absence of logs, or merely seeing EOF cannot pass. Diagnostic publication is awaited through a file-change notification and a bounded read of the existing fixed diagnostic file; diagnostics are supplementary causality evidence and never closure authority. No negative scenario passes until its original roster and whole-run Supervisor closure assertions also pass.

## Build and run after the freeze is lifted

Use native Windows x64, a stable .NET 10 SDK, and an absolute physical path to `node.exe`. Choose fresh build, intermediate and evidence directories; retain earlier results. Example from the repository root:

```powershell
dotnet publish apps/artood/test-fixtures/windows-guardian-regression/WindowsGuardianRegression.csproj --configuration Release --runtime win-x64 --self-contained true --output C:\artoo-builds\guardian-regression-next -p:BaseIntermediateOutputPath=C:\artoo-builds\guardian-regression-next-obj\
C:\artoo-builds\guardian-regression-next\Artoo.WindowsGuardianRegression.exe --run 'C:\Program Files\nodejs\node.exe' C:\artoo-evidence\guardian-regression-next
```

`daemon.mjs` must remain beside the published test executable. The native Supervisor pins its bytes, the Node executable and the generated local configuration. Existing production ACL/reparse/identity guards still apply; do not weaken them to make a test launch succeed. If the example Node location differs on the machine, use its actual reviewed physical path.

`result.json` includes all nine case results and the production Supervisor's `lifetimeClosure` / incarnation facts. Passing requires the original lifetime Job to be observed empty, the original daemon HANDLE wait and EOFs, and the parent's original Supervisor HANDLE wait plus stdout/stderr EOF and exit. The harness delegates cleanup to `DaemonSupervisorState.CleanupLifetime`; it does not reimplement that closure decision. Forced termination of controlled fixture descendants is recorded as test cleanup, never normal product completion. Failure containment may terminate the exact spawned Supervisor process; that fallback cannot produce a passed result.

The test assembly has a same-user-only Guardian inspection pipe and fixed test operations. Its randomly named Node coordination pipe is confined to this short-lived fixture and accepts only fixed operations. It contains no production tokens or user workload. The entire descendant tree remains in the original production shared lifetime Job.

## Remaining verification

R4 compiled the current fixture contract against the reviewed production cleanup changes and passed all three causal cases, all six wire cases and the whole-run closure checks. Preserve its captured source/build hashes and all three earlier failed results. Subsequent source changes require a fresh build and run; a missing result is failure.

The separate `windows-guardian-real.mjs` matrix also passed against the exact production native5 bundle: ten cases, one additional synchronous-interruption regression and eleven normal Supervisor stops, with authenticated outer Job closure and both EOFs. Its evidence is retained in the local `guardian-native-2026-11-07-native5-r1` validation output and Root observation record. This source-linked test executable is not that production binary; new native source changes still require both validations. Packaged-runtime and live-product acceptance remain separate.

This small harness intentionally does not implement the whole ten-case draft plan. More malformed wire types, connection-gate cancellation variants, post-commit authoritative fsync uncertainty, diagnostic-pressure barriers and broader epoch/registration/transfer races still require their focused regressions. None of these controlled checks establish live-provider product acceptance, day-to-day Windows readiness, two physical computers, signed distribution or publication.
