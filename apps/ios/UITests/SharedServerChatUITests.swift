import XCTest

/// Black-box tests of the Release app. The companion client uses the same
/// authenticated REST routes as every other paired client; no API is mocked.
final class SharedServerChatUITests: XCTestCase {
    private let app = XCUIApplication()
    private var fixture: Fixture!

    override func setUpWithError() throws {
        continueAfterFailure = false
        fixture = try Fixture(environment: ProcessInfo.processInfo.environment)
    }

    override func tearDownWithError() throws { app.terminate() }

    @MainActor
    func testPairSendThreadAndCatchUpWithAnotherClient() async throws {
        let suffix = UUID().uuidString.prefix(8)
        let rootBody = fixture.nativeMessage
        let replyBody = fixture.nativeReply
        let liveBody = fixture.browserReply
        let catchUpBody = "Peer background reply \(suffix)"
        app.launch()
        // Repeated local runs can reuse the simulator. Sign out through the
        // product UI so this run still proves one-time pairing and Keychain save.
        if app.tabBars.buttons["More"].waitForExistence(timeout: 3) {
            app.tabBars.buttons["More"].tap()
            let signOut = app.buttons["signOut"]
            try reveal(signOut)
            signOut.tap()
        }
        let origin = app.textFields["serverURL"]
        try require(origin.waitForExistence(timeout: 15), "Live pairing screen must be visible")
        let localHTTP = app.switches["allowLocalHTTP"]
        if fixture.serverURL.scheme == "http" {
            // SwiftUI exposes both the row and the UISwitch as switches. Tap
            // the actual control before opening the keyboard, then verify it.
            try reveal(localHTTP)
            if localHTTP.value as? String != "1" {
                let control = localHTTP.switches.firstMatch
                (control.exists ? control : localHTTP).tap()
            }
            let enabled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "1"), object: localHTTP)
            try require(XCTWaiter.wait(for: [enabled], timeout: 5) == .completed, "Local HTTP must be enabled through the onboarding switch")
        }
        try replace(origin, with: fixture.serverURL.absoluteString)
        try replace(app.textFields["pairingDeviceName"], with: "Native CI \(suffix)")
        try replace(app.textFields["pairingCode"], with: fixture.pairingCode)
        let pair = app.buttons["pairDevice"]
        try reveal(pair)
        try require(pair.isEnabled, "Pairing must be enabled after completing the form")
        pair.tap()
        let channelsTab = app.tabBars.buttons["Channels"]
        try require(channelsTab.waitForExistence(timeout: 20), "The app must authenticate and load the real server bootstrap")
        channelsTab.tap()
        try require(app.navigationBars["Channels"].waitForExistence(timeout: 10), "Selecting Channels must show the channel page")
        let channel = app.buttons["channel.\(fixture.channelId)"]
        try require(channel.waitForExistence(timeout: 15), "The server fixture channel must appear in the selected project")
        channel.tap()
        try waitForLiveConnection()

        try send(rootBody)
        let roots = try await peerMessages()
        let root = try XCTUnwrap(roots.first { $0.body == rootBody }, "Native root must be persisted on the real server")
        XCTAssertEqual(roots.filter { $0.body == rootBody }.count, 1)
        XCTAssertNil(root.threadRootId)
        let thread = app.buttons["thread.\(root.id)"]
        try reveal(thread)
        thread.tap()
        try send(replyBody)
        let nativeReplies = try await peerMessages(root: root.id)
        let reply = try XCTUnwrap(nativeReplies.first { $0.body == replyBody })
        XCTAssertEqual(reply.threadRootId, root.id)
        XCTAssertEqual(nativeReplies.filter { $0.body == replyBody }.count, 1)
        try waitForLiveConnection()

        // The real browser waits for nativeReply, then sends browserReply through
        // its own composer. This test never substitutes an API write for it.
        // The reply must appear promptly without a manual refresh while the
        // authenticated socket is connected. A send-triggered REST refresh may
        // overlap this exchange, so this alone does not isolate the WS path.
        try require(app.staticTexts[liveBody].waitForExistence(timeout: 12), "Web UI reply must appear without a manual refresh")
        let repliesAfterBrowser = try await peerMessages(root: root.id)
        let live = try XCTUnwrap(repliesAfterBrowser.first { $0.body == liveBody })
        XCTAssertEqual(live.threadRootId, root.id)
        try waitForLiveConnection()

        XCUIDevice.shared.press(.home)
        try require(app.wait(for: .runningBackground, timeout: 10) || app.state == .runningBackgroundSuspended, "The app must enter the background")
        let background = try await peerSend(catchUpBody, root: root.id)
        app.activate()
        try require(app.staticTexts[catchUpBody].waitForExistence(timeout: 15), "Foreground must reconcile the message written while backgrounded")
        XCTAssertEqual(background.threadRootId, root.id)
        try waitForLiveConnection()
        let finalReplies = try await peerMessages(root: root.id)
        for body in [replyBody, liveBody, catchUpBody] {
            XCTAssertEqual(finalReplies.filter { $0.body == body }.count, 1, "A logical send must be persisted once")
        }
        XCTAssertTrue(finalReplies.allSatisfy { $0.threadRootId == root.id })
        app.terminate()
        app.launch()
        try require(channelsTab.waitForExistence(timeout: 20), "Relaunch must restore the saved Keychain connection")
        channelsTab.tap()
        try require(app.navigationBars["Channels"].waitForExistence(timeout: 10), "Selecting Channels after relaunch must show the channel page")
        try require(channel.waitForExistence(timeout: 15), "The saved channel must be available after relaunch")
        channel.tap()
        try require(app.staticTexts[rootBody].waitForExistence(timeout: 15), "Channel history must survive app relaunch")
        try reveal(thread); thread.tap()
        try require(app.staticTexts[catchUpBody].waitForExistence(timeout: 15), "Thread history must survive app relaunch")
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Native real-server thread after foreground catch-up"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        let evidence = ["project_id": fixture.projectId, "channel_id": fixture.channelId, "root_message_id": root.id,
                        "native_reply_id": reply.id, "peer_live_reply_id": live.id, "peer_background_reply_id": background.id]
        let record = XCTAttachment(data: try JSONSerialization.data(withJSONObject: evidence, options: .sortedKeys), uniformTypeIdentifier: "public.json")
        record.name = "Real server message identities"; record.lifetime = .keepAlways; add(record)
    }

    @MainActor
    private func send(_ body: String) throws {
        let composer = app.descendants(matching: .any).matching(identifier: "messageComposer").firstMatch
        try reveal(composer)
        try replace(composer, with: body)
        let button = app.buttons["sendMessage"]
        try reveal(button)
        try require(button.isEnabled, "The message send control must be enabled")
        button.tap()
        try require(app.staticTexts[body].waitForExistence(timeout: 15), "The native send must complete against the real server")
    }

    @MainActor
    private func replace(_ field: XCUIElement, with text: String) throws {
        try require(field.waitForExistence(timeout: 10), "Required text field must exist")
        try reveal(field)
        field.tap()
        if let current = field.value as? String, !current.isEmpty, current != field.placeholderValue {
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
        }
        field.typeText(text)
    }

    @MainActor
    private func reveal(_ element: XCUIElement) throws {
        for _ in 0..<5 {
            if element.exists && element.isHittable { return }
            app.swipeUp()
        }
        for _ in 0..<5 {
            if element.exists && element.isHittable { return }
            app.swipeDown()
        }
        try require(element.exists && element.isHittable, "Required control must be reachable")
    }

    @MainActor
    private func waitForLiveConnection() throws {
        // Connection status is read-only. Its decorative image need not be
        // hittable, and scrolling here could trigger the list's manual refresh.
        let connected = app.descendants(matching: .any).matching(identifier: "realtimeStatus")
            .matching(NSPredicate(format: "value == %@", "connected")).firstMatch
        try require(connected.waitForExistence(timeout: 15), "The native client must establish an authenticated WebSocket")
    }

    @MainActor
    private func require(_ condition: Bool, _ message: String) throws {
        guard condition else {
            let screenshot = XCTAttachment(screenshot: app.screenshot())
            screenshot.name = "Native UI failure"; screenshot.lifetime = .keepAlways; add(screenshot)
            // XCTest assertions in async tests can continue despite
            // continueAfterFailure=false. Throw to stop dependent UI actions.
            throw NSError(domain: "ArtooUITestAssertion", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
        }
    }

    private func peerMessages(root: String? = nil) async throws -> [ServerMessage] {
        var components = URLComponents(url: fixture.serverURL.appendingPathComponent("api/v1/rooms/\(fixture.channelId)/messages"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "limit", value: "50")]
        if let root { components.queryItems?.append(URLQueryItem(name: "thread_root_id", value: root)) }
        let response: MessagePage = try await peerRequest(URLRequest(url: components.url!))
        return response.messages
    }

    private func peerSend(_ body: String, root: String) async throws -> ServerMessage {
        var request = URLRequest(url: fixture.serverURL.appendingPathComponent("api/v1/rooms/\(fixture.channelId)/messages"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let key = UUID().uuidString
        request.setValue(key, forHTTPHeaderField: "Idempotency-Key")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["kind": "text", "body": body, "thread_root_id": root, "client_request_id": key])
        let response: MessageEnvelope = try await peerRequest(request)
        return response.message
    }

    private func peerRequest<Response: Decodable>(_ input: URLRequest) async throws -> Response {
        var request = input
        request.setValue("Bearer \(fixture.peerToken)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 20
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: request)
        let http = try XCTUnwrap(response as? HTTPURLResponse)
        guard (200..<300).contains(http.statusCode) else {
            throw NSError(domain: "ArtooUITestPeer", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: "Authenticated peer request failed with HTTP \(http.statusCode)"])
        }
        let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(Response.self, from: data)
    }
}

private struct MessagePage: Decodable { let messages: [ServerMessage] }
private struct MessageEnvelope: Decodable { let message: ServerMessage }
private struct ServerMessage: Decodable { let id: String; let body: String; let threadRootId: String? }

private struct Fixture {
    let serverURL: URL
    let pairingCode: String
    let projectId: String
    let channelId: String
    let peerToken: String
    let nativeMessage: String
    let nativeReply: String
    let browserReply: String
    init(environment: [String: String]) throws {
        func require(_ key: String) throws -> String {
            guard let value = environment[key], !value.isEmpty else {
                throw NSError(domain: "ArtooUITestFixture", code: 1, userInfo: [NSLocalizedDescriptionKey: "Missing required UI fixture field \(key). Start the real server fixture first."])
            }
            return value
        }
        let origin = try require("ARTOO_UI_SERVER_URL")
        guard let url = URL(string: origin), let host = url.host, let scheme = url.scheme,
              ["localhost", "127.0.0.1", "::1"].contains(host), ["http", "https"].contains(scheme) else {
            throw NSError(domain: "ArtooUITestFixture", code: 2, userInfo: [NSLocalizedDescriptionKey: "UI fixtures must target an isolated loopback server"])
        }
        serverURL = url
        pairingCode = try require("ARTOO_UI_PAIRING_CODE")
        projectId = try require("ARTOO_UI_PROJECT_ID")
        channelId = try require("ARTOO_UI_CHANNEL_ID")
        peerToken = try require("ARTOO_UI_PEER_CONTROL_TOKEN")
        nativeMessage = try require("ARTOO_UI_NATIVE_MESSAGE")
        nativeReply = try require("ARTOO_UI_NATIVE_REPLY")
        browserReply = try require("ARTOO_UI_BROWSER_REPLY")
    }
}
