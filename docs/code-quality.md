# Incremental code quality

Biome 2.6.6 is pinned exactly in root devDependencies and package-lock.json. It provides one parser, formatter and a small initial lint rule set without additional ESLint/Prettier configuration. TypeScript's existing typecheck remains the type-aware gate.

Formatting uses two spaces, double quotes, semicolons, trailing commas and a 120-column target. A formatter may keep long string/regular-expression literals on one line; 120 columns is not a hard limit on literal contents. Import organization and other assists are outside this first adoption. The five explicit error rules reject constant conditions, unreachable statements, unsafe finally control flow, invalid typeof comparisons and duplicate switch cases. `preset: none` makes this initial scope explicit; it does not claim that all Biome recommended rules or accessibility checks have been adopted.

Generated package-lock.json is maintained by npm and excluded from formatting. Git ignored dependencies, builds, test evidence and data use the existing ignore rules. The configured scope is JS/JSX/TS/TSX/MJS/CJS/JSON/JSONC/CSS. Swift, Markdown, YAML and other files are outside this first adoption and retain their existing tools; this gate does not validate them.

## Local changes

Stage only the files belonging to the current item, then run:

```text
npm run check:staged
npm run lint
npm run format:check
```

To apply formatting, run `npm run format`, inspect the diff and stage the resulting edits again. The command formats the working copy of the staged paths; it does not rewrite the index or replace a review. For a partially staged file, avoid formatting until its intended changes can be reviewed and staged together. An individual unstaged file can be checked with `npm exec -- biome check path/to/file.ts`.

## Committed changes and CI

```text
npm run check:changed -- --since=<base-SHA>
```

Biome 2.6.6 `--changed` includes committed differences only; it excludes staged and unstaged edits. Its local default is main. Running it on an unchanged main reports zero checked files, which is not evidence that the workspace was checked. Use the staged or explicit-file commands for uncommitted work.

The Changed code quality PR workflow checks out full history and passes `github.event.pull_request.base.sha` through an environment variable. It checks the resulting files at the current revision, including newly committed files. The wrapper resolves the base to a commit before invoking Biome: the pinned CLI alone can exit successfully for a missing ref. Missing base references fail; a change outside the configured source scope may correctly have no matching files. The workflow also runs real temporary Git repository regression tests for these cases. Warning diagnostics, including oversized skipped source files, fail the commands.

The check is incremental by changed file, not by changed line, so editing an older file requires formatting that file. Keep such adoption in the same item and inspect its diff. Do not format the entire repository as a rollout step.

The first pilot formats only `useMentionAutocomplete.tsx`, with behavior verification recorded separately from formatting output. Repository-wide lint adoption, import cleanup and other component formatting remain incremental work; this gate supplements the existing typecheck/build/tests/E2E requirements.

## C4 validation

The pilot passed root typecheck, Web build and the existing composer suites (2 files, 34 tests). The emitted JavaScript AST matches the baseline after excluding comments, trivia and grouping nodes; source/diff review remains part of verification. No application behavior change or performance gain is claimed.

The real Git fixture suite passed all 3 tests, checking newly committed and modified files, staged-only exclusion, untouched legacy-file exclusion, missing base rejection, document-only changes and a correctly formatted invalid typeof expression. Staged check/lint/format each passed with 5 files checked. The first fixture run lacked this repository's LF attributes and was rejected by the host's Git safecrlf check; the fixture now copies the existing attributes instead of changing Git settings. All original failure logs remain under `.git/opt-c4-*`. YAML parsing also verifies the PR trigger, read-only permission, full checkout and base environment wiring.

Logs: `.git/opt-c4-cli-tests-accepted.log`, `.git/opt-c4-staged-reviewed.log`, `.git/opt-c4-lint.log`, `.git/opt-c4-format-check.log`, `.git/opt-c4-typecheck.log`, `.git/opt-c4-build.log`, `.git/opt-c4-composer-tests.log`, `.git/opt-c4-ast-check.log`, `.git/opt-c4-workflow-check.log`. The committed check on source commit `caf3f8f`, against exact item base `93e5bb7`, also checked 5 files and passed (`.git/opt-c4-committed-check.log`). Full integrated gates and E2E remain due after the remaining opportunities.
