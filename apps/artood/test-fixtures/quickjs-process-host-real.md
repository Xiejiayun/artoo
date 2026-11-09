# Native QuickJS owner pipe fixtures

Diagnostic revision 4 is source only and has not run. Root schedules execution
in the shared Windows acceptance environment. The seven native source files
and reviewed input-flush build remain unchanged by revision 4.

Revision 3 passed all five real native-owner cases with the corrected build:
each cumulative echo arrived before the next write, all three child-create
markers arrived, the child creation returned `childStarted: false` with error
code `UNKNOWN`, and blocked-write cancellation, control EOF and the original
deadline collected real closure without an emergency kill. This is controlled
developer-target evidence, not QuickJS, HTTP, provider or product qualification.

The original revision 1 and diagnostic revision 2 runs passed the original
echo/pin-lock case, then failed the child-creation case's original 10-second
output deadline. Revision 2 received no target phase markers. These failures
do not establish that the target reached `spawnSync`, that its one-second
option elapsed, or that child creation was denied. Their cancellation collected
actual process closure, an empty Job and both target/helper EOFs. The remaining
three cases did not run. The old helper package, source copies and failure
receipts are retained; revision 3 does not replace them with a passing result.

The original helper wrote through `Process.StandardInput.BaseStream` without
flushing the Windows `FileStream` buffer. Small admission/message writes could
be acknowledged while still buffered. The native revision flushes synchronously
before admission/write acknowledgements. Revision 3 strengthens the real echo
case so subsequent large writes or stdin closure cannot hide that defect.

Prerequisites are the compiled `application-runtime-installation.js`, a reviewed
complete native publish directory with `quickjs-native-manifest.json`, and the
independently recorded manifest SHA-256. The script reuses the actual strict
manifest parser and measures every native dependency before and after each run.
It does not build, provision or declare the package qualified.

From the repository root, with actual reviewed values replacing placeholders:

```powershell
node apps/artood/test-fixtures/quickjs-process-host-real.test.mjs '<absolute native bundle directory>' 'sha256:<recorded manifest hash>' '<new absolute evidence directory>'
```

The standalone script runs thirteen cases sequentially. The original five are:

- Multiple original binary stdin writes, byte-count ACKs, cumulative exact
  stdout echo after each ACK and before the next write (starting at 22 bytes),
  actual close-input/EOF, and denied write/rename attempts on the pinned entry.
- The real one-process Job denies creation of another copy of the pinned Node
  executable; the actual Job limit/readback fields are also checked. This case
  requires the real child result (`childStarted === false` and an error code).
- A target pauses stdin. After establishing a pending unacknowledged write,
  cancellation must terminate the Job without a false write ACK.
- Actual parent control EOF terminates the owned target and collects closure.
- The original request deadline expires while the target remains active.

Revision 4 adds eight cases with exact failure codes from the unchanged native
source. Malformed/partial messages are sent only after actual target readiness.

| Case | Required native failure |
| --- | --- |
| Invalid JSON control line after admission | `control-invalid` |
| Partial final control line followed by real parent EOF | `control-partial-line` |
| First control carries sequence 1 instead of 0 | `control-sequence` |
| A second write reuses an acknowledged write's nonce | `control-nonce-reused` |
| A second write arrives while an original write is blocked | `control-write-budget` |
| Target stdout exceeds 16,777,216 bytes by one | `target-stdout-limit` |
| Target stderr exceeds 16,384 bytes by one | `target-stderr-limit` |
| Parent output reading is paused with a full readable buffer, then cancellation is sent | `control-cancel` |

Rejected controls cannot receive write ACKs. The concurrent-write case retains
the original unacknowledged write and also rejects the second without an ACK.
The duplicate-nonce case requires exactly its first valid ACK and exact first
echo. The output cases ask the fixed target for one burst at a time (64 KiB for
stdout, 8 KiB for stderr); the parent observes the exact cumulative bytes before
sending the next token. Only after the unchanged cap is reached is the final
one-byte excess requested. Pacing keeps this test below the helper queue bound
and does not extend the original 15-second native lifetime.

The backpressure case pauses the original helper stdout reader before requesting
512 KiB of fixed target bytes. It observes a full paused readable buffer and a
fixed, exclusively created atomic checkpoint in the new case directory. The
checkpoint records only completion of the target's actual stdout write; it is
not process ownership, Job emptiness or closure evidence. The test sends cancel
while paused, resumes reading after 200 milliseconds within the existing cleanup
budget, and still requires the original terminal, process exit/close and all
EOFs. It does not claim to observe target exit before reading resumes. Output
not yet relayed and an ACK not yet sent may be suppressed by cancellation; any
observed ACK must still correspond to the actual original input. The checkpoint
and all raw control/output data remain in the evidence directory.

Every case retains its launch, controls, ordered frames, raw helper stdout and
stderr, original exit/close observations and terminal receipt. Every closure
requires actual process exit, Job empty, both natural target EOFs, settled I/O,
unchanged pins, and the original helper's exit/close and both natural EOFs.
Normal and terminated outcomes have separate assertions. A bounded emergency
kill always fails the assertions; it never substitutes for native closure.
The script neither deletes evidence nor accepts a reused output directory.

The retained revision 2 diagnostics add exactly three bounded stdout phase
markers to the child case:
admission parsed, immediately before child creation, and after the synchronous
call returns. Each marker awaits the original stdout write callback before the
next phase. The first is emitted after mode configuration is read, so its
absence still cannot distinguish entry loading, admission or configuration.
The return marker records the actual synchronous-call duration. Markers do not
prove a denial, and the runner still requires the separate original child
result within one original 10-second event deadline; no phase resets that
deadline. The native lifetime remains 15 seconds and the child call's timeout
option remains 1,000 milliseconds. Only these phase markers and the result are
accepted, with ordered sequences, lines of at most 512 bytes and total output
of at most 2,048 bytes. Compact `childCreate` observations and raw frames are
retained on success or failure. No retry, longer deadline, or skipped assertion
is introduced.

Expected execution is approximately 30–60 seconds for all thirteen serial
cases, subject to the actual machine; this is an estimate, not a measurement.
Every ordinary case retains its 15-second original native lifetime, the existing
deadline case retains 5 seconds, and all event waits retain 10 seconds. Original
cleanup/uncertain-close bounds and emergency-kill failure criteria are unchanged.
The stdout overflow case deliberately retains at least 16 MiB of real target
output plus its encoded raw helper stream and receipts; it cannot be replaced
by metadata or a smaller production cap.

The target is the developer-authored `quickjs-process-host-target.mjs`, copied
to the native protocol's fixed entry basename in each fresh case directory.
It waits for the real admission line before loading its mode or attempting a
child process. This tests actual Windows ownership and pipe behavior with
controlled target code. It executes no QuickJS/Wasm, generated product or
database, and establishes no protected production installation or LPAC claim.
