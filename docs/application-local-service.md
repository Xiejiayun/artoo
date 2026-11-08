# Windows local application service

This entry connects an already installed, protected application bundle to the
real QuickJS runtime and SQLite broker. It provides a bounded local HTTP API and
optional captured client assets. Application publication and Windows service installation
remain separate. Every CLI
result retains `qualified_for_product: false`. Native application qualification
and live-provider product acceptance remain closed.

The two standalone selectors are separate operations:

- `--initialize-application-store` creates a new, absent SQLite file through the
  original broker's `create` configuration and awaits its normal closure receipt.
- `--serve-application` requires an existing store before binding the listener.
  Every request uses the fixed `open` configuration. It never falls back to
  creating a database, changing its schema or advancing its generation.

Neither command connects to an Artoo server, constructs a model adapter, performs
installation or edits the protected bundle. Existing manual/daemon commands and
the offline `--check-application-broker-profile` retain their semantics.

## Installed inputs

Use native Windows x64, physical local NTFS directories, a supported Node runtime
with the SQLite API, the reviewed complete QuickJS native package, complete trusted
`application-runtime.mjs` and `application-broker.mjs` bundles, the protected broker
native installation, and pinned vendor/bootstrap/product files. An ordinary loose
TypeScript emit is not the runtime bundle. Runtime packaging currently has a
separately reviewed artifact workflow; these commands do not package or install it.

Installation is a separate trusted operation. Finish and close its writers before
starting either command. Immutable files must remain unchanged after admission;
mutable SQLite storage must be separate from code/configuration/native directories
and outside every actual agent write root. Failed or partially initialized stores
are retained. The commands never delete, overwrite or silently retry them.

`ARTOO_APPLICATION_SERVICE_PROFILE_FILE` selects one protected local JSON file
inside `installation_directory`. The strict version 1 profile has:

| Field | Binding |
| --- | --- |
| `version`, `format` | `1`, `artoo.application-service-profile.v1` |
| `node_id`, `writable_workspace_roots` | Exact local node ID and complete declared write roots |
| `installation_directory`, `storage_directory` | Separate existing physical directories |
| `runtime` | `helper`, `helperManifest`, `node`, `entry`, `configuration` pins |
| `broker` | `node`, `entry`, `create_configuration`, `open_configuration` pins |
| `http` | `origin`, `timeout_ms`, `maximum_concurrent: 1`, `access: "read"` or `"write"`; optional `same_origin` described below |

Every pin is `{ "path": "absolute physical path", "bytes": positiveInteger,
"sha256": "sha256:<64 lowercase hex characters>" }`, measured independently by
the trusted installer. Both Node pins must match. The Node directory may be a
separate protected installation; the remaining pins and the entire runtime
helper/vendor/source/artifact/toolchain closure must be inside the declared
application installation. The existing runtime configuration owns these lists;
the profile accepts no model-selected admission callback.

The runtime entry and adjacent configuration must be named
`application-runtime.mjs` and `application-runtime.json`; the broker entry must be
`application-broker.mjs`. Broker configurations match exactly except for
`mode: "create"` versus `mode: "open"`. Their database is a direct child of the
fixed store, their maximum access equals `http.access`, and their artifact digest
equals the runtime's independently selected artifact expectation. Content matching
does not prove compiler provenance.

The origin is a canonical `http://127.0.0.1:<nonzero port>` URL without credentials,
path or trailing slash. Timeout is 1–30,000 milliseconds. No remote profile, argv
path, task text or request field can select these bindings.

Also set `ARTOO_NODE_ID`, `ARTOO_ALLOWED_ROOTS`, `ARTOO_WINDOWS_PROCESS_BUNDLE` and
`ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256` to the same fixed local installation and
complete root scope. A declaration is not proof of every agent's effective write
access. IPC-owned, managed, journal and worktree launch modes cannot be combined
with these standalone selectors.

After the host has been built and installed, the corresponding repository CLI
invocations are:

```powershell
# Set the fixed local environment bindings above first.
node apps/artood/dist/main.js --initialize-application-store
node apps/artood/dist/main.js --serve-application
```

Initialize only for a new data generation. Subsequent starts use only
`--serve-application`. These commands do not provision ACLs or migrate/reset data.

## Original installation handoff

The host can now use `createApplicationInstallationOwner` with an existing
protected parent, an independently selected Node pin, the original prepared
backend, and complete agent write roots. Its single-use `install` accepts the
complete independently pinned code/profile plan, exclusively writes and closes
each file, checks the exact file set, and performs strict admission once. It
returns an in-process installation token only after final code, Node, storage and
backend checks and the mandatory evidence writers have closed. Failed generations
are retained and cannot be resumed or automatically retried.

`prepareInstalledApplicationServiceProfile(token)` reuses those original tokens.
Its optional profile tag is `installation: { version: 1, generation_id }`.
File-only CLI preparation rejects tagged profiles; serialized installation
metadata does not recreate the token. Existing untagged manual profiles retain
their behavior. This remains a same-process profile handoff. The separate
installed-session API below adds clean-only process restart; the file-based CLI
still cannot open a tagged profile. Invalidating it revokes client readers and blocks new launches; running
owners still require their own actual closure.

This source integration has controlled tests. Real installation/API/SQLite and
browser acceptance remain separate, and strict ctime rejection is unchanged.

## Installed-session API and normal process restart

`application-installed-session.ts` provides two host-only production APIs:

- `initializeRestartableApplication(installation, signal?)` takes the original
  admitted installation, acquires exclusive ownership, calls the existing
  create-only broker initializer and waits for its actual normal closure. It then
  exclusively publishes `control/REOPEN.v1.json`, retires the current installation
  authority, releases ownership and returns the descriptor's exact file pin.
- `reopenInstalledApplicationService(options, signal?)` acquires new exclusive
  ownership, validates the unchanged installed generation and creates new local
  authority. Its open-only broker preflight checks actual SQLite schema and scope
  and closes normally before the listener starts. The returned service retains
  the fixed origin and existing `close()` / `closed` lifecycle.

Keep the returned `{path, bytes, sha256}` in protected local selection. Options
also require the independently selected Node pin, node ID, complete write roots,
fresh protected backend and the original **current-process** `hostCode` plus
`hostDirectory`. JSON supplies expectations only. The caller must qualify its
complete canonical host/import graph before its first target import; this API
does not extend either existing CLI selector. The separate installed bootstrap
below supplies this admission for its fixed entry and passes its original opaque
bootstrap object into the reopen API. Explicit API callers without that object
retain the existing host-admission contract.

The strict `artoo.application-installation-reopen.v1` record binds the original
CLAIM/PLAN/ADMITTED record bytes, writer metadata and plan digest, complete code
and Node inventories, exact profile and external prerequisites, layout identities
and the original database identity. Existing files are read with all metadata
checks, including ctime. Reopening never invokes the new-writer preparation
transition or reconstructs a writer, host, backend or process receipt from JSON.
The mutable database is checked by physical identity and actual open schema/scope,
not by a frozen content hash or timestamp. Missing stores never fall back to create;
no schema migration or service-generation rotation occurs.

Ownership is an atomically created, protected `control/.application-session`
directory. A second owner, an interrupted initializer and an uncertain close all
fail closed. It has no PID-based takeover, retry, timeout expiry or automatic stale
cleanup. Normal release follows actual listener/transport/invocation settlement,
final integrity checks and retirement of the current in-memory installation. Old
profiles remain unusable after retirement without marking the unchanged generation
failed. A failed initialization, preflight, startup, audit, shutdown or release
retains uncertain ownership and data; callers must preserve them for diagnosis.

An old generation without the new descriptor is not silently upgraded. Start this
workflow with the original installation before its one-time store initialization;
lost original metadata cannot be recreated from current disk. This is normal
process restart of the same installed version, not crash recovery, migration,
Windows Service installation or product publication.

Controlled regressions cover persisted-record and inventory drift, same-byte file
replacement, missing/replaced databases, forged authorities, original session
continuity, late cancellation, retirement and failed closure. They do not prove
real Windows process restart. A separate acceptance run must close the original
CLI/host, observe its actual exit/close/dual EOF, start a different process with
fresh admissions, and use a real browser at the same URL to read prior data and
replay an idempotent write. Keep frozen r2's same-process result separate. The
existing 256-admission normal drain can close a CLI without using Windows
`child.kill("SIGINT")` as claimed graceful-shutdown evidence.

## Independent installed bootstrap

The maintenance entry is `application-service-bootstrap.mjs`; it is separate from
`main.ts` and does not change `--initialize-application-store` or
`--serve-application`. It only reopens an unchanged installed generation. The
trusted installation still initializes the store once and retains the returned
`REOPEN.v1.json` pin. Automatic installation, a default shortcut, crash recovery
and production qualification are separate work.

Build the complete host into a **new absolute directory** whose parent already
exists:

```powershell
npm run build:application-service-host --workspace @artoo/artood -- --out-dir C:\ArtooBuild\application-service-host-v1
```

The builder creates one ESM splitting graph with fixed bootstrap and delayed
`application-service-host-api.mjs` entries, shared chunks and
`application-service-host-manifest.json`. Its graph and emitted-code checks reject
unlisted/bare imports, runtime module resolvers, computed imports, early
application implementation imports and duplicated Windows code authority. The
complete manifest contains version `1`, format
`artoo.application-service-host.v1`, platform `win32`, arch `x64`, the two fixed
entry names and every `.mjs` file's relative path, byte count and SHA-256. It lists
all chunks, excluding only the manifest itself. Only listed files, the manifest
and their inferred parent directories may exist in the installed host directory.
The builder's packaging readback is not runtime ACL/ctime admission and does not
execute the generated application host.

The trusted installer protects the entire host graph, Node and native package,
then writes one independently selected local JSON file in a **separate immutable
configuration directory**. It must not overlap the host, Node, backend, installed
generation or any agent write root. Its strict fields are:

| Field | Required value |
| --- | --- |
| `version`, `format` | `1`, `artoo.application-service-selection.v1` |
| `node_id`, `writable_workspace_roots` | Exact installed node ID and complete write roots |
| `node` | Independent final `node.exe` file pin |
| `host_manifest` | Independent final `application-service-host-manifest.json` pin |
| `installation_reference` | Original returned `control/REOPEN.v1.json` pin |
| `backend` | `{ directory, manifest_sha256 }` for the reviewed native installation |
| `system_root` | Canonical physical Windows system directory |
| `shutdown` | `stdin` for a controlling parent, or `signals` for console use |

Pins have the same `{path, bytes, sha256}` shape described above. They are trusted
installation inputs; measuring a changed file during startup cannot replace them.
After installation, an illustrative invocation is:

```powershell
& 'C:\ArtooRuntime\node\node.exe' 'C:\ArtooRuntime\host\application-service-bootstrap.mjs' '--selection=C:\ArtooRuntime\selection\application.json'
```

Use the pinned executable with the default Node loader, no Node flags or IPC
channel, and no `NODE_OPTIONS` or `NODE_PATH` variable, including differently cased
names or empty values. `SystemRoot` and `WINDIR` must resolve to `system_root`.
Only the single `--selection=<absolute file>` argument is accepted.

Before importing the application graph, the bootstrap checks original file and
handle identity, size, timestamps including ctime, complete inventory and hashes,
Windows ACLs, the executing Node pin, and fresh native backend admission. It
rechecks those original objects after the delayed import and before announcing
readiness. The original bootstrap token remains bound to the exact installation
reference, Node, node ID, roots, host and backend through profile preparation,
request admission, final audit and retirement. A copied token, changed selection
or mismatched target fails permanently; a failed final audit retains ownership.
The installer must establish the trusted bootstrap files before the process starts;
an in-process check does not authenticate code that has already executed.

With `shutdown: "stdin"`, the parent keeps stdin as raw bytes and sends exactly one
UTF-8 JSON line, including its terminating LF:

```json
{"version":1,"kind":"shutdown"}
```

The two literal fields may be reordered. Duplicate keys, escaped keys, extra
fields, further commands, trailing bytes, malformed UTF-8, more than 4096 bytes,
transport errors and EOF without the complete command fail closed. SIGINT and
SIGTERM are latched before admission. Shutdown cancels admission and waits for
the original service's `close()` and `closed`; it never force-exits, kills by PID
or treats cancellation as proof of closure.

Stdout reports bounded JSON lines `application-service.listening` and
`application-service.closed`, always with `qualified_for_product: false`.
Listening retains a 256-request lifetime and one concurrent invocation. The
closed status follows actual service settlement and final checks; a parent must
still observe the process's actual exit, close and both output EOFs. A failure
sets a nonzero exit code and attempts a bounded `application-service.failed`
stderr line. Output failure is a failure, even during the final status flush.

The new builder and bootstrap are source implementations with controlled tests.
Their actual Windows host packaging, native execution, separate-process restart
and browser acceptance must be recorded independently by the integration owner.

## Browser and HTTP policy

One ingress shares a single concurrency slot and a single 256-admission lifetime
budget across API and client requests. API GET receives a broker **read** grant, including when the
service ceiling permits writes. A generated handler attempting a transaction
during GET still encounters the independent broker grant check. Existing ingress
users retain their default write-bound GET Origin requirement.

POST/PATCH/DELETE retain the configured access ceiling and require the exact
Origin. Same-origin browser fetch normally supplies this Origin for those methods;
scripts must not try to set that forbidden header. Browser GET need not carry
Origin, but a supplied foreign Origin or foreign Fetch Metadata site still
rejects. There is no CORS, authentication, cookies, proxy interpretation or tenant
selection. Health/peer still require a dedicated genuinely read-only binding.

The listener bounds connections, parser bytes, header wait and absolute connection
lifetime. It rejects Upgrade/CONNECT/Expect before product dispatch and retains
complete raw headers for validation. API responses are JSON.

To serve the captured product client at the same origin, the trusted installer
can add this optional field inside the protected profile's `http` object:

```json
"same_origin": { "version": 1, "api_prefix": "/api" }
```

Without this field, all admitted paths keep the existing JSON API behavior.
With it, `/api` and `/api/...` select the API, preserving the complete request
path for the handler. `/apix` is a client lookup. Static GET and HEAD select only
the captured `client/` inventory; `/` selects `client/index.html`, and a trailing
slash selects that directory's `index.html`. Unknown assets return 404. There is
no filesystem lookup or SPA fallback, and server/configuration files are never
client assets. Static writes and API HEAD reject.

Static requests use the same header, Host, Origin, Fetch Metadata, target,
deadline, concurrency and lifetime checks. They do not start a broker or grant
database access. Each listener owns a revocable reader of immutable captured
client bytes. Normal budget exhaustion lets the final response drain before
revocation; explicit shutdown still waits for the original owners to settle.

At 256 admissions, the service stops taking new requests and drains the last
admitted request. It does not silently rotate ingress instances or reset the
budget. A later error upgrades that drain to failed shutdown. Restart explicitly
with the same protected profile and existing store for a new bounded session.

## Deadlines and closure

The original ingress deadline includes body consumption; preparation, native
startup, guest execution and normal closure consume its remaining time. No stage
receives a renewed request budget. Every API request owns new original runtime and
broker preparations. Success waits for both original normal-closure gates.

SIGINT/SIGTERM stop admission and request cancellation. Shutdown awaits the actual
listener callback and transports, then the complete original owner set, including
an owner created after a delayed body at the lifetime-budget boundary. Listener
failure cannot skip owner settlement. Closing a socket, receiving a response,
requesting cancellation and confirming original process closure are distinct.
Cancellation promises no SQLite rollback; retain the store and idempotency key.

Metadata changes during admission fail explicitly. Separating installation from
serving is not a fix for the observed asynchronous Windows ctime/EA changes. These
commands do not sleep, ignore ctime, warm up admitted files or retry an audit. The
older offline broker checker's reader is not reused as a workaround.

## Validation scope

The new profile, listener, CLI and browser-ingress suites use controlled files,
authorities, processes and/or streams. They do not establish native, browser or
product publication acceptance. The existing real four-request driver under
`artifacts/application-http-service-fixture-r6/` remains separately scheduled by
the integration owner: create/normal close, POST, GET, close/reopen, GET and
idempotent POST replay. Its explicit Node Origin headers do not establish browser
behavior. Installed-entry acceptance must exercise these commands and browser-style
GET without Origin, retain actual closure evidence, and preserve failed stores.
The existing fixture does not expose per-request native receipts and must not
manufacture them.

No application release profile, deployment health contract, recovery/migration
procedure, signed distribution or live-provider acceptance is introduced here.
The existing release protocol remains for configured static sites.

## Installed restart source validation (2026-11-09)

The isolated `windows-installed-restart` worktree installed its own locked
dependencies with `npm ci --ignore-scripts --no-audit --no-fund`. The following
focused command passed **286 tests across 7 files**, with no skips:

```powershell
npm test -- apps/artood/src/application-installation.test.ts apps/artood/src/application-installed-session.test.ts apps/artood/src/application-session-ownership.test.ts apps/artood/src/application-local-service.test.ts apps/artood/src/application-service-profile.test.ts apps/artood/src/application-local-service-http.test.ts apps/artood/src/application-service-cli.test.ts --maxWorkers=2
```

These are controlled filesystem/ACL/native/CLI tests, plus actual loopback HTTP
tests with controlled native owners. They do not execute the product, native
helpers or a browser. A source-only TypeScript check of the eight changed
source/test roots, using this worktree's compiler options with `noEmit` and
monorepo source aliases, reported zero diagnostics. It produced no build outputs.
That focused check is separate from the required full workspace typecheck/build,
full test suite and Web E2E checks, which remain integration work. Real descriptor
publication, immutable Windows metadata behavior and separate-process restart
acceptance are still unverified.

The subsequent independent-bootstrap candidate passed **386 tests across 10
files**, adding `application-bootstrap-admission.test.ts`,
`application-bootstrap-control.test.ts` and
`application-service-bootstrap.test.ts` to the command above. It also passed
`npx tsc --noEmit --composite false -p apps/artood/tsconfig.json`. This checks the
current artood sources and tests against the available workspace declarations;
it is not a full workspace build. The host builder's **16 pure fixtures** passed
separately. No generated application host, native process, product or browser was
executed by these candidate checks. Integration must record the final immutable
version and its actual build/restart evidence separately.
