# Artoo v1 Release Gates

This document is the release-hardening runbook for task #17. It is intentionally
stricter than the current implementation: v1 is not complete until every
required gate below is either automated and passing or explicitly deferred by a
recorded release decision.

## Automated Local Gate

From a clean checkout:

```bash
npm install
npm run verify:v1
```

`npm run verify:v1` runs, in order:

1. `npm run typecheck`
2. `npm run build`
3. `npm test`
4. `npm run test:e2e --workspace @artoo/web`
5. `git diff --check`

For quick local iteration only, `npm run verify:v1 -- --skip-e2e` or
`ARTOO_V1_SKIP_E2E=1 npm run verify:v1` skips Playwright. A skipped E2E run is
not a release gate result.

## Demo Script

After `npm run build`, run:

```bash
npm run demo:v1
```

The script starts a temporary built server with a fresh in-memory DB and temp
workspace, then drives the API through create -> ready -> assign -> dev mock run
-> review accept. It finishes by fetching `GET /tasks/:id/audit-bundle/export`
and verifying the v1alpha1 envelope, completed run evidence, artifact evidence,
scheduler decision evidence, event-log evidence, signing deferral, and
deterministic SHA-256 over the redacted bundle.

To target an already-running server instead:

```bash
ARTOO_DEMO_BASE_URL=http://127.0.0.1:4000 npm run demo:v1
```

## Manual Dev Runbook

After `npm install` and `npm run build`, start the server:

```bash
ARTOO_PORT=4000 ARTOO_WORKSPACE_ROOT=C:/workspace/artoo-runs/dev node apps/server/dist/main.js
```

In another shell, start the web app:

```bash
npm run dev --workspace @artoo/web
```

Open the Vite URL, create a task, mark it ready, assign it, execute the dev mock
run, review the artifact, and accept it. For direct API checks, use:

```bash
curl http://127.0.0.1:4000/api/v1/bootstrap
```

## Current Gate Matrix

| Gate | Command or Evidence | Current Status |
| --- | --- | --- |
| Typecheck | `npm run typecheck` | Automated |
| Build | `npm run build` | Automated |
| Full Vitest suite | `npm test` | Automated |
| Playwright happy path | `npm run test:e2e --workspace @artoo/web` | Automated |
| Playwright change-request/retry | `npm run test:e2e --workspace @artoo/web` | Automated |
| Playwright approval gate | `npm run test:e2e --workspace @artoo/web` | Automated via node WS + dev approval request |
| Playwright DAG unlock | `npm run test:e2e --workspace @artoo/web` | Automated |
| Web inventory surfaces | Bootstrap/runtime read models + Skills domain-contract component tests | Automated in Vitest |
| Cross-process mock runtime smoke | Covered by server/node and artood integration tests | Automated in Vitest |
| True CLI runtime smoke | Gated manual run in isolated workspace | Open for Claude; Codex previously smoked |
| Audit bundle proof | `GET /api/v1/tasks/:id/audit-bundle/export` returns redacted bundle + deterministic SHA-256 | Automated; cryptographic signing deferred by v1 decision |
| v1 demo path | `npm run demo:v1` after build | Automated local demo script |
| Production dependency audit | `npm audit --omit=dev` | Automated check is clean |
| Dev dependency audit | `npm audit` | Vite/Vitest advisories fixed; drizzle-kit/esbuild dev-tooling advisory remains open |
| Self-host runbook | This document | Local clean-clone validation passed; independent machine validation still recommended |
| Secret/policy negatives | Workspace guard, lease, approval tests plus audit-bundle secret redaction coverage | Broader secret storage/rotation remains out of scope |
| Branch worktree smoke | `ARTOO_GIT_SMOKE=1 npx vitest run apps/server/src/branch-e2e-smoke.test.ts` | Gated automated |
| iOS verification | Requires macOS/Xcode | Open |

## Clean Local Checkout Validation

The self-host runbook has been validated from a fresh local clone on Windows with
Node 24.16.0 and npm 11.13.0:

```bash
git clone <repo> <fresh-dir>
cd <fresh-dir>
npm ci
npm run verify:v1
npm run demo:v1
```

This proves the lockfile, build, full automated gate, Playwright release flows,
and API demo path outside the warmed working tree. It is still not a substitute
for a separate machine smoke before tagging a public release.

## Dependency Audit

`npm audit --omit=dev` is clean, so the production dependency surface has no
known npm advisories at this gate. The full dev audit was reduced by upgrading
Vite/Vitest/React plugin tooling to the current Vite 8/Vitest 4 line; the
remaining npm audit findings are isolated to `drizzle-kit` and its deprecated
`@esbuild-kit/*` / nested `esbuild` migration-generation toolchain. `drizzle-kit`
is not used by the runtime, web build, tests, or v1 demo, but the advisory stays
open until Drizzle publishes a non-vulnerable migration generator path or the
project replaces that tooling.

## Gated Branch Worktree Smoke

This gate is opt-in because it shells out to real `git` and creates throwaway
worktrees. It must always use temporary directories for both the base repo and
the assigned workspace root:

```bash
ARTOO_GIT_SMOKE=1 npx vitest run apps/server/src/branch-e2e-smoke.test.ts
```

Successful proof covers REST `assign { branch_backed: true }`, persisted
`runs.workspace_branch`, persisted ContextPack dispatch, node-client worktree
materialization on a new git branch, mock-agent artifact production, terminal
worktree cleanup, branch retention in the base repo, and task transition to
`review`.

## Gated True Runtime Smoke

Do not run a true CLI runtime smoke unless a human explicitly enables it for the
current machine. Use an isolated workspace such as
`C:/workspace/artoo-runs/<smoke-id>`, keep write scope confined to that
workspace, and stop if the CLI needs interactive auth.

Expected proof for a successful true runtime smoke:

- server run reaches `review`
- run status is `completed`
- at least one artifact is collected, preferably `changes.patch`
- task can be accepted to `done`
- audit bundle for the task includes the run, artifact, scheduler decision, and
  event-log evidence

## Audit Bundle Redaction

The public audit-bundle endpoint redacts common credential-shaped values at
export time, including agent/machine tokens, bearer tokens, JWTs, GitHub-style
tokens, OpenAI-style `sk-` keys, env-var assignments such as `*_TOKEN=...`, and
structured JSON fields named like `token`, `api_key`, `password`, `secret`, or
`credential`. The persisted event log and task-room messages remain unchanged;
redaction is applied only to the shareable evidence bundle.

## Audit Bundle Export

The shareable v1 evidence envelope is:

```bash
GET /api/v1/tasks/<task-id>/audit-bundle/export
```

The response includes:

- `schema_version: "v1alpha1"`
- `exported_at`
- `bundle_sha256`, a SHA-256 over the canonical JSON form of the redacted
  `bundle`
- `bundle`, matching `GET /tasks/:id/audit-bundle`
- `signature: null`
- `signing.status: "deferred"`

Release decision: v1 intentionally defers cryptographic signing because Artoo
does not yet manage signing keys, key rotation, identity binding, or signature
verification policy. The deterministic hash is the v1 replay/proof primitive;
signed archives require a later key-management slice before they can be claimed
as release-complete.
