# Execution work and recovery reports

Branch-backed executions keep their owned Git worktree after success, failure,
cancellation and incomplete delivery. An uploaded patch may cover only part of
the work: changed files, new files and ignored files remain in the worktree.
Ordinary workspace execution keeps its existing behavior and does not gain an
automatic cleanup operation.

Both clients read a persisted worker report on each run. It identifies the
execution computer, exact workspace path, branch, reported outcome and accepted
time. Copy the path or branch to recover work on that computer. The report says
what the worker retained at that time; it does not prove that the directory still
exists, that the computer is online, or that files have not subsequently changed.
Without supported metadata, a planned path is shown separately without a retained
claim. Process output alone cannot create this report.

## Optional report collection

Coding runtime presets normally require and collect `changes.patch`. On an
execution computer, an operator may explicitly set `ARTOO_REPORT_ARTIFACTS=none`
before starting its worker to disable automatic artifact collection. With this
setting a successful execution can reach Review without uploading a report;
requested work remains in its workspace and the clients show the empty artifact
state and recovery information. The runtime prompt continues to require the
task's requested work but does not request an extra automatic patch report.

The default, an unset value, or `ARTOO_REPORT_ARTIFACTS=default` keeps existing
preset collection. Other nonempty values are rejected. The option applies to
both Codex and Claude Code presets on that worker. It is a local worker setting,
not a server-supplied task option, and changes require restarting the worker.
It does not waive execution approval, filesystem scope or sandbox controls.

## Compatibility and remaining limits

Updated workers negotiate typed retention reporting with the server. Older
servers use the existing diagnostic channel, so newer clients correctly report
that verified metadata is unavailable. Older workers may still delete successful
worktrees; update them before relying on preservation. A historical completed
status is not used to manufacture a retention claim.

Each legacy branch-backed agent instance still names one exact worktree root.
A retained directory cannot be silently reused for a new fresh Git worktree.
Use a separately configured unused root until explicit per-run base allocation
is implemented and verified. A new execution starts from the configured source
repository's HEAD; it does not automatically continue previous uncommitted work.
There is no new automatic deletion, export or recovery-copy operation in the
product. Disposable E2E evidence copies are test artifacts only.
