# Autonomous development: verified workspace milestone

This guide documents the original single-agent milestone and its recorded 2026-11-03 checks. New team execution, real research, stage handoffs, independent review and configured static-web publication are described in [Agent Team product development](agent-team-development.md). Omitted `execution_mode` preserves the workflow below; the web form now submits the explicit team mode.

Artoo now has an opt-in goal workflow that accepts one objective, starts agent planning, accepts the resulting validated plan, executes its task graph, and applies node-measured acceptance checks before accepting each task. Failed checks return the task for bounded correction. Existing goals retain the manual workflow.

This milestone delivers a **verified workspace**, not a published product. It does not add automatic production deployment, merge integration, independent model-based code review, web research tooling, or design-tool integration. The existing runtime prompts still prohibit network access. A successful check means the administrator's configured acceptance program passed on the recorded subject files; its coverage determines what has actually been verified.

## Supported setup

- Web, Windows desktop and other API clients can start/control an autonomous goal.
- The original milestone used Linux or macOS verification workers. Native Windows now has a separately qualified installation and verifier path; see [Windows native development](windows-native-development.md) for its setup and outstanding acceptance. Without that explicit configuration, Windows workers retain manual execution and reject verification requests before starting coding.
- At least two real, available agent instances participate in planning, each in a workspace whose current node session advertises the requested verification profile and project. A coding instance is selected and pinned for execution. The instances can be hosted on the same computer and use the same workspace. General verification capability alone is insufficient; missing or mismatched profile bindings leave the goal waiting before planning.
- Use an existing ordinary workspace, without per-run allocation or managed journal execution. Artoo reserves the pinned workspace for the active goal and executes tasks serially. This avoids relying on the unimplemented integration-queue consumer.
- Configure the AI data-sharing policy and, for external processing, consent normally. The goal retains the initiating user and original consent version; reauthorization does not silently broaden an old automation.
- Configure a node-local acceptance program **outside all agent-writable workspaces**. The server and model select only a profile ID; they cannot supply command arguments or credentials.
- A configured verification workspace is dedicated to autonomous work. Use one profile per physical workspace with no overlap between configured roots; conflicting configuration is rejected at startup. The node rejects overlapping ordinary writes, including physical directory aliases; same-project read-only planning remains allowed. Use another directory for manual coding.

## Configure a verifier

Place a JSON profile file outside the product workspace, for example `/opt/artoo/verification-profiles.json`:

```json
[
  {
    "id": "default",
    "project_id": "proj_your_project",
    "workspace_root": "/srv/artoo/products/journal",
    "commands": [
      {
        "id": "acceptance",
        "argv": ["/usr/local/bin/node", "/opt/artoo/verifiers/journal.mjs"],
        "timeout_ms": 120000
      }
    ],
    "required_files": [],
    "subject_paths": ["product"]
  }
]
```

These are example paths and a project ID, not provisioned resources. Supply the actual absolute executable and verifier paths. The workspace must exist before node startup. Subject paths must exist by verification time. Include every file that determines the product behavior in `subject_paths`; empty directories are also fingerprinted. Do not exclude editable test configuration or source code just to obtain a passing digest.

Start the ordinary `artood` worker with its existing identity, allowed roots and runtime settings, plus:

```sh
export ARTOO_VERIFICATION_PROFILES_FILE=/opt/artoo/verification-profiles.json
node apps/artood/dist/main.js
```

The acceptance program receives its workspace as the working directory. `ARTOO_VERIFICATION_CONTEXT_FILE` points to a node-created, temporary file outside the coding workspace:

```js
import { readFileSync } from "node:fs";
const request = JSON.parse(readFileSync(process.env.ARTOO_VERIFICATION_CONTEXT_FILE, "utf8"));
const task = request.context.task;
const goal = request.context.goal_context;
// Run the real assertions for task.acceptance_criteria and the goal objective.
// Exit nonzero when an assertion fails. Do not trust a model-produced report.
```

This snippet only shows how to read the input; it is not an acceptance program. The actual verifier must execute meaningful checks. It can use the current task/goal context to distinguish specification tasks from implementation tasks. The same profile applies to the entire goal; a profile that requires final-product files after every early design task will prevent the graph from progressing.

Executables and script arguments are fingerprinted at configuration time and rechecked during verification. Shell/package-manager launchers are not accepted as direct commands; use an external verifier that invokes the required tools deliberately. Commands run with a bounded timeout, bounded output and a minimal environment, without inherited model-provider credentials. The source manifest is compared before and after checks; a changed subject fails verification. Symlinks, hard-linked subject files, missing files and out-of-scope paths fail closed.

Changing the trusted program requires restarting the node with reviewed configuration. Verifier files must be protected from all coding runtimes and other users that can execute on the host. This is a trusted-team execution boundary, not a sandbox against a compromised node administrator. Directory admission applies to runs through that configured node; separate daemons, external shells and other shared-storage writers must also be kept away from the dedicated workspace. The verification receipt records a measured source version, not an immutable release artifact.

## Start and inspect a goal

In the current web UI, **Goals → New goal → Agent Team — verified workspace** starts the team workflow described in [Agent Team product development](agent-team-development.md). To start this original single-agent milestone, use the API below with `execution_mode` omitted. The UI supplies the `default` verifier profile and a maximum of three retries. The original single-agent scheduling budget is one hour; the current Agent Team workflow uses eight hours. Existing elapsed-budget semantics allow a running process to drain. Planning has its own bounded discussion deadline. Monetary caps remain unsupported.

API clients can use the existing authenticated session/device control token:

```http
POST /api/v1/autonomous-goals
Idempotency-Key: one-stable-key-for-this-submission
Content-Type: application/json

{
  "project_id": "proj_your_project",
  "objective": "Build a journal that stores entries locally and preserves them after restart.",
  "verification_profile_id": "default",
  "max_retries": 3
}
```

The response contains `goal` and `automation`. Read `GET /api/v1/goals/:id/automation` for phase, waiting/failure reason, selected execution location and `delivery: "verified_workspace"`. Existing goals return `automation: null`. Existing goal pause/resume/cancel controls remain available, including pause during autonomous planning.

Missing workers, approval requirements or temporarily unavailable resources remain visible. No mock executor is selected as a substitute. Node profile discovery exposes only profile ID, project ID and workspace root, never command arguments or credentials. The binding is rechecked before assignment and dispatch, and expires with its node session. Pausing prevents new steps; cancellation still requires actual process-stop confirmation. The runner persists its state and observes existing run IDs after restart rather than starting replacement processes blindly. Rejected process starts consume the same bounded retry budget as execution failures; the recorded start time alone does not prove a process actually started.

## Acceptance and evidence

The server persists a versioned verification requirement on each execution attempt. The node with ownership of that run performs the local checks after coding, sends `run.verification`, and only then finishes the run. This event is node-owned: it is deliberately absent from the coding adapter's output schema. An agent answer or ordinary `test_result` artifact cannot authorize automatic acceptance.

Evidence includes the verification request, profile digest, subject digest, measured exit statuses/durations/output digests and required-file checksums. A missing subject digest is represented as `null` on failure, never as a fabricated source hash. Failed checks include bounded, redacted diagnostics so the correction attempt receives the actual failing assertion rather than only an exit code. Automatic review requires the latest completed attempt, matching evidence, successful checks and current expected artifact types. Decisions are recorded as `system:goal_runner`, while the original user remains the source of authorization. An automatic acceptance event records the exact run ID, evidence ID, verification request and profile/source digests. The normal HTTP review route cannot bypass this check for an autonomous goal.

Each run's ContextPack now includes the source goal/plan and bounded dependency descriptors. Only the accepted predecessor's latest completed run contributes artifact references; prior failed-attempt artifacts, unaccepted output, cross-project data and raw artifact URLs/metadata are excluded. Artifact bodies remain behind the authenticated content API. They are not automatically downloaded into another computer's workspace. This milestone deliberately uses one workspace for the coding graph.

Read-only planning is allowed through the restricted process adapter only for the same project and exact physical workspace root. Discussion context files live in a node-created temporary directory outside the workspace and are removed after process closure. Manual discussion creation cannot take over an autonomous goal's planning session; an incomplete recovered planning binding is reported as failed and stopped.

## Validation and remaining delivery work

Run the normal project checks from the repository root:

```sh
npm run typecheck
npm run build
npm test -- --maxWorkers=2
npm run test:e2e --workspace @artoo/web
```

Focused regression files include `goal-automation.test.ts`, `run-verification.test.ts`, `context-pack-handoff.test.ts`, `verification.test.ts`, `goal-automation-migrations.test.ts` and `autonomous-goal.spec.ts`. Real POSIX verifier checks are in `apps/artood/test-fixtures/verification-real.test.mjs` and run against built modules. Fixture orchestration checks do not prove live model quality.

The repository's CI uses Node 24. The Vitest configuration disables Node's experimental Web Storage in test workers so browser tests use jsdom's `localStorage` and `sessionStorage`, including on Node 26. The standard test command above applies this setting automatically.

### Recorded validation — 2026-11-03

The final implementation was frozen before this full regression run. These are local results, not a CI, live-provider or deployment claim.

| Check | Environment | Result |
| --- | --- | --- |
| `npm run typecheck` | Windows, Node 26.13.0 | Passed |
| `npm run build` | Windows, Node 26.13.0 | Passed; Vite reports a bundle larger than 500 kB |
| `npm test -- --maxWorkers=2 --reporter=verbose` | Windows, Node 26.13.0, host Web Storage disabled for tests | 249 files passed, 10 skipped; 2,127 tests passed, 78 skipped; no failures |
| `npm run test:e2e --workspace @artoo/web` | Chromium and isolated local server | 17 passed, including autonomous waiting/pause/resume/cancel and existing manual workflows |
| `node --test apps/artood/test-fixtures/verification-real.test.mjs` | WSL Linux, Node 24.11.0, final built modules | 9 passed, no failures or skips |
| Patch inspection | Working-tree diff and new source/test/migration files | `git diff --check` and whitespace checks passed |

The full run includes the legacy storage migration/backup/restore regressions, original authorization and manual execution flows, profile discovery over authenticated WebSockets, automatic planning and bounded repair, and immutable verification-receipt linkage. Its local log is saved at `artifacts/autonomous-validation/vitest-2026-11-03-final.log` (ignored by Git). Interrupted development runs are not counted in this record.

The POSIX checks execute actual verifier subprocesses and exercise source/script mutation, timeout, cancellation and child-process closure, environment isolation, directory aliases, and discussion context protection. The orchestration and browser tests use controlled fixtures; no live model was asked to build and publish a product, and macOS verification was not separately exercised.

Before claiming autonomous product publication, subsequent milestones must add supported research/design tools, repository initialization and cross-worktree integration, independent review where appropriate, a release executor tied to verified immutable artifacts, deployment idempotency, post-deploy health checks and rollback. A live-provider test from an empty project through the actual published endpoint remains a separate acceptance gate.
