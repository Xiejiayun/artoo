# Artoo v1 Release-Candidate Audit

This is the current release-decision summary for v1. It separates work that is
proved by automated/current evidence from work that is either explicitly
deferred from the v1 installable promise or still awaiting gated smoke evidence.

## Current Evidence

- Latest clean-clone validated source/docs head: `194b10a`.
- Latest local full-gate release-doc head: `adc7fd1`.
- Later docs-only v2 kickoff commit: `d7390cb`.
- Clean clone: `C:\workspace\artoo-clean-v1-194b10a`.
- Environment: Windows, Node 24.16.0, npm 11.13.0.
- `npm ci` passed in the clean clone.
- `npm run verify:v1` passed in the clean clone:
  - typecheck
  - build
  - full Vitest: 90 files / 474 passed + 2 gated-skipped
  - Playwright: 4/4 passed
  - production `npm audit --omit=dev`: clean
  - whitespace diff clean
- `npm run demo:v1` passed in the clean clone with a completed task/run,
  artifact, audit-bundle hash, and signing status `deferred`.
- After later release-decision doc refreshes, the main working tree at
  `adc7fd1` also passed `npm run verify:v1` and `npm run demo:v1`.

## Release Definition Audit

| v1 requirement | Current evidence | Status |
| --- | --- | --- |
| Full task -> assignment -> runtime -> artifact -> review chain | `npm run demo:v1`; Playwright happy path; mock/node integration tests | Proved for mock/runtime path |
| Task DAG create/unlock/block/review/audit | #11 tests and Playwright DAG unlock | Proved |
| Scheduler uses task capabilities, runtime registry, and skill registry input | #15 runtime tests; #24 skill install scheduler tests | Proved for automated mock/runtime paths |
| ContextPack includes accepted memories with source ids | #21 ContextPack tests and persisted `runs.context_pack_id` behavior | Proved |
| Concurrency: leases, branch/worktree isolation, integration queue | #12/#20 tests; #23 gated real-git smoke | Proved with gated temp git smoke |
| Skill registry validates manifests, stores installs, and participates in scheduling | #13 domain tests; #24 API/scheduler tests; #25 web read surface tests | Proved |
| Web surfaces for board/sprint, computers, agents, skills, memory, runs/audit | Component tests, route tests, and Playwright release flows | Proved for current v1 read/action surfaces |
| Audit/replay evidence and public redaction | Audit-bundle/export tests; `npm run demo:v1` export verification | Proved; cryptographic signing intentionally deferred |
| Self-host local runbook | Clean clone `npm ci`, `verify:v1`, and `demo:v1` at `194b10a`; local evidence-doc head `494e7b2` passed `verify:v1` and `demo:v1` | Proved on this Windows machine |

## Release Decisions

These are not ordinary coding gaps on this machine.

1. **True Claude CLI runtime smoke**

   Current status: enabled by @jeremy-xie's renewed delegation on 2026-06-16
   and assigned to @claude_sde for an isolated local smoke. The test spawns a
   real `claude` CLI process using real local auth/quota and possible network
   access, so the run must stay confined to a temporary workspace and must not
   publish auth or credential output.

   Required v1 evidence before closing #15/#17/#10:

   - command/environment boundary
   - task id and run id
   - terminal run status and task status transition
   - collected `changes.patch` artifact with hash
   - audit-bundle export evidence

2. **iOS verification**

   Decision: defer iOS installable/runtime verification from v1. Source exists
   under `apps/ios`, but this Windows environment has no macOS/Xcode/iOS SDK.
   The app is clearly marked unverified in its README and source comments.

   v1 treats the SwiftUI app as an unverified source package, not as a directly
   installable/runnable release artifact. macOS/Xcode build, simulator/device
   run, and tests are v2 release-gate work.

3. **Separate-machine self-host smoke**

   Decision: accept the current Windows clean-clone proof as sufficient for the
   v1 local self-host gate. A separate-machine install/run smoke remains
   valuable, but it moves to v2 installer/release hardening rather than blocking
   v1 completion.

## Already Recorded Deferrals

- Cryptographic audit-bundle signing is deferred because v1 does not manage
  signing keys, key rotation, identity binding, or signature verification
  policy. v1 uses deterministic SHA-256 over the redacted bundle.
- Full `npm audit` still reports dev-only `drizzle-kit` / nested `esbuild`
  migration-tooling advisories. `npm audit --omit=dev` is clean and enforced by
  `npm run verify:v1`.
- Installed skill write UX, DAG editing UX, lease/conflict UX, and runtime
  routing write controls are product follow-ups; current v1 read surfaces and
  task execution flows are backed by server contracts.

## Recommendation

Treat current main as a v1 release candidate while the true Claude runtime
smoke is running. Do not mark v1 complete until that enabled smoke either passes
with recorded evidence or is explicitly replaced by a deferral decision.
