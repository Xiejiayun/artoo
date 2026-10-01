# Native collaboration UI — first implementation milestone

The October 1, 2026 product direction makes conversation the primary entry point. The native app therefore opens Channels first while keeping Inbox, Tasks, Team, More, and their existing navigation destinations available.

## Reference patterns

| Product pattern | Native implementation |
| --- | --- |
| Slack: searchable channels and replies scoped to an original message | Channel directory with topic previews, separate creation sheet, named room title, explicit thread actions, original-message context |
| Discord: recognizable speaker identity and a readable conversation timeline | Consistent identity tiles, author-first messages, compact local times, date dividers, semantic mention treatment |
| Teams: conversation remains available while related work has a separate home | Fixed message composer; decisions, handoffs, blockers and recording tools in channel details; agent requests retain links to their execution tasks |
| Linear / Asana: scan work by state and make the next action clear | Counted status filters, concise task cards, unassigned state, contextual next-step guidance, clearer creation and assignment forms |

These are interaction references, not claims of feature parity. The client uses actual server channels, messages, notification counts, assignees, and statuses. It does not invent direct messages, read receipts, channel unread counts, presence, or reactions.

## Behavior retained

- Room/thread draft isolation, stable pending-send identifiers, realtime reconciliation, paging, and reply counts stay in the existing view models.
- Initial room history opens at the latest message. Incoming messages follow only while the previous latest row is visible; otherwise a counted jump action appears. Loading older history does not move the reader. Mention deep links keep their historical target.
- Message delivery explanations and raw errors are scrollable. The fixed composer exposes a recovery action and bounds its input height for accessibility text sizes and landscape.
- Agent selection still shows runtime, computer, workspace and collision identity. A disabled/deleted explicit selection stays visibly unavailable and blocks fresh requests until the user reselects or deliberately chooses Auto. Inventory loading cannot silently turn a persisted manual draft into Auto. Pending delivery keeps its original request identity. Execution approvals, cancellation, retry, request summaries, original content disclosures and planning-discussion restrictions remain in place.
- All 87 pre-existing accessibility identifiers in the changed source files are retained. New navigation and message actions have additional identifiers.
- Semantic color pairs adapt to dark appearance. New interactive controls use 44 pt targets; text uses native scalable styles. Task metadata has vertical fallbacks when horizontal space is limited.

## Verification recorded on Windows

- Static native API contracts passed: 22 request specimens, 51 server routes, and the existing realtime, scoped draft, stable-send, Keychain and icon checks.
- Exact native UI-suite contract tests passed: 15 tests. This verifies suite selection and evidence validation, not execution of the iOS UI.
- All ten changed Swift source files parsed with the existing tree-sitter Swift grammar. The modified assignee unit tests, core UI tests and mentions UI tests also parsed. Two targeted unit tests cover disabled/deleted/replaced manual targets and inventory loading; their XCTest execution still requires Apple CI. The grammar rejects the entire `AssistantConversationUITests.swift` file at line 1 both on the unchanged baseline and on this revision, so the full-source syntax script is not reported as passing.
- The parser needed `--liftoff-only --wasm-num-compilation-tasks=1 --no-wasm-async-compilation` on this host to avoid a Node parallel WebAssembly compiler crash.
- `git diff --check` passed.

The UI test geometry helpers now exclude the fixed composer and connection strip from historical-message screenshot bounds. The mentions suite checks the composer against usable screen bounds, still excluding navigation, tabs and the read-error inset. Full-frame visibility, exact body/author/mention values, keyboard dismissal, real-server identity, delivery, approvals, and outcome assertions remain intact.

Xcode compilation, XCTest execution, simulator screenshots, VoiceOver, Dynamic Type layout and device keyboard behavior have **not** been verified on Windows. The Apple CI/native gate must run on the committed revision. Visual acceptance should cover light/dark channels, a busy room, a thread, a historical mention with read failure, pending-send recovery, agent selection with duplicate names, task creation/assignment, approval/review, and the largest supported accessibility text sizes on a small phone and iPad.
