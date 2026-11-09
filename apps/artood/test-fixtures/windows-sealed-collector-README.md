# Native sealed-dispatch collector fixture

`windows-sealed-collector-real.mjs` verifies the original Windows dispatch writer
and fixed local collector. It requires native Windows x64, built artood modules,
and a separately validated Windows process-host bundle. Schedule it separately
from native suites, host builds and Web E2E to keep its original deadlines useful.

The production seal is registered only by `writeWindowsReleaseDispatch` after
its original exclusive canonical write, fsync and successful close. Content SHA,
length, volume/file ID and final mtime remain independently bound. The collector
retains owner/group/DACL policy, descriptor equality, single-link regular file,
ordinary attributes and the complete default stream. ctime and bounded EA facts
are diagnostic data. Their private names, formats, hashes and timing grant no
authority. Unregistered files and directories keep the original strict checks.

Prepare an external JSON configuration with these exact fields:

- `version: 1`.
- `bundleDirectory`: canonical absolute path to the validated host bundle.
- `manifestSha256`: independently recorded `sha256:` digest of its manifest.
- `evidenceRoot`: fresh absolute directory; its parent already exists and it
  does not overlap the host bundle. The fixture retains all created files.
- `modulePins`: entries `{ relative, bytes, sha256 }` for each built artood module
  listed below. Record the SHA of the completed configuration independently and
  supply it on the command line; the fixture does not adopt changed inputs.

Required module pins, relative to `apps/artood/dist`:

```text
windows-release-storage.js
windows-local-acl.js
windows-sealed-record-observer.js
windows-process-installation.js
windows-supervisor-authority.js
source-command-diagnostics.js
owned/windows-owned-process.js
owned/windows-runtime-guardian.js
owned/windows-guardian-scope.js
owned/windows-process-diagnostic.js
```

First run startup smoke with its own fresh configuration/evidence directory:

```powershell
$env:ARTOO_WINDOWS_SEALED_COLLECTOR_NATIVE_WINDOW = '1'
node apps/artood/test-fixtures/windows-sealed-collector-real.mjs --startup '<configuration-path>' '<independent-sha256>'
```

It captures the original raw PowerShell spawn/exit/close and both pipe EOFs. A
separate fresh dispatch is then written and immediately receives its first
production audit, with no content read, hash read or raw collector inserted.
Startup process closure alone does not prove compiler-descendant closure.

Then use a different fresh configuration/evidence directory for the supervised
Guardian fixture:

```powershell
node apps/artood/test-fixtures/windows-sealed-collector-real.mjs '<configuration-path>' '<independent-sha256>'
```

The supervisor, Guardian and original observer slots are real. Registration ACK
is explicitly controlled; it is not authenticated-server acceptance. The fixture
checks ordinary and sealed collection, the fresh first production audit, byte
append rejection and file replacement rejection. Original collector receipts
must prove HANDLE wait, both EOFs, empty Job and helper exit/close. Add-Type's
compiler descendants are included in that Job. The parent separately requires
the exact supervisor stop ACK, actual supervisor close and lifetime Job cleanup.
The worker intentionally stays alive until stop: forced lifetime Job termination
is recorded and must not be reported as graceful application drain.

No retry, process-name kill, metadata setter, protection change or successful
reclassification of an earlier failed attempt is used. Inspect `STARTUP-RESULT`,
`WORKER-RESULT` and `WINDOW-RESULT` separately. Native ctime/EA changes are reported
without attributing their cause; no particular scanner behavior is required.
This fixture does not qualify live model execution or product publication.
