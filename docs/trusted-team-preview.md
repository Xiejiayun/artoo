# Trusted small-team preview delivery

This is a historical 2026-09-28 delivery record. For subsequent native Xcode,
cross-client and live Aerial/Copilot verification, use
[the current collaboration milestone record](cross-client-sync.md). The
environment limitations below describe this earlier delivery.

This is the implementation and acceptance record for the Web, Windows and iOS
preview, verified on Windows on 2026-09-28. The supported
deployment is one trusted organization per server, with explicitly admitted
users and paired execution devices. iOS implementation is in scope; Mac/Xcode
runtime verification will be performed by the owner later.

## Acceptance inventory

- [x] Durable storage: first boot, repeated boot, append-only upgrades, failed
  migration rollback, historical migration integrity, legacy data adoption,
  backup/restore, graceful shutdown, health/readiness and startup documentation.
- [x] Access: production authentication cannot be disabled, explicit team
  admission and owner setup, role enforcement, native REST/control WebSocket
  credentials, expiration/logout/revocation, exact public endpoint boundaries,
  organization-scoped replay and credential-free logs.
- [x] Execution: node-bound event attribution, real process cancellation before
  lease release, bounded safe shutdown, reconnection/event recovery, runtime
  availability reporting, explicit execution permissions and negative tests.
- [x] Deliverables: durable upload before workspace cleanup, checksums and size
  limits, authenticated downloads on every client, review/request changes,
  retained workspaces on delivery failure, exported redacted audit evidence.
- [x] Web task workflow: project setup/switching, task creation/priorities/
  capabilities, ready/assign/run/cancel/retry, messages, dependencies, approvals,
  artifacts/review, run/audit, memory curation, skill installation, lease visibility.
- [x] Web goal workflow: create goals, propose/review/materialize plans, child
  execution and completion, checkpoints/pause/resume/reconcile, decisions,
  handoffs/blockers and goal audit. Existing backend capability must be accessible
  through real product controls, with loading/empty/error/conflict states.
- [x] Devices and operations: authenticated pairing, enrollment/revocation,
  computers/runtimes/agents and health, no misleading fake online resources in
  the production setup, clear setup and recovery actions.
- [x] Windows: first-run server configuration, secure credential storage,
  pairing/login/logout, packaged renderer, local daemon configuration/start/
  stop/restart/status, safe navigation, packaged install/read/write/execution/
  approval/artifact/restart/uninstall evidence and reproducible distribution.
- [x] iOS source: live server configuration, Keychain pairing/auth, matching
  task/goal/team/control APIs, artifact access, errors and recovery, runtime
  status refresh, model/view-model tests and documented Mac build/test gates.
- [x] Usability: complete critical workflow at narrow and desktop widths,
  keyboard-accessible dialogs and controls, visible connection/queued/error
  states, safe retries and explicit stale conflicts.
- [x] Release quality: production dependency audit resolved, meaningful unit/
  integration/security regressions, authenticated browser E2E, real subprocess
  daemon E2E, Windows package E2E, fresh install and restart/restore evidence.

## Verification boundaries

Mock subprocesses prove orchestration and cancellation without spending model
credits; they do not prove model quality. Real CLI invocation must be separately
reported. A rendered iOS source preview is not a simulator/device execution.
Unsigned internal Windows packages are not code-signing evidence. Authentication
tests using a local OIDC provider must be distinguished from real Google login.

## Work record

- Baseline: `c97e0c3`. Review found persistent restart failure, cancellation not
  reaching nodes, missing node-event ownership checks, incomplete native auth,
  file-only artifacts and narrow-screen action loss.
- Baseline validation: 909 Vitest passes / 14 gated skips; 5 browser workflow
  passes; 6 authentication-gate passes; production audit reported 7 advisories.
- Implementation branch: `user/jiaxie/trusted-team-preview`.
- Implemented: transactional migration journal, exclusive database ownership,
  production/native authorization, node attribution and confirmed cancellation,
  durable authenticated artifacts, responsive task/goal/team controls, encrypted
  Windows pairing with bundled worker, and a live SwiftUI control client.
- Approval requests are immutable and consumed by one run; stale decisions and
  unsupported plan safety controls fail closed. Session end discards unsent Web
  commands. Paused plan replacement preserves history and requires proof that
  prior execution stopped, including disconnected runs without file leases.
- Runtime limits enforce elapsed time, retry count and concurrency. Cost limits
  are rejected because model cost metering is not implemented. Declarative plan
  `approval_gates` and `write_scopes` are also rejected; `expected_artifacts` is
  advisory. See [operations](preview-operations.md) for the supported alternatives.

Checked items refer to the supported preview behavior and the evidence below,
not public-store or Mac runtime certification.

## Reproduction and evidence

Runtime: Windows, Node 24.14.0, npm 11.9.0, Electron 44.4.3. The verification
below covers this delivery, developed from baseline `c97e0c3`. See Git history
for the delivery commit; the baseline predates these changes.

| Gate | Result / evidence |
| --- | --- |
| TypeScript / release build | `npm run typecheck` and `npm run build:preview` passed |
| Full unit/integration/security suite | `npm test -- --maxWorkers=4`: 1017 passed, 15 skipped; 161 passed files, 5 skipped files; final run 416.28 seconds |
| Web browser workflows | 9/9 passed; tasks/review/retry/DAG, goals, collaboration, devices/projects/skills, responsive controls |
| Authentication browser gate | 6/6 passed; built same-origin app, Google OAuth redirect/PKCE, exact API/session boundaries |
| Real Git and subprocess seams | 13/13 passed with `ARTOO_GIT_SMOKE=1`, `ARTOO_SUPERVISOR_SMOKE=1`, `ARTOO_DAEMON_SMOKE=1` |
| Bundled Windows worker | 2/2 passed; graceful stop and forced parent termination stop the real parent/child fixture writers |
| Persistence and operations | 4/4 preview storage cases passed; restart, full backup/restore, corruption rejection, legacy upgrade and Windows junction lock recovery |
| Production dependency audit | `npm audit --omit=dev`: 0 known vulnerabilities |
| iOS static contracts | 17 request specimens, execution-approval and assignment responses, 36 required routes, Keychain/onboarding and icon validation passed |
| Swift syntax | 19 source/test files parsed; no Xcode type check or XCTest claim |
| Final Windows installer | Full NSIS install/pair/execute/approve/download/restart/logout/uninstall passed at `2026-09-28T07:59:40.201Z`; single-instance and no-horizontal-overflow checks also passed |

The final installer is [Artoo Setup 0.1.0.exe](../apps/desktop/release/Artoo%20Setup%200.1.0.exe).
SHA-256: `ee7b0668e5e27c47f695a0f1601cbef478f1734e9fb399c052deee4f5825fac3`.
The installer signature status is `NotSigned`. The packaged main, preload,
controller and secure-store files were compared byte-for-byte with current source.

Native evidence: [JSON report](../apps/desktop/release/smoke-artifacts/windows-desktop-smoke.json),
[screenshot](../apps/desktop/release/smoke-artifacts/windows-desktop-smoke.png), and
downloaded patches before and after server/app restart in the same directory.
Six visually inspected Web screenshots at 1280/1024/390 widths are retained under
`apps/desktop/release/smoke-artifacts/web/`. Their responsive browser case passed
again independently after preserving output separately from authentication tests.

The installed-app gate caught a late worker-health response overwriting stopped
state. The final controller checks worker identity and lifecycle generation after
each awaited response; all seven controller regressions pass, including delayed
success/failure after stop/restart. The final installer was rebuilt after this fix.

The real Git/subprocess seams are enabled with the three environment variables
above and run against `worktree-git-smoke`, `branch-e2e-smoke`,
`supervisor-smoke`, and `daemon-multiagent-smoke` Vitest files. Their workspaces
and CLI fixtures are temporary. The default test suite deliberately skips these
opt-in gates; the separate pass above is required evidence.
Of the default suite's 15 skips, 13 were enabled and passed separately; the two
remaining skips are the real Claude CLI smoke (CLI unavailable) and the
Unix-only executable-permission case on Windows. Build, auth E2E, extended-smoke,
typecheck and final full-suite logs are retained under
`apps/desktop/release/smoke-artifacts/validation/`.

The cold persistent-startup/backup/restore integration case has a 60-second
deadline because it boots several embedded databases and restores a full archive.
All integrity and failure assertions remain enabled. The final full run passed
after fixing its earlier CPU-contention timeout; no failing case was skipped.

## Remaining environment and distribution gates

- iOS Xcode build, XCTest, simulator/physical-phone flow, signing/provisioning and
  TestFlight remain deferred to the owner's Mac as explicitly agreed. The exact
  commands and manual flow are in [the iOS README](../apps/ios/README.md).
- Codex is installed on this machine but `codex login status` reports no login;
  Claude CLI is unavailable. Subprocess fixtures prove execution orchestration,
  filesystem writes, cancellation and artifact delivery, not live model quality.
- Authentication integration tests use an in-process test OIDC provider. Browser
  auth tests verify the actual redirect and cookie/PKCE boundary; they do not
  complete a deployed Google account login. The installed-app smoke provisions a
  test owner cookie, then uses real production device pairing and bearer auth.
- Operators must supply their HTTPS endpoint, admitted team and Google OAuth
  settings before team deployment. No external deployment or publishing occurred.
- The Windows NSIS package is unsigned. Internal installation is verified;
  publisher signing and public-store distribution are separate release work.
- One organization and one database writer per server are supported. Multi-tenant
  hosting, shared-database replicas and automatic desktop updates are outside this
  preview. Offline workers retain execution uncertainty and leases until confirmed.
- The development-tool audit still lists four moderate advisories through
  `drizzle-kit`'s legacy esbuild tooling; the production dependency audit is clean.
