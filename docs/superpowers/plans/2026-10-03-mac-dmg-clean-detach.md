# Mac DMG Clean Detach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ten normal vendor detach attempts the repository's default DMG build policy without changing distribution acceptance.

**Architecture:** Configure electron-builder's supported `CUSTOM_DMGBUILD_PATH` with a repository launcher. Resolve the same checksum-pinned vendor toolset through `downloadBuilderToolset`, select its host architecture, and replace the launcher with the unmodified vendor CLI plus `--detach-retries 10`. Preserve a caller's explicitly configured executable and distinguish that unknown retry policy in the distribution manifest.

**Tech Stack:** Node.js 24, Node's test runner and POSIX `process.execve`, electron-builder 26.15.3, dmg-builder toolset 1.2.5 / dmgbuild 1.6.7.

## Global Constraints

- Base: `3f297a4e2e169cb37c37a49a662baaeb0dc342b6`; isolated `user/jiaxie/mac-dmg-clean-detach-20261003` worktree.
- Ten normal detach attempts through the supported `--detach-retries` CLI flag.
- Preserve original argument boundaries/order, standard output/error, exit status and signal termination.
- No added force detach, global mount cleanup, vendor/cache/dependency edits or fixed user/architecture paths.
- Keep explicit valid `CUSTOM_DMGBUILD_PATH` overrides effective; reject missing, non-file or non-executable overrides.
- Keep fresh artifact checks, signing/notarization/Gatekeeper and publication gates unchanged.
- Preserve the existing outer global temporary toolset lock; do not reacquire it inside the launcher. Verify installed vendor version/toolset parity and reject duplicate/abbreviated retry flags.
- This implementation phase runs only source checks and subprocess/configuration fixtures; root owns the later real DMG/GUI attempt.
- The referenced optional execution skills are unavailable in this environment. Execute these bounded steps directly and use the available peer for independent review; user authorization already covers implementation/testing.

---

### Task 1: Default launcher and distribution wiring

**Files:**
- Create: `apps/desktop/scripts/mac-dmgbuild.mjs` — override validation, fixed vendor resolution and exec launcher.
- Create: `apps/desktop/scripts/mac-dmgbuild.test.mjs` — real fixture subprocess argv/output/status and pure configuration checks.
- Modify: `apps/desktop/scripts/mac-distribution.mjs` — install the default builder environment and record policy.
- Modify: `scripts/preview-gate.mjs` — run the focused launcher tests in the Mac gate.
- Modify: `apps/desktop/MAC-DISTRIBUTION.md` — document the actual default, override and remaining runtime requirement.

**Interfaces:**
- `configureDmgbuild(env, cwd)` returns `{ env, policy }`; relative explicit overrides resolve from electron-builder's desktop working directory.
- `resolveDmgbuild({ arch, download })` returns the executable from the architecture-specific pinned toolset; the optional download function permits fixture resolution without network access.
- `runDmgbuild(args, options)` resolves the tool and calls `process.execve(vendor, [vendor, "--detach-retries", "10", ...args], process.env)`.

- [x] **Step 1: Write subprocess and configuration tests.** Use a temporary executable called `dmgbuild`, never a real disk utility. Run the exported launcher in a separate Node process with a fixture resolver; assert exact output bytes, argument boundaries and exit 7, including paths with spaces/Unicode and literal shell characters. Verify signal termination, invalid/explicit overrides and both pinned toolset architectures. Add a simulated builder failure test that verifies a failed distribution manifest.

```js
assert.deepEqual(captured.args, ["--detach-retries", "10", ...originalArgs]);
assert.equal(result.status, 7);
assert.equal(result.stdout, expectedStdout);
assert.equal(result.stderr, expectedStderr);
assert.equal(configureDmgbuild({ CUSTOM_DMGBUILD_PATH: fixture }, cwd).policy.source, "caller_override");
```

- [x] **Step 2: Run the focused test file and retain the initial missing-implementation failure.**

```sh
node --test apps/desktop/scripts/mac-dmgbuild.test.mjs
```

- [x] **Step 3: Implement the launcher and wire its configuration before packaging.** Validate regular executable files; use the installed toolset resolver and its exact current archive checksums. Prepend only the retry option, inherit stdio through process replacement, and allow errors/nonzero exits to propagate. In the build function, record the selected policy and launcher digest before existing build commands.

```js
const dmgbuild = configureDmgbuild(buildEnv, desktop);
report.dmgbuild = { ...dmgbuild.policy, sha256: fileSha256(dmgbuild.env.CUSTOM_DMGBUILD_PATH) };
// Pass dmgbuild.env only to electron-builder; renderer/daemon builds retain buildEnv.
```

- [x] **Step 4: Run focused tests and existing distribution guards with real-DMG opt-in disabled.** The existing tiny filesystem-DMG test must remain skipped. Check executable mode, JS syntax, and `git diff --check`.

```sh
ARTOO_TEST_REAL_DMG=0 node --test apps/desktop/scripts/mac-dmgbuild.test.mjs apps/desktop/scripts/mac-distribution.test.mjs
node --check apps/desktop/scripts/mac-dmgbuild.mjs
git diff --check
```

- [x] **Step 5: Document and independently review.** Explain that ten vendor attempts imply about170s of vendor sleeps on full exhaustion, inside the existing600s command timeout, without claiming busy-volume cause or guaranteed success. Explain explicit override policy and preserved failure/trust gates. Review changed files against the frozen source and hand root a focused patch plus command logs; root applies to the CI worktree and owns real packaging/GUI validation and main integration. Root independently reviewed v1 and requested only the exact build dependency-chain anchor; v2 adds that small correction and a nested module-resolution fixture.

```sh
git diff -- apps/desktop/scripts/mac-distribution.mjs scripts/preview-gate.mjs apps/desktop/MAC-DISTRIBUTION.md
git status --short
```

## Completion evidence

The v1 focused launcher tests passed 11/11. The combined launcher/distribution
run passed 19 tests with one real filesystem-DMG opt-in test skipped, zero
failed, cancelled or todo; actual session71353 exited0 on Node24.19.0. The first
implementation run retained two fixture-only cwd assertions caused by macOS's
`/var`→`/private/var` alias; canonicalizing the newly created fixture directory
fixed those assertions without normalizing product paths. Raw initial
missing-module, first implementation and final combined logs are retained in
`artifacts/mac-dmg-clean-detach/`. Syntax, whitespace checks and the Mac gate's
`--list` inspection passed. No package build, toolset download, disk mount or GUI
was executed. Root provides independent source review while other agents occupy
the available slots; actual DMG installation, screenshots and commercial
distribution trust remain root's separate acceptance work.

The v1 files and manifest remain unchanged under
`artifacts/mac-dmg-clean-detach/revision-v1/`. The v2 resolver follows
electron-builder → app-builder-lib → dmg-builder before resolving the public
downloader in the exact vendor context. A small real Node-resolution fixture
places an unrelated hoisted dmg-builder next to a nested build graph and
records that the nested vendor's own downloader receives the pinned options.
No actual toolset download occurs in this fixture. Root requested an applicable
patch including the launcher's 0755 mode, without commit or push in this worktree.
The v2 combined run (actual session7446, exit0) passed all 12 launcher tests and
all eight enabled distribution tests: 21 total, 20 passed, one explicitly
disabled real filesystem-DMG test skipped. The raw output is
`artifacts/mac-dmg-clean-detach/combined-tests-v3-resolution.log`.
