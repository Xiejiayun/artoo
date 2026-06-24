# Artoo v3 Product And Architecture Plan

Status: planning gate for tasks #111-#122.

v3 turns Artoo from a working multi-client framework into a polished
multi-agent product. v1 proved the agent-team operating-system loop. v2 added
device auth, desktop/mobile client surfaces, local `artood` supervision, and
production-grade visual baselines. v3 must make long-running agent teams
understandable, governable, recoverable, and safe enough for real dogfood.

## Release Thesis

Artoo v3 is complete only when a user can set a meaningful goal, watch an agent
team discuss and execute it, intervene through approvals or guidance, recover
from daemon/network interruptions, and inspect a trustworthy evidence trail.

The product must make these questions obvious:

- What is the team trying to accomplish?
- Which agents and computers are available right now?
- Who is working, blocked, stale, awaiting approval, or offline?
- What did the team decide, and why?
- Which work is safe to continue automatically?
- What artifacts were produced, reviewed, accepted, or rejected?
- Can the whole run be replayed from audit evidence without trusting chat logs?

## Goal-First Hierarchy

V3's primary hierarchy is:

`Goal -> Plan -> Task -> Run -> Artifact -> Audit`

Tasks and runs remain important execution primitives, but they are no longer the
top-level product mental model. A user starts from a goal, inspects the accepted
or proposed plan, drills into child tasks, watches runs, reviews artifacts, and
exports or replays goal-level audit evidence.

Client implications:

- Desktop/Web/Mac/Windows enter through a goal workbench: goal header, plan/DAG,
  team roster, active runs, blockers, approvals, artifacts, and audit trail.
- iOS enters through "Needs Attention" and goal progress, then drills into
  approvals, blockers, team status, and artifacts.
- Existing task-first screens must migrate under goal context. A direct task URL
  may still exist, but it must show its parent goal, plan revision, and audit
  context.

## Non-Goals For v3

- Do not claim public, untrusted-code production safety until sandboxing,
  network egress policy, resource limits, update trust, and adversarial testing
  are implemented.
- Do not turn agent-to-agent collaboration into private, invisible chat.
  Communication must be structured, user-readable, and audit-backed.
- Do not treat mobile as a local runtime host. iOS remains a control surface.
- Do not add UI polish that introduces client-only state or bypasses server
  contracts.

## First-Class Product Objects

### Goal

A goal is a durable user intent that may outlive one prompt, one run, or one
agent session.

Required fields:

- title, objective, owner, project, priority;
- status: `draft | planned | running | awaiting_approval | paused | blocked |
  completed | cancelled | archived`;
- acceptance criteria and explicit stop conditions;
- budgets: elapsed time, token/cost estimate, max retries, allowed runtimes;
- current plan version and checkpoint pointer;
- audit bundle pointer.

Rules:

- A goal can be paused, resumed, cancelled, or archived by a human.
- A goal cannot silently continue after a hard approval, budget, or policy
  boundary is hit.
- Goal status is derived from child plan/run/task state, not hand-written by
  clients.

### Plan

A plan is the current executable decomposition of a goal.

Required behavior:

- versioned plan revisions with author and rationale;
- task DAG materialization from the plan;
- explicit dependencies, soft-context links, approval gates, write scopes, and
  expected artifacts;
- plan diff when an agent proposes a new decomposition;
- plan acceptance, rejection, or request-for-change workflow.

### Agent Presence

Presence is a synthesized server read model, not a decorative dot.

Inputs:

- authenticated control WebSocket connection;
- authenticated node WebSocket connection;
- `artood` heartbeat and runtime capability heartbeat;
- current run/task assignment;
- device trust/revocation state;
- last seen timestamp and heartbeat freshness window.

State vocabulary:

- connection: `online | stale | offline | revoked`;
- work: `idle | queued | running | awaiting_input | awaiting_approval |
  blocked | paused`;
- runtime: `available | busy | disabled | stale | missing`;
- health reason: human-readable source such as `heartbeat_timeout`,
  `device_revoked`, `runtime_missing`, `approval_required`,
  `lease_conflict`, or `daemon_restarting`.

Rules:

- UI must show the source and age of presence, not only the state.
- A stale runtime cannot be selected for new work.
- Revoked devices and mismatched node credentials must fail closed.
- Presence transitions must emit event-log entries that contain no raw secrets.

### Team Room

A team room is the structured discussion and activity surface for a goal or
task. It combines human messages, agent messages, system events, decisions,
handoffs, blockers, approvals, and artifacts.

Message/event classes:

- `status_update`;
- `proposal`;
- `decision`;
- `blocker`;
- `handoff`;
- `review_request`;
- `approval_requested`;
- `artifact_produced`;
- `audit_checkpoint`.

Rules:

- Agent-to-agent discussion should occur through task/goal rooms and events.
- Decisions must be promoted into decision records with actor, timestamp,
  rationale, and linked evidence.
- Handoffs must identify sender, recipient, expected action, and blocking
  condition.
- A room must explain who is waiting on whom without reading the whole thread.

### Decision Record

A decision record is a durable, reviewable outcome of discussion or execution.

Required fields:

- decision id, goal id, room id, optional task/run/artifact links;
- status: `proposed | accepted | rejected | superseded`;
- actor, timestamp, rationale, alternatives, and linked evidence;
- impact summary for plan, budget, scope, or release gates.

Rules:

- Decisions cannot remain buried in free-text messages.
- Plan changes, reroutes, release boundary changes, and rejected artifacts need
  decision records.
- Goal-level audit export must include the decision timeline.

### Handoff

A handoff is a structured wait-state between humans, agents, or systems.

Required fields:

- sender, recipient, expected action, blocking condition, linked goal/task/run;
- status: `open | accepted | completed | cancelled | expired`;
- next action and latest status update.

Rules:

- The UI must show "who waits on whom" without reading the whole room.
- A handoff can block a plan step, task, or approval.
- Handoff completion must be auditable.

### Blocker

A blocker is a first-class reason the goal cannot safely progress.

Required fields:

- blocker type: `approval | dependency | lease_conflict | offline_agent |
  stale_runtime | policy | budget | failed_run | missing_artifact | human_input`;
- owner, affected goal/plan/task/run, current mitigation, next action;
- status: `open | mitigated | accepted_risk | resolved`.

Rules:

- Blockers must have owner and next action.
- A blocked goal overview must distinguish "safe to resume" from "needs human
  decision".

### Run Session

A run session is one execution attempt by one runtime/agent instance against a
context pack and policy snapshot.

Required behavior:

- immutable context-pack link;
- selected runtime, model/effort profile, computer, and workspace root;
- write-lease reservations before dispatch;
- lifecycle events: `queued`, `starting`, `running`, `awaiting_input`,
  `awaiting_approval`, `paused`, `completed`, `failed`, `cancelled`;
- streamed logs and artifacts;
- terminal cleanup and lease release;
- reconnect-safe event ingestion from `artood`.

### Checkpoint

A checkpoint is a recoverable state marker for long-running goals.

Required behavior:

- checkpoint on plan acceptance, task DAG materialization, approval decision,
  run terminal state, accepted artifact, and human pause/resume;
- enough state to resume after daemon restart, server restart, or reconnect;
- checkpoint summaries visible in Web/Desktop/iOS.

### Goal Audit Bundle

Goal-level audit is the release evidence boundary.

It must include:

- goal metadata, accepted plan revisions, and plan-change decisions;
- task DAG snapshots and dependency transitions;
- run sessions, context-pack ids, runtime/agent selections, and artifacts;
- decisions, handoffs, blockers, approvals, checkpoints, and review outcomes;
- redaction status and export integrity metadata.

Task audit bundles can remain as drill-down evidence, but V3 release cannot rely
on task-only audit exports.

## Core Product Loop

1. A human creates or resumes a goal.
2. Artoo proposes or loads a versioned plan.
3. The plan becomes a task DAG with dependencies, leases, approval gates, and
   expected artifacts.
4. Scheduler assigns eligible live agent/runtime instances.
5. Agents coordinate through team rooms, run events, decisions, blockers,
   handoffs, and artifacts.
6. Humans intervene through approvals, plan changes, pause/resume, or review.
7. The goal reaches an accepted terminal state or a clear blocked state.
8. Artoo exports a redacted evidence bundle that proves what happened.

## Required Operating States

V3 must define UI and API behavior for degraded and zero states:

- no live agents;
- no accepted plan;
- stale runtime;
- revoked device;
- missing local daemon;
- daemon restarting;
- partial reconnect;
- offline command queue;
- budget threshold reached;
- approval expired;
- blocked dependency;
- rejected artifact;
- checkpoint available for safe resume.

Each state must name what happened, who or what owns recovery, and the next safe
operator action.

## V3 Workstreams

| task | workstream | owner | deliverable |
| --- | --- | --- | --- |
| #111 | daemon + multi-agent production smoke | `@SkywalkerClaude` | hard evidence for multi-node/team orchestration |
| #112 | product thesis and architecture plan | `@SkywalkerCodex` | this planning gate and follow-up task routing |
| #113 | agent presence model | `@SkywalkerClaude` | server/domain/API/read-model contract and tests |
| #114 | agent-to-agent communication | `@SkywalkerClaude` | room/event/decision/handoff model and tests |
| #115 | persistent goals and continuous run loop | `@SkywalkerClaude` | goal/plan/checkpoint lifecycle contract |
| #116 | product-grade UX/UI maturity pass | `@SkywalkerCodex` | cross-client IA and mature interaction spec |
| #117 | iOS/Mac V3 client plan | `@iOSMacCodex` | Apple client control-surface and verification path |
| #118 | daemon/security hardening plan | `@SkywalkerCodex` | threat model and hardening roadmap |
| #119 | integration/release gate | `@SkywalkerCodex` | v3 evidence matrix and acceptance criteria |
| #120 | product/UX/release-quality review | `@SkywalkerCodex54` | independent critique against polished-product bar |
| #121 | implementation gap audit | `@SkywalkerClaude46` | code/schema/test gap map for V3 requirements |
| #122 | Azure deployment and release architecture | `@SkywalkerCodex` | Azure/Cloudflare deployment plan and smoke gate |

## Workstream Acceptance Criteria

### #111 Daemon + Multi-Agent Production Smoke

Minimum proof:

- 2-3 live node/agent instances against one server;
- one parent goal/task DAG with parallel child work;
- scheduler capability/runtime routing visible in decisions;
- at least one clean disjoint write path and one deliberate lease conflict;
- dependency unlock and failure/block propagation;
- approval block/resume;
- artifact aggregation;
- audit replay/export;
- daemon restart/reconnect;
- revoked token refusal and node-id/credential mismatch refusal where practical.

The first pass may use deterministic mock/runtime-fixture agents. A real
Codex/Claude adapter pass is a second evidence layer, not a reason to delay the
orchestration proof.

Accepted evidence baseline:

- #111 is merged at `main=60e273e` as an opt-in gated smoke test. Without
  `ARTOO_DAEMON_SMOKE=1`, the smoke skips and stays out of default CI.
- The accepted proof covers capability routing to distinct computers,
  simultaneous live mock-agent runs, heartbeat visibility, artifact aggregation,
  disjoint and conflicting write leases, DAG unlock/block behavior, approval
  approve/reject paths, audit replay/export determinism, node restart/reconnect,
  and revoked/mismatched/dev-token WebSocket refusals.
- The accepted proof is internal dogfood orchestration evidence, not a public
  production-security claim. The remaining hardening gaps feed #113, #114,
  #115, and #118.

### #113 Agent Presence

Must define and test:

- source-of-truth synthesis from control sockets, node sockets, heartbeats,
  runtime registry, task/run state, and device trust;
- freshness windows and stale behavior;
- UI-ready read API for agent/computer/device presence;
- event-log transitions with secret-safe payloads;
- scheduler exclusion of unavailable/stale/revoked runtimes.

### #114 Agent Communication

Must define and test:

- room message and system event taxonomy for agent collaboration;
- decision records and handoff records;
- mention/assignment semantics;
- blocker visibility and unblock flow;
- audit inclusion for discussion-derived decisions.

### #115 Persistent Goals

Must define and test:

- goal lifecycle and plan lifecycle;
- plan-to-DAG materialization;
- checkpoints and resumability;
- pause/resume/cancel behavior;
- budget and stop-condition enforcement;
- long-running loop after daemon/server reconnect.

### #116 UX/UI Maturity

Must produce:

- V3 information architecture for Goal, Plan, Team Room, Agent Roster, Decision
  Log, Handoff Queue, Blocker Queue, Runs, Approvals, Artifacts, Audit,
  Devices/Daemon, and Settings;
- mature desktop workbench flow for long-running goals, including "what changed
  since I was away", latest checkpoint, active child work, open blockers, and
  safe resume;
- iOS control-surface requirements for presence, approvals, blockers, pause/
  resume/cancel, artifacts, and goal progress;
- state clarity for online/stale/offline/busy/blocked/awaiting approval;
- no-overlap screenshot and interaction evidence requirements.

### #117 iOS/Mac Client Plan

Must define:

- how presence/team/goal state appears on iOS and Mac;
- mobile actions for approve, pause/resume, ask for clarification, and inspect
  artifacts;
- runtime evidence boundary for iOS simulator/device limitations;
- Mac packaged daemon/client smoke path.

### #118 Daemon/Security Hardening

Must produce a threat model and staged hardening roadmap for:

- workspace escape;
- secret exposure;
- untrusted runtime execution;
- network egress policy;
- filesystem and process sandboxing;
- resource quotas and runaway processes;
- token lifecycle, revocation, and credential mismatch;
- signed update/notarization/release trust;
- audit integrity and redaction.

Inputs from #111 accepted smoke:

- the current node channel is bare WebSocket; production needs TLS termination
  rules and likely mTLS or equivalent node identity hardening;
- local agent runtimes execute real commands with path checks but without an
  OS/container sandbox, network egress policy, or resource quotas;
- revocation is device-level and must become finer-grained for per-node token
  rotation, expiry, and emergency revoke;
- current presence evidence reaches computer/runtime heartbeat and registry
  state, but not agent-instance capacity, busy/idle, or queue-depth semantics;
- agent collaboration remains indirect through server task state and events,
  without first-class team discussion, decision, handoff, and blocker records;
- persistent goal execution is still task/DAG-driven and lacks a daemon/server
  resume loop with checkpoints, budgets, and stop-condition enforcement.

### #119 V3 Integration/Release Gate

Must define a single release gate that includes:

- v1/v2 regression gates;
- #111 production smoke;
- presence/communication/goal lifecycle tests;
- Web/Desktop/iOS visual and interaction evidence;
- daemon/security negative tests;
- audit export/replay;
- dogfood scenario script from goal creation to accepted evidence bundle.

Named dogfood scenarios must include:

- create a goal from scratch, accept a plan, run parallel child work, and accept
  final artifacts;
- handoff from one agent to another with visible expected action and completion;
- stale/offline daemon recovery, then safe resume from checkpoint;
- mobile approval followed by desktop follow-through;
- pause overnight and resume next day with "what changed" summary;
- reject an artifact, reroute the plan, and prove the decision in audit;
- export and replay a goal-level evidence bundle.

### #120 Product/UX/Release-Quality Review

Must provide independent critique of #112/#116/#119:

- must-fix / should-fix / later buckets;
- product risks that would make V3 feel like a framework with pages instead of
  a mature workbench;
- missing user journeys, state surfaces, or release evidence;
- explicit review of goal-first IA, decision/handoff/blocker surfaces,
  recovery, governance approvals, and goal-level audit.

### #121 Implementation Gap Audit

Must map each V3 requirement to current code:

- existing, partial, missing, or unclear;
- schema/API/domain/protocol/client files affected;
- implementation slices and dependency order;
- migration coordination risks;
- compatibility behavior for V2 clients that ignore V3 events.

### #122 Azure Deployment And Release Architecture

Initial dogfood topology:

- Run the Node server and built Web UI from one Azure Container Apps origin,
  such as `https://artoo.<domain>`, to keep `/api/v1/*`, `/auth/*`,
  `/api/v1/ws`, OIDC callbacks, and cookies same-origin.
- Use Azure Database for PostgreSQL Flexible Server for production data.
- Use Azure Key Vault for OIDC secrets, session/device-token peppers, database
  credentials, and future signing/sealing keys.
- Use Azure Container Registry plus GitHub Actions or Azure deployment workflow
  for image build, deploy, revision, smoke, and rollback.
- Use Log Analytics / Application Insights for request, WebSocket, node,
  daemon, auth, and device health visibility.
- Use Cloudflare for DNS, custom domain, TLS/WAF/security rules, and proxying
  HTTP(S) traffic where compatible with Azure validation requirements.

Later split option:

- Move Web static assets to Azure Static Web Apps or Cloudflare Pages only after
  same-origin auth, OIDC callback, REST, and WebSocket behavior are proven.
  A split `app.<domain>` / `api.<domain>` architecture is a later optimization,
  not the first dogfood target.

Must define:

- Azure resource group and environment plan;
- domain/subdomain/TLS/redirect/OIDC callback plan;
- secret/config/environment variable plan;
- database migration plan;
- artifact/audit-bundle storage plan;
- CI/CD and rollback;
- deployment smoke for web load, server health, REST, control WebSocket, node
  WebSocket, device pairing/revoke, auth callback configuration, audit export,
  and Cloudflare proxied-domain behavior.

## Product Quality Bar

V3 should feel like an operations workbench for agent teams:

- calm, dense, and scan-friendly;
- clear ownership and state at every layer;
- explicit recovery actions for stale/offline/blocked conditions;
- strong audit trail without making users read logs;
- mobile control for urgent decisions, not a cramped desktop clone;
- mature visual hierarchy and interaction polish across Web, Desktop, and iOS.

No V3 workstream is complete if a user cannot tell what is happening, who is
responsible, what is blocked, what is safe to do next, and what evidence proves
the result.
