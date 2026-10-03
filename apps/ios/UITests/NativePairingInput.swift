import XCTest

/// Public native UI preparation for the prefilled pairing device name only.
@MainActor
enum NativePairingInput {
    static func positionDeviceNameCaret(_ field: XCUIElement, in app: XCUIApplication, expected current: String) throws {
        try require(field.identifier == "pairingDeviceName" && field.elementType == .textField,
                    "Caret preparation must target the exact native pairing device name")
        let keyboard = app.keyboards.firstMatch, done = app.buttons["pairing.keyboard.done"]
        for _ in 0..<14 {
            let area = try viewport(app), frame = field.frame
            try require(finite(frame) && frame.width <= area.width && frame.height <= area.height,
                        "The complete device name must fit the unobscured content viewport")
            if area.contains(frame) && field.isEnabled && field.isHittable {
                if !keyboard.exists {
                    // Form scrolling can dismiss the keyboard interactively.
                    // Refocus only after the whole field is visible, then measure again.
                    field.tap()
                    try require(keyboard.waitForExistence(timeout: 10) && done.waitForExistence(timeout: 10),
                                "The exact device name must restore its native keyboard and Done toolbar")
                    continue
                }
                // Match the established conversation helper's settled-layout check.
                RunLoop.current.run(until: Date().addingTimeInterval(0.15))
                let settledArea = try viewport(app), settled = field.frame
                if !keyboard.exists || !done.exists || !settledArea.contains(settled)
                    || abs(settledArea.minY - area.minY) >= 1 || abs(settledArea.maxY - area.maxY) >= 1
                    || abs(settled.minY - frame.minY) >= 1 || abs(settled.height - frame.height) >= 1 { continue }
                try require(finite(settled) && field.isEnabled && field.isHittable && field.value as? String == current,
                            "The complete device name must remain visible and unchanged before positioning its caret")
                let trailing = CGPoint(x: settled.maxX - min(8, settled.width / 2), y: settled.midY)
                try require(settled.contains(trailing) && settledArea.contains(trailing),
                            "The caret touch must remain inside the exact field above its keyboard toolbar")
                let bounds = app.frame
                app.coordinate(withNormalizedOffset: .zero)
                    .withOffset(CGVector(dx: trailing.x - bounds.minX, dy: trailing.y - bounds.minY)).tap()
                try require(keyboard.exists && done.exists && field.value as? String == current,
                            "Positioning the caret must preserve the device name and its native keyboard")
                return
            }
            let above = max(0, area.minY - frame.minY), below = max(0, frame.maxY - area.maxY)
            try require(above > 0 || below > 0, "Vertical scrolling must address measured device-name clipping")
            let upward = below > 0
            let distance = min(area.height * 0.3, max(24, (upward ? below : above) + 12))
            let start = CGPoint(x: area.midX, y: area.midY + (upward ? distance : -distance) / 2)
            let end = CGPoint(x: area.midX, y: area.midY - (upward ? distance : -distance) / 2)
            try require(distance.isFinite && distance > 0 && area.contains(start) && area.contains(end),
                        "Device-name alignment must stay inside the unobscured content viewport")
            let bounds = app.frame, origin = app.coordinate(withNormalizedOffset: .zero)
            origin.withOffset(CGVector(dx: start.x - bounds.minX, dy: start.y - bounds.minY))
                .press(forDuration: 0.05, thenDragTo: origin.withOffset(CGVector(dx: end.x - bounds.minX, dy: end.y - bounds.minY)),
                       withVelocity: .slow, thenHoldForDuration: 0.2)
        }
        try require(false, "The complete device name must settle above the native keyboard and Done toolbar before editing")
    }

    private static func viewport(_ app: XCUIApplication) throws -> CGRect {
        try require(app.state == .runningForeground, "Pairing input preparation requires the foreground app")
        let bounds = app.frame, navigation = app.navigationBars.firstMatch
        try require(finite(bounds), "Pairing app bounds must be finite and nonempty")
        let top = navigation.exists ? max(bounds.minY, navigation.frame.maxY) : bounds.minY
        var bottom = bounds.maxY
        let keyboard = app.keyboards.firstMatch
        let buttons = app.buttons.matching(identifier: "pairing.keyboard.done"), done = buttons.firstMatch
        if keyboard.exists && !done.exists {
            // A completed interactive dismissal is allowed; the caller refocuses.
            try require(done.waitForExistence(timeout: 10) || !keyboard.exists,
                        "A visible pairing keyboard must expose its Done toolbar")
        }
        if keyboard.exists {
            try require(finite(keyboard.frame), "The native keyboard must expose finite bounds")
            bottom = min(bottom, keyboard.frame.minY)
        }
        if done.exists {
            try require(buttons.count == 1 && finite(done.frame), "The pairing Done control must have unique finite bounds")
            let toolbars = app.toolbars.containing(.button, identifier: "pairing.keyboard.done")
            try require(toolbars.count <= 1, "The pairing keyboard toolbar must be unambiguous")
            // Keep the Done bound even when a containing toolbar is exposed.
            bottom = min(bottom, done.frame.minY)
            if toolbars.count == 1 {
                let toolbar = toolbars.element(boundBy: 0).frame
                try require(finite(toolbar), "The pairing toolbar must expose finite bounds")
                bottom = min(bottom, toolbar.minY)
            }
        }
        let area = CGRect(x: bounds.minX + 6, y: top + 8, width: bounds.width - 12, height: bottom - top - 16)
        try require(finite(area) && bounds.contains(area), "The pairing content viewport must be finite and unobscured")
        return area
    }

    private static func finite(_ rect: CGRect) -> Bool {
        !rect.isEmpty && !rect.isNull && !rect.isInfinite
            && [rect.minX, rect.minY, rect.maxX, rect.maxY, rect.width, rect.height].allSatisfy { $0.isFinite }
    }

    private static func require(_ condition: Bool, _ message: String) throws {
        if !condition { throw NSError(domain: "NativePairingInput", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    }
}
