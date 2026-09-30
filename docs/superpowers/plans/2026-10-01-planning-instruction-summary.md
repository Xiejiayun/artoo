# Planning Instruction Summary Plan

**Goal:** Show compact, readable coordinator instructions in native and Web conversations, with exact original text available on demand.

**Execution:** Bounded parallel tasks with independent review. Root owns integration, both clients' E2E/screenshots, commits and pushes.

**Scope:** This isolated worktree starts at `2db6a98`. Do not change server messages, provider context, API routes, task-plan schemas, the primary workspace or the assignee-label worktree. This implementation stage permits focused Web component tests, Foundation-only model tests and static Swift parsing, but no application build, Xcode or simulator work.

1. **Web presentation** — modify `apps/web/src/components/MessageCard.tsx` and its component tests. Recognize only text replies from `system` / `discussion-coordinator` with a nonempty thread root, `intent: discussion`, nonempty string discussion/turn IDs, and a nonnegative safe integer step. Render `Planning instruction · Step N`, the brief below, and a collapsed original-instructions disclosure. Invalid or unknown metadata retains the original rendering.
2. **Native presentation** — add a small `Message.planningInstruction` projection and focused tests; update `MessageBodyView.swift` with the same brief and an accessible Show/Hide button exposing the exact original string. Preserve existing user roots and agent-plan rendering.
3. **Verification and delivery** — run focused Web tests and actual Foundation-only model tests, parse changed Swift sources, inspect scope and whitespace, then export a base-relative patch. Report pending native/Web E2E explicitly.

**Shared copy:** `The agents use the goal and earlier replies to prepare a plan. You review a proposal before accepting it.`

**Original text:** Never parse, summarize, normalize or rewrite `message.body`; the human-readable text is a view-only projection of the coordinator marker. The original disclosure must preserve whitespace, Unicode and JSON syntax exactly.

**Checks:** Valid coordinator collapsed/expanded/collapsed; exact body and message identity remain unchanged; user/agent/other-system actors, wrong intent, missing IDs/root, malformed/fractional/negative/unsafe steps all fall back; existing agent-plan tests stay unchanged.

**Completed local validation:** Node 24 focused MessageCard component tests passed 52/52. An isolated Foundation-only SwiftPM target assembled from the actual model/test sources passed 13/13 tests (6 new projection cases plus 7 existing identity/metadata cases). Changed Swift files passed frontend parsing and the patch passed whitespace checks. Independent review identified a Unicode whitespace difference; the native identifier guard now matches JavaScript trim, with U+FEFF/U+0085 regressions in both clients.

**Pending root validation:** Native SwiftUI typechecking, both clients' real UI expansion/collapse, compact/Pro screenshot review and existing provider-context hash E2E. No server, persistence or provider-context source was changed.

## Root integration status

The integrated Web implementation shares the strict display helper between
MessageCard and AssistantTurns, preventing the request list from duplicating
the complete coordinator body. All 71 focused MessageCard, AssistantTurns and
RoomConversation cases and Web typechecking passed. The installed Mac gate
verified all three original disclosures and human acceptance at
`2026-09-30T21:33:48.067Z`, with ten inspected images and full cleanup.
Native validation is recorded separately in the integration plan and milestone
ledger; earlier isolated-test results alone do not establish native UI success.

The integrated compact iPhone 16 / iOS 18.2 run subsequently passed 100 unit
and all seven Release UI cases. It verified all three coordinator summaries,
the exact final original instruction, proposal and human acceptance, and
retained 24 inspected client/browser captures. A matching signed development
arm64 archive passed. A fresh Pro/tablet or physical-device run is not implied.
