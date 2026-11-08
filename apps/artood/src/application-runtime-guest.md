# Portable application handler bootstrap

`createApplicationRuntimeGuest(handle)` is a guest-side execution component. It
actually calls the supplied handler and implements asynchronous `context.data.execute`.
The fixed module must be evaluated **inside the isolated guest, before product modules**,
then receive the admitted guest-local `handle` export. Its imports are type-only; it
uses no Node, filesystem, network, host callback or product-code evaluator. Supplying
a Node-evaluated product function is not a supported execution boundary.

The returned API stays with the trusted runtime owner, outside the product's global
namespace. `receive(messageJson)` accepts the existing host-to-application message
fields, without `version` or `sequence`. The owner first uses the existing wire
decoder and removes those two transport fields. `drain()` returns at most 64 FIFO
application-to-host message JSON strings; the owner must validate and frame them
with the existing wire encoder. This split avoids embedding Buffer, SQLite or broker
controls in the guest. The owner still owns stream sequencing, backpressure, actual
write completion and original process/Job/EOF closure.

An invocation ID can be used once. Data-call IDs increase within their invocation;
concurrent data Promises can settle in any order. Replies must match a pending call
already handed to the owner by `drain`. A handoff is not a broker execution receipt.
The response carries the original invocation ID. Malformed host messages, wrong or
duplicate correlations, reused invocation IDs and exhausted session quotas cause a
sticky fixed failure, discard queued output and reject pending data Promises.

The bootstrap bounds text bytes and nesting before JSON parsing, then validates and
freezes the parsed graph. Before stringifying generated objects, it bounds bytes,
nesting, entries and arrays/objects, requires finite numbers and valid Unicode, and
copies the values into a frozen serialization graph. Cycles,
sparse arrays, undefined/function values and executable `toJSON` hooks reject;
getters/proxies can execute only in the guest under the future owner's resource
budget. Handler throws, rejected thenables and invalid responses produce the fixed
500 body `{"error":"application_handler_failed"}`. Completing with unresolved data
fails the session instead of implying those operations finished. A handler must
settle all its data work, including concurrent error paths, before returning.

`cancel` revokes future SDK calls and removes that invocation's queued data/response
messages. One late reply for an exact previously handed-off cancelled data call is
discarded without resuming it; unrelated or duplicate replies reject. `shutdown`
revokes every invocation and discards queued output. Pending rejection bookkeeping
does not depend on product code observing every Promise. Neither operation stops
already running JavaScript, proves process closure or rolls back a transaction
already sent to the broker. The owner must revoke/drain broker authority and preserve
the original store/idempotency key when delivery after COMMIT is uncertain.

All data requests still go through the existing broker's schema, exact-request
permit, scope, access and generation checks. This bootstrap selects no database,
SQL, scope, purpose or access policy. Health/peer execution still requires the
separate read-only broker and isolated runner prescribed by the host contract.

The limits cover eight active calls, 256 lifetime invocations, 32 data calls per
invocation, 2,048 lifetime data calls, 4,096 incoming messages, 32 MiB incoming text,
and 16 MiB lifetime/queued outgoing text. Queue space is bounded to 256 messages;
draining or cancellation never refunds lifetime budgets. The ordinary host wire and
broker continue to enforce their independent complete-frame and transport ceilings.
These guest counters and captured intrinsics are not tamper-resistant confinement
against code in the same realm, hard CPU/memory limits or authorization evidence.

This increment has not run its tests. The new tests are controlled Node fixtures
that call developer-authored handlers. The separate broker suite connects the actual
wire/control/SQLite implementation for CRUD, conflict, replay, reopen and read-only
health/peer behavior; it does not evaluate generated JavaScript in Node. Neither
suite establishes a qualified guest/native execution profile or a published product.

Remaining production integration: immutable source/artifact and module admission,
the actual isolated guest loader/import boundary, bounded Promise job pump and native
resource/lifetime owner, protected profile and broker process enrollment, HTTP,
persistent service lifecycle, database backup/migration/recovery, node verification,
and release health/rollback. Existing compiler qualification, LPAC gate, broker
authority, package manifests and advertised node capabilities are unchanged.
