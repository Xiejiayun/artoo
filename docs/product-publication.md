# Target-product publication

Agent Team goals can request a configured `release_profile_id`. The release step begins only after all required plan tasks are accepted and their processes have exited. The final plan execution must have successful node-owned verification evidence. A separate executor snapshots the measured source, publishes it, checks the actual HTTP endpoint, and returns a node-owned receipt. The goal stays incomplete until that receipt reports successful publication.

The adapter publishes a **static web product** from a Linux/macOS worker or an explicitly qualified native Windows worker. The Windows publisher and separate desktop opt-in are integrated; the [Agent Team guide](agent-team-development.md) records current acceptance evidence. The worker serves immutable HTML, JavaScript, CSS, images and other static files. An operator can put an existing HTTPS reverse proxy in front of this listener. Server applications, database migrations, remote cloud provisioning, DNS changes and application-store publication need additional adapters; this profile does not perform them. A localhost fixture proves local serving and recovery, not an externally reachable production deployment.

## Configure the target once

Create an existing, dedicated release storage directory outside every agent-writable workspace. Protect it and the profile file from coding runtimes and other users. Configure a verifier whose `subject_paths` cover all product source, stage documents and the complete generated public directory. The acceptance program must build before the measured verification window, or verify an existing build without changing the measured subject: source changes during verification are rejected.

For example, `/opt/artoo/release-profiles.json`:

```json
[
  {
    "id": "default",
    "project_id": "proj_product",
    "verification_profile_id": "default",
    "storage_root": "/srv/artoo/releases/product",
    "output_path": "product/dist",
    "public_url": "https://product.example.com",
    "listen_host": "127.0.0.1",
    "listen_port": 9080,
    "health_checks": [
      { "path": "/", "expect_text": "Product" },
      { "path": "/assets/app.js" }
    ],
    "health_timeout_ms": 10000,
    "monitoring": { "interval_ms": 30000, "failure_threshold": 3 }
  }
]
```

These are example values. Supply a real project, paths and reachable endpoint. `output_path` must be covered by the verifier's subject paths. The public URL must be an HTTP(S) origin without credentials or a path prefix. Configure a reverse proxy to preserve `X-Artoo-Release-Id` and `X-Artoo-Artifact-Digest`; endpoint checks require both headers and the exact bytes of each requested immutable file. For content-hashed assets, configure stable meaningful health paths instead of inventing a build filename. Health checks should cover the supported product's critical static entry points; they do not replace browser interaction and acceptance tests.

`monitoring` enables ongoing endpoint checks and automatic recovery after publication. It is optional; omitting it preserves publication-time checks only. The interval must be between 1 second and 1 hour, and the consecutive-failure threshold between 1 and 10. Monitoring uses the same protected health paths, expected immutable bytes, endpoint identity and timeout as publication. It accepts no commands, URLs or policy changes from a model. Set this configuration before publishing: it is part of the immutable profile digest, so changing it does not silently rebind an existing release.

Start the normal worker with both local configurations:

```sh
export ARTOO_VERIFICATION_PROFILES_FILE=/opt/artoo/verification-profiles.json
export ARTOO_RELEASE_PROFILES_FILE=/opt/artoo/release-profiles.json
node apps/artood/dist/main.js
```

The worker publishes profile routing metadata through its authenticated session; the optional criterion mode below also advertises its measured publication contract. Models and server requests never supply deployment commands, paths or credentials. Managed journal/per-run workspace publication is not supported by this adapter.

### Native Windows configuration

Complete the [native Windows verifier setup](windows-native-development.md#启用本地原生验证) first. Use the same release-profile schema with actual Windows paths, for example `"storage_root": "C:\\ArtooControl\\releases\\product"`, and supply the protected local profile explicitly:

```powershell
$env:ARTOO_RELEASE_PROFILES_FILE = 'C:\ArtooControl\release-profiles.json'
node apps/artood/dist/main.js
```

These are example paths, not prepared resources. The release file and existing storage directory must be outside every allowed agent workspace. Windows publication requires local Fixed NTFS storage admission, including physical path, ownership, DACL and directory-identity checks, plus the exact prepared native process backend used by the bound verifier. Both authorities are prepared locally and held privately; JSON, a model answer or a remote request cannot supply them. Unsupported configurations fail closed. Storage is audited at startup and mutation boundaries. An audit failure closes serving, aborts in-flight operations and prevents later state writes until a fresh executor admits the repaired storage.

In the desktop Worker configuration, enable **Enable automatic task verification**, then separately opt in to **Enable automatic product publication** and choose the **Publication profiles file**. Publication defaults off and requires verification. Configuration is checked again on worker start; the desktop passes only the selected release file and filters inherited Windows automation variables. Full profile, backend and storage qualification remains worker-owned. Saving the setting does not establish a successful release or installed-desktop acceptance.

The original 21-file publisher/desktop integration is recorded in [the historical integration manifest](../artifacts/windows-publisher-integration-2026-11-05/integration.json). The subsequent native Windows/Aerial run completed research, design, implementation, validation, independent review and healthy local static-site publication from one objective; see [the Agent Team guide](agent-team-development.md). It used isolated authenticated fixture transport, and its temporary site and product workspace were removed during cleanup. Cross-computer continuation now includes destination design review, implementation and its review, final validation and publication in source; the supervised two-node application flow still needs successful live acceptance. Physical two-computer acceptance, installed-desktop qualification, signed distribution and production hosting remain unverified.

## Bind publication to acceptance criteria

The optional typed publication path has passed controlled integration checks and the scoped native Windows/Aerial acceptance described above. Enable `"criterion_acceptance": { "version": 1 }` on the protected local release profile, and configure its verifier with:

```json
{
  "measurement_plan_policy": {
    "version": 2,
    "coverage": "every-must-criterion",
    "methods": ["workspace-check", "configured-static-release"]
  }
}
```

This policy requires configured browser contracts using version 3. The node advertises the prepared publication contract through its authenticated session. Planning pins that contract alongside verification capabilities; each later author, reviewer and verification request must retain the exact binding. Profiles without this opt-in retain their previous behavior and digests.

Research maps each must-have criterion either to an installed workspace check or to the configured publisher's exact canonical publication statement. A publication route cannot stand for an arbitrary requirement such as database recovery or permanent public availability. Design and validation documents use version 2 for this route. Their publication cases remain `pending-release`, with no browser trace or author-supplied success evidence. Workspace cases still need their actual configured measurements. The node also checks that the actions, keys and storage windows declared in the measurement plan appear in the criterion's programs; that structural check does not prove that natural-language requirements are semantically complete.

Only the final validation author's accepted, independently reviewed verification can authorize typed publication. The request binds the accepted plan, research bytes, measurement plan, source digest, local release contract and exact criteria. After the immutable version is activated and actual HTTP checks pass, the node receipt records which criteria were satisfied at publication time. The server rechecks current acceptance and any latest health report before recording the goal's completion and its settlement facts. A replay, cancellation or recovery request must preserve the complete nested binding. Later health degradation remains visible separately from historical publication success.

The canonical condition establishes the configured static origin's measured paths, content digests and release identity at that point in time, while the configured node service is running. It does not establish a production domain, continuous availability or a live-provider development outcome. Integration and live-run results are tracked in [the Agent Team guide](agent-team-development.md).

## Submission and evidence

Select the Agent Team publication mode, or include `release_profile_id` in a supported autonomous-goal request. The API exposes progress at:

```http
GET /api/v1/goals/:goal_id/release
```

The response contains `release: null` before a release is queued, otherwise a `ProductRelease`. `queued` means publication has not been confirmed. `published` includes a receipt with the endpoint, source/artifact digest, exact run and verification request, release-profile digest and measured endpoint checks. `rolled_back` and `failed` are terminal failures and do not complete the goal. A successful rollback to a prior version also records that version's health measurements.

When monitoring is configured, `release.health` contains the latest subsequent observation: `healthy`, `degraded`, `rolled_back` or `unavailable`. A missing observation does not establish current health. This report has its own event identity and per-release sequence, and binds the complete original request and artifact/profile digests. The original publication receipt remains immutable: a product that was published successfully can later become unavailable. The UI shows those outcomes separately and does not offer a current product link for a withdrawn version. Protected local records retain each release's latest report; node startup and reconnection replay the publication receipt before the later health report. Old or repeated sequences cannot replace newer server state.

Health delivery waits for `product.release.health.ack` bound to the exact event, release and sequence after the server commits the report. Sending bytes to a socket is insufficient. Rejected/timed-out reports remain eligible for retry, including final rollback/unavailable states with no subsequent measurement. While disconnected the sender retains the latest observation per release; a rejected or frequently updated release cannot block other releases. Publication and health ingestion both recheck the current node session inside their persistence transaction.

The release command carries only persisted IDs and digests. The worker also requires its own durable successful-verification attestation for that run; a matching string supplied by the server or model is insufficient. It remeasures the workspace, copies the complete verified subject into protected storage, compares the snapshot's manifest and rechecks the source. It serves only the configured public directory from that snapshot. Later workspace edits cannot change the active product. Every file read for serving is checked against its stored checksum.

## Recovery and operation

Release IDs bind immutable request content. Re-delivery and node/server reconnection reuse the same operation. Local operation records and active-version pointers use file flush and atomic rename, with directory fsync on POSIX. Windows recovery is qualified for process termination/restart on admitted local Fixed NTFS; it does not claim operating-system-crash or power-loss durability. Before activation, the executor records the previous version. Failed endpoint checks first persist a `rolling_back` operation with the failure measurements, then restore the previous pointer and verify the restored endpoint. Process termination during recovery can only resume rollback; it cannot activate the known failed candidate again. If there was no previous version, recovery disables the new publication. If the previous version also fails its checks, a durable `disabling` phase records those measurements before clearing the active pointer. Recovery reports failure and serves HTTP 503; a restart cannot reactivate the rejected previous version. This protection also applies when ongoing monitoring is not enabled. A passed health or recovery measurement requires HTTP 200 and a measured body digest.

Cancellation compares the complete request against both active execution and the durable operation before storing a tombstone or aborting endpoint checks. A reused ID with different goal, source or profile bindings is rejected without those side effects. If activation occurred, the executor restores the previous pointer before reporting its terminal receipt. Goal cancellation waits for node confirmation; an offline or disconnected publication worker remains uncertain. Cancellation after a release already completed returns its recorded terminal result and does not undo that completed publication. Pausing stops new steps; it does not claim to interrupt an already running publication.

The static listener is part of `artood`; keep that service running and use the normal host service supervisor. On startup, the worker scans its local operation journal and restores a confirmed previous release (or disables publication) **before binding the listener**, then measures recovery and saves a terminal receipt before reporting readiness. This recovery runs even when the server is offline or the goal is paused; command replay is not required. The worker refuses to listen if a pointer has no matching published receipt, multiple unfinished operations make recovery ambiguous, or the journal exceeds the bounded startup limit of 10,000 operations. Snapshot and operation records remain retained for recovery; no garbage collector deletes prior versions automatically. Do not change or remove these files while the service is running. The storage boundary protects operations routed through this worker, not a compromised administrator or independent process with filesystem access. Configured profile changes can invalidate existing pointer bindings and require an operator-reviewed recovery plan.

After publication, the monitor schedules actual HTTP measurements independently of server commands. A failed observation records `degraded`; a successful observation resets the consecutive-failure count and records `healthy`. Counts survive daemon restart. Checks and new releases share the profile's serial execution queue, so an observation cannot roll back a newer publication. Daemon shutdown aborts an unfinished observation without inventing a product failure.

At the threshold, the worker first persists a separate recovery intent. It restores only the failed publication's directly preceding confirmed version, then verifies that version through the configured public endpoint. A previous version already withdrawn by monitoring is ineligible. Successful recovery records `rolled_back` with the active version's digest and actual recovery checks. If no eligible version exists, or its checks fail, the worker disables the active pointer and serves HTTP 503; it records `unavailable`. A durable `disabling` phase prevents a crash after failed recovery from reactivating either rejected version. Restart completes pending recovery before readiness, including when the control server is disconnected. Unreadable or unwritable monitor state stops the listener rather than continuing untracked serving. Health journals retain at most 10,000 release records per profile and require operator maintenance at that limit.

A local journal or executor fault is recorded in the worker's diagnostics and error log. If persistent storage cannot accept evidence, the worker does not invent an HTTP failure report or rewrite a prior successful observation. The API's last observation remains historical, with its original timestamp and sequence; it is not proof of present availability. Operators must repair the underlying node/storage fault before restarting the executor.

This monitor recovers to a previously accepted immutable static version. It does not repair product source, provision replacement infrastructure, recover databases, or diagnose an upstream proxy outage. An outage affecting every version results in unavailable service, not a fabricated successful rollback. Those broader operational repair capabilities still require additional executors and acceptance evidence.

## Validation scope

`apps/server/src/product-release.test.ts` exercises durable queueing, accepted-work/evidence gates, current-session ownership, immutable receipts and cancellation confirmation. `apps/artood/src/product-release.test.ts` covers configuration boundaries and includes POSIX HTTP/snapshot tests.

The integrated Windows implementation has the following separately scoped evidence in [the publisher delivery record](../artifacts/windows-release-storage-2026-11-05/DELIVERY.md):

- Native snapshot 7 passed 3/3 corrected publication scenarios, 17/17 follow-up scenarios and 3/3 actual TCP fault regressions. These include publication, rollback, cancellation, monitoring, journal rejection and six actual forced-termination boundaries, with observed process exit/close and unchanged inputs.
- Final snapshot 9 compiled and passed 116 focused tests, with four POSIX-only skips. The only production change after native snapshot 7 moves the existing signal/deadline predicates to the end of the health-success expression, after digest/header/text checks. That final one-line change has controlled actual-HTTP regression coverage; snapshot 7's native results do not cover it. The final integrated native check remains pending.
- The desktop snapshot passed 62 tests with 18 platform skips and Web typechecking; [the focused report](../artifacts/windows-desktop-publication-2026-11-05/focused.json) and [typecheck report](../artifacts/windows-desktop-publication-2026-11-05/typecheck.json) record actual exit/close and unchanged inputs. They do not execute the native Electron dialog or an installed-desktop publication.

Actual NTFS qualification and unsafe-ACL rejection checks are also retained in the publisher record. The boundary trusts the current node user, SYSTEM, Administrators and TrustedInstaller; it does not isolate arbitrary native code running as that same user or a compromised node/admin. Previous failed invocations remain recorded. Main-tree typecheck, build, 325 focused tests (7 platform skips) and four genuine native publisher cases now passed, including the final deadline predicate order; see [the integration record](../artifacts/windows-publisher-integration-2026-11-05/README.md). The subsequent complete Web check passed 27/27 with exit/close 0; the final full source gate remains pending. None of these controlled fixtures is full live-provider product acceptance.

The real POSIX fixture runs acceptance subprocesses, copies source into immutable snapshots, requests actual HTTP responses, injects failed health checks, confirms rollback, and checks cancellation identity. It also checks the actual monitoring timer, persistent failure counts, recovery while the control server is unavailable, serialized publication, shutdown cancellation and invalid journals. Real `SIGKILL` covers candidate health, rollback health, ongoing-monitor recovery, and both publication/monitor `disabling` phases after the state-file rename and directory fsync. Restarts require no command replay and must restore a confirmed version or keep the endpoint unavailable before readiness:

```sh
npm run build
node --test apps/artood/test-fixtures/product-release-real.test.mjs
```

This fixture uses controlled product files, not a live model. A full Agent Team acceptance run must separately show a real provider developing from an empty product workspace through this release boundary.

On 2026-11-04 the complete built POSIX publication fixture passed **22/22 tests with no skips** on WSL Linux / Node 24.11.0, including ongoing monitoring and both failed-recovery shutdown paths. The retained local output is `artifacts/autonomous-validation/product-release-monitor-final-2026-11-04.log`. The node TypeScript build also passed; Windows-focused publication/protocol tests passed 7 tests with 4 POSIX-only skips. These results establish the tested executor boundaries, not a live-provider product delivery or production deployment.

## Live-provider acceptance gate

`apps/server/src/agent-team-live.test.ts` is an explicit opt-in test. It starts with an empty temporary workspace, provisions four distinct agents using the selected real Codex or Claude CLI, enables the supported research broker and repository initialization, runs the protected browser acceptance program, and pumps planning, stage execution, independent review and publication without injecting any model answers. It verifies successful source-bound peer review, multiple actual contributors, research receipts, measured acceptance, provider usage and the real local HTTP endpoint.

The full live-provider test now admits native Windows through the same production helper, verifier and NTFS storage qualification, as well as Linux/macOS. Its original objective, deadline, retry budget and acceptance assertions are unchanged; The first full Windows invocation exceeded the unchanged 45-minute limit after repeated browser-observation timeouts; it did not reach publication. See [the native acceptance record](../artifacts/windows-agent-team-live-2026-11-05/native-live-1/README.md). Prerequisites are a supported host, the authenticated native CLI, Git, an installed native Chromium executable and current built modules. Windows also needs the qualified helper path/digest and a physical temporary root outside redirected AppData. The operator must supply the actual provider disclosure and consent for the isolated fixture user. Existing CLI login/configuration is used; the test does not invent credentials or enable unrestricted permission bypass.

```sh
npm run build
export ARTOO_AGENT_TEAM_LIVE=1
export ARTOO_AGENT_TEAM_RUNTIME=codex
export ARTOO_AGENT_TEAM_BROWSER_EXECUTABLE=/absolute/path/to/chromium
export ARTOO_AI_DATA_SHARING_POLICY='{"mode":"external","providers":[{"id":"openai","name":"OpenAI","privacy_url":"https://openai.com/policies/privacy-policy/"}]}'
export ARTOO_LIVE_AI_SHARING_CONSENT=1
npx vitest run apps/server/src/agent-team-live.test.ts --maxWorkers=1
```

Adjust the disclosure to the actual recipient configured in the CLI; for Claude select `ARTOO_AGENT_TEAM_RUNTIME=claude-code` and disclose its actual provider. `ARTOO_AGENT_TEAM_OBJECTIVE` can supply another bounded static-web requirement. Optional `ARTOO_RESEARCH_BRAVE_KEY_ENV` names an existing environment variable for search; public HTTPS fetch works without a search key.

For a configured Responses API gateway, the live test uses the same validated `ARTOO_CODEX_BINARY`, `ARTOO_CODEX_MODEL`, `ARTOO_CODEX_PROVIDER_URL` and optional `ARTOO_CODEX_PROVIDER_KEY` settings as the normal worker. HTTPS or loopback HTTP is required, and a custom URL requires an explicit model. Provider credentials remain in the environment and are never placed in arguments or the report. An available local gateway can supply inference without a separate Codex CLI login; its actual upstream recipient still belongs in the disclosure.

The test allows at most 45 minutes of orchestration and three goal repair attempts, using the provider's configured model allowance. It writes one timestamped JSON report under `artifacts/live/`, including failed prerequisite/attempt status, bounded validation feedback history and task/run progress as the state changes. Credentials, model transcripts and source bodies are excluded by default. For local failure diagnosis, explicitly setting `ARTOO_AGENT_TEAM_DIAGNOSTICS=1` retains at most four planning-response excerpts and the last six output events for each of the last three failed runs. Each excerpt is limited to 2,000 characters with environment credentials redacted; treat these as untrusted model/tool output. It stops real execution and closes the product listener before deleting its isolated temporary directories. The reported endpoint is a test endpoint available during that run, not a retained production website. With the opt-in flag unset, this test is **skipped**; a skipped test is not evidence that a provider completed product development.
