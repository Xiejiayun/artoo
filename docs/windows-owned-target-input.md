# Windows owned target input

Status: source implementation and controlled regression cases only. This increment
has not been compiled, built, tested or exercised with a native helper. It does not
enable application publication, qualify a node, or replace application acceptance.
The application verification bootstrap is integrated with this owner in source;
its composed native behavior remains untested. Existing product qualification and
unsupported-publication gates remain.

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

The controlled TypeScript cases simulate transport events and do not establish
Win32 handle behavior. The separately gated native fixture sources are documented
in [their README](../apps/artood/test-fixtures/windows-target-input-README.md).
After scheduling, run the focused protocol suite, the project checks, a fresh
native build and the exact installed-bundle fixtures. Native cancellation, setup
and pipe failure, nested Job behavior and actual application bootstrap execution
must be qualified before this can support a live product acceptance claim.
