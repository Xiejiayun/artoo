# Desktop execution approval and clean CI gate

**Goal:** Keep Mac/Web assignment controls consistent with the server's execution approval gate, exercise the real review/replacement flow in a newly installed DMG, and remove the clean-checkout dependency exposed by hosted worker tests.

**Source of truth:** `assertExecutionApprovalGranted` in `approval-service.ts`; disabled-action feedback in `docs/production-ui-gate.md` sections 5 and 9. Server authority and ordinary member assignment permissions remain unchanged.

1. Review and integrate the independently tested TaskActions/TaskDetailPanel patch. Pending, needs-information, rejected, expired and consumed gates disable Assign with an accessible reason. No-gate behavior remains available.
2. Extend packaged E2E using real UI decisions and independent read-only API checks: request, Need info, Reject, replacement request, Approve, Assign, uploaded artifact and human acceptance. Verify no run before assignment and bind the one approved current gate to the actual run. Retain additional approval screenshots in each HTML report.
3. Fix `desktop-worker-posix.test.ts` to bundle its shared packages from current source into its own temporary directory. Reproduce in a clean worktree with no package dist directories; do not hide the issue by relying on a previous build.
4. Run focused React tests and type checks, clean-worktree process tests and a fresh Mac DMG gate. Inspect screenshots, update the milestone ledger, commit and push to main. Inspect the resulting hosted CI; local success is not hosted evidence.

Each E2E attempt retains a timestamped HTML report, including failure. The separate live-provider and native member/revocation work remain outside this milestone until independently verified.

## Verified results

- Integrated and reviewed the renderer patch against the actual server gate; 30 focused React tests and Web no-emit type checking passed.
- Fresh Mac DMG run `2026-09-30T18-55-00-096Z` passed 12 client checks, with six visually inspected screenshots and full cleanup. All task/approval writes used UI; API reads verified the gate/run binding.
- Root Mac gate passed all 46 process regressions and eight distribution tests (the optional tiny filesystem-DMG test skipped).
- Clean worktree `user/jiaxie/ci-worker-clean` at `85eb8cd`, independent Node 24 `npm ci`, reproduced the four package-resolution errors. Only the test's two source aliases changed; all seven cases then passed with no dist directories or fixture leftovers.
- Verified changes are ready for the authorized milestone commit/push; hosted confirmation is tracked separately from these local results.
