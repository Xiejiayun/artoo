# Fixed application runtime channel

This child-side component joins the existing application wire codecs to an actual
`ApplicationQuickJSSession`. It creates no listener, process, interpreter, database,
broker, storage permission or release capability. The fixed runtime entry must
provide its own original session. Structural TypeScript types do not prove that
the supplied session, Wasm module or native owner is qualified. Every status keeps
`qualifiedForProduct: false`; there is deliberately no `settled` result.

Only the three channel files are added by this increment. Existing session,
bootstrap, broker, wire and native source remains unchanged.

## Direction, ordering and readiness

One original session can be consumed by only one channel. Its own `receive`,
`pump`, `drain`, `close` functions and status getter are captured once. Replacing
those properties afterward cannot redirect this channel. The fixed caller owns
the session exclusively; it must not independently pump, close or send to it.
An unexpected native Promise return is rejected and its rejection is observed
with the captured native Promise intrinsic. Trusted `node:util/types.isPromise`
recognizes original Promise objects even with changed prototypes or subclasses.
They are never awaited into synchronous success. Every session status must be
the actual six-field plain data record; tagged Promises, status getters and extra
fields cannot become readiness or disposal evidence. Arbitrary thenables are not
inspected, invoked or accepted.

A single persistent `ApplicationWireDecoder("host-to-application")` owns incoming
fragments, UTF-8, strict fields, direction and consecutive sequence validation.
Only after that entire available chunk has decoded successfully are `version`
and `sequence` removed and each message serialized into the original session's
`receive`. A rejected second complete frame prevents delivery of the valid first
frame from that same chunk. This is not rollback of earlier chunks or data work.
Initialization does not buffer requests: `receive` before actual session readiness
fails closed. The owner calls `advance` to progress initialization first.

The existing decoder makes shutdown terminal. A complete or partial trailing frame
in the same chunk rejects before shutdown is delivered. A valid shutdown follows
its valid prefix in order and must leave the original session closed with confirmed
VM disposal. A shutdown arriving while this adapter still has queued output fails;
it cannot silently discard that output as successful delivery. Actual input EOF
is a separate later observation.

## Pumping and backpressure

`advance` performs at most one original `pump`, and only when this channel's output
queue is empty. The session retains its existing absolute deadline, operation and
job limits, including at most 64 individual jobs per pump. Initialization that is
still pending is not drained or reported ready. A ready session is drained once;
at most 64 primitive JSON strings are validated and encoded using one persistent
`ApplicationWireEncoder("application-to-host")`. The entire output batch must
encode and fit its lifetime budgets before any frame from that batch is queued.
Malformed strings, sparse/accessor arrays, direction errors and excess budgets
cannot expose a valid prefix from that batch.

`readOutput` returns a copied FIFO chunk no larger than 65,536 bytes, including
frame headers. Caller mutation cannot change a future chunk. It only transfers
bytes out of this adapter's queue. `handedOffBytes` does not mean that an OS write
finished, that the broker received anything, or that a transaction succeeded.
The original transport owner must await actual writes and bound its own queue
before it reads more output or asks the session to advance. No asynchronous I/O,
automatic loop or independent timer is hidden inside this component.

Lifetime limits are 8,192 input chunks, 4,096 input and output messages, and the
session's 32 MiB input / 16 MiB output byte budgets plus 64 bytes per allowed
message for the canonical wire envelope and four-byte header. All raw input bytes,
including whitespace and failed input, count. Empty chunks count too. These are
separate transport limits; they do not increase the session's decoded-text budget.
Output queue size is bounded by the remaining lifetime output budget. A stalled
external consumer cannot make this adapter keep pumping and adding output.

## EOF, cancellation and uncertainty

Only the original stream owner may call `endInput` on actual natural stdin EOF.
The persistent decoder checks for a truncated frame before the original session
is closed. Pending output makes EOF fail closed. An EOF during initialization
closes that scope; it never converts unresolved initialization into readiness.
`inputEnded` records the caller's declaration, not independently observed OS EOF.

`close` is the trusted owner's cancellation/disposal operation. It discards any
queued output and records the exact discarded byte count. It neither claims to
send those bytes nor requests a broker rollback. This adapter does not schedule
invocations, cancel broker permissions, interpret idempotency or infer that a
response ends all application work.

Errors latch a fixed category, drop retained output and attempt the original
session close once. A throwing close, unavailable status read or unconfirmed
disposal remains uncertain permanently. Later calls or externally changed status
cannot upgrade `guestDisposed`. Confirmed VM disposal is still distinct from
original process/Job closure, pipe EOF, broker settlement or HTTP delivery.

## Integration and validation scope

The next fixed runtime entry must install the reviewed raw Wasm boundary before
instantiation, obtain admitted immutable artifacts, create its actual session,
and drive this channel from its original bounded pipes. It must handle real write
backpressure and native deadlines. The later service coordinator must serialize
broker commands, route wire bytes, retain cancellation/COMMIT uncertainty and wait
for actual guest and broker closure. This channel does not provide those owners.

Focused tests use controlled session methods and the actual persistent wire
encoder/decoder. They cover fragmentation, Unicode, sequence, terminal shutdown,
initialization, FIFO/backpressure, captured methods, byte/message limits and sticky
cleanup. They do not execute QuickJS, generated code, native children, a provider
or an HTTP service. Executed test results are reported separately after the run;
this source document is not a claim that those checks passed.
