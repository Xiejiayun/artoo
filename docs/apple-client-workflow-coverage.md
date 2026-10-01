# Apple client workflow coverage

Source inventory: 2026-10-01. This is a map of implemented test scenarios, not
a claim that the latest run passed. Use the timestamped HTML reports and
[milestone results](apple-client-milestones.md) for actual outcomes. Unit tests,
mock transport and direct API calls do not establish native or installed-Mac
UI coverage.

| Existing feature | Native UI scenarios currently implemented | Installed Mac scenarios currently implemented | Remaining UI paths |
| --- | --- | --- | --- |
| Identity and devices | Pairing, saved session/relaunch, member permissions, owner Web revocation and fresh member pairing | Pairing, execution enrollment, encrypted credentials, sign-out and restart | Native creation of a personal pairing code, authorized enrollment and native Revoke action |
| Inbox approvals | Needs-information, restored draft/history and approval; task execution gate | Needs-information, rejection, replacement approval and assignment gate | Native rejection; additional approval types |
| Task execution | Create, execution approval, readable manual assignment with colliding IDs, offline refusal/retry, actual subprocess/artifact, Quick Look and acceptance; direct-conversation task/run detail | Success chain, approval history, artifact bytes/review and app/server restart; direct-conversation linked task | Request changes, failed task execution retry, running Stop confirmation, manual dependencies, filters and standalone run history |
| Team conversation | Root/thread messages, independent Web peer, background catch-up and relaunch | Default package smoke does not enter conversation | Channel creation/history, unconfirmed-send UI recovery and installed-Mac message/thread flows |
| Direct agent requests | Exact colliding-agent selection, offline waiting, relaunch/draft, automatic recovery, failed-request Retry, actual prior-answer context, linked task/run identity and UI Cancel with real PID exit | Installed UI channel/agent creation, Settings worker stop/start, waiting/automatic recovery, failed-request Retry, two actual answers, linked task and Cancel with real PID exit | Long/multiline request disclosure, threaded requests and concurrent requests; optional live `all` helper has no successful real-provider result |
| Decisions, handoffs and blockers | Not yet covered by native UI | Not yet covered by package smoke | Create/accept decision; create/accept/complete handoff; create/resolve blocker. Existing Web browser scenarios cover these product paths separately |
| Team execution resources | Actual daemon disconnect/grace/reconnect and status presentation | Instance registration, worker settings and start/stop/restart | Native instance registration, enable/disable and setup recovery |
| Goals and plans | Agent discussion, coordinator summary/original instruction, suggested/original reply, proposal, human acceptance with dependent tasks, cancellation confirmation | Three deterministic process contributions with exact prior-answer context; coordinator/original instruction disclosure; suggested plan, proposal and acceptance with dependent tasks. Optional real-provider helper has no established live pass | Manual plan editor, reject proposal, pause/resume/reconcile, audit export/share |
| Mentions and project navigation | Model and mock-transport coverage, no native UI scenario | No package scenario | Precise historical reply, project/room/thread switch, pagination, unread acknowledgement and retry. Existing Web browser tests are separate evidence |
| Other workspace pages | Projects, Memory, Skills, run history and Privacy have no native UI scenarios | Default package smoke does not cover these pages | Project creation/switching; memory review/supersession; skill installation/details; independent run history; offline privacy navigation |

Primary source references:

- [Native UI cases](../apps/ios/UITests/SharedServerChatUITests.swift),
  [installed package smoke](../apps/desktop/scripts/packaged-e2e-smoke.mjs) and
  [installed planning](../apps/desktop/scripts/installed-mac-planning.mjs), plus
  [native direct-agent case](../apps/ios/UITests/AssistantConversationUITests.swift),
  [installed direct-agent flow](../apps/desktop/scripts/installed-mac-assistant.mjs) and
  [optional provider extension](../apps/desktop/scripts/installed-live-provider.mjs).
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

1. **Cross-project mentions.** Another client mentions the user in an older
   reply. Follow Inbox to the exact project and thread, verify unread counts,
   and recover from one failed read acknowledgement through UI without losing
   drafts or marking unread content as read prematurely.
2. **Execution correction and stopping.** Request changes after reviewing an
   artifact, preserve feedback, retry a failed execution, and dismiss then
   confirm stopping an active run. Check exact run counts, artifact retention,
   approval consumption and absence of duplicate subprocesses.

Each scenario must retain a separate HTML report with actual client captures,
including failed attempts. Server reads may verify identities and counts;
they must not replace the user actions under test. Distribution, real-provider
quality, deployed identity and operator policy remain separate
[release gates](apple-release-readiness.md).
