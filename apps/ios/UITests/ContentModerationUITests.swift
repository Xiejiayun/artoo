import XCTest

final class ContentModerationUITests: XCTestCase {
    private let app = XCUIApplication()
    private var values: [String: String] = [:]
    override func setUpWithError() throws {
        continueAfterFailure = false
        for key in ["ORIGIN", "CODE", "CHANNEL", "MESSAGE", "AUTHOR", "TOKEN"] {
            values[key] = try XCTUnwrap(ProcessInfo.processInfo.environment["ARTOO_MOD_\(key)"])
        }
    }
    override func tearDownWithError() throws { app.terminate() }

    @MainActor func testReportRemoveFilterAndSuspendFromNativeUI() async throws {
        do { try await workflow() }
        catch {
            if app.buttons["moderation.management"].exists || app.navigationBars["Content management"].exists || app.tabBars.firstMatch.exists {
                photo("Native moderation guarded failure")
                let hierarchy = XCTAttachment(string: app.debugDescription); hierarchy.name = "Native moderation failure hierarchy"; hierarchy.lifetime = .keepAlways; add(hierarchy)
            }
            throw error
        }
    }
    @MainActor private func workflow() async throws {
        app.launch()
        let server = app.textFields.matching(identifier: "serverURL").matching(NSPredicate(format: "enabled == 1")).firstMatch
        try require(server.waitForExistence(timeout: 30), "The pairing form must finish restoration before input")
        photo("Native moderation pairing ready")
        try setSwitchOn(app.switches["allowLocalHTTP"])
        try type(server, values["ORIGIN"]!, done: "pairing.keyboard.done")
        try type(app.textFields["pairingCode"], values["CODE"]!, done: "pairing.keyboard.done")
        try tap(app.buttons["pairDevice"])
        XCTAssertTrue(app.tabBars.buttons["Channels"].waitForExistence(timeout: 30))
        try tap(app.buttons["channel.\(values["CHANNEL"]!)"])
        let message = app.staticTexts["message.\(values["MESSAGE"]!)"]
        try reveal(message); XCTAssertEqual(message.label, "Native moderation fixture message")
        photo("Native moderation original message")
        try tap(app.buttons["message.report.\(values["MESSAGE"]!)"])
        let reason = app.textViews["moderation.report.reason"]
        try type(reason, "Please review this native fixture", done: nil)
        try tap(app.buttons["moderation.report.submit"])
        XCTAssertTrue(app.descendants(matching: .any)["moderation.report.sent"].waitForExistence(timeout: 15))
        photo("Native moderation report received")
        try tap(app.buttons["Done"])
        let reports = try await request("/api/v1/moderation/my-reports")
        let id = try XCTUnwrap((reports["reports"] as? [[String: Any]])?.first?["id"] as? String)
        app.tabBars.buttons["More"].tap()
        try tap(app.buttons["moderation.myReports"])
        let ownReport = app.descendants(matching: .any).matching(identifier: "moderation.my-report.\(id)").firstMatch
        try reveal(ownReport)
        XCTAssertTrue(ownReport.label.contains("Awaiting review"))
        photo("Native moderation report status")
        try back("My reports")
        try tap(app.buttons["moderation.management"])
        try tap(app.buttons["Reports awaiting review"])
        try tap(app.buttons["moderation.staff-report.\(id)"])
        try tap(app.buttons["moderation.reportedContent"])
        try reveal(app.staticTexts["Native moderation fixture message"])
        photo("Native moderation staff evidence")
        try type(app.textFields["moderation.staffNote"], "Native staff removal review", done: nil)
        try tap(app.buttons["moderation.reviewResolution"])
        try tap(app.buttons["Confirm removal"])
        XCTAssertTrue(app.navigationBars["Reports"].waitForExistence(timeout: 15))
        try back("Reports")
        try tap(app.buttons["Posting rules"])
        try type(app.textViews["moderation.blockedPhrases"], "native prohibited fixture", done: "moderation.rules.keyboard.done")
        try tap(app.buttons["moderation.saveRules"])
        try reveal(app.staticTexts["moderation.rulesSaved"])
        photo("Native moderation saved posting rule")
        try back("Posting rules")
        try tap(app.buttons["Member access"])
        try tap(app.buttons["moderation.member.\(values["AUTHOR"]!)"])
        try type(app.textFields["moderation.accessReason"], "Native reviewed fixture conduct", done: nil)
        try tap(app.buttons["moderation.changeAccess"])
        try tap(app.buttons["Confirm suspension"])
        XCTAssertTrue(app.navigationBars["Member access"].waitForExistence(timeout: 15))
        let access = try await request("/api/v1/moderation/members")
        let author = try XCTUnwrap((access["members"] as? [[String: Any]])?.first { $0["id"] as? String == values["AUTHOR"] })
        XCTAssertTrue(author["suspended_at"] is String)
        photo("Native moderation suspended member")
        app.tabBars.buttons["Channels"].tap()
        if app.buttons["channel.\(values["CHANNEL"]!)"].exists { try tap(app.buttons["channel.\(values["CHANNEL"]!)"]) }
        try reveal(message)
        XCTAssertEqual(message.label, "This message was removed by a team administrator.")
        photo("Native moderation removed content in conversation")
        let composer = app.descendants(matching: .any).matching(identifier: "messageComposer").firstMatch
        try type(composer, "NATIVE prohibited fixture", done: "conversation.keyboard.done")
        try tap(app.buttons["sendMessage"])
        try reveal(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "conflicts with your team's posting rules")).firstMatch)
        XCTAssertEqual(composer.value as? String, "NATIVE prohibited fixture")
        try require(composer.isEnabled, "A definitively rejected draft must remain editable")
        photo("Native moderation rejected draft retained")
        try replace(composer, "Edited native message after rejection", done: "conversation.keyboard.done")
        try tap(app.buttons["sendMessage"])
        try reveal(app.staticTexts.matching(NSPredicate(format: "label == %@", "Edited native message after rejection")).firstMatch)
        let corrected = try await request("/api/v1/rooms/\(values["CHANNEL"]!)/messages")
        XCTAssertEqual((corrected["messages"] as? [[String: Any]])?.filter { $0["body"] as? String == "Edited native message after rejection" }.count, 1)
        photo("Native moderation corrected message delivered")
        app.terminate(); app.launch()
        XCTAssertTrue(app.tabBars.buttons["Channels"].waitForExistence(timeout: 30))
        try tap(app.buttons["channel.\(values["CHANNEL"]!)"])
        try reveal(message)
        XCTAssertEqual(message.label, "This message was removed by a team administrator.")
        photo("Native moderation removal survives relaunch")
    }
    private func require(_ condition: Bool, _ message: String) throws {
        if !condition { throw NSError(domain: "ModerationUI", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
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

    @MainActor private func replace(_ field: XCUIElement, _ text: String, done: String) throws {
        try reveal(field); field.tap(); field.press(forDuration: 1)
        let menu = app.menuItems["Select All"].firstMatch
        let button = app.buttons["Select All"].firstMatch
        let selectAll = menu.waitForExistence(timeout: 2) ? menu : button
        try require(selectAll.waitForExistence(timeout: 5) && selectAll.isHittable, "The native edit menu must offer Select All")
        selectAll.tap(); field.typeText(XCUIKeyboardKey.delete.rawValue)
        let cleared = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@ OR value == %@", "", field.placeholderValue ?? ""), object: field)
        try require(XCTWaiter.wait(for: [cleared], timeout: 15) == .completed, "The native Delete operation must clear the rejected text")
        try type(field, text, done: done)
    }

    @MainActor private func type(_ field: XCUIElement, _ text: String, done: String?) throws {
        try reveal(field); field.tap()
        try require(app.keyboards.firstMatch.waitForExistence(timeout: 10), "The selected input must have keyboard focus")
        field.typeText(text)
        let entered = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", text), object: field)
        try require(XCTWaiter.wait(for: [entered], timeout: 45) == .completed, "The original typing operation must settle to its intended value")
        XCTAssertEqual(field.value as? String, text)
        if let done {
            let button = app.buttons[done]
            try require(button.waitForExistence(timeout: 10) && button.isHittable, "The input must expose its Done action")
            button.tap()
            let hidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.keyboards.firstMatch)
            try require(XCTWaiter.wait(for: [hidden], timeout: 15) == .completed, "Keyboard dismissal must finish before the next action")
        }
    }
    @MainActor private func tap(_ element: XCUIElement) throws { try reveal(element); element.tap() }
    @MainActor private func back(_ title: String) throws {
        let bar = app.navigationBars[title]
        try require(bar.waitForExistence(timeout: 10), "The expected navigation page must be active before going back")
        let button = bar.buttons.firstMatch
        try require(button.exists && button.isHittable, "The page must expose its Back action")
        button.tap()
    }
    @MainActor private func reveal(_ element: XCUIElement) throws {
        for attempt in 0..<12 {
            if element.exists && element.isEnabled && element.isHittable { return }
            let list = app.collectionViews.allElementsBoundByIndex.last { $0.exists && $0.isHittable }
            var area = (list?.frame ?? app.frame).intersection(app.frame)
            if let nav = app.navigationBars.allElementsBoundByIndex.last(where: { $0.exists && $0.frame.intersects(area) }) {
                let bottom = area.maxY; area.origin.y = max(area.minY, nav.frame.maxY); area.size.height = bottom - area.minY
            }
            if app.keyboards.firstMatch.exists { area.size.height = min(area.maxY, app.keyboards.firstMatch.frame.minY) - area.minY }
            else if app.tabBars.firstMatch.exists { area.size.height = min(area.maxY, app.tabBars.firstMatch.frame.minY) - area.minY }
            guard area.height > 40 else { throw NSError(domain: "ModerationUI", code: 1, userInfo: [NSLocalizedDescriptionKey: "No visible content area"]) }
            let upward = element.exists ? element.frame.midY > area.midY : attempt < 6
            let origin = app.coordinate(withNormalizedOffset: .zero)
            origin.withOffset(CGVector(dx: area.midX, dy: area.minY + area.height * (upward ? 0.75 : 0.25)))
                .press(forDuration: 0.05, thenDragTo: origin.withOffset(CGVector(dx: area.midX, dy: area.minY + area.height * (upward ? 0.25 : 0.75))))
        }
        throw NSError(domain: "ModerationUI", code: 1, userInfo: [NSLocalizedDescriptionKey: "Required control unavailable: \(element.identifier)"])
    }
    @MainActor private func photo(_ name: String) {
        let item = XCTAttachment(screenshot: app.screenshot()); item.name = name; item.lifetime = .keepAlways; add(item)
    }
    private func request(_ path: String) async throws -> [String: Any] {
        var request = URLRequest(url: URL(string: values["ORIGIN"]! + path)!); request.setValue("Bearer \(values["TOKEN"]!)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}
