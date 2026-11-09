# Windows target input native fixture

Status: **fresh r6 passed all seven native input cases and the subsequent ordinary-node compatibility case** on 2026-11-09 (Asia/Shanghai). Both original commands exited/closed 0 with null signals, both output EOFs and no observer errors; neither suite skipped or cancelled cases. The wrapper confirmed exact environment restoration. Evidence remains under `windows-target-input-compatible-20261109-r6` in the external native-development directory, including `WINDOW-RESULT.json`, `INPUT-REVIEW.json`, the original limited input pins and per-case results. The separate target-control matrix passed all 18 cases in `windows-target-control-20261109-r3/control-18`, also with original command exit/close 0 and both EOFs. These runs used the installed helper manifest `sha256:6890cf79448444cdb08854fb166657a2b02f4c3ab617e1c0fe422957f961ffe0`.

The fixture leaves `held-reader` outside all `process.stdin` access, matching the passed target-control descendant's handle-retention behavior. The child still must send its actual PID over the original IPC channel before the root naturally exits; all existing five-second readiness, root-exit, child-identity and native closure assertions remain unchanged. In r6 the original root emitted `root-leaving-reader` with the actual child PID and `eofBeforeRootExit:false`, exited 0 naturally, and the original helper reported `lingering_processes` followed by confirmed Job/EOF/helper closure. This exercises the fixture fix without treating its deliberate lingering-child cleanup as normal application shutdown.

The ordinary-node case verifies Git bootstrap, author execution and independent reviewer verification using its existing controlled installation-admission callback. It does not qualify production ACL admission. The seven input cases and 18 control cases retain their production helper installation checks. None of these controlled compatibility results establishes live-provider, installed-product or product-publication acceptance.

Earlier failed attempts remain retained. In r4, six input cases passed and `root-exit-reader` failed: both original processes emitted ready, but the unchanged five-second IPC deadline expired before `root-leaving-reader`, and the root exited 1. Actual Job/EOF/helper cleanup was confirmed. This locates that failure at fixture IPC admission without proving a specific Node/libuv mechanism. In r5, one case passed and six failed after the fixed worker's ctime changed during `idle-initialize`; bytes, file ID, size and mtime remained unchanged. Later cases did not launch, so r5 did not exercise the held-reader fix. A read-only EA observation recorded the kernel file-hash cache entry; the attempt and its original input baseline were preserved. Fresh r6 used unchanged source/native bytes and retained strict per-case timestamp, identity and hash checks, with no cache setter, warmup or input-integrity exception.

Earlier evidence remains retained: the first native attempt completed with five passes and two failures at commit `3f017a8`. Typecheck, the full workspace build and the fresh native build passed beforehand. Its timeout case observed the original timeout and full cleanup, but the final input check detected a changed worker ctime; the descendant case failed on that same check before launch. Worker bytes, file ID and mtime remained unchanged, with the cause unresolved in that attempt. The original command exited 1 with both output EOFs. No previous attempt or input baseline was overwritten.

Do not run while another acceptance workload pins the build, source, dependencies, installation or machine. The task owner must schedule an exclusive native validation window first. Do not retry a failed input binding by resetting its baseline.

`windows-target-input-real.test.mjs` uses the real built TypeScript owner and exact installed Windows process helper. It retains the production installation checks, including ACLs, physical paths, full bundle inventory and independently supplied manifest SHA-256. It never substitutes a permissive qualification callback. The target worker uses only Node standard libraries; no WSL is involved.

The seven sequential cases cover:

- An ordinary launch without the new option receives NUL EOF and has no `endInput` method or target-input closure extension.
- Initialization actively reads stdin for 300 ms without receiving input or EOF, then voluntarily closes its own read endpoint and exits normally. The parent sends no input. Successful closure requires the original native writer-close fact.
- A target consumes exactly 4096 `A` bytes and EOF, validates its actual contents, and exits normally. The caller mutates its original buffer after submission. The original ACK must bind the copied bytes, digest, request and launch; it does not replace full process closure.
- A target consumes the fixed shutdown message and EOF but deliberately remains alive. A subsequent original-Job member observation must traverse the helper control pipe before cancellation. This detects closing helper control stdin together with target stdin.
- An idle input target is cancelled without receiving a message.
- An idle target receives no message or cancellation from the fixture until its original 30-second operation deadline. The final result must retain timeout, never normal success. The node/native deadline may win first, so native termination may be `timeout` or the node's `cancelled` request.
- A root naturally exits after spawning an actual descendant that retains the inherited stdin read endpoint and standard output handles. The descendant never accesses/resumes `process.stdin`; it must report ready and send its actual PID through the original IPC channel while retaining that handle. The descendant uses Node's detached child mode so the root's private libuv child-lifetime Job does not end it; this does not request breakaway from the native owner's non-breakaway Job. The descendant deliberately stays alive. `require-empty` must report `lingering_processes` and confirm subsequent original Job closure. Forced cleanup in this negative case is not normal application shutdown.

Every case requires the original in-process receipt: exact root identity, atomic Job membership, original process wait, both output EOFs, Job zero, actual helper spawn/exit/close, zero helper exit and confirmed cleanup. Selected input additionally requires versioned pipe/request/byte/close facts. All original results and logs are retained, including successful controlled negative cases. Serialized evidence is never reused as process authority.

## Scheduled execution

First build the composed TypeScript candidate and a fresh native bundle through the existing build/runbook procedures. The bundle must advertise `artoo.windows-target-input.v1`, and the separately recorded manifest digest must come from that exact build. Install it through the normal protected installation procedure. Do not edit ACL checks, reuse an older manifest, or point the fixture at unqualified temporary output to obtain a pass.

The evidence directory's parent must already exist, and the final directory must be new. After the task owner opens the native window, set these values in that same shell and invoke the fixture from the repository root:

```powershell
$env:ARTOO_WINDOWS_TARGET_INPUT_NATIVE_WINDOW = '1'
$env:ARTOO_WINDOWS_PROCESS_BUNDLE = 'C:\artoo-installed\windows-process-host-reviewed'
$env:ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256 = '<separately-recorded-sha256:hex-digest>'
$env:ARTOO_WINDOWS_TARGET_INPUT_EVIDENCE_ROOT = 'C:\artoo-evidence\windows-target-input-new-run'
node --test --test-concurrency=1 apps/artood/test-fixtures/windows-target-input-real.test.mjs
```

The placeholder paths and digest must be replaced with actual reviewed local bindings. Use a location outside the source checkout for the evidence root; it cannot overlap the protected helper installation. The fixture exclusively creates the evidence root, binds its own script, worker, Node executable, the two directly imported built owner/installation modules and installed native manifest by physical identity, timestamps and hash, then rechecks those bindings before and after each case. This small pin set is **not the complete JavaScript dependency graph** and does not establish that the complete installed application runtime version stayed unchanged. The production backend independently validates the complete native helper bundle. `inputs.json` records those limited pins; each case contains `stdout.log`, `stderr.log` and `result.json`. The fixture does not delete any evidence or workspace directory. A missing result, process closure failure or changed input is a failed or incomplete attempt, not a skipped success.

The outer command still needs the project's normal observer to retain its actual spawn, exit, close and stream EOF outcomes. An inner `result.json` cannot establish that the overall test command closed correctly. A qualification or startup failure before target creation is retained and fails the affected case; it is not a native input success.

## Remaining coverage

The 4096-byte case does **not** prove that `WriteFile` blocked. Windows may buffer the complete message. Deliberately blocked I/O, native `WriteFile`/`CloseHandle` failure injection, exact accepted-but-not-yet-writing root-exit ordering, malformed raw native control frames and nested helper Jobs need separate focused native/source-linked regressions. The TypeScript controlled protocol suite covers different wire and acknowledgement faults; it does not provide kernel evidence for them.

This matrix also does not exercise a Guardian/Supervisor lifetime, whole application install/service/reopen, real model providers, two computers, signed packaging or product publication. Those remain separate acceptance gates. Existing native and provider failures must remain retained in subsequent validation.
