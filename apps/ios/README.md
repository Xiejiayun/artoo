# Artoo iOS trusted-team preview

The SwiftUI client opens into real-server onboarding. An owner/admin signs in to
the Web app, creates a pairing code for **iOS**, and enters that code together
with the server origin on the phone. The app stores only the control credential
in a device-bound Keychain item. It never stores the compute node token.

Use HTTPS for the shared server. Local development can explicitly permit
`http://localhost` or a `.local` hostname; `localhost` on a physical phone points
to that phone. No manual token input, source edits, or mock fallback is needed.
Signing out revokes the current control credential on the server before clearing
the local Keychain entry. An expired or revoked credential returns to pairing.

## Implemented surfaces

| Surface | Behavior |
| --- | --- |
| Inbox | Pending approvals; approve, reject, request information; errors retain the decision screen |
| Tasks | Project-scoped list, search/filter, create with criteria/capabilities, ready, assign with agent picker, retry, review feedback |
| Task execution | Ready-task execution approval requests with risk/summary, single-use approval before assignment and fresh review for retries; live run status, cancellation, artifact download/Quick Look/share |
| Team discussion | Messages, decisions, agent handoffs, blockers and their state transitions |
| Dependencies | Select a prerequisite task, add/remove blocking dependencies |
| Goals | Create, propose plans with task criteria/capabilities/dependencies, accept/reject, pause/resume/cancel, checkpoint reconciliation, child tasks, audit export |
| Team | Computer connection/presence, advertised runtimes, configured agent instances, admin create/enable/disable |
| Memory | Propose project memory, accept/reject, propose replacement, inspect current state |
| Skills | Installed capabilities/permissions/manifests, administrator manifest installation |
| Devices | Device inventory, one-time pairing codes, owned/admin device revocation |
| Workspace | Project selection, administrator project creation, session identity, server connection and logout |

Visible screens refresh every eight seconds while active and immediately after
returning to the foreground. Session identity is revalidated every thirty
seconds; every API request independently receives server authorization. Requests
use bearer headers, same-origin paths, an ephemeral cookie-free URLSession and
no redirects. Failed commands surface the server error and do not report success.

`MockApiClient` remains an explicitly injected preview/unit-test fixture; the
production default never switches to mock data after an error.

## Windows verification

From the repository root, after building the domain package:

```powershell
node apps/ios/scripts/verify-contracts.mjs
```

This checks seventeen representative native request bodies against the actual
server schemas plus execution-approval and assignment response fixtures, verifies thirty-six required endpoint declarations, and checks
the live-onboarding/Keychain policy and app icon dimensions. It does not execute
Swift or replace native integration tests.

Optional Swift syntax parsing without modifying repository dependencies:

```powershell
$parserDir = Join-Path $env:TEMP 'artoo-swift-parser'
npm install --prefix $parserDir --no-save --package-lock=false --ignore-scripts web-tree-sitter@0.20.8 tree-sitter-wasms@0.1.13
npx --yes --package=node@22 node apps/ios/scripts/check-swift-syntax.cjs $parserDir
```

Use Node 22 for this legacy parser runtime; Node 24's WebAssembly optimizer can
crash on parser teardown. Syntax parsing is not Swift type checking.

## Mac verification gate

This revision was authored on Windows. Its Xcode build, XCTest execution,
simulator/device UI and live phone/server flow remain **unverified**, explicitly
deferred until a Mac is available. Previous source-build evidence does not prove
this revision. The full asset catalog must be included in verification.

```bash
brew install xcodegen
cd apps/ios
xcodegen generate
xcodebuild -project Artoo.xcodeproj -scheme Artoo \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build-for-testing
xcodebuild -project Artoo.xcodeproj -scheme Artoo \
  -destination 'platform=iOS Simulator,name=iPhone 16' test
```

Choose an installed simulator listed by `xcrun simctl list devices available`.
The project targets iOS 17 and Swift 5.9; use Xcode 15 or newer. No generated
`.xcodeproj` is committed; `project.yml` owns its configuration and resources.

The native tests cover DTOs, unknown statuses, task lifecycle view models,
production onboarding, server-origin rejection, session roles, Keychain
round-trips, bearer requests, one-time pairing, 204 logout, 401 expiration,
cross-origin request rejection, preserved errors, the run/scheduler assignment response,
single-use execution approval and superseded history, retry-to-ready behavior and goal dependency encoding.

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

Signing, provisioning and TestFlight distribution require the team's Apple
developer settings on the Mac. This repository contains no signing secrets.
