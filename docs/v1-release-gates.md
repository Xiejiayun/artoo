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
| Cross-process mock runtime smoke | Covered by server/node and artood integration tests | Automated in Vitest |
| True CLI runtime smoke | Gated manual run in isolated workspace | Open for Claude; Codex previously smoked |
| Audit bundle proof | `GET /api/v1/tasks/:id/audit-bundle` exists and redacts credential-shaped values | Replay/signing still open |
| Self-host runbook | This document | Needs clean-machine validation |
| Secret/policy negatives | Workspace guard, lease, approval tests plus audit-bundle secret redaction coverage | Broader secret storage/rotation remains out of scope |
| Branch worktree smoke | `ARTOO_GIT_SMOKE=1 npx vitest run apps/server/src/branch-e2e-smoke.test.ts` | Gated automated |
| iOS verification | Requires macOS/Xcode | Open |

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
