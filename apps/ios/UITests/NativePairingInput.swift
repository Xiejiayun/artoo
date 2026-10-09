import XCTest

/// Passive native visibility verification for the prefilled pairing device name.
@MainActor
enum NativePairingInput {
    private static let visibilityTimeout: TimeInterval = 10
    private static let stableDuration: TimeInterval = 1

    static func positionDeviceNameCaret(_ field: XCUIElement, in app: XCUIApplication, expected current: String) throws {
        var attempts: [[String: Any]] = [], prepared = false
        defer { if !prepared { retainFailureGeometry(attempts) } }
        try require(field.identifier == "pairingDeviceName" && field.elementType == .textField
                    && app.textFields.matching(identifier: "pairingDeviceName").count == 1,
                    "Caret preparation must target the unique native pairing device name")
        let visible = try waitForStableField(field, in: app, expected: current, phase: "before_caret", attempts: &attempts)
        let trailing = CGPoint(x: visible.field.maxX - min(8, visible.field.width / 2), y: visible.field.midY)
        try require(visible.field.contains(trailing) && visible.area.contains(trailing),
                    "The caret touch must remain inside the complete unobscured device-name field")
        let bounds = app.frame
        attempts.append(["action": "position_native_caret", "x": number(trailing.x), "y": number(trailing.y)])
        app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: trailing.x - bounds.minX, dy: trailing.y - bounds.minY)).tap()
        _ = try waitForStableField(field, in: app, expected: current, phase: "after_caret", attempts: &attempts)
        prepared = true
    }

    private static func waitForStableField(_ field: XCUIElement, in app: XCUIApplication, expected current: String,
                                          phase: String, attempts: inout [[String: Any]]) throws -> (field: CGRect, area: CGRect) {
        let started = ProcessInfo.processInfo.systemUptime
        var stable: (field: CGRect, area: CGRect, since: TimeInterval)?
        while ProcessInfo.processInfo.systemUptime - started < visibilityTimeout {
            let index = attempts.count
            attempts.append(["phase": phase, "action": "observe_only",
                             "elapsed_seconds": ProcessInfo.processInfo.systemUptime - started])
            try require(app.state == .runningForeground, "Pairing input preparation requires the foreground app")
            let observationStarted = ProcessInfo.processInfo.systemUptime
            // One tree gives consistent geometry and avoids repeated remote AX
            // resolutions consuming the entire passive observation deadline.
            let snapshot = try app.snapshot()
            attempts[index]["snapshot_seconds"] = ProcessInfo.processInfo.systemUptime - observationStarted
            if let measured = try measurement(snapshot, expected: current, trace: &attempts[index]) {
                var visible = measured.completeFieldVisible
                if visible {
                    // Hittability is intentionally live: snapshots expose
                    // standard attributes, not a hit-test result.
                    let fieldHittable = field.isHittable
                    let doneHittable = app.buttons["pairing.keyboard.done"].isHittable
                    attempts[index]["field_hittable"] = fieldHittable
                    attempts[index]["done_hittable"] = doneHittable
                    visible = fieldHittable && doneHittable
                }
                attempts[index]["complete_field_visible"] = visible
                if visible {
                    let now = ProcessInfo.processInfo.systemUptime
                    if let reference = stable, sameGeometry(reference.field, measured.field) && sameGeometry(reference.area, measured.area) {
                        attempts[index]["stable_seconds"] = now - reference.since
                        if now - reference.since >= stableDuration && now - started < visibilityTimeout {
                            return (measured.field, measured.area)
                        }
                    } else { stable = (measured.field, measured.area, now) }
                } else { stable = nil }
            } else { stable = nil }
            attempts[index]["observation_seconds"] = ProcessInfo.processInfo.systemUptime - observationStarted
            // Observe the app's automatic layout only. No drag, refocus or
            // corrective tap is allowed to make the visibility assertion pass.
            RunLoop.current.run(until: Date().addingTimeInterval(0.15))
        }
        throw NSError(domain: "NativePairingInput", code: 1, userInfo: [NSLocalizedDescriptionKey:
            "The complete device name must remain automatically visible and stable for one second \(phase), without corrective gestures"])
    }

    @MainActor
    struct Measurement {
        let field: CGRect
        let area: CGRect
        let fieldEnabled: Bool
        var completeFieldVisible: Bool { finite(field) && area.contains(field) && fieldEnabled }
    }

    @MainActor
    private struct SnapshotIndex {
        struct Entry {
            let node: XCUIElementSnapshot
            let form: XCUIElementSnapshot?
        }
        let entries: [Entry]

        init(_ root: XCUIElementSnapshot) {
            var collected: [Entry] = []
            func visit(_ node: XCUIElementSnapshot, form: XCUIElementSnapshot?) {
                let owner = node.elementType == .collectionView ? node : form
                collected.append(Entry(node: node, form: owner))
                for child in node.children { visit(child, form: owner) }
            }
            visit(root, form: nil)
            entries = collected
        }

        func matching(_ type: XCUIElement.ElementType = .any, identifier: String? = nil) -> [Entry] {
            entries.filter { (type == .any || $0.node.elementType == type)
                && (identifier == nil || $0.node.identifier == identifier) }
        }
    }

    // Shared with measurement unit tests. No query or UI action occurs here.
    static func measurement(_ root: XCUIElementSnapshot, expected current: String,
                            trace: inout [String: Any]) throws -> Measurement? {
        let index = SnapshotIndex(root)
        let fields = index.matching(.textField, identifier: "pairingDeviceName")
        trace["field_exists"] = !fields.isEmpty
        trace["field_count"] = fields.count
        try require(fields.count <= 1, "The native pairing device name must be unique")
        guard let entry = fields.first else { return nil }
        let field = entry.node
        let unchanged = field.value as? String == current
        trace["value_unchanged"] = unchanged
        try require(unchanged, "Passive caret preparation must not change the device name")
        trace["field"] = geometry(field.frame)
        trace["field_enabled"] = field.isEnabled

        let bounds = root.frame, navigation = index.matching(.navigationBar)
        trace["application_frame"] = geometry(bounds)
        try require(finite(bounds), "Pairing app bounds must be finite and nonempty")
        var top = bounds.minY
        trace["navigation_exists"] = !navigation.isEmpty
        try require(navigation.count <= 1, "The pairing navigation boundary must be unambiguous")
        if let navigation = navigation.first {
            let frame = navigation.node.frame
            trace["navigation_frame"] = geometry(frame)
            guard finite(frame) else { return nil }
            top = max(top, frame.maxY)
        }
        let keyboards = index.matching(.keyboard)
        trace["form_exists"] = entry.form != nil
        trace["form_selection"] = "device_name_ancestor"
        trace["keyboard_exists"] = !keyboards.isEmpty
        try require(keyboards.count <= 1, "The native keyboard must be unambiguous")
        guard let form = entry.form, let keyboard = keyboards.first?.node else { return nil }
        let formFrame = form.frame.intersection(bounds)
        trace["form_frame"] = geometry(formFrame)
        guard finite(formFrame), let keyboardTop = try keyboardOcclusionTop(keyboard, in: index, bounds: bounds, trace: &trace) else { return nil }

        let buttons = index.matching(.button, identifier: "pairing.keyboard.done")
        let controls = index.matching(identifier: "pairing.keyboard.controls")
        let buttonCount = buttons.count, controlsCount = controls.count
        trace["done_count"] = buttonCount
        trace["controls_count"] = controlsCount
        try require(buttonCount <= 1 && controlsCount <= 1, "The pairing Done control and its layout container must be unambiguous")
        guard buttonCount == 1 && controlsCount == 1 else { return nil }
        let done = buttons[0].node, bar = controls[0].node
        let doneFrame = done.frame, barFrame = bar.frame
        trace["done_frame"] = geometry(doneFrame)
        trace["controls_frame"] = geometry(barFrame)
        let toolbarCount = index.matching(.toolbar).filter {
            !SnapshotIndex($0.node).matching(.button, identifier: "pairing.keyboard.done").isEmpty
        }.count
        trace["toolbar_count"] = toolbarCount
        try require(toolbarCount == 0 && SnapshotIndex(bar).matching(.button, identifier: "pairing.keyboard.done").count == 1,
                    "Pairing Done must belong to the in-layout controls, not a separate keyboard toolbar")
        guard finite(doneFrame), finite(barFrame), bounds.contains(barFrame), barFrame.contains(doneFrame),
              doneFrame.width >= 44, doneFrame.height >= 44, done.isEnabled,
              barFrame.minY >= top, barFrame.maxY <= keyboardTop else { return nil }

        top = max(top, formFrame.minY)
        let bottom = min(formFrame.maxY, min(barFrame.minY, keyboardTop))
        let area = CGRect(x: formFrame.minX + 6, y: top + 8, width: formFrame.width - 12, height: bottom - top - 16)
        trace["viewport"] = geometry(area)
        guard finite(area), bounds.contains(area) else { return nil }
        return Measurement(field: field.frame, area: area, fieldEnabled: field.isEnabled)
    }

    private static func keyboardOcclusionTop(_ keyboard: XCUIElementSnapshot, in index: SnapshotIndex, bounds: CGRect,
                                            trace: inout [String: Any]) throws -> CGFloat? {
        let keys = keyboard.frame
        trace["keyboard_frame"] = geometry(keys)
        guard finite(keys), keys.intersects(bounds) else { return nil }
        var top = keys.minY, observedFullRegion = false
        // Match the established conversation assertion: the keycaps alone
        // omit the input/prediction region on separate keyboard windows.
        for identifier in ["inputView", "SystemInputAssistantView"] {
            let matches = index.matching(.other, identifier: identifier), count = matches.count
            trace[identifier + "_count"] = count
            try require(count <= 1, "The keyboard input region must be unambiguous")
            guard count == 1 else { continue }
            let frame = matches[0].node.frame
            trace[identifier + "_frame"] = geometry(frame)
            guard finite(frame), frame.intersects(bounds), frame.minX < keys.maxX, frame.maxX > keys.minX,
                  frame.minY <= keys.minY, frame.maxY >= keys.minY else { return nil }
            top = min(top, frame.minY)
            observedFullRegion = true
        }
        trace["full_keyboard_region_observed"] = observedFullRegion
        trace["keyboard_occlusion_top"] = number(top)
        // A changed AX structure cannot silently turn keycap-only bounds into
        // proof of full visibility. Missing regions exhaust the passive wait.
        return observedFullRegion ? top : nil
    }

    private static func sameGeometry(_ lhs: CGRect, _ rhs: CGRect) -> Bool {
        finite(lhs) && finite(rhs) && abs(lhs.minX - rhs.minX) < 1 && abs(lhs.minY - rhs.minY) < 1
            && abs(lhs.maxX - rhs.maxX) < 1 && abs(lhs.maxY - rhs.maxY) < 1
            && abs(lhs.width - rhs.width) < 1 && abs(lhs.height - rhs.height) < 1
    }

    private static func number(_ value: CGFloat) -> Any {
        if value.isFinite { return Double(value) }
        return NSNull()
    }

    private static func geometry(_ frame: CGRect) -> [String: Any] {
        ["x": number(frame.minX), "y": number(frame.minY), "width": number(frame.width), "height": number(frame.height)]
    }

    private static func retainFailureGeometry(_ attempts: [[String: Any]]) {
        let payload: [String: Any] = ["field_identifier": "pairingDeviceName",
            "phase_timeout_seconds": visibilityTimeout, "required_stable_seconds": stableDuration,
            "geometry_source": "one_XCUIElementSnapshot_per_observation",
            "corrective_gestures_allowed": false, "input_values_recorded": false, "attempts": attempts]
        let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
        let text = data.flatMap { String(data: $0, encoding: .utf8) } ?? "{\"geometry_encoding_failed\":true}"
        XCTContext.runActivity(named: "Native pairing geometry on preparation failure") { activity in
            let attachment = XCTAttachment(string: text)
            attachment.name = "Native pairing device-name geometry"
            attachment.lifetime = .keepAlways
            activity.add(attachment)
        }
    }

    private static func finite(_ rect: CGRect) -> Bool {
        !rect.isEmpty && !rect.isNull && !rect.isInfinite
            && [rect.minX, rect.minY, rect.maxX, rect.maxY, rect.width, rect.height].allSatisfy { $0.isFinite }
    }

    private static func require(_ condition: Bool, _ message: String) throws {
        if !condition { throw NSError(domain: "NativePairingInput", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    }
}
