# Cross-client synchronization and conversation delivery

This work implements the follow-up objective: Web, Windows and iOS must use the
same server authority, expose consistent workflows, and recover reliably from
network and process interruptions. The existing Fastify server is the shared
service; clients do not keep competing copies of task or conversation state.

## Required outcomes and acceptance evidence

- [ ] Task and goal conversations on Web, Windows and iOS: history, sending,
  stable retry identity, drafts, errors and account isolation.
- [ ] Bounded message pagination and incremental synchronization, authenticated
  realtime subscriptions, reconnect/foreground catch-up without missing messages.
- [ ] Actual assistant conversations: explicit discussion versus assistant intent,
  durable turns, history in model context, visible assistant answers and follow-up,
  execution/approval/cancellation policies preserved.
- [ ] Server restart and node disconnect recovery for ordinary and goal tasks;
  no duplicate execution and no lease release without confirmed process exit.
- [ ] Bounded backup restoration and practical storage capacity handling.
- [ ] Usage/cost visibility and deliverable verification with honest distinctions
  between known usage, unavailable prices, warnings and enforced limits.
- [ ] A reproducible shared-server deployment, health checks, TLS/WebSocket
  configuration, backup/recovery and cross-device connectivity instructions.
- [ ] A unified preview validation entry point and CI for supported platforms;
  refreshed Windows install and native-client integration evidence.
- [ ] Platform distribution readiness: signing/update configuration and clear
  operator setup; actual external credentials/certificates must not be invented.
- [ ] Explicit Agent Daemon online/offline/reconnect/stale status, last heartbeat
  and separate runtime availability on every client. Client connection failures
  must display unknown/stale data rather than inventing daemon offline state.
- [ ] Slack/Discord-style project channels and message threads, real member
  selection for @mentions, durable personal notifications and cross-client deep links.
- [ ] Project objective decomposition into reviewable tasks, dependencies and
  acceptance criteria; multiple agents can discuss in the shared conversation,
  with visible attribution, bounded rounds/budgets, intervention and cancellation.

Completion requires verifying the current revision on the relevant platforms.
Windows-side Swift parsing or contract checks do not prove an iOS build/device
flow. Fixture subprocesses do not prove a real model session. Those gates remain
open until direct evidence is available.

## Shared message API

`GET /api/v1/rooms/:id/messages?limit=50&before=<cursor>` returns the newest page
before that cursor, in chronological sequence. Omit `before` for the newest
page. `after=<cursor>` instead returns the next ascending page of new messages.
`before` and `after` are mutually exclusive, with a maximum page size of 100.

The response is `{ messages, next_before, next_after, has_more }`. Nonempty pages
always carry the first and last opaque cursor, even at the end of history.
`has_more` refers to the requested direction. Empty pages return null cursors;
clients retain their existing cursor. A database sequence, independent of wall
clock and random identifiers, orders messages. Cursors are scoped to their room.

Realtime events are hints to fetch authoritative deltas. Clients merge by message
identity and keep older loaded pages. Drafts and uncertain-send keys are scoped
to server, organization, user and room. Logout clears pending credentials/actions;
an action must never be replayed as another identity.

## Personal notification API

`GET /api/v1/notifications?limit=50&before=<cursor>` returns
`{ notifications, next_before, has_more, unread_count }`. The default page size
is 50 and the maximum is 100. Notifications are newest first, ordered by the
database timestamp and then ID; cursors retain sub-millisecond precision and
belong to one authenticated recipient and organization. Treat them as opaque.
The unread count covers all accessible history, including unloaded pages.

`POST /api/v1/notifications/:id/read` returns
`{ notification, unread_count }`. Repeating the request preserves the first read
timestamp. Clients use this authoritative count and refresh read states after
another client changes them. A failed request does not confirm a read or a
zero count.

Each notification includes its project and room routing context. Clients can
also resolve a room with authenticated `GET /api/v1/rooms/:id`; a URL's selected
project is not an authority for that room. Open the exact mentioned message and
its thread root before recording the notification as read.

## Work record

- Baseline: `3499857`; branch `user/jiaxie/cross-client-sync`.
- Initial inspection reconfirmed the gaps described in the preceding review.
- The collaboration milestone is implemented. Platform release acceptance
  remains open where direct environment evidence is missing.
- User delivery policy: after a coherent milestone passes its relevant checks,
  commit and push it to `main`, using `Xiejiayun <furnace09@gmail.com>`.

## Current implementation

The shared server now has durable assistant turns, provider-structured replies
and usage, bounded conversation pages, project channels, threads, user mentions,
personal notifications, daemon presence and persisted planning discussions. Web
and the packaged Windows renderer share the same views and APIs; native iOS has
matching conversation, channel, thread, notification, daemon and planning flows.
See [agent-planning.md](agent-planning.md) for the planning workflow and its limits.

Recovery tests cover standalone runs, disconnect/reconnect and server startup,
including processes whose database run failed before the node confirmed exit.
Artifact restore streams into unpublished staging and discards partial restores
on a late checksum failure. The database archive still uses PGlite's buffer API.

The latest 2026-09-29 local provider check found both CLIs installed. Codex is
not logged in; Claude reports an authenticated configuration, but its configured
local proxy rejects the default model as unsupported. A process-local override
to a model advertised by that proxy also returned "no model endpoints available
given user constraints". No machine configuration was changed. Successful live
model execution remains unverified; a logged-in CLI alone does not establish it.
Windows-side native Swift syntax/contract checks do not replace Xcode builds,
XCTest, simulator or device evidence. Signing, distribution, external Google
OAuth credentials and public DNS/TLS deployment remain environment-specific
release gates.

## Milestone validation, 2026-09-29

Local validation covers the production preview build, TypeScript checks,
the full unit/integration suite (1,099 passed, 15 skipped, zero failed across
179 files), 10 browser end-to-end workflows, 6 authentication workflows, a
production dependency audit with zero vulnerabilities, and an installed
Windows NSIS package smoke. The Windows smoke exercises pairing, encrypted
credentials, daemon start/stop/restart, a fixture CLI subprocess, artifact
download/review, restart persistence, revocation and uninstall. It does not
establish a live provider session; the generated installer is unsigned.
The verified installer SHA-256 is
`a107ab070cd2d7f746424a6561025e82ff5d14a1cadb2893cdf6d8706ec7a18d`.
Screenshot capture succeeded on its first attempt; the harness verifies native
IPC, renderer, worker, task and realtime health before recording that evidence.

Native static validation checks 22 request samples, 51 required routes and
25 Swift source files for syntax. The
[hosted Windows shared gate](https://github.com/Xiejiayun/artoo/actions/runs/36514121949/job/109232517593)
passed for collaboration milestone `3c730995379349cc6e6a4f1ecb2e9d7d55fc368f`,
covering the preview build, regression suite, browser/authentication flows,
native contracts and dependency audit.

The subsequent [macOS gate](https://github.com/Xiejiayun/artoo/actions/runs/36514981285/job/109235150122)
passed for native validation fix `60b8a248d11a6e5ea298d59dfd61c39a86475a83`.
Xcode 16.4 (16F6) built the app and full asset catalog, then executed all
53 XCTest cases on an iPhone 17 Pro simulator running iOS 26.2: zero failures
and no skipped tests. This includes actual Keychain round-trip storage and
session-revocation notification handling. The fix enables simulator-only
ad-hoc Keychain entitlements and corrects test assertions; it does not change
production Swift behavior or physical-device provisioning. The run retains
an [XCTest result bundle](https://github.com/Xiejiayun/artoo/actions/runs/36514981285/artifacts/11010616964)
for the workflow's configured retention period. That run did not execute a
simulator UI walkthrough. Subsequent native UI evidence is recorded below;
physical-device flows and live cross-device/provider acceptance remain separate
checks.
The gate commands and deployment templates are described in
[shared-server.md](shared-server.md).

Notifications now use bounded cursor pages and a server-calculated unread count
across the recipient's entire history. Web/Windows and iOS expose older pages,
refresh read status across clients, and distinguish a failed count refresh from
an actual zero. Opening a mention fetches its exact message and thread before
marking it read, including replies outside the newest message page. Room metadata
supplies the authoritative project context for channel and notification links.
Planning runtime restrictions and inherited MCP capability limits are documented
in [agent-planning.md](agent-planning.md).

## Notification history and native conversation milestone, 2026-09-29

The changes through `6be6e6ca535fcd99084431a906bf09b6c03b2528` add notification cursor
pagination, full-history unread totals and authoritative room/project routing.
Opening a historical mention loads its exact reply before marking it read.
Failed lookups do not mark notifications read; failed read requests leave status
unconfirmed until retry or synchronization. Read failures can recover after
navigating between notifications in the same thread; the thread draft is preserved.
iOS refreshes read state across its loaded notification pages and labels an
unavailable global count explicitly instead of presenting it as zero.

Local checks passed the clean production build, Web type checking, 28 focused
notification/channel tests and all 13 real-server Chromium workflows. The new
navigation regression was observed failing before the fix. The production
dependency audit reported zero vulnerabilities. The clean-build correction
declares the testkit package's existing storage import in both its workspace
dependencies and TypeScript project references. Browser tests that query a
specific project now explicitly select it in the UI, so adding another project
cannot redirect their setup into a different project's data.

The native UI gate exposed a real navigation failure: tapping Channels selected
Tasks because both TabView children shared the same project-based identity.
Each tab now has a unique selection tag and the two project-scoped views retain
separate identities. The UI gate checks the Channels navigation title before
opening a conversation, both after pairing and after relaunch.

The refreshed Windows NSIS installer passed the complete installed-package smoke
at `2026-09-29T03:38:05Z`, including production pairing, protected credentials,
single-instance startup, daemon controls, fixture-provider execution, artifact
review/download, restart persistence, revocation and uninstall. Its SHA-256 is
`1d51d5fff290e2de95e6a9ec0c6f1583afe039097e5e536a1693fe1fadc8323b`.
The installer remains unsigned, and the CLI fixture does not establish a live
model session.

The [hosted shared gate](https://github.com/Xiejiayun/artoo/actions/runs/36522676613/job/109258786779)
passed for `6be6e6ca535fcd99084431a906bf09b6c03b2528`: 1,118 unit/integration
tests passed and 17 were skipped (176 passing files and six skipped files),
all 13 browser workflows and all six authentication workflows passed, and the
production dependency audit found zero vulnerabilities. Type checking, the
production preview build, native contracts and whitespace checks also passed.
The hosted skips match the preceding CI run; they include opt-in live-provider,
runtime and platform checks. The installed Windows gate separately exercises
the bundled worker that is not packaged by the shared CI build.

The [native macOS gate](https://github.com/Xiejiayun/artoo/actions/runs/36522676613/job/109258786544)
passed for the same revision using Xcode 16.4 (16F6), an iPhone 17 Pro simulator
and iOS 26.2. Both Debug and Release builds succeeded; 55 unit XCTest cases and
one Release XCUITest passed with zero failures. The UI scenario completed in
187.998 seconds and exercised real onboarding/pairing, channel and thread sends,
a reply from the independent Chromium composer, foreground catch-up after a
background reply, and Keychain/history restoration after app relaunch.
Database assertions confirmed message uniqueness and thread scope.

The [retained artifact](https://github.com/Xiejiayun/artoo/actions/runs/36522676613/artifacts/11013509974)
contains XCTest bundles, the native thread screenshot, the browser screenshot,
message identities and the passing synchronization report. Both screenshots
were visually inspected. This validates the shared UI workflow with an
authenticated socket connected; send-triggered REST refreshes can overlap, so
it does not independently isolate WebSocket delivery. Public TLS/WebSocket
deployment, real Google login/model providers, other native UI workflows,
physical iOS devices and distribution signing remain separate release checks.
