# Cross-project historical mentions and read recovery

Base: `81c27deb17cb255085178efcbbd89661d515c57c`. Its exact hosted run
`36795780467` remains independently monitored; do not cancel it with another
push. The previous goal turn made concrete progress by shipping the verified
direct-agent milestone. Commercial acceptance remains the full objective.

That hosted run subsequently ended: Mac/shared passed; unit110/core7 passed,
but the assistant second-request visibility assertion failed. The exact-message
ID locator and guarded diagnostic capture are strengthened in this phase;
the original failure and its missing failure-time image remain documented.

## Product gaps and scope

Native pairing caches the available projects. A later project's notification
can open its room while global project selection remains on the old project.
The isolated native fix refreshes authorized bootstrap before exposing the
destination, preserves errors for explicit retry, and rejects stale session
or navigation responses. It has 19 focused tests but no real UI evidence yet.
Web/Mac can similarly reject a new project absent from its bootstrap cache;
resolve that destination with authorized bootstrap and retain safe retry.

This phase must prove the actual native and installed-Mac flows. It does not
substitute fixture API writes for the recipient's navigation, drafts or read
retry. The independent sender submits both target mentions through Web UI.
Project/channel/root creation, a sentinel and ordinary history are fixture
setup through production APIs. Notification-list pagination beyond 100 rows
remains a separate UI path; this phase exercises a target outside the thread's
latest 50 messages.

## Shared scenario contract

1. Start a persistent, production-authenticated disposable server. Provision a
   recipient and a distinct sender. Create project A's channel/root before the
   native client pairs. The installed Mac remains its already-paired recipient.
2. Through recipient UI, open A's thread and type draft A. Only after this
   readiness point may the shared fixture create project B, its same-named
   channel and root. B must not exist during the recipient's initial bootstrap.
3. Through the independent sender's browser, post two distinct replies in B's
   thread, each with a structured mention of the recipient. The first body is
   longer than its notification preview. Append 55 ordinary replies through
   production APIs. Add one unread sentinel mention in A via fixture setup.
4. Verify the latest B-thread page has exactly 50 replies, `has_more: true`,
   and neither target. Retain exact identities, bodies/hashes and all filler
   IDs. Preserve the original notification baseline; unread rises by three.
5. Recipient UI opens the first target from Mentions. Require the exact project,
   room, root, full historical reply and sender. Fail only this device's first
   POST to that notification's read route with HTTP 503 before its handler.
   Other HTTP requests and WebSocket upgrades remain production behavior.
6. In the same mounted destination, type draft B. Before explicit Retry, keep
   one injected attempt, no successful read and all three new notices unread
   for at least 3.1 seconds. Do not leave/reopen the page to earn an automatic
   retry. Capture the full target and the distant draft/error separately.
7. Click the real Retry action. Require a forwarded production 200 for the
   same notification, unread baseline+2 and draft B unchanged. Then open the
   second notification via UI; require its exact reply, baseline+1 and an
   unchanged unread A sentinel. Reopen the first without losing draft B.
8. Check selected project B after read recovery (native More navigation must
   not happen between the failed request and explicit Retry). Return to A
   through the project picker and verify draft A. Relaunch native/reload the
   installed renderer and reopen B from Mentions, verifying persisted draft B.
   Neither draft may exist as a server message. Subsequent idempotent reads
   are allowed; the injected 503 occurs exactly once and read timestamps/counts
   must remain consistent.

## Shared fixture interfaces and ownership

Root owns `scripts/fixtures/mentions-scenario.mjs`,
`mentions-read-fault.mjs`, `mentions-results.mjs` and focused tests, plus native
suite registration, exact-case/evidence aggregation, PNG whitelist, gates and
documentation. No production fault route or environment backdoor is added.

`createMentionsScenario({ root, server, origin, browser, ownerHeaders,
recipientUserId, platform, deviceName, suffix, onScreenshot })` returns:

- `fields`: flat string values for `project_a_id`, `project_a_name`,
  `channel_a_id`, `channel_a_name`, `root_a_id`, `root_a_body`,
  `recipient_user_id`, `recipient_name`, `sender_user_id`, `sender_name`,
  `native_device_name`, `draft_a`, `draft_b`, `first_mention_body`,
  `second_mention_body`. Parent adds server URL and its private read-only peer
  credential; credentials are never evidence.
- `publish({ deviceId? })`: one-shot awaited setup after recipient readiness.
  A supplied public device ID is validated against real device records;
  native can omit it and select the unique expected name/platform/recipient.
  Returns a JSON publication with nested `project_b`, `channel_b`, `root_b`,
  `first`, `second`, `sentinel`, `baseline_unread_count`,
  `published_unread_count`, `history` and `recipient_device_id`. Each target
  includes its real `message_id`, `notification_id` and exact `body`.
- `observe()`: read-only current notifications/unread count, baseline records,
  exact request observations and publication. `verify()` independently reads
  final records and returns strict counters/identity/hash/draft checks.
- `close()`: closes only its independent sender context and restores its
  request wrapper. It does not own the enclosing server/browser/app.

The native adapter provides authenticated loopback `POST /publish` and
`GET /observations`, serializes publication, and never marks notifications
read. The Mac helper calls the same in-process methods. The request wrapper
authenticates the incoming credential through the real `/auth/session` before
matching the exact recipient/device. It retains only credential-free IDs,
method/path/status and injected/forwarded outcomes. It must reject concurrent
ownership, restore its original HTTP handler, and leave upgrades unchanged.

Native owner: the isolated product patch (root applies once), the independent
`MentionsUITests/testCrossProjectHistoricalMentionReadRetryAndDraftIsolation`,
its parent/control adapter and necessary UI accessibility IDs. Mac owner:
ChannelsPage safe project recovery and focused tests, installed mention UI
helper and parent integration. CI evidence owner writes only the prior run's
ignored artifact directory. No owner starts builds/E2E or commits independently.

## Verification and delivery

Review the native patch, implement the bounded fixes and shared interfaces,
run meaningful focused tests, then freeze all source/docs/Git state. Run the
native mention subset and fresh installed-Mac workflow; retain failed HTML
attempts and inspect the actual captures before declaring visual coverage.
Run full native unit/core/assistant/mentions aggregation and a matching signed
development archive. Restore only generated UI-test configuration after Xcode
finishes. Update coverage/readiness and commit/push the verified milestone,
then follow its exact hosted run. Real-provider, physical-device, public
distribution, deployed identity and operator-policy gates remain open.

The hosted iOS job now permits 60 minutes for the three independent suites:
the preceding two-suite run already took about 33 minutes. No cases, source
checks or per-invocation process timeouts are removed to fit the new scope.

## Local completion evidence

- [x] Recover the native authorized project and reject stale session/navigation
  and same-session bootstrap publications; 30 focused Swift regressions pass.
- [x] Recover Web project access and refresh members on verified room entry;
  28 focused React tests and Web typechecking pass.
- [x] Run the independent real sender self-check and preserve failed attempts.
- [x] Pass the exact native mention subset with nine native and two peer images.
- [x] Pass a fresh installed-Mac full gate: 15 client checks and 26 captures.
- [x] Pass the complete native gate: 133 unit tests and exact core 7 + assistant
  1 + mentions 1 UI cases, with 42 inspected images and complete cleanup.
- [x] Produce and verify a matching signed arm64 development archive; 35 product
  source/resource files byte-match its isolated snapshot.
- [ ] Verify hosted CI for the resulting main commit. Local evidence does not
  retroactively change the failed prior hosted assistant run.

Exact reports, hashes, source comparisons and known limits are recorded in
`docs/apple-client-milestones.md` under the verified historical-mentions entry.
