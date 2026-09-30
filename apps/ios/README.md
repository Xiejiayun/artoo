# Artoo iOS trusted-team preview

The SwiftUI client opens into real-server onboarding. Each team member signs in to
the Web app with their own account, creates a pairing code for **iOS**, and enters that code together
with the server origin on the phone. The app stores only the control credential
in a device-bound Keychain item. It never stores the compute node token.

Pairing transfers the code creator's account permissions. Keep codes private;
never give an administrator's code to another team member. Members can pair
their own control clients; an owner/admin separately authorizes Mac/Windows
execution computers from the Devices screen.

Use HTTPS for the shared server. Local development can explicitly permit
`http://localhost` or a `.local` hostname; `localhost` on a physical phone points
to that phone. No manual token input, source edits, or mock fallback is needed.
Signing out immediately closes realtime, invalidates the old API client and
clears the local Keychain entry, then attempts server revocation. If offline,
the app reports that revocation was not confirmed; an owner can revoke the device
from Web. An expired or revoked credential returns to pairing.

## Implemented surfaces

| Surface | Behavior |
| --- | --- |
| Inbox | Pending approvals; approve, reject, request information; errors retain the decision screen |
| Tasks | Project-scoped list, search/filter, create with criteria/capabilities, ready, assign with agent picker, retry, review feedback |
| Task execution | Ready-task execution approval requests with risk/summary, single-use approval before assignment and fresh review for retries; live run status, cancellation, artifact download/Quick Look/share |
| Team discussion | Paginated task/goal room history, incremental new messages, persistent drafts, decisions, agent handoffs and blockers |
| Agent conversation | Explicit Send to agent, agent-instance selection, durable request status, waiting/errors, cancel/retry and execution-task navigation |
| Channels and threads | Project channels, create channel, isolated reply threads, real-member mention picker and personal mention notifications with exact message/thread destinations |
| Agent planning | 2–6 distinct agent instances and roles, bounded rounds/time, goal-room or channel discussion, progress/stop, thread history, plan proposal and separate human acceptance |
| Dependencies | Select a prerequisite task, add/remove blocking dependencies |
| Goals | Create, propose plans with task criteria/capabilities/dependencies, accept/reject, pause/resume/cancel, checkpoint reconciliation, child tasks, audit export |
| Team | Computer connection/presence, advertised runtimes, configured agent instances, admin create/enable/disable |
| Daemon status | Server-confirmed online/reconnecting/offline/stale/disabled, heartbeat/active runs/runtimes; network failures display Unknown |
| Memory | Propose project memory, accept/reject, propose replacement, inspect current state |
| Skills | Installed capabilities/permissions/manifests, administrator manifest installation |
| Devices | Device inventory, one-time pairing codes, owned/admin device revocation |
| Workspace | Project selection, administrator project creation, session identity, server connection and logout |

Visible screens use an authenticated WebSocket at `/api/v1/ws`, subscribing to
project/inbox and open-room topics. Event cursors are retained across connection
loss and foreground transitions. Replay and live frames may interleave: event-id
deduplication and REST reconciliation avoid discarding older replay frames after
a newer live frame. Notifications coalesce over 250 ms. Foreground fallback
refresh is bounded to once per 60 seconds while connected or 15 seconds while
disconnected; reconnect/foreground immediately reconcile. Backgrounding closes
the socket; this is foreground synchronization, not background push notification.
Session identity is revalidated every thirty seconds; every API request
independently receives server authorization. Requests
use bearer headers, same-origin paths, an ephemeral cookie-free URLSession and
no redirects. Failed commands surface the server error and do not report success.

Room messages load the latest 50 first and use opaque `before`/`after` cursors;
merge/deduplication uses message id and monotonic sequence. A catch-up handles at
most five pages per refresh and exposes a Load new messages action if more remain.
Draft text and a pending logical send are stored on the phone under a canonical
server-origin/user/room/thread namespace. A failed or interrupted send preserves its
body and Idempotency-Key across view/app relaunch. An agent request also retains
the same `client_request_id`. Retrying is explicit; reconnecting or signing in
never replays a command automatically. Switching identity destroys the old view
state and invalidates its requests/socket. These are local drafts, not drafts
synchronized to other devices, and contain no access credentials.

Team discussion sends only a room message. Send to agent creates an execution
request using the server's existing task/run workflow and requires an available
paired execution computer. Approval gates still apply. Final agent replies are
ordinary room messages; queued/running/waiting/failed/cancelled states remain
visible with their execution task and recovery controls. Opening a run fetches
provider input/output/cached tokens and cost; missing measurements or transport
failures are shown as unavailable, never as an invented zero.

The Channels tab opens project discussions; replies have their own history and
draft. The mention picker uses actual server members, writes structured user
references, and creates personal notifications accessible from Inbox or More.
Opening a notification resolves the exact message/root directly, even outside
the latest history page. Sending to an agent inside a thread preserves its
thread scope. Mention metadata alone does not run an agent.

Mentions load in cursor pages of 50 with a Load earlier mentions action.
The global badge uses the server's total unread count, including unloaded
history. Refresh reconciles read state across the loaded pages so a read on
another client is reflected here. A failed count refresh displays an unknown
indicator and labels any retained count as last known. Opening a mention selects
its project and marks it read only after its exact message and thread load.

Daemon rows on Team and computer detail calibrate every five seconds. A failed
request or more than twelve seconds without a confirmed snapshot displays
Unknown, retaining clearly labeled last-known activity. Network failure is not
reported as proof that a computer is offline.

Under More → Goals, open a goal and choose Discuss and break down with agents.
The server owns the bounded multi-agent discussion; the phone displays its
actual progress and thread. A validated final reply appears as a suggested-plan
card with task criteria and named dependencies. Show original reply expands the
unchanged response; viewing either representation creates no proposals or tasks.
A ready discussion can create a plan proposal;
human plan acceptance is a separate action and uses the existing goal controls.
Planning threads accept human team replies; their agent turns and stop action
are managed from the goal so direct agent requests cannot bypass round/time limits.
The execution computer's Codex read-only filesystem sandbox does not disable
inherited MCP tools. Discussion mode therefore still requires a trusted runtime
configuration; filesystem read-only is not proof that all external side effects
are disabled.

`MockApiClient` remains an explicitly injected preview/unit-test fixture; the
production default never switches to mock data after an error.

## Windows verification

From the repository root, after building the domain package:

```powershell
node apps/ios/scripts/verify-contracts.mjs
```

This checks twenty-two representative native request bodies against the actual
server schemas plus execution-approval, assignment, assistant-turn, discussion and message-page
response fixtures, verifies fifty-one required endpoint declarations, and checks
realtime/draft boundaries, live-onboarding/Keychain policy and app icon dimensions. It does not execute
Swift or replace native integration tests.

Optional Swift syntax parsing without modifying repository dependencies:

```powershell
$parserDir = Join-Path $env:TEMP 'artoo-swift-parser'
npm install --prefix $parserDir --no-save --package-lock=false --ignore-scripts web-tree-sitter@0.20.8 tree-sitter-wasms@0.1.13
npx --yes --package=node@22 node apps/ios/scripts/check-swift-syntax.cjs $parserDir
```

The command selects Node 22 for this legacy parser runtime. Local attempts under
Node 24 failed with V8 `Fatal process out of memory: Zone`; the cause was not
established and those attempts do not count as passing validation. Syntax parsing
is not Swift type checking; the Xcode gate is authoritative.

## Mac verification gate

The repository-level `npm run verify:ios` automates XcodeGen, simulator selection,
build and XCTest and retains `.xcresult` bundles. It also runs the Release app
through XCUITest against an isolated real server and an authenticated Chromium
client: pairing, channel/thread sending, receiving a reply from the Web composer,
foreground catch-up and Keychain/history restoration after app relaunch. Separate
scenarios stop/restart an authenticated daemon and drive a two-agent discussion
through proposal review and acceptance. The latter verifies named participants,
three process-backed answers, visible dependency names and criteria, no child
tasks before acceptance, and exactly two dependent tasks afterward. The agent
responses are deterministic subprocess fixtures, not live model inference. Install
the Playwright Chromium browser from `apps/web` before running the gate. See
[`docs/shared-server.md`](../../docs/shared-server.md) for CI and prerequisites.

The 2026-09-29 [macOS CI run](https://github.com/Xiejiayun/artoo/actions/runs/36522676613/job/109258786544)
verified commit `6be6e6ca535fcd99084431a906bf09b6c03b2528` using Xcode 16.4
(16F6) and an iPhone 17 Pro simulator running iOS 26.2. Debug and Release builds
succeeded; all 55 unit XCTest cases passed with zero failures, including real
Keychain storage, session revocation and notification history/read-state
reconciliation. The Release XCUITest also passed: real pairing, native channel
and thread sends, a reply from the Chromium composer, background/foreground
catch-up, and Keychain/history restoration after relaunch. The shared database
checks confirmed each logical message was persisted once in its correct thread.
The native and browser screenshots were inspected. The run retains
[XCTest bundles, screenshots and synchronization records](https://github.com/Xiejiayun/artoo/actions/runs/36522676613/artifacts/11013509974)
under the workflow's artifact retention policy. This flow verifies UI
synchronization while the authenticated socket is connected; concurrent REST
refreshes mean it does not isolate WebSocket delivery. Other native UI flows,
physical-device behavior and the public phone/server deployment remain separate
acceptance checks.

The subsequent [conversation recovery gate](https://github.com/Xiejiayun/artoo/actions/runs/36525442804/job/109267348499)
verified `9715f0de189173539e5756d2d43a9581c26e6a65` on the same Xcode/simulator
versions: 67 unit XCTest cases and the Release channel/thread XCUITest passed,
with Debug and Release builds succeeding. The 12 added unit cases cover member
and agent metadata, structured mentions, database timestamp normalization and
mention lookup/read-retry identity and lifecycle boundaries. Both synchronization
screenshots were inspected; broader native workflow coverage remains separate.

An earlier fully passing [native workflow gate](https://github.com/Xiejiayun/artoo/actions/runs/36533157993/job/109291170779)
verified `eae116666beb76b5ca96ef9bd2ad3f3e39bfc02e` with the same Xcode and
simulator versions: Debug/Release builds, all 71 unit XCTest cases and all three
Release UI scenarios passed with zero failures. The additional UI scenarios
stop/reconnect a real authenticated daemon, then complete a two-agent discussion,
review its criteria and named dependency, and explicitly accept the plan before
two tasks are created. The discussion completion regression verifies the final
three-of-three progress, while two new unit cases cover concurrent refreshes
arriving during an older load, including failure/caller cancellation.

The [retained result bundles and UI evidence](https://github.com/Xiejiayun/artoo/actions/runs/36533157993/artifacts/11018180444)
were downloaded and their archive digest verified. All six native screenshots
were inspected, including Offline/Online daemon states and the proposed/accepted
task lists; the synchronization report confirms cleanup. Native agent responses
are deterministic subprocess fixtures. Separate real Aerial/Copilot conversation
and discussion evidence, with its authentication/transport limits, is recorded
in [the collaboration record](../../docs/cross-client-sync.md), including newer
native plan-card results and the installed Windows provider settings and live
inference checks. Physical devices, other native UI workflows, deployed Google
OAuth/TLS/WebSockets and signing remain separate acceptance checks.

The latest [native workflow job](https://github.com/Xiejiayun/artoo/actions/runs/36546082531/job/109332698586)
passed at `f3358c4ff38d1c555bd19233073aa16dea7d2218` with Xcode 16.4 (16F6), SDK
18.5 and an iPhone 17 Pro simulator running iOS 26.2. Debug/Release builds, all
77 unit XCTest cases and all three Release UI scenarios passed. The plan-card
scenario checks the exact original response through expansion/collapse, no
automatic proposals/tasks, and explicit acceptance creating two tasks with the
original criteria and blocking dependency. Seven native screenshots and the
browser synchronization screenshot were inspected, and cleanup flags passed.
The [native artifact](https://github.com/Xiejiayun/artoo/actions/runs/36546082531/artifacts/11024150088)
has verified SHA-256
`aca03af0894d79b9227d2767e220093a6768cc11713be8de926cc51cd4a4d18f`.
The enclosing workflow failed in its separate shared job on a Web component-test
race; the test fix at `bf2813f` then passed the complete local shared gate. Native
product code, tests and workflow are unchanged between these revisions. This
native gate uses deterministic subprocess responses, not live model inference.
Detailed failure history, evidence scope and current release gaps remain in
[the collaboration record](../../docs/cross-client-sync.md).

```bash
brew install xcodegen
cd apps/ios
xcodegen generate
xcodebuild -project Artoo.xcodeproj -scheme Artoo \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- build-for-testing
xcodebuild -project Artoo.xcodeproj -scheme Artoo \
  -destination 'platform=iOS Simulator,name=iPhone 16' CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- test
```

Choose an installed simulator listed by `xcrun simctl list devices available`.
The project targets iOS 17 and Swift 5.9; use Xcode 15 or newer. No generated
`.xcodeproj` is committed; `project.yml` owns its configuration and resources.
Simulator tests use ad-hoc signing and simulator-only application/Keychain
entitlements. This requires no Apple account or signing certificate and lets
the Keychain round-trip exercise the real API; an entirely unsigned simulator
app returns `errSecMissingEntitlement`. Device provisioning is separate.

The native tests cover DTOs, unknown statuses, task lifecycle view models,
production onboarding, server-origin rejection, session roles, Keychain
round-trips, bearer requests, one-time pairing, 204 logout, 401 expiration,
cross-origin request rejection, preserved errors, the run/scheduler assignment response,
single-use execution approval and superseded history, retry-to-ready behavior and goal dependency encoding.
Additional URLProtocol and socket-seam tests cover opaque message cursors,
sequence ordering/deduplication, persisted unknown-delivery retries, identity
isolation, stable agent request ids, authenticated WebSocket requests,
replay/live ordering, reconnect cursors, background close and revocation,
thread draft/mention boundaries, reply-count ordering, daemon Unknown handling
and agent-planning participant/round/time validation.
The macOS CI evidence above covers these XCTest cases. Windows source checks
alone do not establish that they passed.

On a simulator and a physical phone, verify this complete live flow:

1. Pair from an authenticated Web owner's one-time iOS code; relaunch and restore.
2. Select/create a project, inspect an online execution computer and its agents.
3. Create a task, set it ready, request execution approval, verify assignment is
   blocked, approve through Inbox, then assign. Observe run progress, send a room
   message, download an uploaded artifact and accept/request changes. Also check
   rejected/needs-information requests stay blocked and can be resubmitted.
4. Cancel a running task and confirm its process stops on the Windows computer.
5. Create a goal, propose/accept a dependent plan, open child tasks, pause/resume
   and inspect checkpoint/audit data.
6. Exercise memory/skill/device and collaboration controls with authorized and
   unauthorized users. Unauthorized operations must remain rejected server-side.
7. Lose connectivity and regain it; background/foreground; revoke the phone's
   device from Web; expire a token; verify re-pairing and successful server logout.
8. Check narrow layouts, landscape, Dynamic Type, VoiceOver and artifact sharing.
9. With Web and iOS open on the same task/goal room, send from both, load earlier
   history, then interrupt network after a send. Relaunch, retry and verify a
   single message. Verify the same local draft returns only for its original
   server/user/room, with no automatic replay after logout or pairing.
10. Send to agent, verify waiting/approval/run/cancel/retry/final reply states,
    background/foreground and server restart catch-up. Confirm the Team option
    creates no agent execution and the agent picker sends an instance id.
11. Create a project channel, reply in a thread, mention another real member and
    open their notification on another client. Confirm exact deep-history
    destinations, root reply counts, separate drafts and scoped agent replies.
12. Inspect Team and computer detail, interrupt connectivity, and confirm Unknown
    appears instead of a false offline claim. Reconnect and confirm five-second
    daemon calibration, heartbeat age, run count and runtime availability.
13. On a goal, start a bounded discussion with distinct agent instances/roles,
    inspect the actual discussion thread, stop a run, then create a proposal from
    a completed discussion and explicitly review/accept it before execution.

Signing, provisioning and TestFlight distribution require the team's Apple
developer settings on the Mac. This repository contains no signing secrets.
