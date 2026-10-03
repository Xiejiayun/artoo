# Mac Document Scroll Evidence Repair

> **For agentic workers:** Use the available collaboration tools for bounded implementation and independent review. The superpowers execution skills are not installed in this session.

**Goal:** Capture complete planning text in the installed Mac client when its document and nested conversation containers all scroll.

**Architecture:** Keep the current text-range inventory, genuine viewport screenshots and unobscured-range assertions. Use viewport coordinates for the document scrolling element; ordinary elements retain their border/client geometry.

**Tech Stack:** JavaScript, Playwright, Node test runner, Electron.

## Global Constraints

- Base: `d65d4598443343ad63b57cd8a36785ce3ea1a5e2`.
- Hosted run `37120642443`, Mac job `111195901709`, failed after 594 of 855 painted ranges were captured at 1024×656. The original failure stays failed.
- The observed scroll chain was conversation → MAIN → HTML. HTML moved 16→47 and the target reached top −23.671875. The failed second movement was not retained, so static diagnosis does not establish the sole runtime cause.
- Establish a requested small profile through the real native window before workflows and again after relaunch, recording native and renderer sizes. Do not enlarge/restyle the product during capture, omit text, bypass occlusion checks, relax coverage or infer installed acceptance from a browser fixture.
- Serialize browser/build/client work after the active managed-workspace gate closes. Preserve every actual client attempt's HTML and original photos.

## Task 1: Reproduce the document-coordinate defect

**Files:** `apps/desktop/scripts/installed-mac-planning-evidence.test.mjs`.

- [x] Add two standards-mode fixture cases with `html` overflow auto/visible, body padding above/below the existing nested containers and an initial nonzero document scroll. Expect complete multi-frame coverage through HTML, history and outer scrollports, unchanged original text, styles and viewport.
- [x] Run the existing test file with `ARTOO_PLANNING_EVIDENCE_BROWSER=1`, a fresh evidence directory and one owned browser invocation. The 12:05:42Z attempt reproduced exactly both new failures; all seven existing scenarios passed. Node reported 7 pass/3 fail including the failed parent, no skips. Its command exited 1 with confirmed closure, stable source and original screenshot HTML retained.

## Task 2: Fix only document scrollport coordinates

**Files:** `apps/desktop/scripts/installed-mac-planning-evidence.mjs`, `apps/desktop/scripts/installed-mac-planning.mjs`.

- [x] For scroll positioning, compute `scrollportTop = ancestor === document.scrollingElement ? 0 : box.top + ancestor.clientTop` and add `rect.top - (scrollportTop + 8)` to its real scrollTop.
- [x] For clipping, the root scrolling element uses the viewport bounds already initialized to `[0, innerWidth] × [0, innerHeight]`; skip its translated element box. Preserve every other ancestor clip and occlusion check. Sequential screenshot captions identify the frame without claiming complete coverage before the full sequence passes.
- [x] Run the fixture again: the 12:08:09Z attempt passed all nine scenarios (ten Node results). Both new cases covered all 2144 ranges in five frames through HTML/history/outer; original negative cases still rejected incomplete proof. Command exit zero, owned closure and source stability passed. Original images remain for visual inspection.

## Task 3: Verify actual installed behavior and deliver

- [x] Add the optional `macViewport` input to `runPackagedSmoke` in `apps/desktop/scripts/packaged-e2e-smoke.mjs`. Apply `BrowserWindow.setContentSize` before each launched workflow, then require exact native/renderer dimensions and record each launch. The ordinary invocation retains its normal window behavior.
- [x] Run a fresh installed Mac gate at the observed small viewport. Session 72603 retained 22 driver checks, 56 captures (55 unique PNGs), five exact 1024×656 launches, six complete planning proofs including two instruction frames, all 14 driver cleanup flags and 799 stable sources. The external wrapper remains failed: one observed `(Artoo)` row reported nice0, despite zero exit, all 34 groups absent and no timeout/signals/observer errors. Do not replace that mixed result with a clean outer pass. The preceding 88753 dependency-download timeout remains failed with zero client photos.
- [ ] Independently review the diff and actual reports. Update the milestone ledger with original failure and new result, stage explicit paths, commit and normal-push main after preserving the six user files and stash.
- [ ] Track the new commit's hosted Mac, Windows shared and iOS outcomes separately. Do not supersede a still-running hosted invocation before reviewing its result unless explicitly justified.

## Task 4: Keep Windows fixture roots consistent with native Git paths

The same hosted run failed the new real-Git registration test because Node's
temporary path used `C:\Users\RUNNER~1` while Git reported the native long name
`C:\Users\runneradmin`. The two HEADs and branches matched. That failure stopped
the gate before its correction and zero-artifact protocols ran.

**Files:** `scripts/fixtures/git-worktree-evidence.test.mjs`,
`scripts/fixtures/execution-correction-results.test.mjs`,
`scripts/fixtures/zero-artifact-workspace-protocol.test.mjs`.

- [x] Apply `realpathSync.native(mkdtempSync(...))` at creation of the test-owned temporary roots, including the generated zero-artifact export parent. Keep the pure Git parser and all identity, containment and protocol assertions unchanged. The latter two fixtures are preventive handling of the same alias behavior, not observed failures in this invocation.
- [x] Run the six Git cases and both real protocol suites against the built checkout: session 14331 passed all 83 cases with no skips, stable source and owned closure. Fresh Windows CI remains required to accept the Windows-specific alias fix.
