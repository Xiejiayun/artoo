# artoo

Artoo is an open-source control plane for human and AI-agent teams. It connects
tasks, rooms, agent runs, artifacts, approvals, computers, and runtime adapters
into one auditable workflow.

## Status

This repository includes the Web + Windows + iOS trusted-team preview.
Current acceptance evidence is tracked in
[the collaboration milestone record](docs/cross-client-sync.md). Shared-server
deployment and validation instructions are in
[the shared-server guide](docs/shared-server.md); pairing, backup and recovery
are covered by [the preview operations guide](docs/preview-operations.md).
Historical milestone records below are not evidence that the current preview
has passed its release gates.

For the Web and Windows daemon delivery, see the
[current feature and validation record](docs/release-convergence-2026-11-09.md),
[npm daemon](scripts/npm-daemon/README.md), and
[Web deployment plan](docs/web-deployment-plan.zh-CN.md). Connect computers using
the official npm package `@jiayunxie/artood` and the command in Web; see the
[connection guide](docs/npm-daemon-setup.zh-CN.md). The exact version must be
published and registry-verified before rolling out its Web connection command.
Publication status is separate from local checks and experimental autonomous
application publication.

Mac and iOS verification commands and screenshot-report locations are in
[the Apple client E2E guide](docs/apple-client-e2e.md). Remaining commercial
distribution and deployment requirements are tracked in
[Apple release readiness](docs/apple-release-readiness.md).

v0.1 has been accepted on `origin/main` at `eec68d8`. It proves the core loop:

1. create a task in the web UI;
2. assign it through the server to a node/runtime adapter;
3. execute it with a mock adapter or real `codex exec`;
4. stream run events and collect artifacts;
5. review the artifact and mark the task done.

The v1 workstream is tracked in [docs/v1-roadmap.md](docs/v1-roadmap.md).
Agent Team execution, research, stage handoffs, independent review and configured
static-web publication are described in [the Agent Team guide](docs/agent-team-development.md).
Native Windows progress and the limits of multi-computer execution are recorded in
[Windows native development](docs/windows-native-development.md).
The current stage is Windows native execution and Agent Team local development
preview. It passed typecheck, build, 4,329 source tests (88 skipped), and Web E2E
27/27. A real Aerial run also completed research, design, automatic correction,
implementation, validation, independent review and healthy local static-site
publication from one objective. The fixture used isolated authenticated transport;
its temporary local site has been cleaned up. For source-checkout setup, follow
[the Windows setup guide](docs/windows-native-development.md).
Preparation scripts and detailed historical evidence under `artifacts/` belong to
the existing local environment and are not included in this stage's source delivery.
Activation requires protected local configuration, qualified NTFS storage and the
prepared native process backend. Physical multi-computer product acceptance,
signed desktop distribution and production hosting remain unverified. Integrated
cross-computer continuation currently stops after the destination design writer.
The [original autonomous development guide](docs/autonomous-development.md) records the first verified-workspace milestone.
Release gates and the local self-host runbook are tracked in
[docs/v1-release-gates.md](docs/v1-release-gates.md). The historical v1 release
candidate decision audit is tracked in
[docs/v1-release-candidate.md](docs/v1-release-candidate.md).

The v2 multi-client workstream is tracked in
[docs/v2-roadmap.md](docs/v2-roadmap.md). The Android control-surface plan is
tracked in [docs/v2-android-plan.md](docs/v2-android-plan.md).

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

For a shorter local loop, `npm run test:unit -- --maxWorkers=2` selects the
domain and protocol contracts plus Web unit/component tests. These suites do
not start PGlite; the Web cases use jsdom and controlled API fixtures, so this
command does not replace browser E2E. `npm run test:server -- --maxWorkers=2`
runs all server tests, including their database and subprocess integrations.
Build first when running entrypoint tests that require compiled modules.

Both shortcuts use the existing Vitest configuration, case timeouts and
platform conditions. `npm test -- --maxWorkers=2` remains the full source-test
gate, including artood, desktop, DB, storage and the other workspace packages.
To select individual files, use `npm test -- path/to/file.test.ts`; extra file
filters passed to a shortcut are additive in Vitest and do not narrow its
existing directory filters. Browser E2E and Node `--test` fixture harnesses
retain their separate commands.

`npm run verify:v1` includes typecheck, build, full Vitest, Playwright, the
production dependency audit (`npm audit --omit=dev`), and `git diff --check`.

Before starting agent work, configure the team's actual AI recipients using
[the AI data sharing guide](docs/ai-data-sharing.md). Missing disclosure blocks
agent execution while workspace browsing remains available. Users review the
providers and explicitly allow sharing in the iOS or Web/Mac client.

Run the server after building:

```bash
ARTOO_PORT=4000 node apps/server/dist/main.js
```

Run the web app in another shell:

```bash
npm run dev --workspace @artoo/web
```
