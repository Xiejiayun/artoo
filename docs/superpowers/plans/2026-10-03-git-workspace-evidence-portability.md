# Git Workspace Evidence Portability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify retained Git workspaces on Windows and macOS without confusing Git's path spelling with a different workspace.

**Architecture:** Parse Git porcelain through one pure fixture utility. Normalize platform path separators and Windows drive-letter case only for Git registration comparisons; preserve exact application paths, branches, HEADs, file hashes and raw evidence.

**Tech Stack:** Node 24, node:test, Git, existing correction/retention protocol fixtures.

## Global Constraints

- Base: `3f297a4e2e169cb37c37a49a662baaeb0dc342b6`; isolated `artoo-apple-ci-fixes` worktree.
- Keep main's six unrelated files, recovery stash and frozen retention checkout unchanged.
- The hosted failure reports registration inequality but omits the actual values; do not claim a specific drive-case mismatch was observed.
- No product path, receipt or recovery Copy normalization; only fixture Git registration comparisons change.
- Preserve existing raw Git output and reject extra or changed registration identities.
- Every subsequent client E2E attempt retains actual screenshots and an HTML report.

## Task 1: Portable registration parser and regressions

**Files:** Create `scripts/fixtures/git-worktree-evidence.mjs` and `scripts/fixtures/git-worktree-evidence.test.mjs`.

**Interfaces:** Export `gitWorktreePath(path, platform = process.platform)` and `parseGitWorktreeRegistrations(output, platform = process.platform)`. The parser returns sorted `{ root, head, branch }` records. Tests explicitly select `win32` to check Git forward slashes/native backslashes, drive-letter case, LF/CRLF, spaces and Unicode on every host.

- [x] Add regressions for equivalent Windows path spellings, distinct names/branches/HEADs, duplicate fields, quoted/nonabsolute paths, and a real temporary Git base plus one worktree.
- [x] Run `node --test scripts/fixtures/git-worktree-evidence.test.mjs`; confirm missing utility fails before implementation.
- [x] Implement the pure parser: split records after CRLF-to-LF conversion, reject malformed required fields, preserve path content other than platform separator/drive normalization, and sort exact records.
- [x] Run the same command and require all assertions to pass.

## Task 2: Use the parser in both retained-work scenarios

**Files:** Modify `scripts/fixtures/execution-correction-scenario.mjs`, `scripts/fixtures/execution-correction-results.mjs`, `scripts/fixtures/execution-correction-results.test.mjs`, `scripts/fixtures/zero-artifact-workspace-scenario.mjs`, `scripts/fixtures/zero-artifact-workspace-protocol.test.mjs` and `scripts/preview-gate.mjs`.

**Interfaces:** Correction's observer uses the parser; its verifier applies the same Git path representation to expected registrations. Zero-artifact keeps its raw `base.registrations` string and parses it only for exact comparison. Add the helper to the protocol test's source inventory and the parser regressions to the shared gate.

- [x] Replace correction's local porcelain parsing and normalize only its expected Git registration roots.
- [x] Replace zero-artifact's raw string equality with parsed exact root/HEAD/branch equality; use `core.quotePath=false` for actual Git output while still rejecting ambiguous control-character paths.
- [x] Run `node --check` on edited fixture files and the focused parser tests.
- [x] Build the preview in the isolated worktree, then run `node --test scripts/fixtures/execution-correction-results.test.mjs scripts/fixtures/zero-artifact-workspace-protocol.test.mjs` with fresh task-owned evidence directories using their existing environment switches. Confirm real process cleanup and retained exact file bytes.
- [ ] Review the diff and evidence, then combine with the separately reviewed Mac viewport capture fix for a normal milestone commit/push. Hosted Windows qualification remains pending until the new commit's actual CI passes.

## Local validation, 2026-10-03

Preview build passed and production audit reported zero vulnerabilities. The focused parser checks and both actual protocol flows passed all83 Node tests, including53 correction and22 zero-artifact negative evidence cases. All22 exported files retained their exact hashes after fixture cleanup. Source input fingerprints and process cleanup passed. Report: `artifacts/ci-portability/protocol-20261003T083631Z/report.html`. This is macOS local protocol validation; hosted Windows and installed Mac E2E remain pending. The first real-Git test fixture used a decomposed accented path that Git on macOS recomposed; its path was changed to CJK while the pure parser regression continues to require exact decomposed Unicode preservation.
