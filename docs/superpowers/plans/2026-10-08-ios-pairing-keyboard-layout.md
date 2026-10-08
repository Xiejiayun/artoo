# Pairing Keyboard Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the focused pairing device-name field fully visible without corrective test gestures, while preserving native input and Done behavior.

**Architecture:** Retain the focused-only bottom safe-area inset whose intrinsic height participates in Form layout, and reveal the actual focused input row near the center with `ScrollViewReader`. Public `TextField.onEditingChanged` callbacks identify each editing activation by field and a fresh token; `FocusState` gates its initial reveal and at most one matching local keyboard-completion reveal. The shared native caret helper continues to require a stable, unobscured field for one second before its single caret touch and again afterward; it never scrolls or refocuses to manufacture visibility.

**Tech Stack:** SwiftUI Form and FocusState, iOS 17+, XCTest/XCUITest, existing hosted Preview gates.

## Global Constraints

- Work only in `/Users/jeremy/workspace/artoo-ios-pairing-scroll`; keep main unchanged until root accepts the hosted candidate.
- The current follow-up owns only `apps/ios/Sources/App/ArtooApp.swift` (`PairDeviceView` and its UIKit import) and this plan. The earlier passive-helper implementation below is retained unchanged.
- Preserve the `pairing.keyboard.done` identifier; add `pairing.keyboard.controls` for the in-layout container.
- Keep current Form content, title, focus/submit order, interactive dismissal and pairing behavior.
- No fixed keyboard padding, global screen-height inference or second full-visibility algorithm in product code. The narrow focus-reveal observer follows the existing composer's window/scene scoping; it does not reuse `ComposerKeyboardAvoidance` or calculate an inset.
- Keep `apps/ios/UITests/NativePairingInput.swift` byte-for-byte unchanged: SHA256 `86f63137ec9a58c0f5dd737aadd74ea971685e9c670a3c3d18b83328c08af118`. Preserve its eight-point visibility guard, values, timing, case contract and photo allowlist.
- Keep the original 22-photo Core allowlist and case contract. Do not add onboarding screenshots or record input values in diagnostics.
- This worker makes source-only changes. Root owns compilation, tests, source freezing, branch commit and hosted workflow dispatch after the active runtime closes.
- Earlier hosted failures and interrupted/boot-failed local attempts retain their original verdicts. Source edits alone are not qualification.

---

### Task 1: Reserve layout space for the pairing Done action

**Files:**
- Modify: `apps/ios/Sources/App/ArtooApp.swift` (`PairDeviceView` only).

**Interfaces:**
- Consumes: `focusedField: InputField?` and the existing `Form`.
- Produces: a focused-only safe-area bar, `pairing.keyboard.controls`, containing the existing `pairing.keyboard.done` button.

- [x] Replace `.toolbar { ToolbarItemGroup(placement: .keyboard) ... }` with `.safeAreaInset(edge: .bottom, spacing: 0)`.
- [x] Use an intrinsic-height `HStack` with `Spacer`, native Done button, semantic surface background, top divider and a minimum 44-by-44-point label and rectangular touch target:

```swift
Button { focusedField = nil } label: {
    Text("Done")
        .frame(minWidth: 44, minHeight: 44)
        .contentShape(Rectangle())
}
.accessibilityIdentifier("pairing.keyboard.done")
```

- [x] Give the bar `.accessibilityElement(children: .contain)` and `.accessibilityIdentifier("pairing.keyboard.controls")`; do not alter the form rows or submit handlers.

### Task 2: Require passive native visibility before editing

**Files:**
- Modify: `apps/ios/UITests/NativePairingInput.swift`.
- Existing callers: Core, Assistant, Correction and Retention UI suites use `positionDeviceNameCaret(_:in:expected:)`; their signatures and case selection remain unchanged.

**Interfaces:**
- Consumes: the exact `pairingDeviceName` text field, foreground app and unchanged current value.
- Produces: one native caret touch only after the field is wholly visible and stable; throws if the same condition is not restored after the touch.

- [x] Replace both small and larger corrective-drag branches with passive samples, a ten-second acceptance deadline per phase and at least one second of stable full-field/viewport geometry. A synchronous XCTest query can finish beyond that deadline; late samples cannot pass, and the enclosing test budget still bounds a stalled query.
- [x] Bound visibility by the application, Form, navigation bar, complete keyboard input/prediction region and the new controls container. Require one Done button inside that container, no separate keyboard toolbar, and a fully visible minimum 44-point target.
- [x] Use a fixed stable reference rather than accumulating sub-point drift. Keep exact value equality, finite geometry, enabled/hittable checks and trailing-caret containment.
- [x] After the single native caret touch, repeat the passive stability check before returning to callers that perform Delete/typeText.
- [x] Retain failure-only `.txt` JSON geometry with phase, timing, frames and boolean value-equality observations. Do not retain values, server URLs, pairing codes, raw hierarchies or arbitrary error strings.

### Task 3: Reveal the focused row after the safe-area-only failure

**Files:**
- Modify: `apps/ios/Sources/App/ArtooApp.swift` (`PairDeviceView` plus explicit UIKit import).
- Do not modify the passive helper, any suite or any screenshot contract.

**Evidence:** Hosted run `37723593223`, source `b9e2028bc4cff958064483f6eb38148654e77b23`, failed all seven Core cases before caret placement. Its 23 samples contained zero helper scroll/caret actions and unchanged field values. The 44-point Done bar occupied y=472…516 with no separate keyboard toolbar, while stable device-name frames reached y=472…472.667; Goal Discussion reached y=485, thirteen points inside the bar. The helper's retained viewport still ends at y=464. The safe-area-only candidate therefore remains failed.

- [x] Obtain root confirmation of focus/keyboard triggers and scope before source edits.
- [x] Wrap the existing Form with `ScrollViewReader`; put `InputField` IDs on the three actual input row stacks. Keep their focus, submit, input and pairing behavior.
- [x] Feed each field's public `onEditingChanged` callback directly into one stable controller. Every `true` creates a new activation token; an old field's `false` cannot end the next field's activation. Keep the existing text traits and `.onSubmit` chain. No UIKit cell-topology assumption or AX lookup supplies field identity.
- [x] Queue one unanimated `.center` reveal per editing activation after its fixed field identity agrees with `FocusState`. Bind the native responder on the next main turn, not inside the editing callback; preserve a pending activation if that responder is temporarily unavailable. Keyboard-already-visible field transitions use this initial request without depending on a fresh keyboard notification.
- [x] Record a scoped native keyboard completion at `keyboardDidShow` or `keyboardDidChangeFrame`, independently of a previous field's reveal budget. Match the current key window and native responder; accept the completion before or after initial placement, with at most one extra reveal per activation. There is no will/did pairing, endpoint-equality state machine or claim that a shared keyboard animation belongs to one field. A later first keyboard-type/prediction-bar completion for the same editor can consume its one remaining reveal; repeated completions cannot scroll again.
- [x] Require the attached key window, its foreground-active scene and its current first responder. Reject another screen or a non-local keyboard event; use only that window's coordinate conversion to distinguish a visible completion from dismissal.
- [x] Drop queued requests when the activation token changes; recheck its identity, phase, field, window and native responder when the request executes. Nil or mismatching focus cancels queued work without deleting a newer editor's keyboard-completion record. Disappearance removes the pending activation.
- [x] Keep environment suspension, manual-pan suppression, hidden-keyboard and ended-editing states distinct. A same-field return to the same active key window/current responder may create a fresh bounded activation after environment suspension. Arbitrary SwiftUI, scene or keyboard updates cannot undo a user's pan suppression; a new real editing callback can.
- [x] Process scoped keyboard hide before requiring a current first responder, so a lost responder does not leave stale work queued. Do not treat every downward keyboard-frame change as interactive dismissal: keyboard types and prediction bars can also change height. Actual manual pan cancels the request. Remove observer and gesture targets when invalidated.
- [x] Do not request scrolling from layout, geometry changes or repeated keyboard updates. Do not inspect AX identifiers, test values or the helper's acceptance geometry from product code.
- [x] Preserve the existing safe-area Done control and passive helper bytes.

### Task 4: Root-owned qualification and delivery

**Files / evidence:**
- Existing `scripts/preview-gate.mjs --suite=ios`, native Core/all-suite selection and hosted `.github/workflows/preview.yml`.
- Original failed run: `37718485739`, head `279af8c27ec95c5e35bf21dbd12529954d8415ac`, 159 unit passes and Core 6/7. The failed first member pairing and video establish clipping, not its underlying layout cause.

- [ ] Root reviews the stationary two-file follow-up delta against `b9e2028`, checks Swift compilation and existing suite/report contracts, and preserves the active runtime's ownership boundary.
- [ ] Root commits the isolated candidate and dispatches the existing hosted iOS workflow. The full native gate remains `npm run verify:ios`; no local execution is authorized for this worker.
- [ ] Require the real shared helper to complete its passive checks before and after caret placement, then exact Delete/replacement and the existing pairing/business flow. A missing recovery marker alone is not acceptance.
- [ ] Preserve actual HTML/screenshots, case counts, raw diagnostics, source fingerprints and process cleanup on success or failure. Do not promote main until root accepts the qualified source.

## Current evidence boundary

The safe-area-only candidate failed the strict passive gate; its original report, geometry and selectively recovered video remain failed evidence. Source review of the first focus-reveal draft found late-keyboard ordering, same-field environment-resume and responder-loss cancellation defects before qualification. The current revision uses public editing callbacks and separate activation phases to address those findings; it remains source-only and unqualified. Existing callers may reveal an input before initially focusing it; the unchanged helper must prove post-focus visibility without corrective helper gestures on the new source. Root owns compilation, hosted dispatch, report review and any promotion. No simulator, compiler, parser, test, process probe or Git operation was run by this follow-up implementation task.
