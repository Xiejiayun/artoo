# Artoo Production UI Gate (v2-K / #44)

This document is the reviewable output for the #44 planning gate. It turns the
reference audits, product flow map, cross-client IA, token rules, component
rules, state rules, and evidence matrix into concrete implementation standards.

Scope covered:

- #55 collaboration IA audit
- #56 work dashboard audit
- #57 open-source design-system audit
- #58 product journey map
- #60 cross-client information architecture
- #61 UI tokens
- #62 core component specs
- #63 UI state specs
- #64 evidence and QA matrix

`docs/server-ui-contract-map.md` remains the server/API source of truth. This
document and `docs/ui-system-spec.md` are the UI source of truth for #65-#88.

Status: accepted planning gate for implementation. Web/Electron tasks #65-#78
and iOS tasks #79-#84/#88 may start only after this document is merged.

---

## 1. Non-negotiable Review Rules

1. The UI work is reference-driven. Every implementation task must cite the
   specific section of this document it implements.
2. The #44 refactor is primarily renderer/client UI work. Server contract gaps
   are reported as separate tasks, not silently changed inside UI work.
3. Desktop Web, Windows Electron, and macOS Electron share one renderer and one
   design system. Platform package QA still has to prove that the renderer ships
   correctly in Windows and macOS packages.
4. iOS shares semantic tokens and status vocabulary but uses native SwiftUI
   navigation and controls. It must not copy the desktop three-pane layout.
5. Evidence is required before close. Screenshots without passing smoke/tests,
   or tests without screenshots, are incomplete.
6. A task is not done if text overlaps, controls resize unpredictably, focus is
   invisible, important states are missing, or the result still reads as a demo.

---

## 2. #55 Collaboration IA Audit

References:

- Slack: channels as organized places where work happens; threaded context and
  predictable navigation.
- Microsoft Teams: app design guidance, left navigation, personal app focus,
  and Teams UI kit patterns.
- Discord: dense server/channel/member context and persistent conversation
  navigation.
- WeChat: compact top-level mobile entry points, list-first navigation, and
  lightweight action surfaces.

Official/reference URLs used:

- https://slack.design/articles/beyond-the-last-message-designing-for-all-information-in-slack/
- https://slack.com/help/articles/217626408-Create-guidelines-for-channel-names
- https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/design/design-teams-app-overview
- https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/design/personal-apps

### Borrowed Patterns

| pattern | Artoo desktop mapping | Artoo iOS mapping | rejected part |
| --- | --- | --- | --- |
| Persistent navigation + local context | Top nav for global surfaces; left rail for current task set; main room; right metadata/detail panel | TabView for Today/Inbox, Tasks, Runs/Approvals, Settings/Devices; NavigationStack for detail | Slack/Discord workspace color rail; Artoo is a single product console, not a social workspace switcher |
| Conversation with work context | Task room is a work log with actor, time, system notices, artifacts, approvals, and run updates | Task detail has Activity section; long content drills into a detail view or sheet | Chat bubbles and reaction-heavy social UI |
| Needs-action signals | Inbox badge, approval count, stale/offline indicators, conflict banners | Today/Inbox tab badge; approval rows grouped by urgency | Notification noise that hides work state |
| Presence | Small status dot/lozenge for agents, devices, and computers | Text + semantic symbol in grouped list rows | Large avatars as primary UI; Artoo entities are operational resources |

### Accepted IA Decision

Desktop/Web/Mac/Windows Electron:

- Use a dense workbench: global nav, task/list rail, main work room, detail/
  metadata rail.
- Keep scan targets stable: status, priority, owner/agent, updated time, and
  queued/offline indicators must stay in consistent row locations.
- The task room is not a chat app. It is an operational activity stream.

iOS:

- First-level tabs answer "what needs my attention now", not "copy every
  desktop pane".
- Primary tabs: Today/Inbox, Tasks, Runs/Approvals, Settings/Devices.
- Task detail and approval actions use NavigationStack drill-down plus sheets or
  confirmation dialogs.

---

## 3. #56 Work Dashboard Audit

References:

- GitHub Projects: table/board/roadmap views, filters, custom fields, board
  tracking.
- Jira / Azure DevOps: issue detail, status lozenges, pipeline/run state,
  approval/review flow clarity.
- Linear: restrained operations console, fast scanning, low chrome, compact
  rows, keyboard-friendly density.

Official/reference URLs used:

- https://docs.github.com/issues/planning-and-tracking-with-projects/learning-about-projects/about-projects
- https://docs.github.com/en/issues/planning-and-tracking-with-projects/customizing-views-in-your-project/filtering-projects
- https://github.com/features/issues
- https://atlassian.design/components/lozenge

### Borrowed Patterns

| pattern | Artoo mapping | standard |
| --- | --- | --- |
| Filterable work list | Task rail, board, approvals, runs, memory/audit tables | Search/filter control is always near the surface title; selected filter is visible; empty result explains which filter caused it |
| Board + list parity | Board cards and list rows use same status/priority vocabulary | Same task cannot look like two different products across views |
| Detail rail | Task detail metadata, approvals, runs, artifacts, audit links | Primary action row stays visible near title; metadata uses stable label/value grid |
| Run timeline | Step state dots, timestamps, logs, error/retry affordance | Queued/starting/running/awaiting_input/paused/completed/failed/cancelled are visually distinct |
| Approval inbox | Risk, action, task/run linkage, approve/reject/needs-info | High-risk approvals cannot look like ordinary info cards |

### Rejected Patterns

- Marketing dashboards with oversized hero stats.
- Decorative metric cards that do not help operate the current task.
- Toolbar sprawl. Common actions are visible; rare actions go into a menu.
- Board-only workflow. Artoo needs list/detail/room/timeline views for agent
  operations.

---

## 4. #57 Open-source Design-system Audit

References:

- GitHub Primer: product UI components, neutral scale, labels, timeline, focus
  and accessibility conventions.
- Atlassian Design System: design tokens as source of truth, lozenges for
  status, issue/workflow metadata patterns.
- Microsoft Fluent 2: tokens for color, type, spacing, elevation, focus, and
  cross-platform app component grammar.
- GitLab Pajamas: product foundations, badges, tokens, tables, and compact
  operational surfaces.
- Apple HIG: tab bars, sheets, navigation, Dynamic Type, safe areas, and
  platform-native control behavior.

Official/reference URLs used:

- https://primer.style/
- https://atlassian.design/tokens/design-tokens
- https://atlassian.design/components/lozenge
- https://fluent2.microsoft.design/design-tokens
- https://design.gitlab.com/
- https://design.gitlab.com/components/badge
- https://developer.apple.com/design/human-interface-guidelines
- https://developer.apple.com/design/human-interface-guidelines/tab-bars
- https://developer.apple.com/design/human-interface-guidelines/sheets

### Accepted System Decisions

| source | adopt | Artoo rule |
| --- | --- | --- |
| Primer | Neutral-first surfaces, label/badge restraint, timeline grammar | Use neutral surfaces and semantic badges instead of saturated one-note theming |
| Atlassian | Status lozenges, issue metadata, token discipline | Every status value maps through token names, not ad hoc colors |
| Fluent | Focus rings, elevation tiers, cross-platform token model | Keyboard focus is visible on every interactive desktop control |
| Pajamas | Compact product components, badge/table foundations | Inventory and audit pages use table/list density, not card galleries |
| Apple HIG | Native tab bars, sheets, Dynamic Type, 44pt targets | iOS implementation must feel native and must tolerate text size changes |

### Rejected System Choices

- Importing a full external design system dependency without matching the
  codebase. The first implementation pass should use local primitives and tokens.
- One-hue palettes. The UI must use neutral structure with semantic accents.
- Rounded marketing-card composition as the main app layout.
- iOS custom chrome that fights SwiftUI/HIG conventions.

---

## 5. #58 Product Journey Map

Each journey must be implemented on desktop and iOS with the same server meaning
and platform-appropriate UI.

### Boot and Orientation

- User goal: understand current org/project, connection state, and pending work.
- Server/API: `GET /api/v1/bootstrap`, `GET /api/v1/sync/cursor`, control WS.
- Desktop UI: global nav with active surface, project context, connection/
  reconnecting/offline indicator, pending approval count.
- iOS UI: Today/Inbox default tab with connection/offline banner if needed.
- Required states: first load skeleton, auth required, reconnecting, offline
  queue present, empty project.

### Create and Triage Task

- User goal: create a task, understand priority/status, select work quickly.
- Server/API: `POST /tasks`, `GET /tasks?project_id=`, task WS topic.
- Desktop UI: task rail with search/filter, status/priority lozenges, compact
  metadata, selected row.
- iOS UI: Tasks tab list with grouping, filter/search, create sheet.
- Required states: create validation errors, duplicate/offline queued command,
  empty list, stale/conflict response.

### Task Detail and Review

- User goal: inspect acceptance criteria, status, assignee/agent, dependencies,
  approvals, artifacts, and review action.
- Server/API: `GET /tasks/:id`, `/ready`, `/assign`, `/retry`, `/review`,
  `/dependencies`.
- Desktop UI: main room for activity; right detail panel for task metadata and
  actions.
- iOS UI: task detail screen with grouped sections and action sheet/dialog.
- Required states: disabled actions when invalid, conflict on stale
  `base_version`, done/cancelled terminal state, blocked dependency state.

### Task Room and Activity

- User goal: read messages, system events, artifacts, and run activity without
  losing task context.
- Server/API: `GET /rooms/:id/messages`, `POST /rooms/:id/messages`, room WS
  topic.
- Desktop UI: activity stream in center pane with compact message cards and
  system notices.
- iOS UI: Activity section in detail; long streams may drill into Activity view.
- Required states: sending, retry/offline queue, empty activity, failed send.

### Run and Approval Loop

- User goal: see run progress, understand blockers, approve/reject risky steps.
- Server/API: `GET /runs/:id`, `POST /runs/:id/cancel`, `GET /approvals`,
  `POST /approvals/:id/resolve`, run/inbox WS topics.
- Desktop UI: run timeline and approval cards with risk/status badges.
- iOS UI: Today/Inbox approvals first; run summary from task detail or Runs tab.
- Required states: queued, starting, running, awaiting_input, paused, completed,
  failed, cancelled, pending/approved/rejected/needs_more_info/expired approval.

### Artifact, Memory, Audit

- User goal: inspect evidence, trace decisions, and review memory/audit context.
- Server/API: task artifact snapshot, `GET /memories`, `GET /memories/:id`,
  `GET /tasks/:id/audit-bundle`.
- Desktop UI: tables/detail pages for memory/audit; artifact cards in task room.
- iOS UI: lightweight artifact/audit summaries with external/open actions when
  content is too dense.
- Required states: missing artifact, redacted audit data, empty memory context,
  loading large audit bundle.

### Devices, Computers, Agents, Skills

- User goal: understand available execution resources and device trust state.
- Server/API: `GET /bootstrap`, `GET /devices`, `GET /devices/:id/presence`,
  `GET /computers/:id/runtimes`, `GET /skills`.
- Desktop UI: inventory tables/lists with presence, trust, and settings status.
- iOS UI: Settings/Devices tab with grouped rows and detail drill-down.
- Required states: online/stale/offline/revoked, no runtime, no skills, presence
  stale due to missing device realtime topic.

---

## 6. #60 Cross-client Information Architecture

### Shared Semantics

- Same task, run, approval, priority, device, and presence values on every
  client.
- Same command outcomes: success, queued offline, retryable failure, stale OCC
  conflict, forbidden/auth error.
- Same evidence language: iOS static preview is not a simulator run; packaged
  desktop smoke is not notarization.

### Desktop/Web/Windows/Mac IA

| level | surface | purpose |
| --- | --- | --- |
| global | top nav | Tasks, Board, Runs/Audit, Memory, Agents, Computers, Skills, Settings/Login |
| local | left rail/list | current work set, filters, search, density, selected row |
| work | center pane | task room/activity, board, run/audit table, memory content |
| inspect | right panel | task detail, metadata, actions, approvals, artifacts, dependency summary |
| feedback | toast/banner/modal | command result, offline queue, conflict, destructive confirm |

Desktop breakpoints:

- >=1280px: full workbench with three panes where relevant.
- 1024-1279px: collapse or reduce the detail panel before destroying list
  density.
- <720px web viewport: stacked responsive layout for browser QA only; native iOS
  remains the production mobile client.

### iOS IA

| tab | first screen | detail |
| --- | --- | --- |
| Today/Inbox | pending approvals, blocked tasks, stale/offline alerts | approval detail, task detail |
| Tasks | grouped task list with search/filter | task detail, activity, artifacts |
| Runs/Approvals | run summaries and approval history | run detail / approval resolution |
| Settings/Devices | server/session/device/computer status | device/computer details |

iOS rules:

- Use NavigationStack for drill-down and sheets for creation/actions.
- Respect safe areas, Dynamic Type, VoiceOver labels/hints, and 44pt targets.
- Use confirmationDialog for destructive/cancel/revoke actions.
- Keep metadata in grouped sections; do not force desktop right-rail concepts
  into a phone layout.

---

## 7. #61 UI Tokens

`docs/ui-system-spec.md` defines the canonical values. Implementation tasks must
use those token names and may add only local aliases that map back to them.

Additional acceptance rules:

- CSS uses custom properties for every repeated color, spacing, radius, shadow,
  and focus value.
- SwiftUI uses a single token file/enum or equivalent source for colors, text
  styles, spacing, status mapping, and hit-target defaults.
- No negative letter spacing.
- No viewport-width font scaling.
- Dominant color balance must remain neutral/productive with semantic accents.
- Status color cannot be the only signal; pair color with text/icon/shape.
- Semantic vocabulary must include the full domain/server enum:
  - task: `backlog`, `ready`, `assigned`, `running`, `awaiting_approval`,
    `blocked`, `review`, `done`, `cancelled`
  - run: `queued`, `starting`, `running`, `awaiting_input`, `paused`,
    `completed`, `failed`, `cancelled`
  - approval: `pending`, `approved`, `rejected`, `needs_more_info`, `expired`
  - priority: `p0`, `p1`, `p2`, `p3`
  - presence/trust: `online`, `stale`, `offline`, `active`, `revoked`

---

## 8. #62 Core Component Specs

Every component must be documented by implementation through screenshots and, if
interactive, tests or existing coverage.

| component | desktop standard | iOS standard | implementation owner |
| --- | --- | --- | --- |
| App nav / tabs | top nav with active pill, focus ring, count badge | TabView with labels/icons and badge where supported | #69, #79 |
| Button / icon button | primary/secondary/ghost/danger, loading, disabled, 32px min target | native Button styles, destructive role, 44pt target | #67, #80 |
| Input/search/filter | label/helper/error, clear focus, filter chip state | searchable list/search field, sheet filters | #67, #82 |
| Badge/lozenge | semantic token, compact, text label, optional icon | semantic text + capsule where appropriate | #68, #80 |
| Card/panel | 8px max radius unless tool/modal needs more; no nested page cards | grouped sections/cards using native spacing | #68, #80 |
| List/table row | stable columns, hover, selected, focus, no layout shift | grouped list row, navigation affordance, Dynamic Type | #71, #82 |
| Detail panel | title/action/metadata/sections; sticky action context where useful | sectioned detail with toolbar/actions/sheets | #72, #83 |
| Timeline | state dot, label, timestamp, payload, error/retry | vertical list/section with state labels | #73/#74, #84 |
| Approval card | risk, requested action, task/run link, approve/reject/needs-info | approval detail with confirm actions | #74, #83 |
| Modal/sheet | focus trap, escape/close, e3 elevation, destructive confirm | SwiftUI sheet/confirmationDialog | #68, #79/#83 |
| Toast/banner | semantic, dismissible when persistent, queued/offline counts | banner/alert or inline state row | #68, #81 |
| Skeleton/empty/error | surface-specific, not generic spinner-only | native ProgressView plus explanatory empty/error | #68, #81 |

Implementation standard:

- Prefer lucide icons in Web/Electron where available.
- Icon-only buttons require accessible labels/tooltips.
- Do not put cards inside cards for page layout.
- Fixed-format UI elements need stable dimensions/aspect/track sizing so state
  changes cannot resize the layout.

---

## 9. #63 State Specs

| state | required behavior |
| --- | --- |
| Loading | show skeletons matching final layout; no full-page spinner when partial data can render |
| Empty | name what is empty and provide the next useful action when one exists |
| Error | show recoverable action, server error code/message where useful, and safe retry |
| Offline/reconnecting | persistent but not blocking banner; show queued command count and replay status |
| Stale OCC conflict | tell user data changed, show refresh/retry path, do not pretend command succeeded |
| Disabled | visible disabled state with reason nearby or tooltip where ambiguous |
| Hover/active | subtle background/border change without layout shift |
| Focus-visible | visible ring on every keyboard-reachable control |
| Toast | semantic result; destructive/failure messages persist long enough to read |
| Tooltip | only for supplementary labels, never for critical information |
| Reduced motion | disable shimmer/animated transitions where user requests reduced motion |
| Long text | wrap or truncate with tooltip; never overlap adjacent controls |
| High text size iOS | Dynamic Type screenshots must prove important text remains usable |

---

## 10. #64 Evidence and QA Matrix

| client | required evidence before close |
| --- | --- |
| Web browser | desktop screenshots at >=1280 and ~1024; narrow browser screenshot around 390px; no-overlap visual check; web Playwright; relevant Vitest/component tests; build |
| Windows Electron | `npm run smoke:win --workspace @artoo/desktop`; packaged screenshot; read/write flow; app close; uninstall sanity when installer path changes |
| macOS Electron | packaged `.app` smoke by Mac-capable agent; screenshot; renderer CSS/assets loaded from package; darwin bridge; read/write flow |
| iOS SwiftUI | source screenshots or previews plus clear label if static; Xcode build gate where available; runtime screenshot only if simulator/device actually ran; Dynamic Type/text-stress screenshot; VoiceOver/accessibility label review |
| Cross-client | reference mapping audit; full status vocabulary visible or covered; no known blocking bug list; server contract gaps recorded separately |

Minimum command gates:

- Web/Electron implementation: `npm run typecheck`, focused web tests, web
  build, web Playwright, and desktop package smoke appropriate to touched scope.
- Broad Web/Electron changes: full `npm run verify:v1`.
- iOS implementation: Xcode build/test gate when Mac environment allows it. If
  CoreSimulator blocks runtime, evidence must clearly say build-only or static
  preview; do not claim simulator/device run.
- Docs-only gate: `git diff --check`.

---

## 11. Implementation Dispatch Gate

After this document is merged:

1. @SkywalkerClaude may claim #65-#68 first. These are foundation tasks and must
   establish tokens/components/states before shell/work surfaces depend on them.
2. @SkywalkerClaude may then claim #69-#74 in parallel batches only where the
   touched surfaces do not conflict. If changes share the same component files,
   sequence them.
3. @SkywalkerClaude may claim #75-#78 after the primary workbench surfaces have
   usable primitives.
4. @iOSMacCodex may claim #79-#81 first. These establish iOS navigation,
   tokens/components, state/accessibility.
5. @iOSMacCodex may claim #82-#84 after #79-#81 foundations are reviewable.
6. #85-#88 visual QA tasks start only after their corresponding client
   implementation tasks have screenshots and build/smoke evidence.
7. #89-#91 final closeout starts only after #85-#88 have evidence or explicit
   documented environment blockers.

---

## 12. Closeout Checklist

Before #44 can close:

- #55-#64 are done and cited by implementation tasks.
- #65-#78 Web/Electron tasks are done or explicitly scoped out with reason.
- #79-#84 iOS tasks are done or explicitly blocked with evidence.
- #85-#88 visual QA evidence is attached and inspected.
- #89 reference-mapping audit passes.
- #90 regression gate passes.
- #91 closeout report states the exact claims and boundaries.
- No known blocking production UI bug remains open.
