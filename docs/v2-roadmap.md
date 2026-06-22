# Artoo v2 Roadmap

This document starts the v2 workstream after the v1 release-candidate audit.
v2 turns Artoo from a web-first control plane plus local node prototype into a
multi-client product with installable control surfaces and managed local runtime
nodes.

## Release Principles

- Do not claim a platform is directly installable or runnable until that exact
  platform has a recorded build, install, launch, and smoke-test result.
- Keep source delivery separate from installable delivery. Source can be merged
  before a platform runner exists, but release notes must say when it is
  unverified.
- One backend service should serve every client. Client-specific behavior must
  stay behind shared read, command, sync, and auth contracts.
- Desktop clients may supervise a local `artood` node. Mobile clients are first
  control surfaces; local runtime execution on mobile is a later platform-risk
  decision.
- Every v2 slice must preserve the v1 self-host loop: create task, assign,
  execute through a node/runtime, review artifact, accept, and export evidence.

## Client Matrix

| Client | v2 target | Verification rule |
| --- | --- | --- |
| Web | Existing browser control surface remains the reference UI | Must pass Playwright release flows |
| Windows desktop | Installable desktop app that can connect to a server and supervise local `artood` | Must build, install, launch, and run smoke on Windows |
| macOS desktop | Desktop app source and package path | Installable claim requires real macOS runner or human Mac proof |
| Android | Mobile control surface for tasks, inbox, approvals, runs, and notifications | Must build APK and run an emulator/device smoke before installable claim |
| iOS | Existing SwiftUI source evolves into the Apple mobile client | Installable claim requires real macOS/Xcode build, simulator/device run, and tests |

## Architecture

### Shared Backend And API

The server remains the authority for tasks, rooms, approvals, runs, artifacts,
memory, skills, agents, computers, and audit bundles. v2 adds a client-facing
contract layer:

- read APIs for all product surfaces used by desktop and mobile clients;
- command APIs with idempotency keys for mutating actions;
- stable error envelopes suitable for offline retry and mobile display;
- typed API schema export for generated or manually synchronized SDKs.

### Cross-Client Sync

v2 sync builds on the current websocket topic model. The protocol should support:

- topic subscriptions for project, task, room, run, inbox, computer, and agent
  state;
- reconnect with resubscription;
- a client-visible event cursor or snapshot version for recovery;
- command acknowledgements that tie optimistic UI state back to server results;
- conflict records when offline commands cannot be replayed cleanly.

### Device Identity And Pairing

Every installed client should have a device identity distinct from a human user:

- device records with platform, app version, last seen time, and trust status;
- scoped device tokens that can be revoked without rotating user credentials;
- short-lived pairing codes or links for first setup;
- presence state for active clients and local nodes.

### Human Login And Google Auth

v2 must add real human login before installable multi-client release claims. The
default identity provider is Google OAuth/OIDC, using authorization-code flow
with PKCE as the primary contract:

- Google sign-in creates or links a durable user identity inside an Artoo org;
- web sessions use server-owned `HttpOnly` cookies with explicit expiry and
  logout/revocation behavior;
- desktop and mobile clients use the same server session model through bearer
  access/refresh tokens stored in platform secure storage after a system-browser
  PKCE login;
- OAuth state, nonce, redirect URI, issuer, audience, expiry, and PKCE replay
  protection are required before production enablement;
- local development keeps an explicit dev-auth fallback that cannot be enabled
  accidentally in production;
- device pairing and device-token issuance require an authenticated user, but
  device tokens remain separate from Google/user credentials;
- web, desktop, Android, and Apple clients must share the same login/session
  contract instead of each client inventing its own auth flow.

### Local Node And Runtime Control Plane

`artood` is the portable local node. v2 clients should be able to show and manage
its state without duplicating runtime logic:

- desktop app can discover, start, stop, and health-check a local `artood`;
- local node reports runtime capabilities through heartbeat;
- runtime logs and recent run status are visible from the control surface;
- workspace roots, allowed roots, and worktree base repo are explicit settings;
- mobile clients control remote nodes first, rather than spawning arbitrary local
  runtimes.

### Client Shell Strategy

Current direction after the #30 desktop spike review and #31 Android plan:

- keep the existing web UI as the reference product surface;
- use Electron as the first desktop shell because it is the fastest credible
  Windows path in the current Node-based toolchain and gives a direct
  main-process seam for supervising local `artood`;
- keep the #30 desktop spike open until a normal Windows machine or CI produces
  installer, launch, connect/read, and quit smoke evidence;
- keep Apple installable commitments gated on Mac verification;
- use React Native as the first Android implementation path so the mobile client
  can reuse the TypeScript client/domain contracts and later cover iOS if the
  product accepts that shell direction.

## Proposed Task Split

| Task | Lane | Primary output | Suggested owner |
| --- | --- | --- | --- |
| v2-A | Architecture/release definition | Final client matrix, shell decision, release gates, and task boundaries | `@codex_architect` |
| v2-B | Shared client API and sync foundation | Read/command API contract, websocket recovery model, typed SDK surface | `@claude_engineer` |
| v2-C | Device auth, pairing, and presence | Device records, token lifecycle, pairing flow, presence events | `@claude_engineer` |
| v2-D | Local node/runtime control plane | Client-managed `artood`, runtime status, settings, and local node smoke | `@claude_sde` |
| v2-E | Desktop shell spike | Windows package proof plus macOS packaging plan | `@claude` with runtime input from `@claude_sde` |
| v2-F | Android client | React Native control-surface plan and APK smoke path | `@claude` |
| v2-G | iOS and macOS verification | Mac runner setup, Xcode build/run/test, Apple release limitation removal | unassigned until Mac access exists |
| v2-H | Installer/release hardening | Cross-machine smoke, installer docs, update/uninstall checks, audit evidence | `@codex_architect` |
| v2-I | Google Auth login | OAuth/OIDC user identity, sessions, logout, client login surfaces, and device-pairing boundary | `@claude_engineer` with client integration from `@claude` |

## v2 Release Gates

- `npm run verify:v1` continues to pass until replaced by a broader v2 gate.
- Web Playwright release flows pass against the v2 API.
- Google Auth can complete auth-code + PKCE login, session refresh/validation,
  logout, and protected API access in automated tests with a fake OIDC provider;
  production Google credentials are never required for the default test gate.
- Production auth rejects dev-login paths and validates OAuth state, nonce,
  redirect URI, issuer, audience, expiry, and hosted-domain policy when
  configured.
- Windows desktop package installs, launches, connects to a server, and completes
  Google login plus a task approval/review smoke.
- Local `artood` supervision smoke proves start, heartbeat, runtime capability
  display, stop, and restart on at least Windows.
- Android APK builds and runs a Google login or fake-OIDC login, pairing, plus
  task/inbox smoke before any Android installable claim.
- macOS and iOS installable claims require real Mac evidence.
- Device tokens can be created, revoked, and refused after revocation.
- Offline command replay has tests for success, duplicate replay, stale state,
  and conflict surfacing.
- Audit export still redacts credential-shaped data and includes cross-client
  command/device evidence.

## Open Decisions

- Whether v2 needs push notifications in the first mobile release.
- Whether mobile clients should ever run local runtimes, or remain remote control
  surfaces only.
- Whether Electron package size becomes a hard enough requirement to revisit
  Tauri after the first Windows package proof.
- Mac runner availability for macOS desktop and iOS.
- Production Google Auth policy: allowed domains, invite-only org creation, and
  whether non-Google identity providers are required in v2.
