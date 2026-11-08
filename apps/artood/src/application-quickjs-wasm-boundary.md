# Fixed QuickJS-Wasm import boundary

`application-quickjs-wasm-boundary.ts` supplies a host boundary for the exact
QuickJS **release-sync 0.32.0** distribution retained under
`../vendor/quickjs-0.32.0`. It creates a private linear memory and wraps the complete
raw import namespace before instantiation. It does not import, compile,
instantiate or execute QuickJS/Wasm, load an application, start a process, or
advertise a supported application runtime. Product qualification remains false.

The contract depends on private fields of this pinned release. Upgrading a package
version or substituting apparently compatible imports requires a new complete
ABI/loading-closure review and validation. The reviewed binary declares nonshared
imported memory with a 256-page minimum and 32768-page maximum, and has an actual
start function. Guards installed after instantiation cannot protect that start.

## Trusted assembly and ordering

The fixed owner must verify the complete original Node/glue/core/FFI/Wasm/adapter
closure and supply the actual captured Wasm bytes. This boundary cannot identify
arbitrary functions by their JavaScript object shape. The raw imports, module
argument, clock, runtime, context and handles are trusted original host objects;
none may be supplied by product data or reconstructed from product JSON.

1. Create a fresh boundary per session. Its `moduleOptions` contains the exact
   `wasmMemory`, fixed `thisProgram: "artoo-application"`, `noExitRuntime: true`
   and fixed terminal `print`, `printErr`, `onAbort` references.
2. The fixed raw-module loader supplies those references and a trusted
   `instantiateWasm` hook on the same module argument. The hook passes that
   argument and the raw imports to `wrapImports` **before** instantiation. Only
   its returned guarded imports may reach the Wasm instantiation.
3. Use the actual returned QuickJS module to create one runtime. Set its heap
   limit, stack limit and interrupt handler, then call `onRuntime(runtime)`.
4. Create its one context, install the fixed session module loader/normalizer,
   then call `onContext(context)` before any bootstrap or product evaluation.
5. Execute bounded session operations, then retain actual owner responsibility
   for guest disposal, process termination and closure. `close()` is idempotent
   and prevents further boundary use; it does not dispose QuickJS or report
   process, Job, pipe or stream closure.

The loader must exclude optional host hooks such as `preInit`, `preRun`,
`postRun`, `setStatus`, `locateFile`, or product-selected module arguments. This
boundary checks its required options and exact imports; it is not an allowlist
for every trusted loader configuration property. Startup Node imports in the
original glue still require the fixed loader/process authority policy.

## Import policy

Only one outer namespace `a`, containing the memory `a` and the nineteen named
functions below, is accepted. Missing/unknown names, symbols, accessors or wrong
function/memory shapes fail before original callbacks execute. Wrapping twice is
terminal. Outer namespace accessors are rejected without invoking their getter.
Every guarded function checks its exact argument count and i32/i64/f64 types,
the current clock/memory, and cumulative import/argument budgets.

| Import | Policy |
| --- | --- |
| `a.a` | Original private nonshared memory, initially 256 pages / 16 MiB, maximum 8192 pages / 512 MiB |
| `a.b`, `a.c` | Reject assertion/stdio before string decoding, iovec walks or output buffering |
| `a.d`, `a.o` | Fixed errno results 52 and 70, without calling original glue |
| `a.e`, `a.f` | Fixed environment values with validated, disjoint destination ranges |
| `a.g`, `a.h` | Exact original runtime/context, bounded UTF-8 module names, captured normalizer/loader, bounded primitive string copy |
| `a.i` | Exact runtime and original interrupt callback; only primitive boolean result |
| `a.j` | Reject timer scheduling |
| `a.k` | Bound growth attempts/request; original pinned glue refreshes its private/public views; check actual result and memory afterward |
| `a.l` | Reject keepalive mutation |
| `a.m`, `a.n` | UTC localtime/timezone policy with bounded, validated destination writes |
| `a.p` | Fixed host epoch plus monotonic elapsed milliseconds |
| `a.q`, `a.r` | Fixed terminal abort/exit rejection, without original output or process-exit-code path |
| `a.s`, `a.t` | Reject host-function and host-reference callbacks |

There is deliberately no JavaScript host-function bridge here. The session may
use guest functions and bounded guest JSON for broker messages, but may not use
`newFunction`, `newHostRef` or an asynchronous host callback. Ordinary internal
host-reference cleanup would require a separately defined authority map; this
session creates no such references and rejects the import entirely.

The replacement environment is exactly `USER=artoo`, `LOGNAME=artoo`, `PATH=/`,
`PWD=/`, `HOME=/`, `LANG=C.UTF-8`, `_=artoo-application`. It does not depend on host
environment variables, locale or the Node entry path.

Date semantics are explicitly retained under UTC. `Date.now` advances from a
fixed host epoch anchor using the original monotonic clock. Localtime fields use
UTC, timezone/daylight offsets are zero and both timezone names are `UTC`.
Supported signed-second values cover JavaScript Date's full finite range,
including negative timestamps, leap years and both extreme dates. Invalid
seconds, invalid destinations, overlapping timezone destinations and exhausted
clock/Date budgets are terminal. This is a declared UTC policy, not preservation
of the host machine's local timezone or wall-clock adjustments.

## Original identities, strings and ownership

`onRuntime` retains the runtime, its original `rt` lifetime, numeric pointer,
module, FFI object, ownership checker and interrupt callback. `onContext` retains
the corresponding context/`ctx` lifetime, original loader/normalizer, `_malloc`,
`_free`, `QTS_GetString`, and `QTS_FreeCString`. Dispatch checks liveness, unchanged
lifetimes/pointers and original callback references. A copied or later-mutated
runtime/context cannot change the captured authority. Memory address range
checks alone do not authenticate an arbitrary host handle; the session supplies
actual host handles and the original runtime ownership check must pass.

`a.g`/`a.h` read raw C-string pointers directly. They validate the original
runtime/context before scanning, require a NUL within the bounded range, then
perform fatal UTF-8 decoding. They never call the glue's unbounded name decoder
or the core callback catch/console wrappers. Captured session callbacks receive
the original context, and may return only a well-formed primitive string with no
NUL. Promise, boxed string, object, `{ error: ... }`, exception, malformed string
or oversized result is a fixed terminal failure. Module selection policy stays
in the captured session's immutable virtual source map.

Canonical base/load/result names use a 1024-byte cap. A normalizer's relative
request has the existing source-file 128 KiB cap instead: repeated `./`,
separators or traversal may still resolve to an exact captured canonical name.
The immutable owner decides that final resolution. Applying the canonical cap
to the raw request would incorrectly narrow existing admitted source behavior.
Both forms still consume the same cumulative decoded-byte budget.

Results are copied into an allocation from the captured original Emscripten
`_malloc`. Both the byte budget and exact destination range are checked. After
successful transfer the original C loader/normalizer path owns and frees that
buffer. If a valid allocation was obtained but transfer fails, the boundary
calls the captured `_free`. An invalid allocation pointer is terminal and is not
passed to an arbitrary deallocator. It is not a successful owner-close receipt.

For host output, `boundedReadString` performs original-context/handle checks,
calls the original `QTS_GetString(ctx, handle)`, validates the returned pointer,
scans within its byte cap, and decodes with fatal UTF-8. Once a valid CString
pointer exists, a `finally` block invokes the captured original
`QTS_FreeCString(ctx, pointer)`, including after decode, budget, identity or
deadline failure. It never uses `context.getString()`, `dump()`, or generic
`_free` for CString cleanup. Invalid pointers are terminal and never sent to the
deallocator. Cleanup exceptions are fixed terminal errors too.

**The session must also perform a length equality check.** First require
`typeof(handle) === "string"`, obtain its original guest UTF-16 length with
`getProp(handle, "length")`/`getNumber`, require a finite bounded nonnegative
integer, and dispose the temporary length handle. After `boundedReadString`,
require `decoded.length === originalLength` before JSON parsing or delivery.
`QTS_GetString` returns only a NUL-terminated pointer: a guest string containing
an embedded NUL can otherwise yield a valid-looking prefix. This API cannot
discover the length by scanning past the first NUL. The C `QTS_GetLength` API
accepts objects rather than primitive strings and is not a substitute.
The length precheck also bounds the guest-side CString conversion before the
host decode; it does not replace the UTF-8 byte limit or memory/CPU policy.

## Limits and failure behavior

| Budget | Per boundary lifetime |
| --- | ---: |
| Lifetime | At most 180000 ms; caller may select less |
| Import calls / arguments | 65536 / 262144 |
| Monotonic clock checks | 262144 |
| Date/time calls | 16384 |
| Module load/normalize calls | 4096 |
| Host string reads | 8192 |
| Growth attempts | 256 |
| Canonical base/load/result name | 1024 UTF-8 bytes |
| Relative import request spelling | 131072 UTF-8 bytes |
| Returned host string | At most 1048576 UTF-8 bytes |
| Loaded compiled module text | 16777216 UTF-8 bytes |
| Total decoded / written bytes | 33554432 / 33554432, counting NUL terminators |

Budgets are cumulative and cannot be reset by a call, clock adjustment or a
successful read. Raw memory stays private and nonshared. The exact full HEAP8
and HEAPU8 views must match the current buffer before use and after growth.
Using the original pinned `a.k` is necessary because it also refreshes private
glue views that are not exposed through the module object. Requests beyond the
512 MiB maximum fail without invoking growth. A refused growth with unchanged
memory returns zero; a claimed success without sufficient memory, stale views,
or a malformed result is terminal.

The first boundary failure remains sticky, including after close or a second
failure. `ApplicationQuickJsBoundaryError` has a fixed message and finite code;
guest/module callback errors and values are never interpolated into it. These
exceptions must be handled by the fixed owner's bounded diagnostics/termination
path. Original trusted host object setup must itself be protected by that owner;
passing arbitrary proxies/getters in place of actual runtime objects is outside
the assembly contract.

These bounds do not establish an OS resource limit. A synchronous interpreter
loop cannot be terminated by an event-loop timer in the same process, and Wasm
memory is only part of process RSS. Finite checks require an independently
qualified watchdog, CPU/memory policy, Job ownership, original PID/start identity,
and actual process/Job/pipe closure. Terminal callbacks, an elapsed deadline,
`close()` or QuickJS disposal do not prove those outcomes.

## Validation and remaining work

The focused suite uses controlled host objects/FFI functions and actual
`WebAssembly.Memory` allocation/growth only. It never creates a WebAssembly
Module/Instance, imports the vendor distribution, runs generated code or starts
a native helper. The initial focused run passed **129/129** cases (`0886a8`, exit
0). The no-emit TypeScript check of these two new files reported **0 diagnostics**
(`df256a`, exit 0). These results cover the adapter contract, not actual QuickJS
startup compatibility or application isolation. Final source hashes and any
subsequent focused recheck are recorded in the handoff.

Root review then identified that the initial 1024-byte name cap also covered raw
relative requests and would narrow existing artifact admission. Two exact
controlled owner-to-boundary regressions failed before repair (`54be65`, exit 1),
using 600 and 65490 repeated `./` segments that both resolve to captured
`server/value.js`; the 130 unselected cases in that run were not executions.
The source strings remain under the existing 128 KiB source-file cap. The fix
separates the relative-request cap from canonical names, leaves the 32 MiB
cumulative decode budget intact, and adds a request-over-limit rejection case.
No source or artifact admission budget was expanded.

The same review found that an 8 MiB loaded-module cap would narrow the existing
16 MiB compiled-artifact allowance. The exact 16 MiB controlled module-copy
regression failed before repair (`e0fc08`, exit 1; 133 unselected cases). The
boundary now uses the existing 16 MiB module ceiling while retaining the 32 MiB
cumulative written-byte budget, and tests both exact acceptance and over-limit
rejection. The copied text remains inert fixture data and is never executed.
After both compatibility repairs the complete suite passed **134/134**
(`38add3`, exit 0); the final targeted no-emit TypeScript check again reported
**0 diagnostics** (`f87a45`, exit 0). No assertion or existing admission guard was
removed to achieve those results.

Cases cover import/accessor/namespace changes, argument shape, denied imports,
fixed environment, original identity/callback mutation, loader failure shapes,
UTF-8/range/termination limits, allocation and CString cleanup, growth and stale
views, UTC extremes, clock rollback/expiry, cumulative budgets and terminal
stickiness. An explicit CString-prefix case demonstrates why the session's
additional UTF-16 length gate is mandatory.

The actual assembly must still validate the exact complete vendor/adapter
closure, pre-start imports, runtime/session behavior, malformed/hostile guest
paths, real OS resource/closure receipts, broker IPC and capability scope,
persistent ownership/rotation, and eventual product acceptance/publication.
The owner runs workspace-wide typecheck/build/tests and native/provider gates
after integration. This increment ran no full workspace, build, native, provider
or publication checks and changes no existing frozen compiler/runtime/broker
files or capability enrollment. The separate LPAC profile remains closed; this
component does not authorize an automatic fallback or a production release.
