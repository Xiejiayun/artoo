# Artoo v3 iOS And Mac Client Plan

Status: #117 planning input for the v3 scope freeze.

This plan maps the v3 product hierarchy in `docs/v3-product-plan.md` onto the
Apple clients. It is intentionally a client-experience and verification plan,
not an implementation patch. Broad client implementation should wait until
#112/#116 reconcile #111, #113, #114, #115, #117, #120, and #121.

## Current Baseline

The v3 product hierarchy is:

`Goal -> Plan -> Task -> Run -> Artifact -> Audit`

The current iOS app is a native SwiftUI task/run/approval control surface. It
uses `TabView` and `NavigationStack`, defaults to mock data, and has live REST
seams for bootstrap, tasks, task snapshots, approvals, and room messages. It
does not yet have Goal, Plan, Presence, Decision, Handoff, Blocker, Checkpoint,
or Goal Audit Bundle models.

The current Mac app is the Electron desktop shell over the shared web renderer.
It has a configurable server URL and an `artood` child-process supervision seam.
The Mac V2 evidence proves an unsigned packaged directory smoke path, renderer
asset loading from the package, darwin bridge exposure, and server read/write
against a temp server. It does not prove signing, notarization, update trust, or
external-production daemon safety.

## Considered Client Strategies

Recommended: keep iOS as a native urgent-control surface and make Mac the full
Apple desktop workbench. This matches the v3 non-goal that mobile is not a local
runtime host, avoids cramming the desktop workbench into a phone, and lets the
Mac package own daemon pairing, health, and local evidence.

Rejected: make iOS a full workbench clone. This would bury approvals, blockers,
presence, and checkpoints under cramped navigation, and it would make mobile
feel like a reduced desktop instead of a fast intervention tool.

Rejected: keep iOS task-first and add only small badges for goals/presence. This
would preserve V2 screens but fail the v3 hierarchy. Users must be able to enter
through goal progress, risk, and ownership, not a flat task inbox.

## iOS Information Architecture

iOS should become a mobile command center. The first screen should answer:
what needs me, what is blocked, what changed, and what is safe to do next.

Recommended root tabs:

| tab | purpose | replaces/current basis |
| --- | --- | --- |
| Needs Attention | approvals, blockers, stale/offline agents, budget/policy prompts, expired decisions | current Today/Inbox |
| Goals | running, awaiting approval, blocked, paused, completed, and archived goals | current Tasks becomes goal-context drill-down |
| Team | agent/computer/device presence, current assignments, health reasons, stale/revoked state | current Settings/Devices placeholder expands |
| Activity | recent runs, artifacts, checkpoints, audit milestones, filtered by goal | current Runs |
| Settings | account, server, device trust, notification preferences, diagnostics | current Settings/Devices split |

On compact iPhone, Needs Attention should stay the default launch tab. On iPad,
use the same information model but allow split-view style list/detail layouts
where SwiftUI can do so without custom desktop chrome.

## iOS Object Surfaces

### Goal

Goal rows should show title, status, plan version, progress summary, owner,
primary blocker or next action, last checkpoint age, and whether the goal is
safe to resume. Goal detail should show acceptance criteria, stop conditions,
budget state, current plan revision, active blockers, pending approvals,
current team assignment, recent decisions, latest checkpoint, artifacts, and
audit export status.

Primary mobile actions:

- approve or reject plan changes, budget increases, policy exceptions, and
  artifact acceptance;
- pause, resume, or cancel a goal when the server says the action is safe;
- ask for clarification with a structured note tied to the goal, plan, task, or
  approval;
- inspect linked artifacts and checkpoint summaries;
- hand off a decision or request more information without editing raw task
  state.

Goal status must remain server-derived. The iOS client should not compute a
goal's terminal or blocked state from local task lists.

### Plan

Plan views should be summary-first. iOS does not need a full graph editor in
v3, but it must show the accepted plan version, proposed revisions, dependency
impact, approval gates, expected artifacts, and why a revision is being
proposed. A plan approval sheet should make the diff, rationale, risk, budget
impact, and rollback/checkpoint context visible before action buttons.

### Presence And Team

Presence should render as a structured health row, not only a colored dot:

| field | iOS display requirement |
| --- | --- |
| connection | online, stale, offline, revoked, with age/source |
| work | idle, queued, running, awaiting input, awaiting approval, blocked, paused |
| runtime | available, busy, disabled, stale, missing |
| health reason | human-readable reason such as heartbeat timeout, runtime missing, lease conflict, approval required, daemon restarting |
| assignment | current goal/run/task and whether the agent can accept work |

Team detail should explain who is waiting on whom. Revoked, stale, and missing
runtime states need clear recovery ownership and must not appear selectable for
new work.

### Team Room, Decisions, Handoffs, And Blockers

iOS should not expose agent collaboration as an unbounded chat stream first. The
mobile view should elevate structured events:

- decisions with proposed/accepted/rejected/superseded status, rationale,
  alternatives, and evidence links;
- handoffs with sender, recipient, expected action, blocking condition, status,
  and next action;
- blockers with owner, type, affected object, mitigation, next action, and safe
  resume status;
- team-room activity grouped by proposal, decision, blocker, handoff,
  review request, approval request, artifact, and audit checkpoint.

Free-text messages can remain available in detail, but the summary surface must
answer "who waits on whom" without requiring thread reading.

### Checkpoints And Recovery

Checkpoints should be visible anywhere the user can resume, pause, approve, or
reject. iOS should show checkpoint summary, created-at age, linked plan/run/
artifact, resume safety, and what changed since the last accepted checkpoint.
If a daemon or server reconnect changed state while the user was away, iOS
should show the change summary before exposing destructive actions.

### Artifacts And Audit

iOS artifact review should prioritize inspection and decision, not authoring.
Artifact detail should show type, producer, linked goal/task/run, review status,
risk, checksum or integrity state where available, and evidence links. Goal
audit bundle views should show completeness, redaction status, export status,
and replay availability; large export/replay workflows can deep-link or defer to
desktop.

## Mac Client Experience

Mac should use the shared Electron/web renderer as the primary Apple desktop
workbench. The Mac package must support the same v3 desktop information
architecture as Web/Windows while adding local-computer clarity.

Mac-specific requirements:

- show server connectivity, user/session state, control WebSocket state, node
  WebSocket state, and local `artood` heartbeat separately;
- surface the local computer identity, device trust state, runtime capability
  freshness, workspace root, and current run assignment;
- provide packaged controls for start, stop, restart, reconnect, and diagnostics
  only when #118 defines the safe command policy;
- distinguish "server cannot see the daemon" from "daemon is running but runtime
  is missing" and from "device was revoked";
- keep all goal/plan/decision/handoff/blocker/checkpoint state server-backed;
- expose logs, artifacts, audit bundles, and local diagnostics without leaking
  secrets in UI or uploads.

The Mac workbench should be the place for full plan/DAG inspection, goal-level
audit replay/export, broad artifact comparison, daemon diagnostics, and
multi-agent team supervision. iOS should deep-link into these objects but should
not try to replace the full workbench.

## Required Server And API Dependencies

#117 depends on these v3 contracts before implementation can be complete:

- #113: UI-ready presence read model for agents, computers, devices, runtimes,
  connection/work/runtime/health reason, freshness windows, scheduler
  eligibility, and secret-safe transition events.
- #114: event taxonomy plus first-class Decision, Handoff, and Blocker records,
  with room links, actor/timestamp/rationale/evidence, and wait-state status.
- #115: Goal, Plan, Checkpoint, budget, stop-condition, pause/resume/cancel, and
  safe-resume APIs.
- #116: cross-client IA so iOS terminology and Mac renderer surfaces match Web
  and Windows.
- #119: release evidence matrix and dogfood scenarios, including mobile
  approval followed by desktop follow-through.
- #122: deployed server URL, auth/cookie/WebSocket behavior, and Cloudflare/
  Azure staging smoke target for live-client verification.

The clients should not derive Goal, Presence, Decision, Handoff, Blocker, or
Checkpoint state from raw task lists or unstructured room messages. The server
must own read-model synthesis and action eligibility.

## iOS Verification Path

No iOS runtime claims should be made until the specific evidence is produced.
Current proven boundary is source-derived/static plus generic no-assets build.

Minimum v3 iOS gate after implementation:

1. `xcodegen generate` from `apps/ios/project.yml`.
2. Generic no-assets build-for-testing:
   `xcodebuild -project Artoo.xcodeproj -scheme Artoo -destination 'generic/platform=iOS' -derivedDataPath build/VerifyNoAssetsDerivedData CODE_SIGNING_ALLOWED=NO EXCLUDED_SOURCE_FILE_NAMES='*.xcassets' build-for-testing`.
3. Focused model/view-model tests for new v3 DTO decoding, unknown enum fallback,
   action eligibility, grouping, and error states where they can execute.
4. Static SwiftUI/source-derived screenshot matrix for iPhone and iPad sizes:
   Needs Attention, Goals, Goal detail, Plan approval, Team presence,
   Blocker/Handoff detail, Checkpoint recovery, Artifact review, Audit summary,
   Settings.
5. Accessibility source audit: semantic fonts, Dynamic Type stress, VoiceOver
   labels/hints for action buttons, hit targets, safe-area behavior, dark mode,
   and long text.
6. Live server smoke only when a healthy simulator/device path exists: bootstrap
   against the #122 staging URL, login/auth if required, list goals, resolve a
   low-risk approval, pause/resume a fixture goal, and inspect an artifact.

Blocked or not yet proven unless actually run:

- full `.xcassets` asset-catalog build;
- simulator/device runtime;
- executed XCTest on simulator/device;
- push notifications;
- App Store signing, notarization, or review readiness;
- live Azure/Cloudflare server smoke.

## Mac Verification Path

Mac should keep using real packaged-app evidence, not only web screenshots.

Minimum v3 Mac gate after implementation:

1. Build the shared renderer with `npm run prepare-renderer --workspace @artoo/desktop`.
2. Package an unsigned macOS directory app with `electron-builder --mac dir`
   or an equivalent repo script. If Electron download cache issues recur, use a
   local verified `electronDist` and record that explicitly.
3. Launch the packaged `.app` with Playwright Electron or equivalent automation.
4. Prove packaged renderer JS/CSS/assets load from the app package.
5. Prove the darwin bridge exposes server URL, platform, Electron version, and
   any v3 daemon/client bridge fields.
6. Against a temp or #122 staging server, prove bootstrap, goal list/detail,
   plan read, presence read, approval action, artifact read, and command write.
7. When #111/#113/#115 are available, prove local `artood` heartbeat, daemon
   restart/reconnect, stale/offline transitions, revoked-device refusal, and
   safe resume from checkpoint.
8. Capture screenshots for desktop workbench, local daemon health, presence
   roster, checkpoint recovery, approval/governance, artifact/audit, and
   degraded states.

Not proven unless separately run:

- DMG/zip installer quality;
- code signing;
- notarization;
- auto-update;
- update trust chain;
- adversarial daemon sandbox/security claims.

## Product Risks To Track

- If Goal/Plan/Checkpoint APIs lag, iOS will remain task-first and fail v3's
  product hierarchy.
- If presence is only a dot, users will not know whether the problem is server,
  device, daemon, runtime, assignment, or policy.
- If decisions, handoffs, and blockers remain event text, mobile will force
  users to read threads to understand wait states.
- If Mac daemon health is collapsed into generic online/offline status, local
  recovery will be unsafe and hard to diagnose.
- If screenshots do not stress long text, Dynamic Type, stale/offline states,
  and no-live-agent states, the polished-client claim will be weak.
- If #122 staging is not available, live-client verification must stay local or
  temp-server only and the release gate should say so explicitly.
