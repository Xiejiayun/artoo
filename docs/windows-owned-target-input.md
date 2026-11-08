# Windows owned target input

Status: TypeScript checks, the full workspace build and a fresh native build have
passed. The first real native fixture at `3f017a8` passed five of seven cases;
the remaining two failed an input-identity check described below. This increment
does not enable application publication, qualify a node, or replace application
acceptance. The complete application bootstrap sequence still awaits actual
execution. Existing product qualification and unsupported-publication gates remain.

`startWindowsOwnedProcess` has an optional local selection:

```ts
targetInput: { version: 1, mode: "single-message-eof", maximumBytes: 4096 }
```

The pinned installation manifest and the original helper's `ready` frame must both
advertise `artoo.windows-target-input.v1`. A missing manifest capability fails
before launch; a missing ready capability prevents target dispatch. Calls without
this selection retain NUL target stdin and expose no `endInput` method. The
synchronous Guardian collector input protocol remains separate and cannot select
this extension.

Binding a locally prepared application verification profile also requires this
capability from the original backend's pinned manifest, after the full local
installation audit. An older bundle is rejected before that profile can advertise
application support. Ordinary and static-web profiles keep their existing binding
behavior; serialized profile or backend capability claims confer no authority.

After `started`, `endInput(bytes: Uint8Array)` copies exactly one 1–4096-byte
message. It cannot be called again, after root exit, or after cancellation. Invalid
local bytes are rejected before consuming the single request. A new UUID binds the
private `target_input` frame to the original launch token; canonical base64 carries
the copied bytes. No target argument or environment value carries this message.

The original native owner creates an inheritable read end and a non-inheritable
write end. The target's fixed inheritance list contains only the read end and its
existing output handles. A dedicated thread owns the write end after an explicit
transfer. It performs the actual `WriteFile` and checks the full byte count, then
checks the actual `CloseHandle`. Only then can it enqueue `target_input_closed`,
containing the request ID, byte count, SHA-256 and `inputClosed: true`. The node
checks every field against its copied request and marks only its original frozen
receipt as an `OriginalTargetInputReceipt`. A serialized copy is evidence, not an
original receipt.

This closes target stdin only. Helper control stdin stays open for cancellation,
original Job membership observations and terminal protocol. The ACK deadline is
at most five seconds and never exceeds or renews the original operation deadline.
A timeout or cancellation rejects pending input and invokes the existing owner
cancellation path. A later genuine ACK is checked against the retained request;
it cannot restore success or erase a termination reason. Duplicate, unrequested,
malformed or rebound ACKs fail the control protocol.

An initialization target may finish without needing input. The writer stays open
until the main owner observes the original root HANDLE signaled. Only then may
the idle writer close without writing or sending an ACK. A request accepted but
not started when that exit wins fails; an already-started write remains owned
until the kernel call returns. Root exit may legitimately precede the ACK when a
target consumes EOF and exits quickly, so an existing request still waits for its
original ACK, terminal frame, cancellation or fixed deadline.

Neither the main owner nor the control reader holds the writer's state lock during
kernel I/O, closes its handle concurrently, or waits synchronously for its thread.
The original Job deadline and `require-empty` descendant policy remain active
even if a write blocks. Cancellation terminates the original Job. A writer whose
close is not confirmed cannot produce successful native cleanup. Final cleanup
also waits until the writer's ACK enqueue attempt finishes, so `complete` cannot
overtake that ACK.

Selected launches add optional versioned `targetInput` facts to the final closure:
`pipeCreated`, `writeRequested`, `requestId`, `bytesWritten` and `inputClosed`.
No-input natural exit records a null request ID, zero bytes and an actually closed
writer. A setup failure before pipe creation records no pipe and no close. These
facts are additional to atomic Job enrollment, the original root HANDLE wait,
both output EOFs, Job-zero and actual helper exit/close. An input ACK alone cannot
substitute for any of those checks or for internal runtime/broker normal closure.

The four complete controlled suites passed 198 tests after correcting an
incomplete routing fixture; the original 194-pass/four-failure result is retained.
Typecheck and the full workspace build passed. The official native builder used
.NET SDK 10.0.403 to produce a fresh win-x64 bundle; that ordinary build result is
not a dedicated compiler-process ownership qualification.

The first installed-bundle fixture ran on 2026-11-09 (Asia/Shanghai). Ordinary
NUL input, initialization without premature EOF, the copied 4096-byte message,
control-pipe use after input ACK, and cancellation passed with original native
closure receipts. The 30-second timeout case observed timeout and complete native
cleanup, but failed its final input check because the worker file's ctime changed.
Its bytes, file ID and mtime remained equal; the cause is unknown. The descendant
case then failed before launch on the same input mismatch. The outer command
closed with exit 1 and both output EOFs. This is a failed overall attempt, retained
without resetting the baseline or weakening checks.

The native fixture and remaining coverage are documented in
[its README](../apps/artood/test-fixtures/windows-target-input-README.md).
Blocked I/O, native pipe failure, nested Job behavior and actual application
bootstrap execution still require qualification for live product acceptance.
