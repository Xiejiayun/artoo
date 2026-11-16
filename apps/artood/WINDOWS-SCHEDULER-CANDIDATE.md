# Windows scheduler process owner candidate

This slice composes the existing original physical owner with a prepared local Windows Job backend. It does not declare Windows qualified. No build, test, typecheck, formatting or native qualification was run while implementing it; all checks belong to the final integrated pass.

## Local assembly

`RuntimePresetOptions.windowsProcessBackend` is forwarded by the Codex and Claude presets to `ProcessAdapterOptions.windowsProcessBackend`. `NodeClientOptions.ownedGit` must contain that same prepared backend plus an absolute, operator-selected `git.exe` path. Missing or older backend capabilities fail closed. No payload, ContextPack or model output may choose these values.

For the env-driven daemon, `ARTOO_WINDOWS_GIT_EXECUTABLE` selects the canonical
absolute physical local `git.exe` path. It requires the complete saved journal
binding and the existing `ARTOO_WINDOWS_PROCESS_BUNDLE` /
`ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256` pair. Relative, UNC, normalized aliases
and linked paths are rejected; there is no PATH lookup. The bootstrap passes the
same prepared backend to runtime presets and `ownedGit`. Selecting these settings
does not bypass journal qualification or enable scheduler claims: the existing
explicit `ARTOO_MANAGED_EXECUTION=1` and `ARTOO_SCHEDULER_ENABLED=1` requirements
still apply, and a refused physical check keeps the candidate unavailable.

`assertWindowsSchedulerStartBackend` additionally requires both `artoo.windows-launch-window.v1` and `artoo.windows-job-member-observation.v1` in the pinned manifest. The bridge checks live ready capabilities and QPC alignment too. The native program must be rebuilt, receive a new manifest digest, and pass native qualification before this capability is enabled.

The original consumed journal ready window becomes a private optional `{version:1,clock:"windows-qpc-ms.v1",deadline_ms}`. Every preparation Git helper and the target receive that absolute deadline. Native code checks it immediately before `CreateProcessW` and `ResumeThread`; asynchronous helper setup cannot renew it. Signal and private admission checks also run again before target dispatch. Ordinary native calls without the optional deadline retain their existing wire behavior.

The original process owner's actual spawn event ends the worktree startup phase. Later read-only worktree/result observations do not reuse that consumed deadline. This does not grant another start. Unknown helper closure retains the repository lane and workspace.

## Physical and filesystem boundaries

Windows Git uses the existing native Job helper and actual root HANDLE/creation-time, Job-empty, EOF and helper-exit/close proof. Owned Run status queries the original Job for the exact root identity; Stop cancels that owner. Physical receipts include separate Windows Job observations and do not synthesize POSIX group absence. Full Run closure additionally requires actual tool and dependency-input closure.

Namespace and context paths require real local NTFS/no-reparse/current-SID/DACL observations, exclusive creation, stable file and ancestor identities and exact context bytes. Windows relative context paths reject both slash forms of traversal, alternate streams, devices and aliases. The existing five-second startup budget is never extended; slow ACL/Git setup fails closed. Practical latency and filesystem support remain final-pass questions.

## Final native evidence

After rebuilding the exact source and helper bundle, run the ordinary repository checks plus `node --test apps/artood/test-fixtures/windows-scheduler-start-window-real.test.mjs` with `ARTOO_WINDOWS_PROCESS_BUNDLE` and its exact `ARTOO_WINDOWS_PROCESS_MANIFEST_SHA256`. It independently exercises the native expired-deadline rejection and exact live Job-member observation/closure. Its installation callback pins controlled fixture bytes only; it is not production installation qualification or a real-provider, cross-computer, signed-distribution or product deployment acceptance run.

The separate Windows journal candidate must also qualify its durable directory flushing, boot identity and private ACL policy. A passing process fixture cannot establish journal durability.
