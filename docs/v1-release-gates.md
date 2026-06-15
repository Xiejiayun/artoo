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
| Audit bundle proof | `GET /api/v1/tasks/:id/audit-bundle` exists | Replay/signing still open |
| Self-host runbook | This document | Needs clean-machine validation |
| Secret/policy negatives | Workspace guard, lease, approval tests exist | Secret redaction coverage open |
| Branch worktree smoke | Requires `worktreeBaseRepo` and git smoke | Open |
| iOS verification | Requires macOS/Xcode | Open |

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
