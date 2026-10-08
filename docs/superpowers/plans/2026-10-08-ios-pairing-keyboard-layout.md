# Pairing Keyboard Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the focused pairing device-name field fully visible without corrective test gestures, while preserving native input and Done behavior.

**Architecture:** Replace the separate keyboard toolbar with a focused-only bottom safe-area inset whose intrinsic height participates in Form layout. The shared native caret helper must observe a stable, unobscured field for one second before its single caret touch and again afterward; it must never scroll or refocus to manufacture visibility.

**Tech Stack:** SwiftUI Form and FocusState, iOS 17+, XCTest/XCUITest, existing hosted Preview gates.

## Global Constraints

- Work only in `/Users/jeremy/workspace/artoo-ios-pairing-scroll`; keep main unchanged until root accepts the hosted candidate.
- Own only `apps/ios/Sources/App/ArtooApp.swift`, `apps/ios/UITests/NativePairingInput.swift`, and this plan.
- Preserve the `pairing.keyboard.done` identifier; add `pairing.keyboard.controls` for the in-layout container.
- Keep current Form content, title, focus/submit order, interactive dismissal and pairing behavior.
- No fixed keyboard padding, ScrollViewReader, new keyboard observer or speculative reuse of ComposerKeyboardAvoidance.
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

### Task 3: Root-owned qualification and delivery

**Files / evidence:**
- Existing `scripts/preview-gate.mjs --suite=ios`, native Core/all-suite selection and hosted `.github/workflows/preview.yml`.
- Original failed run: `37718485739`, head `279af8c27ec95c5e35bf21dbd12529954d8415ac`, 159 unit passes and Core 6/7. The failed first member pairing and video establish clipping, not its underlying layout cause.

- [ ] Root reviews the stationary three-file source delta, checks Swift compilation and existing suite/report contracts, and preserves the active runtime's ownership boundary.
- [ ] Root commits the isolated candidate and dispatches the existing hosted iOS workflow. The full native gate remains `npm run verify:ios`; no local execution is authorized for this worker.
- [ ] Require the real shared helper to complete its passive checks before and after caret placement, then exact Delete/replacement and the existing pairing/business flow. A missing recovery marker alone is not acceptance.
- [ ] Preserve actual HTML/screenshots, case counts, raw diagnostics, source fingerprints and process cleanup on success or failure. Do not promote main until root accepts the qualified source.

## Current evidence boundary

The safe-area-only change is a candidate. If strict passive checks still observe clipping after layout settles, preserve those frames and geometry before considering a separately reviewed focus-scroll change. Existing callers may reveal an input before initially focusing it; the strengthened helper proves post-focus visibility without corrective helper gestures. Independent static review found no material issue. No simulator, compiler, parser, test, process probe or Git operation was run by this source-only implementation task.
