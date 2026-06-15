# artoo

Artoo is an open-source control plane for human and AI-agent teams. It connects
tasks, rooms, agent runs, artifacts, approvals, computers, and runtime adapters
into one auditable workflow.

## Status

v0.1 has been accepted on `origin/main` at `eec68d8`. It proves the core loop:

1. create a task in the web UI;
2. assign it through the server to a node/runtime adapter;
3. execute it with a mock adapter or real `codex exec`;
4. stream run events and collect artifacts;
5. review the artifact and mark the task done.

The v1 workstream is tracked in [docs/v1-roadmap.md](docs/v1-roadmap.md).
Release gates and the local self-host runbook are tracked in
[docs/v1-release-gates.md](docs/v1-release-gates.md). The current release
candidate decision audit is tracked in
[docs/v1-release-candidate.md](docs/v1-release-candidate.md).

## Development

```bash
npm install
npm run typecheck
npm run build
npm test
npm run test:e2e --workspace @artoo/web
npm run verify:v1
npm run demo:v1
```

`npm run verify:v1` includes typecheck, build, full Vitest, Playwright, the
production dependency audit (`npm audit --omit=dev`), and `git diff --check`.

Run the server after building:

```bash
ARTOO_PORT=4000 node apps/server/dist/main.js
```

Run the web app in another shell:

```bash
npm run dev --workspace @artoo/web
```
