# Product UI refresh — work, resources and setup

This milestone extends the conversation-first direction in
[collaboration-ui-refresh.md](collaboration-ui-refresh.md) to the remaining
product routes. Web, Windows and macOS use the same renderer; iOS keeps native
navigation, forms, lists and sheets. The product references and existing server
contracts remain unchanged.

## Surface coverage

| Area | Shared Web / desktop | Native iOS |
| --- | --- | --- |
| Channels, groups, threads, mentions | Searchable directory, author groups, focused threads, fixed composer, historical-message recovery (first milestone) | Primary Channels tab, native conversation and thread context, fixed composer, recovery (first milestone) |
| Task handoff and review | Task list/board, explicit assignee/computer/runtime, next action, approval gates, artifact origin and durable review history | Task filtering, native creation/assignment, next action, native review and stop confirmation |
| Goals and plans | Search/filter, clear outcome and criteria, numbered dependent tasks, readable capabilities, contextual planning participants and checkpoints | Outcome/criteria sections, numbered participants, rich agent picker, goal controls above long histories |
| Runs and evidence | Task search and status filters, chronological execution information, readable evidence sections, technical references available on demand | Task/status/run-ID search, readable task and failure context, native summary navigation |
| Memory | Search/filter and review guidance, readable record details, replacement semantics and recoverable drafts | Content displayed once, clear review and replacement guidance |
| Agents, computers and skills | Searchable inventory, distinct enabled/work/connection states, registration dialog and two-step permission review | Computer/runtime context, readable permissions, setup guidance and multiline paths |
| Settings and onboarding | Section navigation, focused project creation, pairing steps, device management, grouped local worker configuration, responsive sign-in | Persistent pairing field labels, code entry assistance, grouped settings |
| Platform presentation | Windows executable/window icon and Web favicon derived from the existing native icon; native menu remains available through Alt on Windows | Adaptive metadata, status badges and execution headings for accessibility text sizes |

The UI exposes actual counts, statuses and permissions. Search filters the loaded
server inventory; it does not imply a global full-text index. Enabled agents and
offline computers remain separate states. Skill installation still reviews the
manifest's declared access before sending the existing request.

## Workflow corrections

- Failed memory replacement keeps the user's text. Selecting another memory
  starts its own editor state. Replacement copy states that the new record is
  accepted immediately, matching the server behavior.
- The computer shown for a task follows the newest run's creation time, rather
  than its event sequence count.
- Disabled or missing planning participants require deliberate reselection;
  existing pending submissions retain their captured request identity.
- Settings section navigation scrolls without changing the desktop HashRouter
  route. Project creation stays visible while the request is pending, including
  when Escape, the backdrop or the close control is used.
- Project, agent, skill, approval and worker forms preserve their real errors,
  role restrictions, confirmations and API payloads.

## Visual evidence

These captures use synthetic records on an isolated local development server.
The onboarding screenshot uses a preview of the desktop bridge's unpaired
state; it is layout evidence, not proof of an installed application.

| Surface | Capture |
| --- | --- |
| Goal and dependent plan | [Desktop](assets/ui-refresh/product-goals.png) |
| Execution evidence | [Desktop](assets/ui-refresh/product-runs.png) |
| Memory curation | [Phone-width detail](assets/ui-refresh/product-memory-mobile.png) |
| Agent inventory | [Desktop](assets/ui-refresh/product-agents.png) |
| Skill permission review | [Phone width](assets/ui-refresh/product-permissions-mobile.png) |
| Settings | [Desktop](assets/ui-refresh/product-settings.png) |
| Sign-in | [Desktop](assets/ui-refresh/product-login.png) |
| Desktop connection | [Phone-width layout fixture](assets/ui-refresh/product-onboarding-mobile.png) |

## Verification boundaries

Focused component tests cover changed workflow behavior, including unavailable
planning selections, skill permission review, memory drafts, latest-run identity,
and desktop-safe settings navigation. Browser QA checks real goal/plan creation,
skill installation, searches, and widths of 1440, 1024 and 390 pixels where
applicable. The PR records the final production build, full Web test suite,
real-server browser workflows and installed desktop checks.

Native changes, simulator results and source provenance are documented separately in
[native-work-management-ui.md](native-work-management-ui.md). Xcode compilation,
XCTest and installed macOS results come from Apple CI. VoiceOver, physical-device
keyboard behavior and a complete manual accessibility-size matrix are separate
from the automated simulator evidence; they are not claimed as verified here.
