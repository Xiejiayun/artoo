# Host application HTTP ingress

This component adapts Node `IncomingMessage` / `ServerResponse` to
the existing application wire DTOs and broker invocation action. It creates no
listener, process, guest, database or release capability. It does not import the
broker implementation at runtime. Native application qualification remains closed.
The separate bounded local entry is documented in `docs/application-local-service.md`.

## Trusted owner boundary

`createApplicationHttpIngress` captures one fixed origin, purpose, access ceiling,
timeout, concurrency limit and original service `begin` function. These are local
host policy, never HTTP fields, model output or remote profile data. The service
declaration is not proof of process isolation or storage authority. Only the future
qualified owner may provide this adapter with its actual original service channel.

After bounded input validation, `begin(action, signal)` receives the existing
broker `begin` shape: host-generated `invocation`, `requestJson`, fixed `purpose`
and `access`, and the remaining `lifetimeMs`. `request_id` is also host-generated;
client correlation headers are not reused. The owner returns a synchronous original
handle with three members:

- `response`: a native host Promise of one existing broker `responses` member
  serialized as JSON, `{ "invocation": "...", "response": { "status": ..., "body": ... } }`.
  The ingress requires exact correlation and fields and validates the response
  using the existing application wire encoder. An arbitrary object cannot cross
  this boundary. The owner must serialize already validated data independently,
  never concatenate an unparsed response into this envelope.
- `settled`: a native host Promise resolving to `undefined` only when this
  invocation has no remaining work or authority. A returned response, cancellation
  request or timeout alone cannot settle it. A rejection fails the ingress closed.
- `cancel()`: the original owner cancellation method, captured once. It must be
  idempotent with the supplied AbortSignal. This adapter calls the method at most
  once while the invocation remains unsettled; signal abortion is a second
  notification of the same cancellation, not a second broker command.

A throwing `begin` must have created no work. If startup has begun, the owner must
return its handle even while startup is pending. The owner owes actual pipe writes,
broker sequence/correlation, guest scheduling, native deadlines, original process/
Job/EOF closure and uncertainty handling. The settlement Promise is a host interface
contract, not a serialized verification or native closure receipt.

Health and peer bindings require both `access=read` and `maximumAccess=read`.
They only accept GET. A writable service cannot acquire health/peer semantics by
passing a per-call read flag. The future owner must actually provide a separate
read-only broker and isolated guest without another write channel. A `/health`
path on an application binding remains an application invocation. Apart from the
explicit local `readOnlyGet` policy described below, methods do not select data
permissions; request paths, headers and queries never increase them.

## Supported HTTP subset

Only HTTP/1.1 is accepted. API methods are GET/POST/PATCH/DELETE; an explicitly
configured same-origin client additionally permits static GET/HEAD. API HEAD and
static write methods reject. Host must exactly equal the
configured canonical origin authority, and the actual socket's TLS state must
match its scheme. No proxy forwarding or TLS-offload interpretation is supplied.
Origin, when present, must equal the configured origin. Every non-GET request and
**every write-bound invocation, including GET**, requires that exact Origin.
Browser GET APIs without Origin therefore need a read-bound ingress; an HTTP
method does not make a write-bound handler safe to call without this check.
An explicit trusted `readOnlyGet` application binding lowers GET's actual broker
grant to read before invoking the owner. It then permits a missing Origin for
that read-only GET. Write methods retain the fixed ceiling and exact Origin
requirement; a supplied foreign Origin still rejects. This option shares the same
admission/concurrency counters and cannot enable health/peer semantics on a
writable owner.
Foreign Fetch Metadata sites are rejected. There are no CORS response grants.
Origin checks mitigate browser cross-origin use; they do not authenticate an API
client, because a non-browser client can supply its own headers. This component
does not implement login, multi-user authorization or tenant selection.

Raw header names/values, count and size are checked before dispatch. Duplicate
headers, forwarding headers, Expect, upgrades, announced/actual trailers,
ambiguous Content-Length/Transfer-Encoding and compressed bodies reject. Framing
allows canonical decimal Content-Length or exactly `chunked`, never both.
Only `application/json`, optionally with `charset=utf-8`, is accepted for a
nonempty body. GET has no body. An absent/empty body maps to JSON null. Body bytes
must be valid UTF-8; JSON is depth-bounded before parsing and checked against the
existing wire graph/body limits. Nonfinite numeric parse results reject before
re-encoding, avoiding JSON.stringify's conversion of Infinity to null.

Targets must be origin-form and use the existing ASCII wire path grammar. No
percent-encoded paths, dot segments, backslashes, fragments or authority-form
targets are normalized into another route. Queries use unique literal keys and
UTF-8 percent-decoded values; `+` denotes space. Malformed escapes, duplicate keys,
empty query pairs and limits reject. Paths never name a filesystem location.

An optional local same-origin client binding uses an original captured client
reader. `/api` and `/api/...` retain their full path when dispatched to the API;
other paths select only captured client HTML/CSS/JavaScript bytes. `/` and trailing
slashes select a client `index.html`; absent entries return 404. Static requests
pass the common admission checks and share the existing concurrency, deadline
and 256-admission budget, without calling `begin` or acquiring database access.
The listener revokes its reader after draining or closing its original owners.

Limits per ingress are eight concurrent admitted requests (configurable downward),
256 lifetime admissions, 64 headers / 16 KiB raw header budget, an 8 KiB target,
256 KiB raw body, 64 KiB input chunks and 4,096 body chunks. Existing wire query,
graph, nesting and response-body limits also apply. This conservatively supports a
subset of the wire format, particularly target length and fragmented uploads.
Limits count failed admitted requests too; they cannot be reset by cancellation.

Responses have only a validated fixed status and JSON body (204 has null/no body).
Product code cannot set HTTP headers, redirects, cookies or content types here.
The host sets Content-Length, JSON UTF-8, no-store, nosniff and Connection: close.
At most one bounded response body is queued. Fixed errors do not expose request
contents, owner exception text, paths or stack traces.

## Deadline, concurrency and shutdown

The deadline starts before body consumption and is not renewed after upload.
Only its remaining time is sent to the broker. Client disconnect/error, parent
abort, deadline and ingress close stop successful delivery and forward cancellation.
Elapsed time and abortion are rechecked after owner response/settlement and response
validation. Once output headers have been sent, timeout destroys the transport;
it does not append another response or claim the existing output finished.
If the first deadline response itself blocks, the deadline schedules a cutoff for
the next event-loop turn. An immediately writable fixed error may finish first;
otherwise the transport is destroyed. There is no renewed response-write timeout.

A successful response waits for both response data and owner settlement. After
cancellation, an invocation retains its concurrency slot until owner settlement
and HTTP finish/close. An uncooperative owner therefore exhausts a bounded capacity
instead of allowing repeated cancelled work to exceed the limit. Late responses
are observed but cannot be delivered. A settlement or cancellation failure closes
admission; it cannot manufacture a successful closure or free an uncertain owner.

`handle()` resolves after HTTP finish/close, including rejected admission. It does
not return a delivery acknowledgement from the client or a backend closure receipt.
`close()` stops admission and requests cancellation; it does not wait for or claim
native closure. COMMIT and HTTP delivery remain separate. Cancellation must retain
the original store/idempotency information; this component promises no rollback.

`admissionStopped` reports the first stop reason, including exhaustion of the
256-request lifetime budget. Budget exhaustion stops new admission without
cancelling the last admitted request. `admissionFailed` independently reports a
failure, including one after the budget notification. Neither is a closure
receipt. The listener must await all transport creation paths and then the
complete set of original owner settlements, retaining failure upgrades while
draining.

Timers are event-loop checks, not hard CPU or OS deadlines. The actual listener
must additionally bound connections, HTTP parser/header allocation and header wait,
disable upgrades/checkContinue paths before dispatch, and enforce socket lifetime.
It must retain complete raw headers within its byte bound rather than silently
truncate them before this adapter. Ingress admission cannot bound sockets or bytes
already allocated by Node's listener/parser. Rejected-admission replies have a
bounded payload and timeout but still rely on that listener connection limit.
Persistent owner/session rotation is still needed for the finite lifetime budget.

## Validation scope

The focused suite uses controlled host services and actual Node streams. Two cases
also start temporary loopback HTTP listeners, exercise an actual JSON request and
an actual client disconnect, and await listener closure. No generated JavaScript,
native helper, broker process, provider or persistent product listener runs.

The first run (`7714bd`, exit 1) passed 64 of 66 cases and exposed two nonfinite
number failures: both request and response Infinity were converted to null before
wire validation. The parser now rejects these values before re-encoding. The next
run passed 66; correlation/deadline and socket-scheme cases brought the focused
suite to 69 passing cases (`dbd269`, exit 0). The targeted TypeScript check initially
found one test-only mixed Map value inference error (`c4384a`); the test now declares
the existing string/number values as `Map<string, unknown>`. No assertion or runtime
guard was removed. Final validation is recorded in the handoff separately.

Independent review subsequently reproduced a distinct blocked-output defect on the
69-test snapshot. Its source SHA256 was
`946e6661376dd5551f4f2ce590afbf56d8bb6f6ef95b24b77c6bbfa05e8cd7c7`, test SHA256
`7a6911acd810ff92ebc3d155b9304d5c8cb0fd67a4015d2cd391a6a3a39daf02`, and document
SHA256 `33da40f6700cce1c91afa4d41fad03510f0d4265325edae1a342f389451c57e1`.
With both owner promises pending, the first deadline's 504 could block its output
after the only timer had fired; the aborted owner-await branch then returned
without ending HTTP transport. This differs from blocking a successful response
before the deadline, which the earlier suite already covered.

The exact new regression failed before repair (`3dd15b`, exit 1): after 80 ms with
a 10 ms deadline, cancel had occurred once and 504 headers existed, but the stream
was not destroyed and handle completion remained pending. The 69 unselected cases
in that focused red run were not executions. The fix adds the event-loop-turn
transport cutoff described above without changing owner settlement or capacity.
The complete 70-case suite then passed (`fb53c5`, exit 0), including confirmation
that another request remains rejected until the original owner actually settles,
and succeeds only afterward. Neither transport destruction nor test cleanup is
reported as backend/native closure. Full workspace/build/native checks were not run.

This increment does not establish a qualified application owner, production profile
enrollment, actual guest/broker IPC, persistent service, database recovery, application
release contract, live-provider acceptance or publication. Those remain the next
integration stages; existing frozen compiler/native/broker code is unchanged.
