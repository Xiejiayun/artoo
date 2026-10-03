# Apple client workflow coverage

Source inventory: 2026-10-03. This is a map of implemented test scenarios, not
a claim that the latest run passed. Use the timestamped HTML reports and
[milestone results](apple-client-milestones.md) for actual outcomes. Unit tests,
mock transport and direct API calls do not establish native or installed-Mac
UI coverage.

| Existing feature | Native UI scenarios currently implemented | Installed Mac scenarios currently implemented | Remaining UI paths |
| --- | --- | --- | --- |
| Identity and devices | Pairing, saved session/relaunch, member permissions, owner Web revocation and fresh member pairing | Pairing, execution enrollment, encrypted credentials, sign-out and restart | Native creation of a personal pairing code, authorized enrollment and native Revoke action |
| Inbox approvals | Needs-information, restored draft/history and approval; task execution gate | Needs-information, rejection, replacement approval and assignment gate | Native rejection; additional approval types |
| Task execution | Create, execution approval, readable manual assignment with colliding IDs, offline refusal/retry, actual subprocess/artifact, Quick Look and acceptance; durable Request changes/retry/version history, exact Keep/Stop and default-off isolated worktree selection; partial/zero-artifact success preserves work with reported recovery details, exact Copy and cold relaunch | Success, approval history, artifact bytes/review and app/server restart; direct-conversation linked task; four-run correction retains all worktrees; separate zero-artifact success and recovery Copy across cold renderer reload | Safe same-instance repeat execution through per-run allocation and explicit continuation; manual dependencies, filters and standalone run history |
| Team conversation | Root/thread messages, independent Web peer, background catch-up and relaunch | Historical thread navigation, independent Web mentions and separate thread drafts across project changes/reload | Native channel creation/history, unconfirmed-send UI recovery and installed-Mac ordinary root/reply submission |
| Direct agent requests | Exact colliding-agent selection, offline waiting, relaunch/draft, automatic recovery, failed-request Retry, actual prior-answer context, linked task/run identity and UI Cancel with real PID exit | Installed UI channel/agent creation, Settings worker stop/start, waiting/automatic recovery, failed-request Retry, two actual answers, linked task and Cancel with real PID exit | Long/multiline request disclosure, threaded requests and concurrent requests; optional live `all` helper has no successful real-provider result |
| Decisions, handoffs and blockers | Not yet covered by native UI | Not yet covered by package smoke | Create/accept decision; create/accept/complete handoff; create/resolve blocker. Existing Web browser scenarios cover these product paths separately |
| Team execution resources | Actual daemon disconnect/grace/reconnect and status presentation | Instance registration, worker settings and start/stop/restart | Native instance registration, enable/disable and setup recovery |
| Goals and plans | Agent discussion, coordinator summary/original instruction, suggested/original reply, proposal, human acceptance with dependent tasks, cancellation confirmation | Three deterministic process contributions with exact prior-answer context; coordinator/original instruction disclosure; suggested plan, proposal and acceptance with dependent tasks. Optional real-provider helper has no established live pass | Manual plan editor, reject proposal, pause/resume/reconcile, audit export/share |
| Mentions and project navigation | Late-created project, two precise historical replies beyond the latest 50, explicit read Retry after a device-bound 503, global unread/sentinel checks and A/B drafts across project changes/relaunch | The same independent-sender scenario through the installed renderer, including reload and exact hash-route identities | Notification-list pagination beyond 100 and project-refresh error/retry through native or installed UI |
| Other workspace pages | Projects, Memory, Skills, run history and Privacy have no native UI scenarios | Default package smoke does not cover these pages | Project creation/switching; memory review/supersession; skill installation/details; independent run history; offline privacy navigation |

Primary source references:

- [Native UI cases](../apps/ios/UITests/SharedServerChatUITests.swift),
  [installed package smoke](../apps/desktop/scripts/packaged-e2e-smoke.mjs) and
  [installed planning](../apps/desktop/scripts/installed-mac-planning.mjs), plus
  [native direct-agent case](../apps/ios/UITests/AssistantConversationUITests.swift),
  [installed direct-agent flow](../apps/desktop/scripts/installed-mac-assistant.mjs) and
  [optional provider extension](../apps/desktop/scripts/installed-live-provider.mjs).
- [Native historical mentions](../apps/ios/UITests/MentionsUITests.swift),
  [installed historical mentions](../apps/desktop/scripts/installed-mac-mentions.mjs)
  and the [independent Web sender](../scripts/fixtures/mentions-scenario.mjs).
- [Native correction](../apps/ios/UITests/ExecutionCorrectionUITests.swift),
  [installed correction](../apps/desktop/scripts/installed-mac-correction.mjs)
  and the [shared four-run fixture](../scripts/fixtures/execution-correction-scenario.mjs). The milestone ledger
  records actual correction passes and their original-image/data audits.
- [Native zero-artifact retention](../apps/ios/UITests/SuccessfulWorkspaceRetentionUITests.swift),
  [installed zero-artifact retention](../apps/desktop/scripts/installed-mac-zero-artifact.mjs)
  and [the shared retention fixture](../scripts/fixtures/zero-artifact-workspace-scenario.mjs).
- Native [collaboration](../apps/ios/Sources/Views/CollaborationView.swift),
  [team/devices](../apps/ios/Sources/Views/TeamViews.swift),
  [workspace/goals](../apps/ios/Sources/Views/WorkspaceViews.swift) and
  [navigation](../apps/ios/Sources/App/ArtooApp.swift).
- Web [trusted-preview scenarios](../apps/web/e2e/trusted-preview.spec.ts),
  [mention navigation](../apps/web/e2e/notification-navigation.spec.ts),
  [channels](../apps/web/e2e/channels.spec.ts), and
  [task lifecycle](../apps/web/e2e/happy-path.spec.ts). The latter's execution
  fixture is not an installed worker. The command-queue-replay suite calls the
  API client directly and is not a browser UI workflow.

## Next bounded scenarios

1. **Remaining mention paths.** Exercise notification-list pagination beyond
   100 entries and failed project-access refresh with explicit Retry. Historical
   thread targets, read Retry and draft isolation now have passing local native
   and installed-Mac evidence in the milestone ledger.
2. **Per-run allocation and explicit continuation.** Successful-work preservation,
   durable recovery details, exact Copy and cold reload/relaunch have local coverage.
   The correction case still uses four distinct worktrees. Verify safe same-instance
   repeat execution with administrator-approved allocation, and define explicit
   continuation of earlier uncommitted work. Isolated allocation/receiver/WebSocket
   and UI-heading candidates remain unapplied.
3. **Native device management.** Exercise personal pairing-code creation, authorized
   enrollment and Revoke through the actual native UI. Isolated device patches are
   outside current verified coverage.

Each scenario must retain a separate HTML report with actual client captures,
including failed attempts. Server reads may verify identities and counts;
they must not replace the user actions under test. Distribution, real-provider
quality, deployed identity and operator policy remain separate
[release gates](apple-release-readiness.md).

Current source26 local verification passed **159 fresh native units and all 11
exact UI cases** (core 7/assistant 1/mentions 1/correction 1/retention 1), plus the
matching development-signed arm64 archive. Correction's 21 and Retention's seven
original photos and their exact visual/data relations are verified. The
[current milestone](apple-client-milestones.md#2026-10-03-successful-work-retention-and-recovery-locally-verified) records the full original-image/HTML inventory,
data audits, eleven preserved frame warnings and retained failed attempts.

Historical source10 installed Mac evidence remains 22 checks, 55 original captures,
22 Copy values and 14 cleanup flags. The source26 applicability comparison supports
those component paths; it does not claim a fresh Mac binary or runtime result.
The remaining UI paths above and external commercial release gates remain open.
