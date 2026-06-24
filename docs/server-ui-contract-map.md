# Artoo Server / UI Contract Map (v2-K0e / #59)

How each client (Web, Windows desktop, macOS desktop, iOS) talks to the server,
what the server exposes, and how UI state is derived. This is the contract source
of truth for the production UI refactor (#44): the UI is a **renderer-only**
refactor — **no new server contract** is introduced here. Any gap found is raised
as a separate task, never silently changed.

Authoritative as of `main` (post #28/#27/#42). Endpoints verified against
`apps/server/src/app.ts`.

---

## 1. Transport surfaces

- **REST** under `/api/v1/*` — JSON, error envelope `{ error: { code, message,
  details } }`. Mutations accept an `Idempotency-Key` header (deduped server
  side) **except** the credential-issuance routes which are exempt (raw secrets
  never persisted).
- **Control WebSocket** `/api/v1/ws` — realtime fan-out. Auth: browser session
  cookie (#34), or a device `control_session` bearer token, or dev escape
  (non-prod). Client sends `{type:"subscribe", topics, since_cursor?}`; server
  pushes `{type:"event", topic, event, cursor}` where `cursor` =
  `event_log.position` (monotonic).
- **Node WebSocket** `/api/v1/node?token=…` — compute-node plane (artood),
  not a UI surface.
- **Auth** `/auth/*` (origin root, not `/api/v1`) — Google OIDC start/callback,
  `/auth/session`, `/auth/logout`.

---

## 2. Read APIs (UI hydration)

| endpoint | feeds UI surface |
| --- | --- |
| `GET /api/v1/bootstrap` | org/user/projects/computers/agents/instances/model+effort profiles + current actor → app boot, nav context |
| `GET /api/v1/sync/cursor` | org max `event_log.position` → WS `since_cursor` hydration baseline |
| `GET /api/v1/tasks?project_id=` | left-rail / board task list |
| `GET /api/v1/tasks/:id` | task detail snapshot: task + room + runs[] + approvals[] + artifacts[] + **`version_cursor`** (task-scoped OCC base) |
| `GET /api/v1/tasks/:id/dag` · `/dependencies` | task DAG / dependency view |
| `GET /api/v1/tasks/:id/audit-bundle[/export]` | audit/traceability surface |
| `GET /api/v1/rooms/:id/messages` | task room message stream |
| `GET /api/v1/runs/:id` | run detail / timeline |
| `GET /api/v1/approvals` | approval inbox |
| `GET /api/v1/computers/:id/runtimes` | computer runtime/presence |
| `GET /api/v1/devices` · `/devices/:id/presence` | devices list + presence |
| `GET /api/v1/memories[/context]` · `/memories/:id` | memory surfaces |
| `GET /api/v1/skills` · `/skills/:id` | skills surfaces |
| `GET /api/v1/projects/:id/leases` | concurrency/lease view |

## 3. Command APIs (mutations)

Idempotency-Key on all; offline-queued + replayed by the canonical
`@artoo/client` command queue (#27). Optional `base_version` (from a read's
`version_cursor`) gives optimistic concurrency → `409 conflict` with
`{reason:"stale_base_version", base_version, current_version, resource}`.

- Task lifecycle: `POST /tasks` · `/tasks/:id/ready` · `/assign` · `/retry` ·
  `/review` (review accepts `base_version`).
- Dependencies: `POST/DELETE /tasks/:id/dependencies`.
- Rooms: `POST /rooms/:id/messages`.
- Runs: `POST /runs/:id/cancel`.
- Approvals: `POST /approvals/:id/resolve`.
- Memory: `POST /memories` · `/memories/:id/supersede` · `/memories/:id/:action`.
- Skills: `POST /skills/install`.
- Leases: `POST /leases` · `DELETE /leases/:id`.
- Devices (issuance/lifecycle): `POST /devices/pairings` (create code) ·
  `/devices/claim` (code-authed, guard-exempt, rate-limited, returns raw
  control+node tokens ONCE) · `/devices/:id/enroll` · `/devices/:id/revoke`
  (revokes + closes live sockets).

## 4. Realtime / sync model

- WS topics: `task:<id>`, `room:<id>`, `run:<id>`, `project:<id>`, `inbox:<user>`.
  (Device presence currently emits `device.presence_changed` to the event log;
  no `device:<id>` topic yet — **gap**, see §7.)
- Recovery: client tracks max `cursor`, dedupes by event id, reconnects with
  `since_cursor` for exact catch-up (slice 1). UI should show a connected/
  reconnecting indicator and an **offline** state when the command queue has
  pending items.
- Optimistic UI: a command's result reconciles via the returned record + the
  realtime event; conflicts surface the stale-version record to the user.

---

## 5. State vocabulary (drives UI badges — shared across clients)

- task status: `backlog | ready | assigned | running | awaiting_approval |
  blocked | review | done | cancelled`
- priority: `p0 | p1 | p2 | p3`
- run status: `queued | starting | running | awaiting_input | paused |
  completed | failed | cancelled`
- device trust/presence: trust `active | revoked`; presence `online | stale |
  offline`
- pairing code: `pending | claimed | expired | cancelled`
- approval status: `pending | approved | rejected | needs_more_info | expired`;
  approval resolve decisions `approved | rejected | needs_more_info`; risk
  `low | medium | high`

(Maps to semantic color tokens in the UI system spec §6.)

---

## 6. Cross-client model

- **Shared by Web/Mac/Windows Electron** (one renderer): all of the above, in a
  3-pane workspace + board + secondary pages. Desktop packages add a preload
  bridge (`serverUrl`, platform) and local `artood` supervision context.
- **iOS (native, drill-down)**: same read/command/sync/auth contract, but IA is
  Tab + NavigationStack + sheets: Inbox (approvals/needs-action), Tasks (list →
  detail), Run summary, Approvals. iOS is a control surface — it does **not**
  host a local node (mobile controls remote nodes only).
- **Intentional differences**: desktop shows 3 panes simultaneously (scan +
  compare); iOS drills down one level at a time and uses sheets for create/action.

---

## 7. Known gaps (raise as separate tasks if UI needs them — do NOT change contract here)

- No `device:<id>` realtime topic for device presence (event_log only); a live
  devices/presence UI would want one.
- No first-class `GET /api/v1/agents` / `/computers` list endpoints beyond
  `bootstrap` (inventory pages read from bootstrap today).
- No server-driven notification/toast feed; client synthesizes feedback.

These are observations for IA completeness, not part of the #44 renderer refactor.
