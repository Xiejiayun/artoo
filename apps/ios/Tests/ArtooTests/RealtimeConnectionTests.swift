import XCTest
@testable import Artoo

@MainActor
private final class TestRealtimeSocket: RealtimeSocket {
    var closeCode = 0
    var closed = false
    var sent: [String] = []
    var onSend: ((String) -> Void)?
    private var waiting: CheckedContinuation<Data, Error>?
    private var queued: [Result<Data, Error>] = []
    func start() {}
    func send(_ text: String) async throws { sent.append(text); onSend?(text) }
    func receive() async throws -> Data {
        if !queued.isEmpty { return try queued.removeFirst().get() }
        return try await withCheckedThrowingContinuation { waiting = $0 }
    }
    func close() { closed = true; fail(code: closeCode) }
    func frame(cursor: Int, id: String) {
        complete(.success(Data("{\"type\":\"event\",\"topic\":\"room:r\",\"cursor\":\(cursor),\"event\":{\"id\":\"\(id)\"}}".utf8)))
    }
    func fail(code: Int) { closeCode = code; complete(.failure(URLError(.networkConnectionLost))) }
    private func complete(_ result: Result<Data, Error>) {
        if let continuation = waiting { waiting = nil; continuation.resume(with: result) }
        else { queued.append(result) }
    }
}

final class RealtimeConnectionTests: XCTestCase {
    @MainActor
    func testNativeSocketUsesBearerHeaderAndSameOriginWithoutURLCredentials() throws {
        let request = try RealtimeConnection.authenticatedRequest(origin: URL(string: "https://team.example.com:8443")!, controlToken: "secret")
        XCTAssertEqual(request.url?.absoluteString, "wss://team.example.com:8443/api/v1/ws")
        XCTAssertNil(request.url?.query)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer secret")
        XCTAssertThrowsError(try RealtimeConnection.authenticatedRequest(origin: URL(string: "https://user:secret@team.example.com")!, controlToken: "secret"))
    }

    @MainActor
    func testReplayIncludesOlderOutOfOrderEventsAndReconnectUsesHighWaterCursor() async throws {
        let first = TestRealtimeSocket(); let second = TestRealtimeSocket()
        let subscribed = expectation(description: "first subscribed")
        first.onSend = { _ in subscribed.fulfill() }
        let reconnected = expectation(description: "cursor replay subscription")
        second.onSend = { text in
            let frame = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
            XCTAssertEqual(frame?["since_cursor"].text, "10")
            reconnected.fulfill()
        }
        var creates = 0
        let connection = RealtimeConnection(factory: { _ in creates += 1; return creates == 1 ? first : second }, retryDelay: 0.001)
        defer { connection.stop() }
        try connection.configure(origin: URL(string: "https://team.example.com")!, controlToken: "token", sessionID: "session_1", topics: ["room:r"])
        await fulfillment(of: [subscribed], timeout: 1)
        let firstUpdate = expectation(description: "live event refresh")
        let olderUpdate = expectation(description: "older replay event still refreshes")
        var updates = 0
        let observer = NotificationCenter.default.addObserver(forName: .artooRealtimeChanged, object: "session_1", queue: nil) { note in
            if note.userInfo?["topic"] as? String == "room:r" {
                updates += 1
                if updates == 1 { firstUpdate.fulfill() } else { olderUpdate.fulfill() }
            }
        }
        defer { NotificationCenter.default.removeObserver(observer) }
        first.frame(cursor: 10, id: "new")
        await fulfillment(of: [firstUpdate], timeout: 1)
        first.frame(cursor: 5, id: "older"); first.frame(cursor: 10, id: "new")
        await fulfillment(of: [olderUpdate], timeout: 1)
        XCTAssertEqual(connection.cursor, 10)
        first.fail(code: 1006)
        await fulfillment(of: [reconnected], timeout: 1)
        XCTAssertEqual(creates, 2)
        connection.setActive(false); XCTAssertTrue(second.closed); XCTAssertFalse(connection.connected)
    }

    @MainActor
    func testIdentityReplacementClosesOldSocketAndResetsReplayCursor() async throws {
        let old = TestRealtimeSocket(); let fresh = TestRealtimeSocket()
        let first = expectation(description: "old connection")
        old.onSend = { _ in first.fulfill() }
        let second = expectation(description: "new identity")
        fresh.onSend = { text in
            let frame = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
            XCTAssertEqual(frame?["since_cursor"].text, "0"); second.fulfill()
        }
        var requests: [URLRequest] = []
        let connection = RealtimeConnection(factory: { request in requests.append(request); return requests.count == 1 ? old : fresh })
        defer { connection.stop() }
        let origin = URL(string: "https://team.example.com")!
        try connection.configure(origin: origin, controlToken: "old", sessionID: "old-session", topics: ["room:r"])
        await fulfillment(of: [first], timeout: 1)
        try connection.configure(origin: origin, controlToken: "new", sessionID: "new-session", topics: ["room:r"])
        await fulfillment(of: [second], timeout: 1)
        XCTAssertTrue(old.closed)
        XCTAssertEqual(requests.last?.value(forHTTPHeaderField: "Authorization"), "Bearer new")
        connection.stop(); XCTAssertTrue(fresh.closed); XCTAssertEqual(connection.cursor, 0)
    }

    @MainActor
    func testForegroundReconnectRetainsCursorAndRoomSubscription() async throws {
        let first = TestRealtimeSocket(); let second = TestRealtimeSocket()
        let started = expectation(description: "foreground connection")
        first.onSend = { _ in started.fulfill() }
        let resumed = expectation(description: "foreground resumed")
        second.onSend = { text in
            let value = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
            XCTAssertEqual(value?["since_cursor"].text, "7")
            XCTAssertEqual(value?["topics"].array.map(\.text), ["room:r"])
            resumed.fulfill()
        }
        var count = 0
        let connection = RealtimeConnection(factory: { _ in count += 1; return count == 1 ? first : second })
        defer { connection.stop() }
        try connection.configure(origin: URL(string: "https://team.example.com")!, controlToken: "token", sessionID: "foreground", topics: ["room:r"])
        await fulfillment(of: [started], timeout: 1)
        let update = expectation(forNotification: .artooRealtimeChanged, object: "foreground") { $0.userInfo?["topic"] as? String == "room:r" }
        first.frame(cursor: 7, id: "event_7")
        await fulfillment(of: [update], timeout: 1)
        connection.setActive(false); XCTAssertTrue(first.closed)
        connection.setActive(true)
        await fulfillment(of: [resumed], timeout: 1)
        XCTAssertEqual(count, 2)
    }

    @MainActor
    func testRevokedSocketExpiresOnlyItsSessionAndDoesNotReconnect() async throws {
        let socket = TestRealtimeSocket()
        let subscribed = expectation(description: "subscribed"); socket.onSend = { _ in subscribed.fulfill() }
        let expired = expectation(forNotification: .artooAuthenticationExpired, object: "revoked-session")
        var creates = 0
        let connection = RealtimeConnection(factory: { _ in creates += 1; return socket }, retryDelay: 0.001)
        defer { connection.stop() }
        try connection.configure(origin: URL(string: "https://team.example.com")!, controlToken: "token", sessionID: "revoked-session", topics: ["room:r"])
        await fulfillment(of: [subscribed], timeout: 1)
        socket.fail(code: 1008)
        await fulfillment(of: [expired], timeout: 1)
        XCTAssertEqual(creates, 1); XCTAssertFalse(connection.connected)
    }
}
