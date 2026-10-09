import XCTest

@MainActor
enum NativeAssignmentInput {
    static func selectManual(in app: XCUIApplication) throws {
        var observations: [[String: Any]] = []
        defer {
            let data = try? JSONSerialization.data(withJSONObject: observations, options: [.prettyPrinted, .sortedKeys])
            let text = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
            XCTContext.runActivity(named: "Native assignment mode selection") { activity in
                let attachment = XCTAttachment(string: text)
                attachment.name = "Native assignment mode selection"
                attachment.lifetime = .keepAlways
                activity.add(attachment)
            }
        }
        try require(app.state == .runningForeground && app.navigationBars["Assign Task"].exists,
                    "Manual assignment must be selected in the foreground Assign Task form")
        let modes = app.segmentedControls.matching(identifier: "task.assignment.mode")
        try require(modes.count == 1, "Assignment must expose one mode control")
        let manualMatches = modes.firstMatch.buttons.matching(NSPredicate(format: "label == %@", "Manual"))
        let autoMatches = modes.firstMatch.buttons.matching(NSPredicate(format: "label == %@", "Auto"))
        try require(manualMatches.count == 1 && autoMatches.count == 1,
                    "Assignment mode must have unique Manual and Auto buttons")
        let manual = manualMatches.firstMatch, automatic = autoMatches.firstMatch

        func selected() -> Bool { manual.isSelected && !automatic.isSelected }
        func waitForSelection() -> Bool {
            let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "selected == true"), object: manual)
            return XCTWaiter.wait(for: [expectation], timeout: 3) == .completed && selected()
        }
        observations.append(["phase": "before", "manual_selected": manual.isSelected, "auto_selected": automatic.isSelected])
        if selected() { return }
        try require(manual.isEnabled && manual.isHittable, "The real Manual segment must be available")
        observations.append(["action": "native_element_tap"])
        manual.tap()
        if waitForSelection() { observations.append(["phase": "after_native_tap", "manual_selected": true]); return }

        // Retrying an explicit mode choice is safe only while Auto remains the
        // observed selection. Never continue to the instance picker on a guess.
        try require(app.state == .runningForeground && app.navigationBars["Assign Task"].exists
                    && !app.keyboards.firstMatch.exists && !app.alerts.firstMatch.exists
                    && modes.count == 1 && manualMatches.count == 1 && autoMatches.count == 1
                    && !manual.isSelected && automatic.isSelected && manual.isEnabled && manual.isHittable,
                    "A bounded Manual retry requires the same available form with Auto still selected")
        let frame = manual.frame, bounds = app.frame
        try require(!frame.isEmpty && !frame.isNull && !frame.isInfinite
                    && [frame.minX, frame.minY, frame.maxX, frame.maxY].allSatisfy { $0.isFinite }
                    && !bounds.isEmpty && !bounds.isNull && !bounds.isInfinite
                    && [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].allSatisfy { $0.isFinite }
                    && bounds.contains(frame), "The Manual center touch must stay inside its fully visible button")
        observations.append(["action": "verified_manual_center_tap", "manual_selected": false, "auto_selected": true,
                             "x": Double(frame.midX), "y": Double(frame.midY), "button_x": Double(frame.minX), "button_y": Double(frame.minY),
                             "button_width": Double(frame.width), "button_height": Double(frame.height)])
        app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: frame.midX - bounds.minX, dy: frame.midY - bounds.minY)).tap()
        let changed = waitForSelection()
        observations.append(["phase": "after_center_tap", "manual_selected": manual.isSelected,
                             "auto_selected": automatic.isSelected])
        try require(changed, "Manual assignment must actually be selected before finding an execution instance")
    }

    private static func require(_ condition: Bool, _ message: String) throws {
        if !condition { throw NSError(domain: "NativeAssignmentInput", code: 1,
                                      userInfo: [NSLocalizedDescriptionKey: message]) }
    }
}
