# Artoo onboarding and Web experience delivery

Status: implementation complete; final main checks, merge and production publication remain pending. This document is a delivery checklist, not evidence that the work has shipped.

## Requested outcome

- A single command on a target machine installs and connects artood, securely saves its own identity and starts the daemon. No manual node URL/token/ID environment configuration or separate administrator enrollment for an owner/admin setup.
- After a machine connects, the user selects an existing logical Agent and creates an instance on an available runtime and permitted workspace. An Agent and its instances remain distinct.
- Rebuild the complete Web visual language and interaction structure around `C:\Users\jiaxie\Downloads\多智能体项目管理平台`: dark/light shell, project sidebar, Agent Squad, Thread / Plan / Board / Release navigation, machine management, clear dialogs and task details, and responsive layouts.
- Preserve live authorization, persistence, approval, execution and release contracts. The supplied reference's mock data and simulated execution are design references only.
- Merge the finished change to `main`, publish the daemon version used by the install command, and deploy the latest Web portal to `https://artoo.jeremyxie.com` through GitHub Actions.

## Acceptance evidence required

1. A fresh Windows and Linux user setup runs the displayed command against an authenticated pairing flow; exact machine presence becomes online. Saved setup survives restarting and does not rely on the npm cache. Reconnect/start/stop/status and failed/expired enrollment are verified. No long-lived tokens in argv, logs, repo or model-child environments.
2. Web pairing progress is bound to the exact pairing, and instances use the selected existing Agent without silently creating another identity. Unsupported runtimes, other organizations, invalid roots and expired/revoked access fail safely.
3. Browser checks cover sign-in, project navigation, conversation, planning, board, task details, release history, Machines, Agent library, Settings, light/dark mode and narrow screens, using real local API data. Visual comparison uses the supplied design project.
4. Repository-required typecheck, build, unit/integration and Web E2E gates pass. Release gates remain intact; fixture tests are reported separately from live setup or production evidence.
5. GitHub `main` contains the reviewed version. Required Actions checks bind to that immutable source. The public daemon install command resolves to the shipped package and integrity record.
6. GitHub Actions builds and deploys an immutable image to the existing Singapore Container App, preserving external database/blob storage and the custom domain. A fresh encrypted backup and recovery plan exist before migration. Production health, login and static assets identify the deployed source; the live machine/instance flow is checked afterward.

## Implementation boundaries

Continue the existing Azure/Supabase branch and update PR #33 to the final scope. Do not alter unrelated VPN, VM, `canvas`, or DNS resources. Do not use deployment fixtures as proof of production or model execution. Do not retire the existing production revision until the validated release and recovery path are prepared.

## Implemented behavior

- Versioned GitHub installers prepare Node.js when needed, verify the published package and run `connect`; credentials and retained executable files live outside task workspaces and the npm cache. Repeated connection retains the same machine identity. OS boot/login auto-start is not registered.
- Machines presents actual runtime and instance inventory. The creation form reuses existing Agents, checks runtime compatibility and suggests the current node's advertised workspace roots. A required heartbeat is a complete runtime snapshot; removed runtimes become missing without discarding their last observation metadata.
- The Web shell uses the supplied design's dark/light theme, project sidebar, Agent Squad and four project views. Plan's outcome composer enters the existing confirmation flow, Board filters actionable work, and Release displays recorded executor evidence. Existing task, device, approval and publication paths are retained.
- Production workflows bind required checks, daemon artifacts and container images to the exact main source. The Azure executor verifies an encrypted backup and an isolated PostgreSQL restore before switching the single server; incompatible database history prevents automatic image rollback.

Production acceptance is limited to connection and existing-Agent instance creation until the operator signs in to the local model CLI. The operator explicitly selected this scope on 2026-11-11. Controlled model fixtures do not establish live model execution.
