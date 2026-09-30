# Apple client release readiness

Source review started 2026-09-30. This document distinguishes implemented
behavior from release evidence and operator-supplied information. It is not an
App Store approval, a production acceptance report, or a legal privacy policy.
Use the HTML E2E report for the exact revision and environment being released;
older screenshots and successful simulator builds do not certify a new binary.

## Identity and device trust

Authenticated members can create pairing codes only for their own account in
the current organization. Claimed control credentials retain that account's
current role. Owner/admin authorization is separately required to enroll a
desktop execution computer; members can revoke their own devices. The HTTP and
service boundaries and regression coverage are in
[request-auth.ts](../apps/server/src/auth/request-auth.ts),
[device-service.ts](../apps/server/src/services/device-service.ts), and
[native-auth.test.ts](../apps/server/src/auth/native-auth.test.ts).

Pairing codes are credentials. Giving another person a code still gives that
person the creator's account access. Earlier onboarding told users to obtain
an owner/admin's code. Before upgrading an existing team, its administrator
must inspect previously paired devices, revoke any device paired with another
person's administrator code, and have that device's actual user sign in and
create a new personal code. The server cannot infer the intended user and does
not silently transfer old devices or their audit history.

## Privacy implementation and remaining policy work

[PrivacyView.swift](../apps/ios/Sources/Views/PrivacyView.swift) provides an
offline-readable description for onboarding and settings. It explains local
credentials and drafts, team-server processing, agent providers, shared files,
and the limits of sign-out. It intentionally contains no invented operator
name, contact address, privacy-policy URL, or data-retention promise.

| Data or behavior | Source evidence | Release treatment |
| --- | --- | --- |
| Device-bound local credential, server origin and device ID | [CredentialStore.swift](../apps/ios/Sources/Networking/CredentialStore.swift), [StoredConnection](../apps/ios/Sources/Models/WorkspaceModels.swift) | Keychain item uses `WhenUnlockedThisDeviceOnly`, with synchronization disabled. iOS ignores the compute credential. |
| Local conversation drafts and pending sends | [RoomMessagesViewModel.swift](../apps/ios/Sources/ViewModels/RoomMessagesViewModel.swift) | UserDefaults is scoped by server/account/conversation. Manifest declares `CA92.1`; sign-out does not erase these drafts. |
| Account identifiers and mentions | [request-auth.ts](../apps/server/src/auth/request-auth.ts), [RoomMessagesViewModel.swift](../apps/ios/Sources/ViewModels/RoomMessagesViewModel.swift) | Authenticated actions and submitted mention IDs are linked to team users. Manifest declares User ID for app functionality. |
| App installation device identifier | [device-service.ts](../apps/server/src/services/device-service.ts), [TeamViews.swift](../apps/ios/Sources/Views/TeamViews.swift) | Server-assigned device records are linked to the enrolling account; device IDs are used in management requests. Manifest declares Device ID; this is not an advertising identifier. |
| Messages and submitted task/goal/approval content | [ApiClient.swift](../apps/ios/Sources/Networking/ApiClient.swift), [message-service.ts](../apps/server/src/services/message-service.ts), [WorkspaceViews.swift](../apps/ios/Sources/Views/WorkspaceViews.swift) | Server retains submitted content and its actor. Manifest declares messages and other user content, linked to identity, for app functionality. |
| Account name and email | [auth-service.ts](../apps/server/src/auth/auth-service.ts), [SessionIdentity](../apps/ios/Sources/Models/WorkspaceModels.swift) | Web OAuth obtains identity details; iOS reads the server's account record. Publisher must assess the complete service's name/email disclosure rather than infer that an iOS read means no service-side collection. |
| Agent context and model providers | [context-pack-service.ts](../apps/server/src/services/context-pack-service.ts), [runtimes.ts](../apps/artood/src/runtimes.ts) | Conversation, task and project context reaches the configured execution runtime. Provider endpoints, processing terms and retention depend on the operator's runtime configuration. |
| Downloaded artifacts and exported audits | [ApiClient.swift](../apps/ios/Sources/Networking/ApiClient.swift), [WorkspaceViews.swift](../apps/ios/Sources/Views/WorkspaceViews.swift) | Temporary files use complete file protection. There is no sign-out purge; copies shared to another app follow that destination's handling. |

[PrivacyInfo.xcprivacy](../apps/ios/Resources/PrivacyInfo.xcprivacy) declares the
directly evidenced identifiers and user-content flows above. It declares no
cross-app tracking or tracking domains; the current native project has no
advertising/tracking SDK dependency. These declarations are a source-derived
baseline, not evidence that a particular server or provider has no additional
collection. Before distribution, the publisher must:

1. Identify the actual service operator and contact, processing locations,
   configured providers, server/proxy logs, retention periods and backup policy.
2. Publish the applicable privacy policy at an accessible URL, provide access
   inside the client, and set the URL in App Store Connect. The data-flow page
   does not substitute for this policy.
3. Reconcile the manifest, App Store privacy answers, actual deployed traffic
   and third-party SDK manifests. Assess name/email collection across the Web
   account flow and any diagnostics or other data added by that deployment.
4. Provide a documented account/content deletion or retention process for the
   service, including backups and downstream AI providers. There is no existing
   in-app account deletion workflow; evaluate the requirements for the chosen
   account and distribution model before public submission.
5. Verify that users understand what is sent to the selected AI provider and
   that any consent required for that deployment is implemented before sending.

## Release gates and external dependencies

| Priority | Current gap and evidence | Implementable next step | External information or credential |
| --- | --- | --- | --- |
| P1 | A real development-signed arm64 archive now passes; [project.yml](../apps/ios/project.yml) still uses `dev.artoo.app` and version/build defaults. | Repeat the [archive gate](apple-development-archive.md) for release source, then verify distribution export and TestFlight on supported phone/tablet sizes. | Distribution provisioning and App Store Connect app/bundle registration, build metadata and available physical devices. |
| P1 | Fresh unsigned DMG/ZIP creation and DMG installation E2E now pass; this does not prove a distributable trust chain. | Run the [Developer ID/notarization gate](../apps/desktop/MAC-DISTRIBUTION.md), then test signed installation, upgrade and removal on a clean Mac and each supported architecture. | Developer ID identity/private key, notarization profile and actual release hosting. |
| P1 | Desktop source has no implemented trusted update channel in [main.cjs](../apps/desktop/main.cjs) or package configuration. | Define a signed manual-update or automatic-update flow, publish version/checksum metadata, and verify upgrade preserves connection/settings and server compatibility. | Update policy, release endpoint and signing custody. |
| P1 | Operator policy details cannot be established from the source tree. | Complete the privacy steps above; keep onboarding and settings disclosures reachable without signing in. | Operator identity/contact, privacy-policy URL, retention/deletion terms and provider choices. |
| P1 | Production startup requires configured auth and durable storage in [main.ts](../apps/server/src/main.ts) and [auth-config.ts](../apps/server/src/auth/auth-config.ts). Fixture auth is not deployed Google login evidence. | Run real HTTPS/OIDC and WebSocket flows, device revocation and cross-client updates against the chosen staging deployment. | Controlled HTTPS origin, registered Google OAuth client/redirect, team allowlist/owners and securely managed secrets. |
| P1 | The isolated production-mode backup/restore drill passes, including credentials, records and exact artifact bytes after the original data is removed. | Repeat recovery on the chosen deployment, including off-site backup retrieval, host loss and documented recovery objectives. | Durable host/storage, backup destination/access, retention and recovery objectives. |
| P1 | Native and packaged-client acceptance must match the binary being shipped. | Save an HTML report with actual app screenshots for each Mac/iOS E2E run, including failure state and authentication/model-execution limits; retain reports in CI. | A usable Mac/Xcode simulator or device environment and credentials only for gates explicitly exercising real external services. |

No new P0 issue was confirmed by this source audit. That statement is limited
to the reviewed paths and is not a penetration-test or commercial-readiness
certification. The current architecture remains one trusted team per server;
multi-tenant hosted service isolation is a separate product and security scope.

Submission materials still require real screenshots of the shipping build,
support contact/URL, review access or a reviewable demo environment, export
compliance answers, age/category metadata and a decision on distribution and
pricing. A future paid digital feature must be reviewed against the applicable
store payment requirements; no billing behavior is inferred or added here.

## Local recovery evidence, 2026-10-01

The deterministic production-mode drill in `scripts/recovery-e2e.mjs` now
exercises the existing offline storage CLI through backup and restoration into
a different directory. It independently checks archive/artifact hashes,
rejects an online backup and unsafe restore targets, and removes the original
database and workspace output before verifying account/session and device
credentials, node reconnection, task/run/message records, artifact bytes,
idempotent replay and a real Web download. Eight checks and two actual browser
screenshots passed with complete cleanup in the local run beginning
`2026-09-30T16:43:22.347Z`. Its HTML/JSON live under
`artifacts/recovery/2026-09-30T16-43-22-347Z/`.

Run `npm run verify:recovery` to rebuild and repeat the drill. This closes the
missing repeatable local recovery evidence; the deployed, off-site and
operator-specific recovery requirements in the table remain open.

## Local distribution evidence, 2026-10-01

The Mac DMG run starting `2026-09-30T18:10:58.898Z` passed all 11 checks and
complete cleanup. It built new x64 DMG/ZIP artifacts, verified the exact DMG
checksum, installed the app from a read-only mount, checked copied renderer
and daemon bytes, detached before launch, and completed the existing task,
artifact, review and restart workflows. Four actual app screenshots are in
`apps/desktop/release/mac-dmg-smoke-artifacts/history/macos-dmg-2026-09-30T18-10-58-898Z.html`.
The gate also passed 46 worker regressions and eight distribution checks; the
separate optional tiny-filesystem DMG test was skipped. The product DMG was
actually built, mounted, detached and used for the full E2E.

The current native product source was independently archived as a signed
Release arm64 device app in the run starting `2026-09-30T18:32:09.609Z`.
The signature, Team, certificate, embedded development profile, app identifier,
compiled assets and privacy manifest passed verification. Its report is
`artifacts/ios-device/2026-09-30T18-32-09-609Z/report.html`. This is a development
archive, with no physical-device installation, TestFlight export or upload.
