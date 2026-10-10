import XCTest

final class AIDataSharingUITests: XCTestCase {
    private let app = XCUIApplication()
    private var values: [String: String] = [:]
    override func setUpWithError() throws {
        continueAfterFailure = false
        for key in ["ORIGIN", "CODE", "TASK", "TOKEN"] {
            values[key] = try XCTUnwrap(ProcessInfo.processInfo.environment["ARTOO_AI_\(key)"])
        }
    }
    override func tearDownWithError() throws { app.terminate() }

    @MainActor
    func testPermissionAboveAssignmentAndDurableWithdrawal() async throws {
        app.launch()
        let server = app.textFields.matching(identifier: "serverURL").matching(NSPredicate(format: "enabled == 1")).firstMatch
        try require(server.waitForExistence(timeout: 30), "The fresh pairing form must finish restoring before entry")
        photo("Native consent pairing ready")
        try setSwitchOn(app.switches["allowLocalHTTP"])
        try type(server, values["ORIGIN"]!)
        try type(app.textFields["pairingCode"], values["CODE"]!)
        let connect = app.buttons["pairDevice"]
        try reveal(connect); connect.tap()
        let tasks = app.tabBars.buttons["Tasks"]
        XCTAssertTrue(tasks.waitForExistence(timeout: 30)); tasks.tap()
        let task = app.staticTexts["Native consent acceptance task"]
        XCTAssertTrue(task.waitForExistence(timeout: 20)); task.tap()
        let assign = app.buttons["task.action.assign.\(values["TASK"]!)"]
        try reveal(assign); assign.tap()
        let confirm = app.buttons["task.assignment.confirm"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 15)); try reveal(confirm); confirm.tap()
        let allow = app.buttons["aiSharing.allow"]
        let recipient = app.staticTexts["Fixture AI recipient (test only)"]
        try reveal(recipient)
        XCTAssertTrue(recipient.isHittable)
        photo("Native AI disclosure above assignment")
        try reveal(allow)
        let countBefore = try await runCount(); XCTAssertEqual(countBefore, 0)
        app.buttons["aiSharing.decline"].tap()
        XCTAssertTrue(app.navigationBars["Assign Task"].waitForExistence(timeout: 15))
        let countDeclined = try await runCount(); XCTAssertEqual(countDeclined, 0)
        try reveal(confirm)
        let enabled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: confirm)
        XCTAssertEqual(XCTWaiter.wait(for: [enabled], timeout: 15), .completed)
        photo("Native declined disclosure preserves assignment")
        confirm.tap(); try reveal(allow); allow.tap()
        let dismissed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.navigationBars["Assign Task"])
        XCTAssertEqual(XCTWaiter.wait(for: [dismissed], timeout: 20), .completed)
        let countAllowed = try await runCount(); XCTAssertEqual(countAllowed, 1)
        app.tabBars.buttons["More"].tap()
        let settings = app.buttons["aiSharing.settings"]
        try reveal(settings); settings.tap()
        try reveal(app.staticTexts["aiSharing.allowed"])
        XCTAssertTrue(app.staticTexts["aiSharing.allowed"].isHittable)
        let withdraw = app.buttons["aiSharing.withdraw"]
        try reveal(withdraw); photo("Native recorded AI permission in settings"); withdraw.tap()
        app.buttons["Withdraw and stop my agent work"].tap()
        let result = app.staticTexts["aiSharing.withdrawalResult"]
        try reveal(result)
        XCTAssertTrue(result.label.contains("could not be confirmed"))
        photo("Native withdrawal reports unconfirmed stop")
        let withdrawn = try await consentIsWithdrawn(); XCTAssertTrue(withdrawn)
        app.terminate(); app.launch()
        XCTAssertTrue(app.tabBars.buttons["More"].waitForExistence(timeout: 30)); app.tabBars.buttons["More"].tap()
        try reveal(settings); settings.tap(); try reveal(allow)
        XCTAssertFalse(app.staticTexts["aiSharing.allowed"].exists)
        photo("Native withdrawn permission survives relaunch")
    }

    private func require(_ condition: Bool, _ message: String) throws {
        if !condition { throw NSError(domain: "AIConsentUI", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    }
    @MainActor private func setSwitchOn(_ element: XCUIElement) throws {
        // Same bounded native-state verification as the existing business suite.
        for _ in 0..<3 {
            let nested = element.switches.firstMatch
            let control = nested.exists ? nested : element
            try reveal(control)
            try require(control.isEnabled, "The onboarding switch must be enabled")
            if element.value as? String == "1" { return }
            try require(element.value as? String == "0", "The onboarding switch must expose a known off/on state")
            control.tap()
            let changed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "1"), object: element)
            if XCTWaiter.wait(for: [changed], timeout: 3) == .completed { return }
        }
        let changed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "1"), object: element)
        try require(XCTWaiter.wait(for: [changed], timeout: 15) == .completed, "Local HTTP must be enabled before pairing")
    }

    @MainActor private func type(_ field: XCUIElement, _ value: String) throws {
        try reveal(field); field.tap()
        try require(app.keyboards.firstMatch.waitForExistence(timeout: 10), "The selected input must have a keyboard before typing")
        field.typeText(value)
        // UI synthesis may return before the accessibility value catches up.
        // Observe this one typing operation; never append/retype on a timeout.
        let entered = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", value), object: field)
        try require(XCTWaiter.wait(for: [entered], timeout: 45) == .completed, "The one typing operation must settle to its complete intended value")
        XCTAssertEqual(field.value as? String, value)
        let done = app.buttons["pairing.keyboard.done"]
        try require(done.waitForExistence(timeout: 10) && done.isHittable, "The pairing input must expose its Done action")
        done.tap()
        let hidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.keyboards.firstMatch)
        try require(XCTWaiter.wait(for: [hidden], timeout: 15) == .completed, "Keyboard dismissal must finish before the next input")
    }
    @MainActor private func reveal(_ element: XCUIElement) throws {
        for _ in 0..<10 {
            if element.exists && element.isEnabled && element.isHittable { return }
            let scroll = app.collectionViews.firstMatch
            if element.exists && element.frame.midY < app.frame.midY {
                if scroll.exists { scroll.swipeDown() } else { app.swipeDown() }
            } else { if scroll.exists { scroll.swipeUp() } else { app.swipeUp() } }
        }
        throw NSError(domain: "AIConsentUI", code: 1, userInfo: [NSLocalizedDescriptionKey: "Required consent control is not reachable: \(element.identifier)"])
    }
    @MainActor private func photo(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
    private func request(_ path: String) async throws -> [String: Any] {
        var request = URLRequest(url: URL(string: values["ORIGIN"]! + path)!)
        request.setValue("Bearer \(values["TOKEN"]!)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
    private func runCount() async throws -> Int {
        let snapshot = try await request("/api/v1/tasks/\(values["TASK"]!)")
        return try XCTUnwrap(snapshot["runs"] as? [Any]).count
    }
    private func consentIsWithdrawn() async throws -> Bool {
        let snapshot = try await request("/api/v1/privacy/ai-sharing")
        return snapshot["consent"] is NSNull
    }
}
