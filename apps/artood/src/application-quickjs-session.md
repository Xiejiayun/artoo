# Explicit QuickJS application session

This component uses the real synchronous `quickjs-emscripten` 0.32.0 public API.
Its structural types describe those existing methods; there is no abstract
evaluate-product callback or Node evaluator. A future fixed owner supplies the
original fresh `QuickJSWASMModule`, immutable artifact capture and guarded boundary.
The module is consumed once. The session itself creates one original runtime and
context, with a 128 MiB QuickJS heap limit and 512 KiB stack limit. These are not
Wasm, Node, process, Job or host-allocation ceilings.

The module has no `dispose()` method in this release. Cleanup explicitly frees
owned values, the context and runtime. `guestDisposed` reports only these API
lifetimes, never pipe EOF, OS process closure, broker settlement or rollback.
The caller still owns boundary closure and actual native ownership. Every status
record keeps `qualifiedForProduct: false`.
If final handle/scope cleanup is uncertain, that uncertainty remains permanent
for this session; repeated `close()` calls cannot upgrade `guestDisposed` to true.

## Loading and exact handle ownership

The artifact owner supplies the fixed `server/handler.js` entry, captured module
bytes, and original relative-module resolver. No filesystem, package, URL or Node
fallback exists. Module loader calls are limited to 1,024 and their context must
be the original context. The captured owner enforces canonical final membership;
the session does not narrow its accepted relative-path spelling aliases. Compiler
restrictions and compiler-to-artifact causality remain separate requirements.

`application-runtime-guest-bootstrap.js` is the fixed toolchain logical ID. It
must be a measured, trusted IIFE expression that returns the existing
`createApplicationRuntimeGuest` factory, without publishing a product global.
It is obtained with `readToolchain` from the original capture, limited to 1 MiB,
and decoded as strict UTF-8. It runs in QuickJS before the product module. The
factory, module namespace, guest-local `handle`, guest API, `receive` and `drain`
are retained only as host-owned QuickJS handles. Product code is never evaluated,
imported, required or converted to a host function in Node.

Module evaluation uses `{type: "module"}`. `getPromiseState` distinguishes a
pending top-level await, an independently owned fulfilled result, and an owned
rejection. In 0.32, `notAPromise: true` returns the **borrowed original input**;
the session transfers its already owned evaluation handle to the namespace and
frees it exactly once. A real Promise result has its own handle, which is tracked
before checking the deadline. The borrowed `context.undefined` is never disposed.
Errors are disposed without `dump`, string coercion or product error formatting.

Loader rejection records a sticky failure and returns a fixed error object, as
the actual public loader contract permits. The raw import boundary may reject
that non-string result terminally. Neither path disposes the runtime while a
QuickJS loader callback is still on the original interpreter stack. Cleanup occurs
only after evaluation or pumping returns to the host session.

## Boundary integration

The original raw Wasm import adapter must be installed before instantiation/start.
After setting memory/stack/interrupt, the session calls `boundary.onRuntime`.
After creating the context and installing its exact loader/normalizer, and before
any evaluation, it calls `boundary.onContext`. This lets the adapter retain the
real runtime/context/FFI and original loader function identities.

The required `boundedReadString(context, handle, maxBytes)` must inspect the actual
FFI pointer and bound UTF-8 decoding before host allocation. The session first
checks primitive string type and obtains its code-unit length via `getProp` and
`getNumber`, then uses that original reader and independently rechecks UTF-8 bytes.
The decoded UTF-16 length must exactly equal the original guest string length:
`QTS_GetString` exposes a C string, so embedded NUL truncation fails closed.
Plain `context.getString` is not a valid raw-boundary implementation. The session
does not call `getString`, `dump`, `newFunction`, `newHostRef` or `resolvePromise`.
An injected trusted callback is an interface requirement, not isolation evidence.

## Jobs, input, output and shutdown

Every pump uses only positive `executePendingJobs(1)` calls, at most 64 per call
and 4,096 for the entire session. The actual default/negative argument drains
without a finite count, so it is never used. Empty queues do not turn unresolved
top-level await into success. After readiness, empty queues also do not establish
handler or data-operation settlement.

The owner supplies one absolute monotonic deadline no more than 30 seconds ahead;
upload, loading, jobs and response validation cannot renew it. Backward/nonfinite
clocks fail closed. Interrupt checks use that original deadline and sticky failure.
API operations are capped at 8,192 independently of the clock. This is a finite
development session, not persistent service scheduling or a native watchdog. A
synchronous Wasm call still needs the qualified external resource/lifetime owner.

`receive` and `drain` use the existing wire-message shape without transport
version/sequence fields. The existing encoder validates the complete frame budget;
the external owner retains actual framing, sequencing and writes. Incoming JSON
is limited to 4,096 messages / 32 MiB. Draining reads at most 64 primitive strings,
with independent frame, 4,096-message and 16 MiB lifetime output budgets. It does
not dump an arbitrary guest array/object. Cancellation is an existing `cancel`
message to the portable guest. A `shutdown` message or `close()` disposes this VM
scope; the owner must separately cancel/drain the broker and preserve uncertain
COMMIT/idempotency state.

## Validation and remaining work

The focused tests are controlled simulations of the actual public API. Their
`evalCode` method records text and never evaluates it. They exercise the real
artifact capture and wire contract and strict handle ownership, TLA states,
module rejection, finite jobs/deadlines, reader bounds and cleanup. They do not
prove real QuickJS compatibility, import guards, runtime isolation or publication.

The independent diagnostic preparation uses the fixed vendor 0.32.0 distribution,
the actual fixed bootstrap packager, actual guarded imports and this component.
Its ESM/TLA/handler/data/job fixtures must run in a separately bounded original
native process after Root schedules it, with measured input pins and original
process/Job/EOF evidence. No successful future result is implied by these sources.
Real broker IPC, owner settlement, HTTP service, protected profiles, storage
recovery and verified release remain separate integration work.
