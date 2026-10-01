# Native work management UI — second implementation milestone

This pass builds on the conversation-first native UI. It addresses remaining navigation, information hierarchy, and long-content problems without adding server features.

## Changes and their purpose

- **Goals and plans:** the outcome, success criteria, planning, linked tasks, checkpoints, goal controls, and audit export have distinct sections. The goal title is readable content instead of an uppercase section header. Pause, resume, reconcile, and confirmed cancellation remain above long plans and task histories, with their existing API behavior. Plan proposals number their tasks; the first task no longer displays a dependency toggle that cannot affect its request.
- **Agent planning:** participants are numbered and separate from discussion limits. Agent selection shows name, computer, runtime, workspace, and a complete instance identity when rendered details collide. Duplicate selections have an explanation. A disabled or removed selection remains explicit and blocks a new request; a pending start still retries its original body and idempotency key.
- **Memory and skills:** memory detail shows the content once, with guidance for its actual review state. Replacement copy now describes the server's real behavior: the replacement becomes accepted immediately and the old memory becomes superseded. Skills show readable groups for files, network destinations, secret references, services, high-risk actions, and approval requirements. Raw permission JSON and manifest source remain available in disclosures. Manifest input disables automatic capitalization and correction.
- **Run history:** rows lead with the task, execution status, sequence/title, local date, and failure context. Search supports task names, statuses, and exact run IDs. Empty and no-match states explain the next step. Complete run identities remain available in the summary.
- **Team and setup:** agent rows expose computer/runtime context and collision identity. Workspace path fields support multiple lines. An empty runtime inventory explains how to populate it. Pairing fields keep visible labels after entry, and the one-time code uses the system code content type. Next advances through the server and device name fields; Done dismisses the keyboard while Connect remains an explicit action. Short instructions lead into the form, with account-permission guidance below it.
- **Large text:** metadata switches from label/value columns to vertical rows at accessibility sizes. Status badges can wrap. Task badges and execution headings adapt instead of forcing a single horizontal line. Native grouped lists/forms keep their platform layout on phone and iPad.

## Retained contracts

All 68 pre-existing accessibility identifier declarations and all API route literals in the six edited source files remain present. The task's model-owned feedback, review history, artifact provenance, stop confirmation, and execution-workspace controls remain intact. Goal cancellation still requires the existing explicit alert. Pending discussion retries bypass fresh-selection validation only to resend their captured request unchanged. No UI test helper, request model, server route, or networking implementation was edited in this pass.

Approvals, artifact previews, devices, privacy, and workspace settings were audited. Their existing decision boundaries and navigation were retained; shared metadata and badge improvements benefit their existing content where applicable.

## Verification

- Native static contracts passed: 22 request specimens, 51 routes, and existing realtime, draft, idempotency, Keychain, onboarding, and icon checks.
- Native UI-suite contract tests passed: 16 tests. These validate suite selection and retained-evidence rules, not a simulator run.
- Each of the six edited Swift source files parsed with the repository's tree-sitter Swift grammar using the serial WebAssembly compilation flags needed on this Windows host.
- The identifier/route preservation audit and `git diff --check` passed.

Xcode type checking, XCTest, screenshots, VoiceOver, and physical keyboard/layout behavior still require Apple CI. Visual verification should cover a small phone and iPad in light/dark appearance, the largest accessibility text size, long task/goal names, a duplicate-name planning team, unavailable planning selections, memory replacement, a failed run, and pairing with the keyboard visible. No native runtime or visual acceptance is claimed from Windows checks.
