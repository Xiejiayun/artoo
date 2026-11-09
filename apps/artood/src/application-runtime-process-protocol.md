# Fixed QuickJS process protocol, source proposal v1

This is a new bounded development process owner. It does not change the existing
daemon supervisor, LPAC gate, broker or application wire protocol. Product
qualification stays false. The TypeScript client starts and retains its original
native helper; the helper starts and retains the original Node process, Job and
pipes. Neither side accepts an adopted PID or a serialized closure as ownership.

Host preparation additionally requires a protected `quickjs-native-manifest.json`
pin beside the helper. Its strict format is `artoo.quickjs-native-host.v1`,
version1, platform win32, arch x64, entry `artoo-quickjs-process-host.exe`, and
`files:[{path,bytes,sha256}]` for every actually published native dependency.
Paths are relative members and digests use the `sha256:` prefix. The manifest
excludes itself; an exact recursive file inventory, no linked members, every
file pin, and protected local admission are rechecked before launch/after close.
SingleFile build settings are never treated as proof of an exe-only package.
No native package or actual manifest has yet been built by this source increment.

The host computes one monotonic expiry when HTTP begin is accepted. Startup,
broker readiness, module loading, writes and execution all consume that budget.
The helper receives only the remaining whole milliseconds (1..30000), starts its
own stopwatch before target preparation, and subtracts elapsed time before its
admission write. The entry sets a cooperative monotonic deadline from that
remaining value before any vendor or Wasm loading. The original host/helper
timers remain armed throughout; no stage obtains another 30 seconds. Cleanup is
separately bounded by 5000 milliseconds and cannot turn expiration into success.

## Native input

Native helper argv is exactly `--application-quickjs-owner-v1`. stdin is UTF-8
JSON lines, each <=65536 bytes including newline. The first line is:

```ts
{ version: 1, kind: "launch", node: Pin, entry: Pin, configuration: Pin,
  runtimeFiles: Pin[], cwd: string, lifetimeMs: number }
type Pin = { path: string, bytes: number, sha256: `sha256:${string}` };
```

No caller-selected argv/environment, executable fallback or restart is accepted.
The exact target argv is `node.exe --max-old-space-size=256 <entry.path>
--application-runtime-v1 <configuration.path> <configuration.sha256>`.
The explicit environment consists of actual `SystemRoot` and `WINDIR`. The
entry preserves the independently exercised development gate's exact five names:
those two plus `AI_TELEMETRY_SESSION_ID`, `AI_TELEMETRY_SOURCE` and
`AI_TELEMETRY_HOOK_DLL_PATH`. Unknown names, duplicates or missing names reject;
telemetry values are never read or changed. Their introduction is not source
authentication or product qualification. The cwd equals the
entry's directory. File pins include the complete runtime/vendor/bootstrap and
artifact/source closure, max1024 distinct files, each <=256MiB, total <=512MiB.
The entire serialized launch must also fit its 65536-byte line limit; the file
count ceiling never exempts a larger descriptor from that check.
Pins and protected-local admission are separate requirements; host preparation
must establish the latter and recheck it after closure. Original pinned handles
must prevent replacement/writes while the helper owns the target.

Before release, the helper creates and reads back one original noninherited Job:
KILL_ON_JOB_CLOSE | PROCESS_MEMORY | ACTIVE_PROCESS, active-process limit 1,
process commit limit 1610612736 bytes. It assigns/verifies the original process
before admission; failure never releases vendor/Wasm startup. The target receives
exactly one native-generated first line:

```ts
{ version: 1, kind: "admit", protocol: "artoo.application-runtime.v1",
  remainingMs: number }
```

This line is written fully to the original target stdin; it is not an EOF token.
Following native control lines have consecutive sequence numbers starting at 0:

```ts
{ version: 1, sequence: number, kind: "write", nonce: UUID, data: Base64 }
{ version: 1, sequence: number, kind: "close-input", nonce: UUID }
{ version: 1, sequence: number, kind: "cancel", nonce: UUID }
```

Canonical base64 decodes to 1..16384 bytes per write. At most one write is
outstanding; max2048 writes and 8388608 cumulative target input bytes, including
admission. Success acknowledgement is emitted only after the actual original
stream write completes. `close-input` closes that original stream after earlier
writes and acknowledges actual closure. `cancel`, control EOF, malformed input,
deadline and I/O failure request termination of the original Job, retain its
original handles and collect closure; none count as normal shutdown. The helper
may not block cancellation behind a stalled target stdin write.

## Native output

All helper stdout lines are ordered envelopes `{version:1,sequence,kind,payload}`,
sequence starting at 0; each line <=65536 bytes. No raw target text leaks outside
the bounded output payload. Helper stderr is reserved for a fixed failure code.

```ts
started: { pid: number, creationTime: string, image: string,
  jobAssigned: true, jobLimitsReadBack: true,
  processCommitLimitBytes: 1610612736, activeProcessLimit: 1 }
admitted: { bytes: number, remainingMs: number }
input-written: { nonce: UUID, bytes: number }
input-closed: { nonce: UUID }
output: { stream: "stdout"|"stderr", data: Base64 }
terminal: { pid: number|null, originalExitObserved: boolean, exitCode: number|null,
  jobAssigned: boolean, jobLimitsReadBack: boolean, jobEmptyObserved: boolean,
  inputSettled: boolean, inputClosed: boolean, stdoutEof: boolean,
  stderrEof: boolean, outputTasksSettled: boolean,
  terminationRequested: boolean, terminationSucceeded: boolean,
  inputsUnchanged: boolean, failure: string|null }
```

An output event carries 1..8192 original target bytes. Target stdout is capped
at 16777216 bytes and stderr at 16384; overflow is failure while readers still
drain or terminate under the cleanup budget. The client also bounds complete
helper output at 25165824 bytes and helper stderr at 16384. Terminal is unique
and last. Normal closure needs actual target exit0, original Job empty, both
natural pipe EOFs, completed I/O tasks, unchanged pins and no termination/failure,
plus the original helper's actual exit/close0 and its two natural EOFs. A helper
receipt alone does not establish that the runtime's VM was disposed.

## Trusted runtime input/output carried in the original pipes

After the admission line the trusted TypeScript client sends these JSON lines,
consecutive sequence starting at 0, each <=90000 bytes including newline:

```ts
{ version: 1, sequence: number, kind: "receive", data: Base64 }
{ version: 1, sequence: number, kind: "close" }
```

`receive` holds 1..65536 bytes from the real broker's application wire. The
native helper does not interpret it. The fixed entry alone decodes this outer
control and supplies only the bytes to the actual RuntimeChannel. Generated
code can emit application data/response messages only, never host controls.
`close` disposes the channel without fabricating a broker shutdown wire frame;
the client then requests native close-input and the entry waits for actual
natural stdin EOF, calling channel.endInput only on that observation. Unexpected
EOF, input after close, partial lines and queued undelivered output fail closed.

Entry stdout uses the same ordered version/sequence/kind/payload envelope:

```ts
ready: { protocol: "artoo.application-runtime.v1", qualifiedForProduct: false }
output: { data: Base64 } // original channel bytes, max65536 each
closed: { guestDisposed: true, inputEnded: true,
  discardedOutputBytes: 0, qualifiedForProduct: false }
```

The entry awaits each actual stdout write before reading another channel output
chunk or advancing the guest. It never directly closes a session already owned
by a channel. Closed is emitted only after actual stdin EOF, confirmed channel
disposal and actual original QuickJS runtime/context alive=false. The entry
never evaluates/imports product source in Node. Its entire trusted loader and
all allowed vendor URLs are fixed by the protected installation/config pins.

## Single-request service

One accepted HTTP invocation owns one guest VM/process and one broker process.
Broker commands are serialized, and broker reply frames go unchanged to the
guest owner; guest output goes unchanged into broker receive commands. A broker
response ends broker invocation authority but cannot settle the guest. The
coordinator stores it, closes the runtime independently, calls broker.stop and
waits for both original closure receipts before returning HTTP success. This
also handles broker.stop's intentionally private shutdown frame without claiming
that frame was delivered to the guest. Cancellation after a response must not
send broker.cancel for the already removed invocation; the whole owned pair is
closed instead. No failure promises SQLite rollback or deletes the store.

`settled` resolves only when both original owners establish no work/authority
remains; uncertainty rejects that promise and cannot release an HTTP capacity
slot as successful settlement. Source-only contract/tests are not qualification.
