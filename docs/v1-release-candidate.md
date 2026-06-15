# Artoo v1 Release-Candidate Audit

This is the current release-decision summary for v1. It separates work that is
proved by automated/current evidence from work that needs an explicit human
release decision because this Windows machine cannot or must not run it
unilaterally.

## Current Evidence

- Current main: `194b10a`.
- Current validated code/docs head: `194b10a`.
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
| Self-host local runbook | Clean clone `npm ci`, `verify:v1`, and `demo:v1` at `194b10a` | Proved on this Windows machine |

## Explicit Release Decisions Still Needed

These are not ordinary coding gaps on this machine.

1. **True Claude CLI runtime smoke**

   Current status: not run. The test would spawn a real `claude` CLI process
   using real local auth/quota and possible network access. It must stay gated
   until @jeremy-xie explicitly enables it.

   Release decision options:

   - Enable it now in an isolated workspace and require a passing result before
     v1.
   - Defer it from v1 and record that v1 ships with Codex/mock/runtime-registry
     evidence plus documented Claude-runtime readiness, but no true Claude CLI
     smoke on this machine.

2. **iOS verification**

   Current status: source exists under `apps/ios`, but this Windows environment
   has no macOS/Xcode/iOS SDK. The app is clearly marked unverified in its README
   and source comments.

   Release decision options:

   - Require macOS/Xcode build/run/test before v1.
   - Defer iOS verification from v1 and treat the SwiftUI source as an
     unverified preview/control-surface source package.

3. **Separate-machine self-host smoke**

   Current status: local clean-clone validation passed on this machine. The
   runbook still recommends a separate-machine smoke before public tagging.

   Release decision options:

   - Require a second-machine smoke before v1.
   - Treat the current clean-clone proof as sufficient for v1 and keep
     separate-machine validation as a recommended pre-public-tag check.

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

Treat current main as a v1 release candidate once @jeremy-xie records explicit
decisions for the three remaining gated items above. Do not mark v1 complete
until those decisions are present or the required smokes have passed.
