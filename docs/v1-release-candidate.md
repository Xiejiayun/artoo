# Artoo v1 Release-Candidate Audit

This is the v1 release-decision summary. It separates work proved by automated
or gated evidence from platform work explicitly deferred from the v1 installable
promise.

## Current Evidence

- Latest clean-clone validated source/docs head: `194b10a`.
- Latest local full-gate release-doc head: `adc7fd1`.
- Later docs-only v2 kickoff commit: `d7390cb`.
- Runtime ContextPack fix head: `5310bea`.
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
- After the runtime ContextPack delivery fix at `5310bea`, the main working
  tree passed `npm run verify:v1`: typecheck, build, full Vitest (90 files /
  474 passed + 2 gated-skipped), Playwright 4/4, production audit clean, and
  whitespace diff clean.

## Release Definition Audit

| v1 requirement | Current evidence | Status |
| --- | --- | --- |
| Full task -> assignment -> runtime -> artifact -> review chain | `npm run demo:v1`; Playwright happy path; mock/node integration tests; gated true Claude runtime smoke after `5310bea` | Proved |
| Task DAG create/unlock/block/review/audit | #11 tests and Playwright DAG unlock | Proved |
| Scheduler uses task capabilities, runtime registry, and skill registry input | #15 runtime tests; #24 skill install scheduler tests; true Claude smoke selected `claude-code` and reached review | Proved |
| ContextPack includes accepted memories with source ids and reaches real runtimes | #21 ContextPack tests; persisted `runs.context_pack_id`; `5310bea` inline dispatch fix; true Claude smoke created the requested marker file | Proved |
| Concurrency: leases, branch/worktree isolation, integration queue | #12/#20 tests; #23 gated real-git smoke | Proved with gated temp git smoke |
| Skill registry validates manifests, stores installs, and participates in scheduling | #13 domain tests; #24 API/scheduler tests; #25 web read surface tests | Proved |
| Web surfaces for board/sprint, computers, agents, skills, memory, runs/audit | Component tests, route tests, and Playwright release flows | Proved for current v1 read/action surfaces |
| Audit/replay evidence and public redaction | Audit-bundle/export tests; `npm run demo:v1` export verification | Proved; cryptographic signing intentionally deferred |
| Self-host local runbook | Clean clone `npm ci`, `verify:v1`, and `demo:v1` at `194b10a`; local evidence-doc head `494e7b2` passed `verify:v1` and `demo:v1` | Proved on this Windows machine |

## Release Decisions

These are not ordinary coding gaps on this machine.

1. **True Claude CLI runtime smoke**

   Decision: required for v1 and passed on 2026-06-16 after the runtime
   ContextPack delivery fix at `5310bea`.

   Evidence:

   - Command: `ARTOO_CLAUDE_SMOKE=1 npx vitest run apps/server/src/claude-runtime-smoke.test.ts`
   - Boundary: gated test, default skipped, isolated OS-temp workspace, in-process
     server, true `claude` CLI 2.1.178, no credential/auth output posted.
   - Task/run: `task_000001` / `run_000001`.
   - Lifecycle: `started -> completed`; task reached `review`.
   - Real work proof: `greeting.txt` existed with exact content
     `ARTOO-CLAUDE-SMOKE-OK`.
   - Artifact: non-empty `changes.patch`, 155 bytes, SHA-256
     `0726c6a47eba49c0b70d683b07f3c9b8ad3733f640e848bbe735ab1c89872480`.
   - Audit export: `GET /api/v1/tasks/:id/audit-bundle/export` returned HTTP
     200 with a 7,559-byte export.

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

## Conclusion

v1 is release-complete for the Windows local self-host and web/control-plane
scope defined here. The remaining non-v1-installable items are explicit
deferrals: iOS/macOS verification, separate-machine installer proof, signed
audit archives, dev-only migration-tooling audit advisories, and product write
surfaces listed above.
