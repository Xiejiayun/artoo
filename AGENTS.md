# Project development

Artoo is a TypeScript workspace monorepo. `packages/domain` owns versioned data contracts, `packages/protocol` owns node/control transport envelopes, `packages/db` owns Drizzle schema and append-only SQL migrations, `apps/server` owns authorization and orchestration, and `apps/artood` owns local execution. Web is the shared browser/desktop control surface.

Read relevant code and tests before changing a contract. Preserve existing manual goals and runtime behavior. Add optional versioned fields for protocol/context extensions; do not silently reinterpret older payloads. Database changes require a new ordered SQL migration and matching schema. Never edit a previously released migration to pass a check.

## Autonomous development

Agent Team execution and configured static-web publication are being implemented. See [the Agent Team guide](docs/agent-team-development.md) for current setup, validation and remaining work; [the original autonomous development guide](docs/autonomous-development.md) records the first milestone. Verified workspace delivery alone is not product publication, and controlled fixtures are not a live-provider product acceptance run.

- GoalRunner owns durable planning and task scheduling. Keep the initiating user's authorization separate from system decision attribution.
- A model answer, artifact metadata or CLI exit alone cannot authorize automatic review. `run.verification` is node-owned and must remain outside the adapter output schema.
- Verification commands come from protected node-local profiles, never task text or remote argv. Preserve exact request/profile/run binding, source fingerprints and actual process-exit confirmation.
- Unsupported platforms, workspace strategies and missing verifier profiles fail closed. Preserve ordinary manual execution.
- Product deployment requires a separate validated release executor, immutable input version, health criteria and recovery plan. Artoo's own CI and publisher site do not establish target-product deployment.

## Checks

For new/modified JS, TS, JSON and CSS files, stage the intended files and run `npm run check:staged` before committing. `npm run format` formats only staged paths; stage its resulting edits again. CI uses `npm run check:changed -- --since=<PR-base-SHA>` for committed differences. See [code quality](docs/code-quality.md) for the initial rule scope; keep unrelated files out of formatting changes.

From the repository root run `npm run typecheck`, `npm run build`, `npm test -- --maxWorkers=2`, and `npm run test:e2e --workspace @artoo/web`. Use relevant focused suites during development; run broader checks after integration. POSIX verification subprocess tests live in `apps/artood/test-fixtures/verification-real.test.mjs` and require built modules plus Linux/macOS.

For storage-test timeout and cleanup changes, run `node --test apps/server/test-fixtures/preview-storage-timeout.test.mjs`. Its child deliberately fails cases; the parent passes only after checking the exact failures, actual process closure, and safe directory deletion or retention. Keep the emitted evidence and distinguish that parent result from the ordinary four-case storage integration suite.

Follow existing preview/release runbooks for Artoo releases. A passing fixture or mock test is not live-provider, signed-distribution or production-deployment evidence. Record those scopes separately.
