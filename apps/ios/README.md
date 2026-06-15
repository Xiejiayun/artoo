# artoo iOS — native SwiftUI client

A native SwiftUI control surface for **artoo** (the agent-team operating system).
This is the #18 v1 mobile slice: an **Inbox/Approvals-first** mobile work
surface plus the task lifecycle loop (`create → ready → assign → run → review`).

> ## ⚠️ UNVERIFIED — Windows-authored, macOS/Xcode-pending
>
> This entire app was written on a **Windows** machine that has **no iOS SDK,
> no Swift compiler, and no Xcode**. Per @jeremy-xie's decision (2026-06-15,
> *"先写 Swift 源码不验证"*) the Swift source is delivered **without being
> compiled, run, or tested** here.
>
> **Nothing in this directory has been built or executed.** Treat it as a
> reviewed-by-eye source draft. The first real verification happens when someone
> opens it in Xcode on a Mac (see *Build & run* below). Expect to fix compile
> errors and reconcile the API contract against the live server on first build.
>
> This app is intentionally **not** part of the repo's Node/Vitest/`tsc -b`
> build — the root `npm install/test/typecheck/build` skip it. The empty
> `package.json` exists only so the `apps/*` workspace glob tolerates a
> Swift-only directory.

## Build & run (macOS)

The Xcode project is **not** committed — it is generated from `project.yml` by
[XcodeGen](https://github.com/yonaskolb/XcodeGen), so we never hand-maintain a
`.xcodeproj` on Windows.

```bash
brew install xcodegen          # one-time
cd apps/ios
xcodegen generate              # writes Artoo.xcodeproj from project.yml
open Artoo.xcodeproj           # build + run on the iOS Simulator (Cmd-R)
```

Run the unit tests:

```bash
xcodebuild \
  -project Artoo.xcodeproj \
  -scheme Artoo \
  -destination 'platform=iOS Simulator,name=iPhone 15' \
  test
```

Requirements: macOS, Xcode 15+ (iOS 17 deployment target), XcodeGen.

## Mock vs. live server

The app **defaults to an in-memory mock** (`MockApiClient.demo()`), so it runs in
the Simulator immediately with seeded fixtures — no server required. To talk to a
real artoo server, edit `AppConfig` in `Sources/App/ArtooApp.swift`:

```swift
AppConfig(useMock: false, baseURLString: "http://localhost:4000", projectId: "proj_artoo")
```

`NSAllowsLocalNetworking` is enabled so plain-http `localhost` works in dev.

## Architecture

Protocol-oriented, dependency-injected, and previewable. Every view depends on
`ApiClientProtocol`, never on a concrete client, so screens render under both the
mock and the live client.

```
Sources/
  App/         ArtooApp (@main), AppContainer (DI + bootstrap), RootView (TabView)
  Models/      Codable DTOs matching the server's snake_case JSON
               (.convertFromSnakeCase). Status enums decode unknown values to
               `.other(raw)` so the UI never breaks on a new server status.
  Networking/  ApiClientProtocol, ApiClient (URLSession async/await, Idempotency-Key
               on mutations), MockApiClient (actor, mutable in-memory store)
  ViewModels/  @MainActor ObservableObjects with a shared ViewState<T> load enum:
               InboxViewModel, TasksViewModel, TaskDetailViewModel
  Views/       InboxView (+ ApprovalDetailView), TasksView (+ CreateTaskView),
               TaskDetailView (+ AssignSheet, RunSummaryView), shared Components
Tests/
  ArtooTests/  ModelsTests (JSON decode/encode, unknown-status fallback),
               ViewModelsTests (load → resolve, grouping, create, lifecycle actions)
```

### Screens (this slice)

| Screen            | Backed by                                   |
|-------------------|---------------------------------------------|
| Inbox             | `GET /approvals?status=pending`             |
| Approval detail   | `POST /approvals/:id/resolve`               |
| Tasks (grouped)   | `GET /tasks?project_id=:projectId`          |
| Create task       | `POST /tasks`                               |
| Task detail       | `GET /tasks/:id` (snapshot)                 |
| Lifecycle actions | `ready` / `assign` / `retry` / `review`     |
| Run summary       | from the task snapshot (`GET /runs/:id` ready) |

These mirror the endpoints exercised by `apps/web` against the current v1
server contract.

## API contract assumptions (reconcile on a Mac with the live server)

The request/response shapes were inferred from `apps/web/src/api/client.ts` and the
domain schemas. **Verify these before shipping the iOS client** — they are the
most likely source of first-build mismatches:

- Base path `/api/v1`. Endpoints as in the table above.
- Bootstrap is `GET /api/v1/bootstrap` returning `{ organization, user, projects[], actor }`.
- Task list returns `{ tasks: [...] }`; task detail returns the snapshot
  `{ task, room?, runs[], approvals[], artifacts[] }`.
- Lifecycle endpoints return `{ task, run? }`; approvals resolve returns `{ approval }`.
- Mutations send an `Idempotency-Key` header (random UUID per call).
- Timestamps are decoded as raw ISO-8601 strings (no `Date` parsing).

## Not in this slice (follow-ups)

- **WS realtime** (`/api/v1/ws`) — screens are pull-to-refresh for now; live
  `task:`/`run:`/`approval:` subscriptions are a follow-up.
- **Auth** beyond an optional bearer token (embedded v0.1 bootstrap is unauthenticated).
- **Rich agent picker** for assign — currently a minimal auto/manual type+id
  sheet; a picker over the backed Agents inventory is a product follow-up.
- Push notifications, offline cache, voice.

## Open contract questions

Tracked in the #18 thread rather than guessed at:

- First Mac build may reveal Swift syntax/XcodeGen issues; none of the Swift code
  has been compiled on this Windows machine.
- Live-server verification should confirm the Swift DTO optionality for fields
  the web client does not render yet, especially messages, run timing, and room
  display metadata.
- Live-server verification should confirm assignment request fields
  `{ mode, agent_instance_id?, model_profile_id?, effort? }` before building a
  richer manual routing picker.
