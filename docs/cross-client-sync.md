# Cross-client synchronization and conversation delivery

This work implements the follow-up objective: Web, Windows and iOS must use the
same server authority, expose consistent workflows, and recover reliably from
network and process interruptions. The existing Fastify server is the shared
service; clients do not keep competing copies of task or conversation state.

## Implementation and acceptance evidence

The table separates implemented behavior from the remaining environment checks.
Exact revisions, commands, test totals and evidence boundaries are recorded below.

| Outcome | Implementation and available evidence | Remaining acceptance |
| --- | --- | --- |
| Task/goal conversations on all three clients | History, sending, retry identity, drafts, errors and account isolation; browser and native channel/thread synchronization tested | Complete task/goal UI walkthrough and physical devices |
| Bounded pagination and synchronization | Cursor APIs, authenticated subscriptions, replay, reconnect and foreground reconciliation; regression for final discussion events to project subscribers | Deployed TLS/WebSockets and independently isolated realtime delivery |
| Actual assistant conversation | Durable turns, explicit agent intent, actual Codex/Copilot follow-up context, exactly-once replies and recorded usage; installed Windows UI provider settings persist across restart and two live replies passed | Claude route and deployed authentication/transport |
| Restart/disconnect recovery | Server/node recovery regressions preserve process-exit boundaries; native daemon and installed Windows scenarios passed | Deployed failure/recovery drill |
| Backup restoration and capacity | Artifact restore streams to staging and discards failed checksums | Database backup still uses a buffer; capacity limits and deployed restore drill |
| Usage, cost and deliverables | Actual provider token measurements; unavailable prices remain null; Windows artifact download/review tested | Real pricing and model-produced deliverables; monetary spending caps are not implemented |
| Shared deployment | Service/TLS templates, health checks, backup/recovery and connectivity instructions | Actual host, DNS/TLS, Google OAuth and cross-device deployment |
| Repeatable validation | Shared CI, native XCTest/UI scenarios and installed Windows gates have evidence by source revision below | Repeat on subsequent product changes; live scopes, platform/device/deployment checks retain their own limits |
| Platform distribution | Windows install/control/restart/uninstall exercised; native simulator Debug/Release builds passed | Windows signing/update delivery; iOS device signing, provisioning and distribution |
| Agent Daemon status | Three clients distinguish daemon presence from runtime availability; heartbeat/activity and Unknown/stale behavior covered; native disconnect/recovery UI passed | Physical-device recovery |
| Channels, threads, mentions and notifications | Project channels, scoped threads, real-member mentions, durable paginated notifications and exact destinations implemented and covered by API/browser/native tests | Native notification deep-link UI and physical-device coverage |
| Agent discussion and task decomposition | Real installed-worker three-turn Copilot discussion, prior-answer context, readable plan cards, validated proposal and accepted criteria/dependencies verified; native proposal/acceptance UI passed with subprocess fixtures | Deployed/device interaction; full live sequence has not passed in one uninterrupted run |

Windows-side Swift parsing or contract checks do not prove an iOS build/device
flow. Simulator evidence does not certify physical devices. Deterministic fixture
subprocesses and the separately verified live model sessions have distinct scopes.

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

The initial 2026-09-29 provider checks failed with the existing CLI settings.
After selecting the user's Aerial GitHub Copilot route, real Codex conversation
and multi-agent discussion gates passed using requested model `gpt-5.4-mini`.
They verify actual responses and prior-answer context through Artoo's production
dispatcher/adapters, with fixture authentication and in-process node transport.
Those initial process-level checks did not configure the installed worker. The
latest milestone below adds local Windows provider settings and verifies actual
installed-worker chat and discussion in separate live attempts, without changing
user-wide CLI settings. The observed Aerial catalog did not expose an Anthropic
Messages route, so Claude remains unverified on that proxy.

Native Xcode builds, XCTest and simulator UI evidence are recorded below by exact
revision. The latest native gate at `f3358c4` passed Debug/Release builds, all
77 unit cases and three UI scenarios, including plan-card review and acceptance.
The complete local shared gate at `bf2813f` passed all eight checks; the only
subsequent changes from the native source are a Web test and documentation.
Signing, distribution, physical iOS devices, external
Google OAuth and public DNS/TLS deployment remain separate release gates.

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

## Conversation recovery and daemon freshness milestone, 2026-09-29

Changes through `9715f0de189173539e5756d2d43a9581c26e6a65` unify conversation
attribution on Web/Windows and iOS. Timeline messages, thread roots and exact
historical mention targets use the same member/agent names, current-user marker,
system label and typed missing-identity fallback. iOS also renders structured
mentions and formats database/ISO timestamps in the device's locale and time zone.

iOS separates message lookup failures from failed read confirmations. A read
retry keeps the loaded thread and its composer, validates the exact notification,
room, message and root, and rejects stale responses after navigation. Tests cover
mismatched destinations, old responses, single-flight retry and invalid receipts.

Web/Windows no longer treats a cached online daemon sample as current when the
browser is offline, a request is paused, the server returns an error, or no fresh
sample arrives within 12 seconds. Reopening the page requires a new successful
sample; reconnecting the browser alone is insufficient. Previously known run
counts remain explicitly labeled as historical, and connection failure is
reported as unknown rather than an invented daemon-offline state.

Runtime failures now preserve the provider's structured error even when the CLI
exits nonzero and its final JSON record has no newline. Both Codex and Claude
subprocess regressions reproduced the prior generic `exit 1` result before the
fix. The opt-in live conversation gate is documented in
[shared-server.md](shared-server.md#optional-live-conversation-gate). At that
milestone, the local provider configuration failed before an answer; successful
live Copilot conversation and discussion were verified later, as recorded below.

The local shared gate passed 1,130 tests (16 opt-in/platform skips), all 13
browser workflows, all six authentication workflows and a production audit
with zero vulnerabilities. The
[hosted shared gate](https://github.com/Xiejiayun/artoo/actions/runs/36525442804/job/109267348803)
passed for the same code revision with 1,128 tests and 18 skips, 13 browser and
six authentication workflows. The hosted environment does not include the
locally packaged worker checks. Type checking, production build, native API
contracts and whitespace checks passed in both environments.

The [macOS gate](https://github.com/Xiejiayun/artoo/actions/runs/36525442804/job/109267348499)
passed using Xcode 16.4 and the iPhone 17 Pro/iOS 26.2 simulator. Debug and Release
builds succeeded, all 67 unit XCTest cases passed, and the existing Release
pairing/channel/thread/background/relaunch XCUITest passed in 86.763 seconds.
This includes the 12 new conversation metadata and mention recovery tests.
The [retained native evidence](https://github.com/Xiejiayun/artoo/actions/runs/36525442804/artifacts/11014995916)
includes both result bundles, the passing synchronization report and native/Web
screenshots. Both screenshots were inspected; they show resolved current-user
names and readable dates in the synchronized thread. The UI coverage and
WebSocket isolation limits described in the preceding milestone still apply.

The rebuilt Windows installer passed all seven installed-package checks at
`2026-09-29T05:33:34.404Z`. Its SHA-256 is
`2ae0fc31a1e88c5d8570c8f59ec29731e9ea9d179549c6fa14772effb1e54b9f`;
it remains unsigned. Screenshot review exposed a remaining name-resolution
gap: actual runtime answers carry an agent-instance ID, while the current name
resolver directly looks up agent IDs. They retain an explicit typed-ID fallback.
The following native workflow milestone addresses that gap and the duplicate
inventory-status label found during real node recovery testing.

## Runtime attribution and native goal workflows, 2026-09-29

Actual runtime replies now resolve their agent-instance ID through the agent
directory on Web/Windows and iOS, including mentions and native discussion
participants. Legacy direct agent IDs retain their names; missing agent records
retain a typed fallback and never resolve through a member with a colliding ID.
Computer screens use the live daemon observation instead of displaying a second
cached inventory status. Native plan review shows dependency names alongside
the task titles and acceptance criteria before acceptance. Native pairing fields
also wait for connection restoration/sign-out to finish before accepting input.

The expanded Release XCUITest suite contains independent chat, real daemon
stop/recovery, and discussion/proposal/acceptance scenarios. Its discussion uses
two process-adapter fixture instances for two contributions and a final synthesis.
The subprocesses check their actual context and read-only policy; the harness
checks the persisted answers, exact thread scope, and zero goal tasks before
human acceptance, followed by two tasks with acceptance criteria and a `blocks`
dependency. These deterministic subprocesses do not establish provider inference.

The opt-in real Codex conversation gate passed locally using the user's Aerial
0.3.3 GitHub Copilot route with requested model `gpt-5.4-mini`. Both actual CLI
answers were persisted exactly once, the second received and used the first
answer in the production context pack, provider usage was recorded, and no
model-written workspace files remained. The report includes successful temporary
workspace cleanup. The two turns reported input/output/cached token counts of
30,637/356/28,928 and 31,596/512/29,952 respectively. Cost remains unknown (`null`).
The local evidence is `artifacts/live/codex-conversation.json`, excluded from Git.

This gate uses temporary process-level Responses-provider configuration, an
ephemeral CLI session and a read-only sandbox. It does not change the installed
worker or persistent CLI configuration. Server/node transport and authentication
are in-process fixtures, so this establishes real model conversation through
Artoo's dispatcher and process adapter, not public deployment or real Google
OAuth. Aerial's observed catalog had no Anthropic Messages-compatible route;
the existing Claude live gate therefore remains unverified with that proxy.

The refreshed Windows installed-package smoke passed all seven checks at
`2026-09-29T05:54:00.965Z`, including pairing, encrypted credentials, single
instance startup, worker controls, fixture execution/artifact review, restart,
revocation and uninstall. The unsigned installer SHA-256 is
`cea143dabba547f02c445d8174da2e6b4865592e773571aad5f04caac85cd925`.
The installed `app.asar` matches the packaged build, and its renderer matches
the current Web code apart from the expected browser-versus-desktop authentication
build default. The screenshot was inspected and shows the executing agent's
name rather than its instance ID. The worker fixture is separate from the live
Codex conversation gate above. Temporary installation/process cleanup passed.

The separate opt-in real Codex discussion gate also passed on its first live
attempt, starting at `2026-09-29T05:57:26.980Z`. It used the same Aerial/Copilot
route and requested model, two distinct agent instances, and three independent
provider sessions. The reviewer and final synthesis reused a code invented by
the first model response; every context was checked against the actual prior
answers. The production proposal parser accepted the synthesis, and explicit
acceptance created exactly two tasks with the expected criteria and blocking
dependency. There were no goal child tasks before proposal or before acceptance.
No model-written files or live test processes remained after successful cleanup.
Evidence is retained locally in `artifacts/live/codex-discussion.json`.

The three turns reported input/output/cached token counts of
31,311/9,107/28,928; 31,726/9,303/28,928; and 32,115/2,061/28,928. All reported
costs remain `null`. This establishes real multi-agent discussion and proposal
materialization through the production dispatcher/adapter logic, with fixture
authentication and in-process node transport. It does not establish task-writing
execution, deployed WebSockets, physical-device interaction, or that the installed
worker has been configured to use this temporary provider.

The local shared gate passed 1,134 tests with 17 opt-in/platform skips, all 13
browser workflows and all six authentication workflows. Type checking, the
production preview build, native API contracts and whitespace checks passed;
the production dependency audit found zero vulnerabilities. The newly added
real discussion gate was checked separately with its explicit opt-in and with
the normal skip behavior; it was not part of that earlier full-suite discovery.

The documentation-only `08e5dc2` main rerun exposed a historical-notification
E2E race: after the test removed its 503 interceptor, a legitimate reconnect
refresh could load the exact message and remove the Retry button before the
test clicked it. A controlled offline/online reproduction confirmed that the
target message had loaded and become read before the old click timed out.
The test now keeps the lookup failure active until the actual retry click,
also checks reconnect failures retain unread state, and preserves all historical
message, pagination and reload assertions. The complete notification-navigation
spec passed all three scenarios after the change; production code was unchanged.

The [hosted shared gate](https://github.com/Xiejiayun/artoo/actions/runs/36528301572/job/109276087605)
passed for `8a8ba3ed120cdbce007a2d9e0f5df56166148dda`, including all 13 browser
and six authentication scenarios, 1,132 unit/integration tests (19 skips), type
checking, production build, native API
contracts, whitespace and a production audit with zero vulnerabilities. The
subsequent commit adds the separately verified live discussion gate, strengthens
test cleanup and the notification fault timing, and updates evidence; it does
not change the production Web, Windows or iOS code validated by that run.

The native job in that run passed 69 unit XCTest cases, Debug/Release builds,
the chat synchronization UI scenario and the real daemon recovery UI scenario.
The new planning scenario stopped before starting its discussion because the
test assumed the native stepper's decrement button had an English accessibility
label. The failure screenshot shows both adjustment controls. The test now
scopes its query to the identified stepper, locates the two actual buttons by
their left-to-right frames, and checks the displayed value after every tap.
This changes only the test interaction; the one-round/five-minute server
assertions and proposal acceptance checks remain intact. The subsequent runs
below record the remaining product fix and eventual successful verification.

The subsequent [shared rerun](https://github.com/Xiejiayun/artoo/actions/runs/36530506335/job/109282907669)
passed for `70112f320b97a4802439d778475f720f1daa962c`: 1,132 unit/integration
tests passed, 20 opt-in/platform tests were skipped, and all 13 browser and six
authentication workflows passed. This includes the corrected historical-message
retry scenario. Type checking, production build, native contracts, whitespace
and the production audit passed, with zero production vulnerabilities. The
[retained shared artifact](https://github.com/Xiejiayun/artoo/actions/runs/36530506335/artifacts/11017085098)
was downloaded and its SHA-256 verified before inspecting its passing report.

The [native rerun](https://github.com/Xiejiayun/artoo/actions/runs/36530506335/job/109282907546)
again passed 69 unit tests and both chat/daemon UI scenarios. The stepper
interaction passed, but the planning scenario exposed a real synchronization
gap: the server was `ready` at step 3 while the native screenshot and accessible
value still showed `running`, step 2. Discussion updates lacked `project_id`,
so their final event did not reach a planning screen subscribed only to its
project/inbox. Discussion events now carry the owning goal's organization-scoped
project ID. A regression with an actual discussion and project-only subscriber
failed on the old implementation and passed after the fix, including replay of
the same final event; all seven discussion service tests passed.

An independent native refresh race was also corrected: a direct load started
after a command could cause a concurrent realtime refresh to return early and
lose its invalidation. The workspace model now coalesces overlapping requests
and fetches again after the old response, with all callers awaiting completion.
Two native regressions cover a delayed stale discussion response, multiple final
invalidations, request failure and cancellation of the original caller. The
original UI assertions remain unchanged; macOS results for this fix are below.

The installed Windows smoke was refreshed against the rebuilt server at
`eae116666beb76b5ca96ef9bd2ad3f3e39bfc02e` and passed all seven checks at
`2026-09-29T06:53:11.529Z`. The unchanged installer retains the SHA-256 recorded
above (`cea143d…cd925`); the smoke imported the newly built server containing the
discussion event fix. Its screenshot was inspected. The current temporary
installation, processes and listening ports were cleaned up; pre-existing test
directories were preserved. This remains fixture execution and an unsigned
Windows package, separate from the successful live Copilot checks.

## Discussion completion synchronization validation, 2026-09-29

The [shared gate](https://github.com/Xiejiayun/artoo/actions/runs/36533157993/job/109291170573)
passed for `eae116666beb76b5ca96ef9bd2ad3f3e39bfc02e`: 1,132 unit/integration
tests passed and 20 opt-in/platform cases were skipped (178 passing files and
nine skipped files); all 13 browser and six authentication scenarios passed.
Type checking, production preview build, native API contracts and whitespace
checks passed, and the production dependency audit found zero vulnerabilities.
The [retained shared artifact](https://github.com/Xiejiayun/artoo/actions/runs/36533157993/artifacts/11016833986)
was downloaded, its source revision checked and its SHA-256 verified before
inspecting the passing suite report. Installed Windows validation for the same
server revision is recorded immediately above.

The [native gate](https://github.com/Xiejiayun/artoo/actions/runs/36533157993/job/109291170779)
passed for the same `eae1166` source using Xcode 16.4 (16F6), an iPhone 17 Pro
simulator and iOS 26.2. Debug and Release builds succeeded. All 71 unit XCTest
cases passed, including both new refresh-coalescing regressions, and all three
Release UI scenarios passed with zero failures: real daemon disconnect/recovery
(52.008 seconds), discussion/proposal/human acceptance (109.303 seconds), and
pairing/channel/thread/foreground/relaunch synchronization (81.333 seconds).

The discussion UI reached the final three-of-three progress assertion, displayed
named participants and prior answers, and reviewed two proposed tasks with
criteria and a named prerequisite. The pre-acceptance screenshot has an empty
task list and the explicit acceptance button; the subsequent screenshot shows
the accepted plan and exactly two tasks. Production API checks confirm the
three process-backed turns' thread-scoped contexts and the materialized `blocks`
dependency. Daemon evidence records an actual authenticated node disconnect and
reconnect, with matching native Offline/Online screens.

The [native artifact](https://github.com/Xiejiayun/artoo/actions/runs/36533157993/artifacts/11018180444)
retains both XCTest bundles, six native screenshots, stepper accessibility
attachments, message/workflow identities and the passing synchronization report.
It was downloaded and its SHA-256 verified:
`99e55e87b44c8cf01519cbee5688b40fcd4bd08f9dad3ea567d54e072d2f0725`.
All native screenshots were inspected. The report confirms resources closed and
the temporary directory removed. These native discussions use deterministic
subprocess fixtures; the separate real Copilot gates above establish actual
model inference. Neither gate establishes public deployment, installed-worker
provider setup, physical iOS behavior or distribution signing.

## Local provider settings and plan cards, 2026-09-29

Product revision `bd0ee48970c3f74e7858803916a907563b2b7e8b` adds Windows
Settings for an explicit Codex executable, model and Responses-compatible API.
The key is separately encrypted with Electron safeStorage, is never returned
to the renderer, and is supplied to the process through its environment rather
than command arguments. Normal conversations and read-only discussions use
the same selected connection. Saving settings confirms storage, not a successful
inference connection; live execution was checked separately as described below.
Global user Git, Codex and provider configuration was not changed by these tests.

All clients now render a server-validated final synthesis as a readable suggested
plan with task criteria and named dependencies, while preserving the original
reply behind an expandable control. A card never creates a proposal or tasks.
The shared schema and proposal parser reject malformed plans, cycles and
unsupported controls. Historical reads enrich only correctly attributed final
replies using bounded queries and preserve ordinary or invalid messages as raw
text. An actual server/node/browser regression covers initial realtime delivery,
reload, an old reply beyond the newest message page, and the exact-message path.

The [shared gate](https://github.com/Xiejiayun/artoo/actions/runs/36538110967/job/109306805731)
passed for `bd0ee48`: 1,170 unit/integration tests passed and 20 opt-in/platform
cases were skipped (180 passing files and nine skipped files), all 14 browser
workflows and six authentication workflows passed, and the production dependency
audit found zero vulnerabilities. Type checking, preview production build,
native API contracts and whitespace checks also passed. The
[shared artifact](https://github.com/Xiejiayun/artoo/actions/runs/36538110967/artifacts/11019319187)
was downloaded, its source checked and its SHA-256 matched to GitHub's digest:
`e3c4688e8e5d4c595f04b3e737a8b9437801e88c4ee6bb924569e0988a7f7c71`.
Both desktop-width and phone-width plan-card screenshots were inspected.

The unsigned Windows installer built from that source has SHA-256
`51f5b8430a7205a3445979a5888ec598783c66ba1f9c240f7ad26a249f5eaf61`.
Installed fixture checks cover production pairing/enrollment, encrypted provider
settings, explicit CLI selection with an empty PATH, secret isolation/redaction,
worker controls and duplicate-launch prevention, task execution/artifact review,
app/server restart persistence and cleanup. Live checks used Aerial 0.3.3's
GitHub Copilot route, requested model `gpt-5.4-mini`, and an absolute Codex path.
Provider settings were saved in the installed UI and restored after app restart.
Native pairing and actual node WebSocket transport use production paths; the
Web owner's cookie is test-provisioned and the server remains on loopback.

The first live attempt began at `2026-09-29T07:45:03.725Z`. Two real chat turns
passed exactly-once persistence and prior-answer-context checks, then discussion
failed at step 0/3. The overall reports remain failed. Its older helper retained
only a broad stage, so the discussion failure's cause is unknown. Cleanup
completed at `2026-09-29T07:46:37.238Z`; original evidence remains in
`apps/desktop/release/smoke-artifacts/attempt-1/`.

A discussion-only retry began at `2026-09-29T07:52:11.117Z` with the same installer
hash and product code. All three independent provider sessions completed. Two
registered agents received the actual preceding replies; the reviewer and final
synthesis preserved a code invented by the first answer. The installed UI showed
the validated plan and unchanged expandable original response. There were zero
goal tasks or proposals before human action, and zero tasks before acceptance.
UI acceptance created exactly two tasks retaining their criteria and `blocks`
dependency. No model-created workspace files remained. Both reports passed and
all resources, the isolated installation and temporary data were cleaned up by
`2026-09-29T07:55:22.634Z`. The installed plan screenshot was inspected.

These results cover chat and discussion across two separate attempts; they do
not claim one uninterrupted five-turn pass or explain the first failure. The
original second enclosing report has a generic check label mentioning chat;
its companion report's `scope: "discussion"`, three measurements and three
sessions identify its actual coverage. Original reports/logs were preserved.
The test helper now retains discussion failure states and fixed error categories,
omits provider-controlled text, and uses
scope-specific report wording. See [Windows verification](windows-copilot-verification.md)
for exact commands, evidence paths and scope controls. These test-helper and
documentation follow-ups do not change the verified product source or installer.

The five successfully measured live runs report 201,287 input and 23,237 output
tokens. Consumption from the failed discussion is unknown and is not included.
All reported monetary costs remain `null`. Public hosting, DNS/TLS/WebSockets,
real Google OAuth, physical iOS devices, distribution signing and live Claude
execution remain separate acceptance gates.

The [native gate for `bd0ee48`](https://github.com/Xiejiayun/artoo/actions/runs/36538110967/job/109306805725)
built Debug and Release successfully and passed all 77 unit XCTest cases.
Daemon recovery (85.748 seconds) and chat synchronization (79.621 seconds)
passed. The planning UI scenario failed when XCTest evaluated the hittability
of the visible **Show original reply** control. Its accessibility tree exposes
a synthetic outer button and a separate inner chevron button; the outer button
had no valid activation point. Later action logs lack synthesized gestures, so
the unchanged final screen does not establish that an ordinary user tap failed.
The screenshot also shows a visually truncated acceptance criterion despite
its complete accessibility label. This run does not validate original-reply
expansion or the later acceptance steps for the new card.

The [failed native artifact](https://github.com/Xiejiayun/artoo/actions/runs/36538110967/artifacts/11020296000)
was downloaded, its source checked and its SHA-256 matched to GitHub's digest:
`9e0ac4eccb633c3a634e33b725e89cfd963c01b0a597aaaa7bbae4146b0dc200`.
The plan and failure screenshots were inspected; the report confirms resources
closed and temporary data removed. The passing Windows live checks remain
separate from this failed native UI acceptance.

The native follow-up replaces that disclosure with a single, full-width button
with a minimum 44-point height, one accessibility identifier and explicit
Expanded/Collapsed values. Text selection is limited to the summary and original
reply; both have room to wrap vertically. The UI test still requires a hittable
control, exact original response, collapse, zero automatic proposals/tasks and
human acceptance with the original dependency, and now also checks the button's
accessible state. Static API contracts pass locally; only a subsequent macOS
run can establish the fix's build and UI results.

The optional Windows WASM Swift parser did not complete successfully: it emitted
a V8 `Fatal process out of memory: Zone` under both installed Node 24 runtimes.
One attempt printed that all 35 files parsed first, but its failing process exit
is not counted as a passing check. Xcode remains the native build/type-check gate.

## Native plan-card follow-up validation, 2026-09-29

The [shared gate](https://github.com/Xiejiayun/artoo/actions/runs/36541057108/job/109316302144)
passed for native fix `e92e01d485610a7a3330fd8d7fe2fda360ca7df6`: 1,170 tests
passed with 20 opt-in/platform skips (180 passing files and nine skipped files),
all 14 browser and six authentication workflows passed, and the production
dependency audit found zero vulnerabilities. All eight shared checks passed.
The [shared artifact](https://github.com/Xiejiayun/artoo/actions/runs/36541057108/artifacts/11020874032)
was downloaded and its source and GitHub digest verified; SHA-256 is
`229ea34dfc607155a834efd121f31b6009a4578be9031b121cc0a36b6675b0a1`.
Desktop-width and phone-width plan screenshots were inspected. This follow-up
does not change the server, execution runtime or Windows/Web product code used
by the installed live checks above.

The [native follow-up](https://github.com/Xiejiayun/artoo/actions/runs/36541057108/job/109316302290)
again built Debug/Release and passed 77 unit cases, daemon recovery (60.657
seconds) and chat synchronization (79.202 seconds). The plan screenshot confirms
that the long criterion now wraps completely and the 44-point original-reply
control is visible. However, the planning test's typed button query did not find
that control, so it stopped before expanding the reply or accepting the plan.
The final failure accessibility snapshot was captured after scrolling away and
does not establish the missing control's actual accessibility type.

The [native artifact](https://github.com/Xiejiayun/artoo/actions/runs/36541057108/artifacts/11020694854)
was source/digest verified with SHA-256
`f076a93819977d1e9ac06d01073a0b8c0e5e4b97cacb26346e0f7c6e526087c1`.
Cleanup completed. The follow-up retains the full-row button and restored
wrapping, removes the redundant accessibility container around the button,
and hides only the decorative chevron from accessibility. The typed-button
query and all expansion, collapse and acceptance assertions remain required;
the next native run must confirm its accessibility behavior.

## Native button semantics verification, 2026-09-29

The [shared gate](https://github.com/Xiejiayun/artoo/actions/runs/36543392566/job/109323916787)
passed for `ef19a98520cf5c466e6ae44fc8706e5d94dd98c4`: all eight checks passed,
including 1,170 unit/integration tests with 20 opt-in/platform skips (180 passing
files and nine skipped files), 14 browser workflows and six authentication
workflows. The production dependency audit found zero vulnerabilities. The
[shared artifact](https://github.com/Xiejiayun/artoo/actions/runs/36543392566/artifacts/11022193113)
was downloaded and its source and GitHub digest verified; SHA-256 is
`0b40c3dd6c0fe59654655f94c48757925a35ceca47c34368b77cf6edc7fa5a92`.
Both desktop-width and phone-width suggested-plan screenshots were inspected.

The [native gate](https://github.com/Xiejiayun/artoo/actions/runs/36543392566/job/109323917488)
built Debug and Release and passed all 77 unit XCTest cases. Daemon recovery
(136.271 seconds) and the complete planning scenario (147.553 seconds) passed.
The original-reply control is now exposed as a real 314-by-44-point button;
the UI test verified Collapsed, Expanded and Collapsed states, the exact original
response, zero automatic proposals/tasks, human acceptance, and two tasks with
their original criteria and blocking dependency. The plan, expanded-response,
proposal and accepted-task screenshots were inspected; the long criterion wraps
fully without truncation.

The suite still failed because the third, chat-synchronization scenario stopped
while waiting for launch restoration, before pairing or sending messages. The
wait helper checked the onboarding field's existence and enabled state in two
separate accessibility queries. Between those queries, Keychain restoration
replaced onboarding with the authenticated Today/Inbox screen. The failure
hierarchy confirms the authenticated tabs and no onboarding field. The follow-up
changes only the test's readiness query to match an enabled field in one query;
it retains the authenticated-state alternative and all chat workflow assertions.

The [native artifact](https://github.com/Xiejiayun/artoo/actions/runs/36543392566/artifacts/11022485963)
was downloaded and its source and GitHub digest verified; SHA-256 is
`65c8ec5e1a3cb9d070f477384dddda3b7b9d4ca8ef614635b6fe7f088dfc3610`.
The failed suite's report confirms resources closed and temporary data removed.
This run validates the native plan-card fix, but does not count as a passing
three-scenario native gate.

## Readiness-query follow-up, 2026-09-29

The [shared run for `f3358c4`](https://github.com/Xiejiayun/artoo/actions/runs/36546082531/job/109332698909)
passed type checking and the production preview build, but stopped in the test
gate with 1,169 passing cases, one failure and 20 skips (179 passing files, one
failing file and nine skipped files). Browser workflows, authentication workflows,
native contracts, the dependency audit and whitespace gate did not run afterward.
The [shared artifact](https://github.com/Xiejiayun/artoo/actions/runs/36546082531/artifacts/11023675845)
was downloaded and its source and GitHub digest verified; SHA-256 is
`d2d8a92008de9d34979ed955f3396fe18fa8adec86fb08bb688fcf1e915a1643`.

The sole failure was the channel-creation component test asserting against a
detached heading returned by an earlier asynchronous query. After creation,
channel-list invalidation can display the first channel before navigation to
its explicit URL; that navigation waits for authoritative room/project metadata
and remounts the conversation. The follow-up keeps the creation arguments and
conversation assertions, but queries the current heading and enabled composer
together inside the wait callback after the room lookup starts. It changes only
the test, with no product or native-test changes from `f3358c4`.

## Completed plan-card milestone, 2026-09-29

The [native job](https://github.com/Xiejiayun/artoo/actions/runs/36546082531/job/109332698586)
passed for `f3358c4ff38d1c555bd19233073aa16dea7d2218`: Debug and Release builds,
all 77 unit XCTest cases and all three Release UI scenarios passed. The scenarios
cover daemon stop/recovery (46.532 seconds), discussion and plan review/acceptance
(123.325 seconds), and channel/thread synchronization (73.330 seconds). All four
native gate checks passed using Xcode 16.4 (16F6), SDK 18.5 and an iPhone 17 Pro
simulator running iOS 26.2. The enclosing workflow failed because of the separate
shared-test failure recorded above; only the native job is successful in that run.

The native test verifies Collapsed → Expanded → Collapsed with real button taps,
the exact unchanged original response, zero automatic proposals or tasks, and
zero tasks after proposal. Human acceptance creates exactly two tasks with the
original criteria and the intended `blocks` dependency. Seven native screenshots
and the browser synchronization screenshot were inspected. The report confirms
resources closed and temporary data removed. Native discussions use deterministic
CLI subprocesses over the production authenticated server and node WebSocket;
they do not validate live provider inference.

The [native artifact](https://github.com/Xiejiayun/artoo/actions/runs/36546082531/artifacts/11024150088)
was downloaded and its source and GitHub digest verified; SHA-256 is
`aca03af0894d79b9227d2767e220093a6768cc11713be8de926cc51cd4a4d18f`.
The local audit is retained in
`%TEMP%/artoo-native-ci-36546082531/xctest-summary.json`, and the reviewed visual
summary is `artifacts/ios/native-milestone-proof.png` in the verification checkout.

After the Web test fix, the complete `npm run verify:preview` gate passed from
clean source `bf2813fe8b091676775646c52108685a5ac005e1` on Windows with Node
24.14.0 and npm 11.9.0, starting at `2026-09-29T09:17:31.546Z`. All eight checks
passed: type checking, production build, 1,172 unit/integration cases with 18 skips
(181 passing files and eight skipped files), native static API contracts,
14 browser workflows, six authentication workflows, production dependency audit
with zero vulnerabilities, and whitespace checks. Both Playwright run records
report success with no failed tests. Desktop-width and phone-width plan screenshots
were inspected; criteria and dependency names remain readable at both widths.

The two extra passing cases compared with the earlier successful hosted shared
gate are conditional Windows bundled-worker tests in
`apps/server/src/desktop-worker.test.ts`: IPC shutdown waits for CLI/descendant
exit, and the independent guardian terminates a crashed daemon's CLI process
tree. Both environments are Windows, but the local ignored
`apps/desktop/daemon/artood.mjs` bundle already existed before this run; the hosted
runner skipped these two cases because that bundle was absent. The skip condition,
fresh local file-level result and totals were cross-checked. This does not claim
that this gate rebuilt the desktop package or performed live model calls.

Local evidence is preserved under `artifacts/preview-gate` in the verification
checkout. SHA-256 digests:

| File | SHA-256 |
| --- | --- |
| `shared-local-bf2813f.json` | `d607f45214b9285ac33c3885b874009be0b48ecae0badeb415e83ef71188a08f` |
| `shared-local-bf2813f.log` | `96609095c9820174d9a6250c0522b06a3def1f475b24b28ea1c7fa3ae0079eef` |
| `shared-local-bf2813f-source.json` | `b075bce72da3405b992f738987b2d0deca7b4d53bf5de77bf13626ae1b0279c6` |

This milestone combines separately scoped evidence: native product code, tests
and workflow are unchanged between `f3358c4` and `bf2813f`; server, Web and Windows
runtime product code is unchanged since the installed Windows build at `bd0ee48`.
The final follow-up records these results in documentation only. Windows live
chat and discussion passed in the two separate attempts described above. Physical
iOS devices, signing/TestFlight, Windows signing/update delivery, real Google
OAuth and an actual shared host with public DNS/TLS remain release checks.
