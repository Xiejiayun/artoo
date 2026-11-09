# QuickJS development process owner

Source candidate for the native side of the fixed
[runtime protocol](../../src/application-runtime-process-protocol.md). No native
build or run is claimed by this directory. The installed daemon supervisor,
existing native process host and LPAC qualification gate are unchanged.

The executable is `artoo-quickjs-process-host.exe`; it accepts exactly one fixed selector:
`--application-quickjs-owner-v1` for runtime or
`--application-quickjs-compiler-owner-v1` for compiler.
A new .NET 10 self-contained win-x64 build uses
`Artoo.QuickJsProcessHost.csproj`. `PublishSingleFile` with native extraction
disabled can still publish native runtime DLLs alongside the executable. The
complete published directory needs its own manifest, every-file pins and the
separate protected-local admission record; pinning only the executable is
insufficient. Packaging and installation are caller responsibilities.

The helper starts one fixed trusted Node bootstrap. It creates a noninherited
Job, sets and reads back its kill-on-close, one-process and 1610612736-byte
process-commit limits, and assigns/verifies the original Process HANDLE before
writing the admission line. The bootstrap must wait for that admission before
loading vendor code or Wasm. This is the development DiagnosticOwner lifecycle,
not atomic LPAC creation or product sandbox qualification.

File pins are checked from original open handles. File sharing denies writes
and replacement, ancestor-directory sharing denies namespace renames, and
reparse points, aliases and hardlinked files are rejected. The original handles
stay open through closure and a second hash/identity check. Pin equality does
not establish who installed or approved a file; the trusted caller must admit
the complete fixed runtime closure independently.

The parent control reader never waits for a target write. A separate input
worker synchronously writes and flushes the original input stream before
admission or a write acknowledgement, and closes stdin only after earlier
writes. Windows `Process.StandardInput.BaseStream` is a buffered `FileStream`;
the wrapping `StreamWriter.AutoFlush` does not flush direct byte writes. A
small admission or message must reach the pipe without a later large write or
close. Both writing and flushing remain on the input worker, followed by the
original deadline/cancellation check before acknowledgement. Cancel, parent
EOF, malformed input, I/O failure and expiration terminate the original Job
and cannot become successful shutdown.
The admission budget subtracts helper startup and file preparation; the original
timer stays active during execution and closure. Cleanup has at most five
seconds and never renews application authority.

Target pipes are byte relays. Their actual chunks are bounded and emitted
through one ordered helper writer with a bounded queue. If the parent stops
reading, the lifecycle owner can still terminate the Job; it never blocks behind
the output writer. Success requires original process exit 0, Job empty, actual
stdin closure, both natural target EOFs, completed I/O workers, unchanged pins,
and the caller's independent observation of helper exit/close 0 and both EOFs.
The runtime entry separately owns VM/context disposal; this helper does not
invent that evidence or interpret application-wire messages.

Required native validation includes successful multi-write/close, partial and
malformed controls, duplicate sequence/nonce, concurrent-write rejection,
cancellation during a blocked input write, parent EOF, deadline, stdout/stderr
overflow, output backpressure, pinned-file replacement attempts, child-process
limit and real original Job/pipe closure. A successful compile alone establishes
none of those observations.

The real pipe fixture requires each write's cumulative exact echo before the
next write, beginning with a 22-byte message. A following large write or input
close cannot conceal a buffered acknowledgement. Its separate child-creation
case requires target admission markers without any parent data write. The
flush revision and these stronger assertions require a newly reviewed build
and actual execution; the prior failed runs remain failed evidence.
