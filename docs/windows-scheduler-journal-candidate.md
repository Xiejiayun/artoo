# Windows scheduler journal candidate

Status: implementation candidate, **not validated or platform-qualified**. Per the
2026-11-16 implementation instruction, no checks, unit tests, native helpers,
PowerShell probes, journal provisioning or browser/E2E runs were executed while
writing this slice. Final integrated validation owns those results. Existing
manual execution remains independent of this candidate.

## Storage boundary

`managed/journal-boundary.ts` selects a separate Windows implementation; the
macOS UID/mode/filesystem checks remain in their original platform branch.
Windows requires native x64 Windows 10+, a canonical physical local NTFS path,
trusted current-user/system ownership, and an audit of every path component.
Foreign principal read or mutation on the private directory/files, replacement
rights on ancestors, reparse points, aliases and hardlinked files are rejected.
The private directory's DACL must be protected. All file identities retain their
full decimal `dev`/`ino` precision, and marker namespace/scope/content continuity
is still checked on every boundary assertion.

Provisioning uses native `CreateDirectoryW` with the private protected security
descriptor in the creation call. It rejects an existing path and never creates
a public directory followed by ACL hardening. Database and marker files are
created exclusively inside that directory and flushed by their real handles.
The parent directory is flushed after namespace creation. An interrupted or
failed provision leaves its private directory for inspection; there is no
automatic adopt, reset, retry or deletion of that uncertain namespace.

SQLite's Windows VFS does not supply the Unix directory-sync path. Each private
boundary audit therefore requires a successful native directory-handle
`FlushFileBuffers`, bound to the exact volume/file ID before and after the
flush. Existing journal-worker assertions run this gate after COMMIT and before
returning a durable receipt. This does not change the worker's ownership,
timeout, commit-uncertainty or actual-exit behavior.

**Directory flush is an unresolved qualification gate.** Windows access control,
the filesystem or a filter driver can reject opening/flushing a directory
handle. Such rejection keeps the journal unsupported; this implementation does
not suppress the error, substitute POSIX `chmod`, flush a privileged volume
handle, or advertise Windows scheduler readiness on that basis. A flush that
the OS accepts is necessary; a production durability claim also needs the
actual filesystem, restart/crash-recovery and failure-injection evidence below.

## Boot-bound monotonic clock

The fixed native helper reads `SystemBootEnvironmentInformation` from the
Windows kernel and obtains `QueryPerformanceCounter`/frequency. Its counter
sample must lie inside the surrounding Node `hrtime` samples, proving the same
origin and scale. The persisted ID is `windows-boot-v1:<kernel boot GUID>`;
there is no random per-process boot identity, wall-clock fallback or calibrated
offset that renews an old delivery budget after a daemon restart. Unknown boot
identity, a counter mismatch, unsafe numbers or backwards time remain unknown
or fail closed. Linux remains unqualified by this slice.

All native operations use fixed code and an absolute system PowerShell path,
hidden with `shell:false`, bounded output and a 2.5-second helper timeout. Only
explicitly selected local data fields travel on stdin. The compiler temporary
directory comes from the genuine Windows known profile and a fixed audited
`.artoo/windows-journal-compiler` directory, never inherited TEMP/TMP or task
configuration. A helper failure never supplies storage or process authority.

## Final validation scope

The added controlled suites are `journal-clock.test.ts`,
`windows-journal-native.test.ts` and `windows-journal-boundary.test.ts`. They
cover continuity, SID/ACL/identity rejection, unsupported-platform handling and
unsuccessful native completion. They do not prove any Windows API succeeded.

On the actual protected Windows installation, final integrated validation must:

1. Establish real kernel boot identity across separate daemon processes and
   verify that persisted delivery deadlines continue within the same boot.
2. Provision a fresh namespace and reopen the same exact namespace, checking
   protected ACLs, NTFS identities, marker bytes and actual directory flushes.
   A native flush refusal is an unsupported result, never a passing fixture.
3. Exercise COMMIT, worker/daemon restart, uncertain replies and retained
   one-time permits; validate rollback-journal recovery without restarting a
   process or reclaiming a consumed permit from a test's assumptions.
4. Confirm failure for unsafe ACLs, path replacement/reparse/hardlink attempts,
   denied reads/flushes and unavailable boot identity. Preserve failed storage.
5. Measure whole worker requests against the existing 5-second default / 10-second
   maximum. Synchronous PowerShell/compilation/ACL work can exhaust that budget;
   do not relax timeouts or skip audits just to label the platform qualified.
6. Separately validate the actual Windows Run owner/Job, isolated workspaces,
   Stop/exit/cleanup, reconnect, ordinary/manual paths and real two-machine
   dependency-artifact collaboration. This journal candidate alone proves none
   of those product flows.

Source review and merge do not complete T16 or T19. Keep native qualification,
controlled tests, real-provider acceptance and two-machine acceptance separate
in the final evidence.
