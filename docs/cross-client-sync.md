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

The 2026-09-29 local provider check found Codex CLI installed but not logged in,
and no Claude CLI on PATH. Live model validation is therefore still pending.
Windows-side native Swift syntax/contract checks do not replace Xcode builds,
XCTest, simulator or device evidence. Signing, distribution, external Google
OAuth credentials, public DNS/TLS deployment and real-provider execution remain
environment-specific release gates, not claims made by this preview milestone.

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
for the workflow's configured retention period. Simulator UI walkthroughs,
physical-device flows and live cross-device/provider acceptance remain open.
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
