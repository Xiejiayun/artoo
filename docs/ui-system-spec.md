# Artoo UI System Spec (v2-K / #46)

Reference-driven production UI system for Artoo's shared Web/Electron renderer
(Web, Windows desktop, macOS desktop) and the cross-client design language that
the native iOS client (#51/#52) mirrors. This spec is the hard acceptance ruler
for #47–#50 (and a token reference for #51/#52). It is implementation-blocking:
"has some CSS" is not acceptance — these tokens, components, states, and density
rules are.

Status: accepted baseline for implementation after SkywalkerCodex review, with
`docs/production-ui-gate.md` as the companion gate document. Implementation code
for #65-#88 must cite the relevant sections of both documents.

---

## 1. Product character & baseline

- **Character:** a calm, dense **production operations console** for running
  agent work — not a landing page, marketing site, or demo shell. Closest in
  spirit to Linear / GitHub Projects: information-first, low chrome, fast to scan
  and compare, keyboard-friendly.
- **Visual baseline:** **light mode first.** Dark mode is explicitly out of scope
  this round unless Jeremy requests it (tokens are authored so a dark theme is a
  later additive `:root` override, not a rewrite).
- **Platform stance:** Web/Electron share one renderer and one layout system.
  iOS does **not** copy the 3-pane desktop layout — it uses native
  NavigationStack / grouped lists / sheets (Apple HIG), but consumes the same
  tokens (color/type/spacing semantics) and the same status/priority vocabulary
  so the product reads as one family.

---

## 2. Mature references & mapping

Design is borrowed from shipped products and published design systems, not
invented. For each: **reference → borrowed pattern → Artoo surface → rejected (why)**.

### Design systems (token & component grammar)
- **GitHub Primer** → neutral gray scale, semantic state colors, compact
  controls, `Label`/`Token` badges, `Timeline` component → Artoo color tokens,
  status/priority badges, run/approval timeline. *Reject:* Primer's marketing
  density on some pages — Artoo stays denser.
- **Atlassian Design System** → issue-tracker IA: list + detail split, status
  lozenges, field metadata grids, inline edit affordances → task list/detail,
  task metadata grid, status lozenge semantics. *Reject:* Jira's heavy
  borders/visual noise and modal-heavy flows.
- **Microsoft Fluent** → focus ring system, elevation tiers, command bar,
  accessible contrast targets → focus tokens, elevation scale, filter/command
  bar. *Reject:* Fluent's rounded, chunky control proportions — Artoo is tighter.

### Work dashboards (layout, density, flows)
- **Linear** → restrained palette, tight row density, keyboard-first, minimal
  badges, left nav + content, instant view switching → app shell, list density,
  badge restraint, nav model. *Reject:* full command-palette-first interaction
  (deferred to a later phase, not in #47).
- **GitHub Projects / Issues** → board column view, detail right-rail metadata,
  activity timeline, top filter bar → board, task detail right rail, run +
  approval timelines, filter/search bar. *Reject:* over-full toolbars.
- **Azure DevOps / Jira** → pipeline/run **step state** timelines, clear status
  color mapping, approval/review surfaces → run timeline step states, status
  semantic colors, approval inbox. *Reject:* visual clutter, dense chrome.

### Collaboration / IM (information architecture)
- **Slack / Discord** → 3-column shell (nav / list / main), message-stream
  cards, presence dots → workspace 3-pane, task room message stream, device/agent
  presence indicators. *Reject:* colored workspace switcher rail (single-org
  console doesn't need it), social emoji/reaction noise.
- **Teams / WeChat** → skeleton loading, friendly empty states, unread/needs-action
  signaling, toast notifications → loading skeletons, empty states, inbox badge,
  toasts. *Reject:* rounded "chat bubble" proportions; chat-first IA.

### iOS (mirrored by #51/#52)
- **Apple HIG** → NavigationStack/TabView, grouped lists, sheets, Dynamic Type,
  44pt hit targets, semantic colors → all iOS surfaces. *Reject:* porting the
  desktop 3-pane onto iPhone.

---

## 3. Design tokens

Authored as CSS custom properties on `:root` (web) and mirrored as a Swift token
enum (iOS). Names are semantic, not literal, so theming is a token swap.

### 3.1 Color — neutrals (light)
| token | value | use |
| --- | --- | --- |
| `--bg` | `#f6f7f9` | app background |
| `--surface` | `#ffffff` | cards, panels, nav |
| `--surface-2` | `#fbfcfd` | subtle raised/inset |
| `--surface-3` | `#eff1f4` | hover/track/column bg |
| `--border` | `#e3e6ea` | hairline dividers |
| `--border-strong` | `#d2d7de` | control borders |
| `--text` | `#1b1f27` | primary text |
| `--text-muted` | `#5b6573` | secondary text |
| `--text-subtle` | `#8a94a3` | tertiary/placeholder |

### 3.2 Color — brand & semantic
| token | value | use |
| --- | --- | --- |
| `--accent` / `--accent-hover` | `#4f46e5` / `#4338ca` | primary actions, active nav, selection |
| `--accent-soft` | `#eef0fe` | selected row / active pill bg |
| `--success` / `--success-soft` | `#15803d` / `#e7f6ec` | done / online / completed |
| `--warning` / `--warning-soft` | `#b45309` / `#fdf1e0` | review / awaiting / stale |
| `--danger` / `--danger-soft` | `#b42318` / `#fdeceb` | blocked / failed / revoked / offline |
| `--info` / `--info-soft` | `#1d6fd1` / `#e8f1fc` | running / in-progress |
| `--neutral` / `--neutral-soft` | `#475467` / `#eef1f4` | backlog / default |

Status/priority/presence **must** map to these semantic tokens (see §6), never
ad-hoc hex.

### 3.3 Typography
- Family: `Inter` (bundled) with system fallback (`-apple-system, "Segoe UI",
  Roboto, …`); mono: `ui-monospace, SFMono-Regular, Menlo, Consolas`.
- Scale (size / line-height / weight):
  `display 20/28/650` · `h1 17/24/650` · `h2 15/22/600` · `h3 13/18/600` ·
  `body 14/20/450` · `small 13/18/450` · `caption 12/16/500` ·
  `mono 12/18/450`. Letter-spacing 0 (no negative tracking).

### 3.4 Spacing, radius, elevation, motion
- Spacing grid (4px base): `4 / 8 / 12 / 16 / 24 / 32 / 48`.
- Radius: `sm 6` · `md 8` · `lg 12` · `pill 999`.
- Border: 1px hairlines; elevation `e1` (cards) `0 1px 2px rgba(16,24,40,.06)`,
  `e2` (popover/menu) `0 4px 12px rgba(16,24,40,.10)`, `e3` (modal) `0 12px 32px
  rgba(16,24,40,.18)`.
- Focus ring: `0 0 0 2px var(--surface), 0 0 0 4px var(--accent)` (2px offset),
  always visible on keyboard focus.
- Motion: 120ms ease for hover/bg, 160ms ease-out for enter; respect
  `prefers-reduced-motion`.
- z-index layers: base `0`, sticky nav `20`, dropdown `30`, toast `40`, modal `50`.

---

## 4. Component inventory (each with required states)

Every interactive component must define **default / hover / active / focus-visible
/ disabled** plus, where relevant, **selected / loading / error**.

- **App shell**: sticky top nav (brand, primary nav items w/ active pill, global
  search, inbox indicator, account), scrollable content region.
- **Nav item**: default / hover / active(pill) / focus.
- **Button**: variants `primary` / `secondary` / `ghost` / `danger`; sizes
  `sm` / `md`; + icon-only; loading spinner state; disabled.
- **Input / Select / Textarea / Search**: default / focus / error / disabled;
  label + helper/error text.
- **Tabs / Filter chips / Segmented control**: selected vs rest.
- **Card / Panel**: surface + border + e1; header/body/footer slots.
- **List row** (task row): title + status + priority + meta; hover; selected
  (accent-soft); keyboard focus.
- **Detail panel**: title, metadata grid, action bar, sectioned content.
- **Badge / Lozenge**: status, priority, presence, count — semantic-colored,
  pill, 11–12px, capitalized.
- **Timeline item** (run/approval): step state dot + label + timestamp +
  payload; states pending/running/completed/failed.
- **Approval card**: summary, risk badge, action buttons, result state.
- **Message card** (task room): actor, time, body, system-notice variant.
- **Table** (runs/audit/inventory): header, zebra-free hairline rows, sortable
  affordance, empty row.
- **Modal / Sheet**: overlay + e3 panel; web modal, iOS sheet.
- **Toast**: success/info/warning/danger, auto-dismiss + manual close.
- **Tooltip**: on hover/focus, delayed.
- **Skeleton**: shimmer placeholders for list/detail/cards.
- **Empty / Error / Offline states**: dashed container + concise copy + optional
  primary action; offline shows queued-command count (ties to #27 command queue).

---

## 5. Density & layout rules

- Desktop content max-width for reading surfaces (memory/audit) ~1100px; work
  surfaces (workspace/board) use full width.
- Workspace 3-pane grid: left rail `290px` · center `minmax(0,1fr)` · right
  `380px`; each pane scrolls independently; collapse right pane <1100px, stack
  <720px.
- List row vertical padding `8px`, comfortable hit target ≥32px; board card
  padding `12px`; nav height `52px`.
- Repeated-scan optimization: consistent left alignment, fixed badge column
  positions, monospace for ids.

---

## 6. Semantic vocabulary (shared across clients)

| domain | values → token |
| --- | --- |
| task status | backlog→neutral, ready→info-soft, assigned→neutral, running→info, awaiting_approval→warning, blocked→danger, review→warning, done→success, cancelled→danger |
| priority | p0→danger, p1→warning, p2→accent, p3→neutral |
| run status | queued→neutral, starting→info-soft, running→info, awaiting_input→warning, paused→warning, completed→success, failed→danger, cancelled→danger |
| device/agent presence | online→success, stale→warning, offline→neutral/danger; revoked→danger |
| approval status/risk | pending→warning, approved→success, rejected→danger, needs_more_info→warning, expired→neutral; risk low→neutral, medium→warning, high→danger |

This vocabulary is the single source for badges on every client (web + iOS).

---

## 7. Accessibility & responsiveness

- WCAG AA contrast for text/icons on their backgrounds (semantic-soft pairs
  chosen to pass).
- Visible focus ring on all interactive elements; full keyboard operability of
  nav, lists, actions.
- Hit targets ≥32px desktop / 44px iOS; Dynamic Type respected on iOS.
- No text truncation that hides meaning without tooltip; no overlap/broken layout
  at desktop (≥1280, ~1024) and mobile (~390) widths.

---

## 8. Evidence checklist (per implementation task #47–#50)

A task is reviewable only with:
1. **Before/after screenshots** of every touched surface (web dev viewport).
2. **Packaged Windows** `npm run smoke:win --workspace @artoo/desktop` pass +
   screenshot; **packaged Mac** recheck requested from @iOSMacCodex.
3. `npm run typecheck`, `npx vitest run apps/web/src`, `npm run build --workspace
   @artoo/web`, web Playwright e2e — all green (no flow/behavior regression).
4. **Reference-mapping note**: which §2 references this surface implements.
5. No server-contract change (this is a renderer-only refactor); if a real
   contract gap is found, raise a separate task — do not silently change it.

---

## 9. Sub-task scope mapping (#47–#50)

- **#47 (K2 foundation)**: tokens (§3), icon set (lucide), base components
  (§4 button/input/select/badge/card/tooltip/toast/modal/skeleton) + all
  interaction/loading/empty/error/offline states. **Blocks #48–#50.**
- **#48 (K3 shell)**: app shell, global nav, workspace 3-pane layout, responsive.
- **#49 (K4 work surfaces)**: task list/detail, task room, run timeline,
  approvals, filters/search.
- **#50 (K5 secondary)**: board, memory, agents/computers/skills, runs/audit,
  login.
