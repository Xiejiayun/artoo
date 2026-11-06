# Native Windows source and continuation nodes

This entrypoint uses native Windows and ordinary reserved workspaces. It does not use WSL or a managed execution journal. Each computer needs its own paired node identity, qualified Windows process helper, locally installed agent runtime, protected verifier/release configuration, and allowed write roots. Initial machine provisioning remains an administrator task.

Select a dedicated protected JSON file with `ARTOO_PRODUCT_SOURCE_CONFIG_FILE`. Keep its directory, source store, Git executable, verifier assets and research receipts outside every agent write root. The node validates the configuration directory using the existing Windows storage ACL qualification; it does not grant permissions or weaken ACLs. Use canonical absolute Windows paths. The standard entrypoint enables committed run-event receipts.

Startup and source capability publication re-audit this protected directory's ACLs. During a live session the node rechecks the fixed file identity and complete bytes. NTFS first-read access metadata may change, but a second complete read must keep its metadata and bytes stable; content or path changes reject admission.

Autonomous planning on a source-enabled node requires exactly one prepared local verifier profile matching the planning agent's current project and workspace, plus a runtime preset supporting the context-only read-only broker. That profile supplies native process ownership; its verifier commands are not run for planning. Missing or ambiguous local profiles reject planning. The future worker's capability snapshot grants no access to its workspace. Planning uses its own native execution admission and cannot produce verification or source-export authority; completion and cancellation still require the original process and broker closure.

The file has these fields:

| Field | Meaning |
| --- | --- |
| `version` | Must be `1`. |
| `storeRoot` | Existing protected local source journal and capsule directory. |
| `gitExecutable` | Existing protected native Git executable. |
| `sourceResearch` | Optional boolean. When true, reuses the author's existing `ARTOO_RESEARCH_ENABLED=1` and receipt-directory configuration. |
| `destinationResearchMappings` | Optional policy-v1 destination mappings with `sourceProfileDigest`, `destinationProfileId` and complete `commandPairs`. |
| `measurementV2` | Optional `{ version: 1, releaseProfileIds, destinationResearchMappings }`. IDs select original prepared local release profiles. Each mapping also contains the exact source `ReleaseCapabilitiesV1` as `sourceRelease`. |
| `operations` | Optional `{ version: 1, importedReview, importedDesign, importedDesignReview, importedExecution, importedExecutionReview, importedValidation }`. Each later controller requires the preceding configured stage. |
| `recovery` | Optional `{ version: 1, deviceId, workspaceRoot, controlDirectory }`. Requires the complete imported chain, committed receipts and a genuine native Supervisor; see the supervised CLI below. |

A source computer configured for policy-v2 research export can use this shape, replacing the paths and release-profile ID with its installed configuration:

```json
{
  "version": 1,
  "storeRoot": "C:\\ArtooNode\\source-store",
  "gitExecutable": "C:\\Program Files\\Git\\bin\\git.exe",
  "sourceResearch": true,
  "measurementV2": {
    "version": 1,
    "releaseProfileIds": ["product-static-site"]
  },
  "operations": { "version": 1 }
}
```

A destination computer may omit `sourceResearch`. Configure its complete source-to-destination measurement mapping using the source computer's actual prepared capability contract and its own local profile IDs. For policy-v2, each `sourceRelease` must match the source contract, source verifier digest, project and destination's prepared release contract. JSON contains selections and contracts; it cannot create a release reader or a prepared verification authority.

To enable imported design, set both `operations.importedReview` and `operations.importedDesign` to true, configure a policy-v2 destination mapping, and install a native Windows v3 browser Job verifier for every selected destination. Missing profiles, incomplete mappings, unsupported checks or uncommitted event delivery reject startup before hello. H3 ends after the imported design writer's verified result; it does not enable a later design-review or publication continuation.

The semantic-transfer client reuses the exact paired `ARTOO_NODE_URL`. It requires `/api/v1/node`, exactly one device token, no other query parameters, no user-info or fragment, and WSS except for loopback WS. There is no separate task-supplied URL or token setting. Tokens are kept out of hello and source runtime configuration.

Without this file, source transfer and continuation features are removed from caller-supplied hello metadata. With it, discovery is derived from the original prepared runtime and actual constructed controllers. Destination-only nodes can advertise semantic and policy-v2 roles without a research receipt store.

Source continuation authority belongs to one live connection. A disconnect ends that session, aborts its controllers, and reports node failure; this node does not reconnect automatically. After controllers settle, the source owner closes only if the runtime confirms no live or uncertain writer. Durable workspace claims and operation history remain. Do not delete lock or claim files to resume work: restarting cannot reconstruct accepted review authority from disk. Ordinary nodes without source configuration retain their existing reconnect behavior.

## Native supervised CLI

The opt-in Windows CLI starts the first daemon under the native Supervisor and can replace a crashed daemon under that **same live Supervisor**. Use the existing Web control surface to submit requirements and inspect the paired computer. This path uses native `node.exe`, a local agent executable and the Windows process helper; it does not require WSL. Desktop keeps its existing manual worker launch. Electron's executable cannot substitute for `node.exe` here.

Provision the computer once before use:

- Install the complete daemon bundle produced by `apps/desktop/scripts/bundle-daemon.mjs`, including `artood.mjs`, its helper entrypoints, Playwright packages and `bundle-manifest.json`, in a dedicated protected directory outside every agent write root. The CLI reuses this bundle format without requiring the Desktop application. Use the native helper build advertising `artoo.windows-daemon-supervisor-lifetime.v1`.
- Configure the paired node identity, allowed write roots, protected verifier/release profiles, local source store and source configuration described above. All referenced programs and configurations must satisfy the existing physical-path and ACL checks. The CLI never grants permissions or rewrites an existing owner fence.
- In the source JSON, enable the complete imported chain: `operations.version=1`, `importedReview`, `importedDesign`, `importedDesignReview`, `importedExecution`, `importedExecutionReview` and `importedValidation` must all be true. Retain the actual policy-v2 destination mappings and prepared profiles required by those roles. Add `recovery: { "version": 1, "deviceId": "<this paired device ID>", "workspaceRoot": "C:\\ArtooWorkspaces\\product", "controlDirectory": "C:\\ArtooNode\\recovery-control" }`. The workspace must exactly match a prepared local verifier workspace. The source store and control directory must be protected and outside the write roots.
- Select `ARTOO_RUNTIMES=codex` and an absolute `ARTOO_CODEX_BINARY` pointing to the installed native Codex executable. The supervised environment uses the Windows system PATH; implicit CLI discovery and the default `codex,claude-code` selection are not supported by this entrypoint yet.
- With `ARTOO_INITIALIZE_REPOSITORY=1`, supervised product bootstrap uses the exact protected `gitExecutable` from the source configuration. The parent pins that executable and the daemon rechecks the selection and source configuration before and after bootstrap. Missing, invalid or changed selections fail before product execution. This does not add Git to the system PATH, accept task-supplied commands, or grant additional process authority; ordinary non-supervised nodes retain their previous installed-Git PATH resolution. `ARTOO_SUPERVISED_BOOTSTRAP_GIT` is an internal parent-derived projection and is never copied from the caller's environment.

After preparing those local settings, start from PowerShell:

```powershell
$env:ARTOO_RUNTIMES = 'codex'
$env:ARTOO_CODEX_BINARY = 'C:\ArtooNode\tools\codex.exe'
$env:ARTOO_PRODUCT_SOURCE_CONFIG_FILE = 'C:\ArtooNode\config\source.json'
$env:ARTOO_SUPERVISED_BUNDLE_MANIFEST_SHA256 = 'sha256:' + (Get-FileHash -LiteralPath 'C:\ArtooNode\daemon\bundle-manifest.json' -Algorithm SHA256).Hash.ToLowerInvariant()
& 'C:\Program Files\nodejs\node.exe' 'C:\ArtooNode\daemon\artood.mjs' --windows-supervised
```

Supply the ordinary paired `ARTOO_NODE_URL`, `ARTOO_NODE_ID`, allowed roots and native/profile settings through the local launch environment as before. An existing Aerial Responses provider can use `ARTOO_CODEX_PROVIDER_URL=http://127.0.0.1:18181/v1` and its actual configured `ARTOO_CODEX_MODEL`; provider availability still requires a real acceptance run. Keep tokens and API keys in the local environment or secret store. The launcher passes them over private inherited stdin to the native Supervisor and never puts them in argv, the bundle manifest or lifecycle output.

The Supervisor retains read-only physical handles for Node, the entrypoint, source JSON, bundle manifest and every listed runtime file. It checks the complete bundle again before each generation and native qualification. Changed files, an unqualified helper, missing mappings, an existing ordinary owner fence or a different original Supervisor fail closed. The parent only inspects configuration; it does not create a source runtime before the supervised daemon starts.

`artoo.supervised.ready` means that the current generation passed native qualification, received its current guardian registration (and, for a recovered generation, the accepted recovery receipt), and completed required controller/publisher initialization. A new process PID, open WebSocket or ordinary model response does not trigger this status. Replacement generations begin unready and cannot reuse a previous generation's notification.

Press Ctrl+C once for a graceful stop. The parent first asks the Supervisor to prohibit further restarts, then asks the daemon to settle its controllers. `artoo.supervised.stopped` appears only after the actual native process exits successfully, both pipes reach EOF, every original daemon HANDLE has signalled, and the shared lifetime Job is empty. Failed or timed-out cleanup returns a failure; a stop ACK alone never counts as closure. Loss of the parent control pipe also terminates the supervised Job and is reported as failure when observation remains possible.

For a local service or automation that owns the CLI's inherited stdin pipe, set `ARTOO_SUPERVISED_STDIN_CONTROL=1` on the outer `--windows-supervised` process. Write one UTF-8 line `{"version":1,"kind":"shutdown"}` followed by a newline after readiness. This requests exactly the same graceful stop as Ctrl+C. Keep observing the original CLI until `artoo.supervised.stopped`, exit zero, process close and both output EOFs. A request alone is not proof of cleanup. On Windows, `ChildProcess.kill("SIGINT")` terminates the process and is not this graceful protocol.

The stdin option defaults off (`0` or unset); ordinary interactive and Desktop behavior stays unchanged. It is not forwarded to the daemon. Only the versioned shutdown command is accepted, with a 4 KiB total input bound. EOF before a complete request, a malformed frame or a pipe error fails the supervised lifecycle. EOF after a complete shutdown request is allowed. The pipe conveys no execution, pairing or recovery authority, and it cannot bypass the complete pinned bundle or native qualification checks.

The current fixed session limits are eight daemon replacements, one second between replacements, a 24-hour total lifetime and 16 MiB of cumulative daemon output. Registration initialization has a two-minute deadline per generation. Graceful settlement and native cleanup each have a 15-second budget. Limits fail closed and retain the existing failure evidence.

**Recovery across separate Supervisor starts is not implemented.** Stopping this entire CLI, exhausting its lifetime, closing its owner or losing the Supervisor ends its live recovery authority. Recovery stores and workspace fences remain retained; the same workspace cannot simply be reopened by another CLI process. A later independently provisioned session requires its own prepared source/workspace binding. Do not delete, rewrite or upgrade `owner.lock`, operation claims or audit files to bypass this boundary.

These entrypoint checks do not establish a live-provider, multi-computer or publication acceptance run. Follow the Agent Team guide for the current complete product-development acceptance scope.
