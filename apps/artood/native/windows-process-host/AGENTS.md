# Windows process host

This fixed helper implements `artoo.windows-job-process.v1`. Keep target output separate from control frames and retain the atomic Job membership, exact process HANDLE wait, pipe EOF and Job-zero requirements. A successful build alone does not qualify Windows autonomous execution or publication.

Build on native x64 Windows with a stable .NET 10 SDK:

```powershell
npm run build:windows-process-host --workspace @artoo/artood
```

The source is this directory. The default complete bundle is `apps/artood/native-dist/windows-process-host`; its SDK intermediate files remain under the ignored `apps/artood/native-dist/.build` directory. The build always produces a self-contained `win-x64` host, so installed users do not need the .NET SDK or runtime.

The destination must be new. To preserve an existing bundle, choose a new output directory:

```powershell
npm run build:windows-process-host --workspace @artoo/artood -- --out-dir C:\artoo-builds\windows-process-host-next
```

`manifest.json` uses version 1 and binds every published file by canonical relative path, byte size and SHA-256. It is published last, after successful SDK exit/close and complete bundle inspection. The final JSON output includes the manifest SHA-256 for a separate local installation record. A failed build may retain partial binaries and intermediate files, but must not publish a usable manifest. Do not copy a manifest from another build to make partial output loadable.

Verify packaging with this actual build and the native process fixtures against the exact compiled module and separately recorded manifest hash. Production installation ACLs, qualified profiles, real CLI/browser compatibility, signing/distribution and product publication are separate gates; this command enables none of them and does not replace the ordinary TypeScript build.

## Optional target control (native transport regression passed)

`artoo.windows-target-control.v1` is a separate capability selected only by
`targetControl:{version:1}`. It cannot be combined with `targetInput`, and does not
change the existing `artoo.windows-target-input.v1` single-message EOF contract.
Ordinary launches still receive NUL stdin; synchronous collectors remain unchanged.

The original anonymous target-input writer accepts at most 512 messages, each
1–4096 bytes, with a 2 MiB lifetime total. `target_control` envelopes bind the
original token, unique request ID, contiguous sequence from zero, final flag and
canonical base64. Only one message may await its actual write acknowledgement.
The existing operation deadline is never renewed. A nonfinal write keeps the
same writer open; an explicit final write closes that writer exactly once.

`target_control_written` acknowledges actual byte count, digest, request ID,
sequence, final flag and actual input-closed state. This is native transport
evidence, not proof that the application paused/resumed or that an owner closed.
`complete.targetControl` binds cumulative requested/acknowledged message counts,
actual bytes written, writer closure, and the original final acknowledgement.
Original process HANDLE wait, both pipe EOFs, Job-zero and helper exit/close remain
separate requirements. Cancellation, partial writes, missing/replayed ACKs or a
missing final acknowledgement never become a successful normal service drain.

The 2026-11-09 native target-control r3 run passed all 18 cases against installed
manifest `sha256:6890cf79448444cdb08854fb166657a2b02f4c3ab617e1c0fe422957f961ffe0`.
Fresh input-compatibility r6 then passed all seven input cases and one ordinary-node
case against that same helper. All three original commands exited/closed 0 with
null signals, both output EOFs and no observer errors; no cases were skipped or
cancelled. Evidence is retained in the external native-development directories
`windows-target-control-20261109-r3` and `windows-target-input-compatible-20261109-r6`.
Earlier failed attempts and their original input baselines remain retained.

The control/input matrices keep production helper installation checks. The
ordinary-node case retains its controlled installation-admission callback and
does not qualify production ACL admission. These are native transport and
compatibility results, not live-provider, installed-product or product-publication
acceptance. A changed helper still requires its own newly recorded manifest and
actual native regression; the target-input fixture alone cannot qualify control.
