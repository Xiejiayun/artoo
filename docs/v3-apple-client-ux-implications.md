# V3 Apple Client UX Implications

Status: #126 planning input for #116 UX/UI maturity and #119 release gates.

This note updates the accepted #117 Apple client plan after the concrete #113,
#114, and #115 Phase 1 plus P2-S1/P2-S2 contracts landed on `main=001ac00`.
It is a UX/API/evidence impact map only. It does not authorize broad iOS or Mac
implementation.

## Contract Baseline

Available on `main=001ac00`:

- #113 Agent Presence: server-synthesized agent-instance and computer presence
  read models, capacity-backed scheduler eligibility, device-trust exclusion,
  and secret-safe connection-edge presence events.
- #114 Team Communication: first-class Decision, Handoff, and Blocker records;
  mention/assignment payloads; "who waits on whom" derived from records; audit
  inclusion.
- #115 Phase 1: Goal and Plan domain/service/routes, goal rooms, plan
  versioning, and atomic first-plan acceptance plus plan-to-DAG materialization.
- #115 P2-S1/P2-S2: checkpoint create/list/get, materialize/pause/resume
  checkpoint hooks, latest-checkpoint reconciliation, `event_cursor` stale-run
  detection, idempotent run-sourced blockers for failed/stale/missing runs, and
  running-goal to blocked derivation.

Still conditional:

- #115 P2-S3 run.resume protocol, grace window, and daemon handler remain
  unmerged. Until S3 lands, daemon restart/reconnect resume should be specified
  as required V3 behavior, but not claimed as implemented.
- "What changed since I was away" remains a product/read-model requirement on
  top of checkpoints, decisions, handoffs, blockers, approvals, artifacts, and
  run events; do not imply a dedicated Apple-facing summary API exists until a
  follow-up lands it.
- Presence push events currently cover connection edges only. Work/runtime
  changes are correct through read APIs, but live push for those dimensions is a
  release-boundary item for #116/#119 unless a follow-up lands it.
- iOS live runtime proof remains blocked/unproven unless a healthy simulator,
  device, or staging path is actually exercised.

## iOS Information Architecture Impact

iOS remains a mobile command center, not a desktop clone. The #117 tab model
still holds, with these concrete data responsibilities:

| Tab | Primary Objects | Required Behavior |
| --- | --- | --- |
| Needs Attention | approvals, active blockers, open handoffs to the user, stale/offline/revoked presence, budget/policy prompts | Prioritize human action over chronology; show the safe next action without thread reading. |
| Goals | goals, current plan, derived status, blockers, latest checkpoint summary | Replace the task-first mental model. Task rows must show parent goal and plan context when entered directly. |
| Team | agent-instance presence, computer presence, runtime health, open handoffs | Show connection/work/runtime/health reason/age/source. Do not collapse daemon/server/runtime failures into one dot. |
| Activity | runs, artifacts, decisions, handoffs, blockers, checkpoints, audit milestones | Provide a filtered timeline by goal, not a raw global log. |
| Settings | account, server, device trust, staging/local selection, diagnostics | Keep device/server trust separate from agent work state. |

### Needs Attention Priority

Needs Attention should be ordered by operator risk, not by creation time:

1. Hard approvals that block a goal or accepted plan.
2. Open blockers with `needs_human_decision`: approval, human_input, policy,
   or budget.
3. Open handoffs where the current user/agent is the recipient.
4. Revoked/stale/offline agent or computer states affecting an active goal.
5. Checkpoint/resume prompts after pause, reconnect, or failed run recovery.
6. Artifact review requests and rejected-artifact reroute decisions.
7. Informational stale states with a server-safe recovery path.

Each card should show: parent goal, affected plan/task/run/artifact, owner,
reason, age/source, and primary action. If a card cannot name an owner and next
action, the server read model is not ready for mobile.

## Presence And Team UX

### iOS

An agent row should render these fields:

- agent instance name/id and current goal/run if any;
- connection: online/stale/offline/revoked;
- work: idle/queued/running/awaiting_input/awaiting_approval/blocked/paused;
- runtime: available/busy/disabled/stale/missing;
- health_reason, source, age_ms, as_of;
- capacity: active_runs / concurrency_limit.

Rows should group by actionability:

- Active on this goal.
- Waiting on human.
- Available.
- Degraded: stale/offline/revoked/runtime_missing.
- Disabled or not eligible.

iOS must not offer assignment to stale, revoked, disabled, missing-runtime, or
capacity-full agent instances. Scheduler eligibility is server-owned; the
client only displays eligibility and routes commands to accepted APIs.

### Mac

Mac should show a full operations roster:

- server/API health;
- control WebSocket state;
- node WebSocket state;
- local `artood` process/heartbeat;
- computer presence;
- per-runtime freshness;
- agent-instance presence and capacity;
- current goal/task/run assignment.

Mac must distinguish these cases visually and textually:

- server unreachable;
- server reachable but control socket disconnected;
- daemon process stopped/restarting;
- node socket rejected or missing;
- computer heartbeat stale;
- runtime missing/stale/disabled;
- device revoked;
- agent busy at capacity.

This separation is required because several of these states have different safe
recovery actions. A single online/offline indicator is not acceptable for V3.

## Team Room, Decision, Handoff, And Blocker UX

The Apple clients should treat #114 records as first-class operational objects,
not as decorated chat messages.

### Decision Records

iOS should show decisions as reviewable summary rows:

- status: proposed/accepted/rejected/superseded;
- summary and rationale;
- impact_summary;
- linked goal/plan/task/run/evidence_refs;
- actor and timestamp.

Safe mobile actions: accept/reject a proposed decision only when the API says
the current actor is allowed; request clarification; inspect evidence; open the
related goal/plan/task.

Mac should add side-by-side context: plan diff, evidence list, room messages,
affected blockers/handoffs, and audit position.

### Handoffs

Handoffs are the main answer to "who waits on whom." iOS should expose:

- sender -> recipient;
- expected_action;
- blocking_condition;
- status: open/accepted/completed/cancelled/expired;
- priority/due_at when present;
- next_action/latest_status.

Safe mobile actions: accept a handoff assigned to the user, mark completed when
the expected action was performed, cancel only if the server grants permission,
and request clarification by adding a structured message/mention.

Mac should show handoff queues by goal and assignee, with filters for "waiting
on me", "waiting on agent", "expired", and "blocking release".

### Blockers

Blockers must drive both Goal and Needs Attention summaries:

- type: approval/dependency/lease_conflict/offline_agent/stale_runtime/policy/
  budget/failed_run/missing_artifact/human_input;
- status: open/mitigated/accepted_risk/resolved;
- owner;
- source_kind/source_id where linked;
- mitigation and next_action;
- resume state: no_active_blockers, safe_to_resume, or needs_human_decision.

Safe mobile actions: acknowledge/accept risk only for policy-approved blocker
types, resolve only when the server says the actor owns it, inspect linked
source, request clarification, or pause/cancel the goal. The app must not let a
user "clear" a deterministic blocker by hiding it locally.

Mac should show the blocker queue in the workbench and in the goal header, with
direct links to source approval, DAG node, lease conflict, run, presence row, or
manual blocker detail.

## Goals, Plans, Checkpoints, And Recovery

### Goals

Goal rows on iOS and Mac should show:

- title, objective, priority, owner;
- derived status;
- current_plan_id and plan version;
- acceptance criteria progress;
- retry_count and budget highlights;
- open blocker count and resume state;
- latest checkpoint summary when available.

Safe mobile actions available from current server APIs:

- create goal;
- inspect goal;
- pause/resume/cancel goal through server actions;
- propose plan;
- accept/reject plan;
- inspect materialized tasks under the goal.
- inspect goal checkpoints;
- invoke checkpoint reconciliation only through a product-approved recovery
  flow, not as an unexplained raw maintenance button.

Action constraints:

- Goal status is server-derived. The client must not compute terminal,
  running, blocked, or awaiting_approval state from local task caches.
- Re-planning a running goal requires an explicit pause first.
- Plan acceptance and materialization are atomic server behavior; clients should
  not create task DAGs directly.

### Checkpoints And "What Changed"

Checkpoint UX is required for V3 and is partially backed by #115 P2-S1/P2-S2:

- show latest checkpoint type, summary, age, plan_id, event cursor, and
  reference counts;
- show what changed since last visit: new decisions, opened/resolved blockers,
  handoffs, approvals, artifacts, run terminal states, and checkpoint movement;
- show whether resume is safe, needs human decision, or blocked by missing
  runtime/offline agent/stale daemon;
- make pause/resume/cancel sheets include the checkpoint consequence.

S1/S2 allow checkpoint reads and checkpoint-based reconciliation claims. They do
not prove daemon restart/reconnect resume, `run.resume` protocol handling, or a
dedicated changed-since-away summary API; those remain S3/follow-up release
boundaries.

## Server-Backed State Rules

These must be read from server APIs or command responses, never inferred only in
iOS/Mac:

- goal status and current plan;
- plan version and materialization state;
- agent-instance presence and scheduler eligibility;
- computer/runtime health;
- decision/handoff/blocker status;
- who-waits-on-whom;
- safe_to_resume versus needs_human_decision;
- latest checkpoint and changed-since-away summary;
- audit bundle completeness/redaction/replay availability.

Client-local state is acceptable only for view navigation, selected filters,
draft text before submit, optimistic progress indicators while awaiting a
server response, and cached read models clearly labeled by `as_of`/age.

## Mobile-Safe Actions

Allowed on iOS once corresponding APIs are accepted:

- approve/reject approvals and plan decisions;
- pause/resume/cancel a goal;
- accept/reject a plan;
- request clarification through a structured message/mention;
- accept or complete a handoff assigned to the actor;
- inspect artifacts and evidence_refs;
- acknowledge or resolve blockers only when server action eligibility allows it;
- open Mac/deep-link target for full plan/DAG/audit work.

Not appropriate for iOS V3:

- local runtime hosting;
- daemon start/stop/restart;
- raw `artood` log triage as a primary flow;
- editing task DAGs directly after plan materialization;
- local-only blocker clearing or presence overrides;
- signing/notarization/update-trust claims.

Mac can expose daemon and diagnostic controls only after #118 defines the safe
command policy and the release gate proves the packaged path.

## Evidence Matrix For #119

### Static / Source-Derived Planning Evidence

Acceptable before live Apple runtime proof:

- iOS source review of new DTOs, view models, and SwiftUI navigation;
- static SwiftUI/mock screenshot matrix for Needs Attention, Goals, Team,
  Activity, Goal detail, Plan decision, Handoff detail, Blocker detail,
  Presence detail, Checkpoint recovery, Artifact review, Audit summary;
- Dynamic Type and long-text stress screenshots;
- source audit for semantic fonts, SF Symbols, VoiceOver labels/hints, safe
  areas, and dark mode;
- Mac web-renderer screenshots for the same surfaces in browser/dev mode.

These artifacts prove layout intent and source compatibility only. They do not
prove live data, WebSocket behavior, device runtime, or packaged app behavior.

### iOS Build And Runtime Evidence

Minimum build gate:

- `xcodegen generate`;
- generic no-assets `xcodebuild build-for-testing` with
  `EXCLUDED_SOURCE_FILE_NAMES='*.xcassets'`;
- focused model/view-model tests where executable.

Live iOS proof requires a healthy simulator/device or staging path:

- authenticate/bootstrap against #122 staging or a labeled temp server;
- list Goals and Needs Attention;
- inspect agent/computer presence;
- resolve one low-risk approval or decision;
- pause/resume a fixture goal;
- inspect artifact and checkpoint summary.

Do not claim full `.xcassets`, simulator/device runtime, executed XCTest, push
notifications, App Store readiness, or live Azure behavior unless those commands
actually pass and the evidence is attached.

### Mac Packaged Evidence

Minimum Mac gate:

- build shared renderer;
- package unsigned macOS `.app` directory;
- launch packaged app under automation;
- prove renderer JS/CSS/assets load from package;
- prove darwin bridge;
- prove server read/write against temp or staging server;
- prove goal list/detail, presence read, decision/handoff/blocker read, approval
  action, artifact read, checkpoint read, and checkpoint reconciliation against
  the P2-S1/P2-S2 APIs;
- prove local daemon/computer/agent health separation when #118/#115 support it;
- prove daemon restart/reconnect resume only after S3 lands.

Not included unless separately proven: DMG quality, signing, notarization,
auto-update, update trust chain, public-production sandbox/security.

## Visual QA Cases For #116

#116 should require screenshot or recording coverage for:

- empty: no live agents, no goals, no pending attention;
- degraded: revoked device, stale computer, runtime_missing, capacity full;
- active: goal running with two agents, one active run, one queued run;
- waiting: approval_required and open handoff to user;
- blocked: policy/budget blocker needing human decision;
- safe resume: non-human blocker resolved, latest checkpoint available;
- checkpoint/reconnect: daemon restart with changed-since-away summary;
- audit: goal audit bundle completeness/redaction/replay state;
- long text: decision rationale, handoff expected_action, blocker mitigation,
  goal objective, artifact URI;
- accessibility: Dynamic Type large sizes, VoiceOver labels, keyboard/focus on
  Mac, dark mode, no overlap at mobile and desktop breakpoints.

## Release Claims

Dogfood-ready Apple claim:

- iOS: native command-center design and source/build evidence; live claim only
  for the specific simulator/device/staging flows actually proven.
- Mac: packaged unsigned workbench smoke with live read/write and renderer
  evidence; daemon controls only if #118 and #115 gates prove them.

Not a valid V3 claim:

- "iOS is live-verified" from static screenshots alone.
- "Presence is fully realtime" if work/runtime changes only update on polling.
- "Daemon restart/reconnect resume is proven" before S3 protocol/grace-window/
  daemon-handler evidence passes.
- "Mac is production-ready" without signing/notarization/update trust/security
  hardening evidence.
