# Collaboration UI refresh — October 2026

The product direction is now conversation first: people should be able to find a
channel, read a discussion, reply in context, and turn an outcome into assigned
work without navigating an operations console. This updates the earlier
operations-first decisions in `ui-system-spec.md` §1–2, §4–5 and
`production-ui-gate.md` §2/§6. Their semantic states, accessibility, native
platform conventions and evidence requirements continue to apply.

## References and application

Official product documentation reviewed on 2026-10-01:

- [Slack threads](https://slack.com/help/articles/115000769927-Use-threads-to-organize-discussions):
  preserve the channel while a focused reply panel opens, show the original
  message, and keep independent thread drafts. Do not invent thread subscription
  settings, reactions, or read receipts without a server contract.
- [Slack sidebar sections](https://slack.com/help/articles/360043207674): persistent
  navigation and a scannable local conversation directory. Artoo separates
  collaboration/work from resources and settings, with channel search scoped to
  the current project's actual channels.
- [Discord introduction](https://support.discord.com/hc/en-us/articles/360045138571-Beginner-s-Guide-to-Discord):
  stable channel context, topic descriptions and immediate access to discussion.
  Artoo uses neutral surfaces and avoids importing gaming/server-management chrome.
- [Teams design guidance](https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/design/design-teams-app-overview):
  clear action hierarchy, accessible navigation, integrated work context and
  progressive disclosure of less frequent controls.
- The work-management mapping in `production-ui-gate.md` §3 remains the reference
  for Linear-style task scanning and GitHub Projects-style assignment and boards.

## Shared desktop and web

The shared renderer serves Web, Windows and macOS. A persistent product sidebar
replaces the wrapping global menu. Channel directory, conversation and optional
thread have distinct boundaries; the conversation uses the available height.
Narrow layouts show the active thread in place of the main conversation, and
closing it restores the channel and its draft. Mobile web keeps navigation
reachable without horizontal document overflow.

Channels are real project discussions. Search only filters loaded channel names
and descriptions; it does not claim full-text message search. Channel creation
uses a focused dialog with topic guidance. Empty, loading, failed-sync and
unknown states remain explicit. Counts and identities come from server data.

Message presentation uses readable authors, timestamps and date boundaries.
The composer keeps text entry primary, with mentions and agent routing secondary.
Enter sends, Shift+Enter inserts a newline, and input-method composition does not
send. History browsing is not interrupted by a new message. Drafts, uncertain
delivery, idempotent retries, assistant execution approvals and exact notification
destinations retain their existing contracts.

Short windows retain a usable history scrollport without allowing messages to
paint over the composer. If a multiline draft exceeds the available height,
the conversation can scroll to its complete send control. Browser regression
coverage checks the actual hit target and successful channel/thread submission
at 390×667 and 390×400, as well as the fixed desktop composer.

## iOS

iOS uses native list navigation, sheets and a reachable composer with 44-point
controls and Dynamic Type. It mirrors the shared semantic colors and hierarchy,
not the desktop columns. Channels remain discoverable as a primary tab. Native
accessibility identifiers and real-server UI workflows remain supported.

## Verification and milestones

Each milestone records its actual checks and screenshots in the PR. Required
evidence includes component behavior, production build, real-server browser
workflows, narrow/desktop layout and packaged desktop smoke. Native Swift checks
on Windows establish API/syntax compatibility only. Xcode/XCTest, simulator UI
screenshots and the installed macOS package are verified by the repository's
Apple CI jobs; no Windows result substitutes for them.

1. Shared navigation, channels, conversation, threads and task workflow.
2. Native iOS collaboration/work surfaces and remaining secondary screens.
3. Cross-platform review, package evidence and fixes found by those checks.

## First implementation evidence

The screenshots below use the same isolated development server and real persisted
channels/messages. The baseline is commit `e2f25ce`; the new renderer is the
collaboration UI branch. Content is a synthetic design discussion, not a live
team's conversation. Screenshots are visual evidence, not native package proof.

| Surface | Before | After |
| --- | --- | --- |
| Channel | [Baseline](assets/ui-refresh/channels-before.png) | [Updated](assets/ui-refresh/channels-after.png) |
| Thread | [Baseline](assets/ui-refresh/thread-before.png) | [Updated](assets/ui-refresh/thread-after.png) |
| Mobile web thread | — | [390px view](assets/ui-refresh/thread-mobile.png) |
| Task creation | — | [Dialog](assets/ui-refresh/tasks-create-desktop.png) |
| Task board | — | [Board](assets/ui-refresh/tasks-board-populated-desktop.png) |
| Assignment | — | [Ready-task workflow](assets/ui-refresh/tasks-assignment-desktop.png) |
