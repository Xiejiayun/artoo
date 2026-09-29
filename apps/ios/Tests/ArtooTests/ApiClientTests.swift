import XCTest
@testable import Artoo

private final class APIProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (Int, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            guard let handler = Self.handler, let url = request.url else { throw ApiError.transport("No test handler") }
            let (status, data) = try handler(request)
            let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

final class ApiClientTests: XCTestCase {
    private var session: URLSession!

    @MainActor
    func testNotificationPagesRetainOlderUnreadAndUseWholeInboxCount() async throws {
        var phase = 0
        var oldRead = false
        var cursors: [String?] = []
        func row(_ id: String, read: Bool = false) -> [String: Any] {
            ["id": id, "created_at": "2026-09-29T00:00:00Z", "read_at": read ? "2026-09-29T01:00:00Z" : NSNull(),
             "project_id": "project_other", "room_id": "room_other", "body_preview": id]
        }
        APIProtocol.handler = { request in
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
            XCTAssertEqual(query?.first { $0.name == "limit" }?.value, "50")
            let cursor = query?.first { $0.name == "before" }?.value
            cursors.append(cursor)
            let rows: [[String: Any]]
            let next: Any
            if cursor == nil {
                rows = phase == 2 ? [row("n8"), row("n7")] : (phase == 1 ? [row("n4"), row("n3")] : [row("n3"), row("n2")])
                next = "opaque +/="
            } else if phase == 2 && cursor == "opaque +/=" {
                rows = [row("n6"), row("n5")]; next = "tail"
            } else {
                rows = phase == 2 ? [row("n4"), row("n3"), row("n2"), row("n1", read: oldRead)] : [row("n2"), row("n1", read: oldRead)]
                next = NSNull()
            }
            let response: [String: Any] = ["notifications": rows, "next_before": next,
                                           "has_more": next is String, "unread_count": oldRead ? 135 + phase : 136]
            return (200, try JSONSerialization.data(withJSONObject: response))
        }
        let model = NotificationInboxViewModel(client: client())
        await model.refresh()
        XCTAssertEqual(model.unreadCount, 136); XCTAssertEqual(model.notifications.count, 2)
        await model.loadEarlier()
        XCTAssertEqual(cursors[1], "opaque +/=")
        XCTAssertEqual(model.notifications.map(\.id), ["n3", "n2", "n1"])
        XCTAssertFalse(model.hasMore)
        oldRead = true; phase = 1; await model.refresh()
        XCTAssertEqual(model.notifications.map(\.id), ["n4", "n3", "n2", "n1"])
        XCTAssertNotEqual(model.notifications.last?["read_at"], .null, "A read on another device must update the loaded older page")
        XCTAssertEqual(model.unreadCount, 136)
        XCTAssertFalse(model.hasMore)
        phase = 2; await model.refresh()
        XCTAssertEqual(model.notifications.map(\.id), ["n8", "n7", "n6", "n5"])
        XCTAssertTrue(model.hasMore, "New bursts must retain a cursor for rows that moved beyond the refreshed window")
        await model.loadEarlier()
        XCTAssertEqual(cursors.last!, "tail")
        XCTAssertEqual(model.notifications.map(\.id), ["n8", "n7", "n6", "n5", "n4", "n3", "n2", "n1"])
        XCTAssertEqual(model.unreadCount, 137)
        XCTAssertFalse(model.hasMore)
        let readValue = try JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: row("n8", read: true)))
        model.recordRead(try XCTUnwrap(WorkspaceRecord(readValue)), unreadCount: 136)
        XCTAssertEqual(model.unreadCount, 136)
        XCTAssertNotEqual(model.notifications.first?["read_at"], .null)
    }

    @MainActor
    func testUnreadBadgeDistinguishesUnknownFailedAndMeasuredZero() async throws {
        let container = AppContainer(client: client())
        XCTAssertNil(container.unreadNotificationCount)
        XCTAssertEqual(container.notificationBadge, "?")
        APIProtocol.handler = { _ in (200, Data(#"{"notifications":[],"next_before":null,"has_more":false,"unread_count":136}"#.utf8)) }
        await container.refreshNotificationCount()
        XCTAssertEqual(container.unreadNotificationCount, 136)
        XCTAssertEqual(container.notificationBadge, "136")
        APIProtocol.handler = { _ in throw ApiError.transport("offline") }
        await container.refreshNotificationCount()
        XCTAssertEqual(container.unreadNotificationCount, 136)
        XCTAssertEqual(container.notificationBadge, "?")
        XCTAssertTrue(container.notificationCountSummary.contains("Last known: 136"))
        APIProtocol.handler = { _ in (200, Data(#"{"notifications":[],"next_before":null,"has_more":false,"unread_count":0}"#.utf8)) }
        await container.refreshNotificationCount()
        XCTAssertEqual(container.unreadNotificationCount, 0)
        XCTAssertNil(container.notificationBadge)
        XCTAssertNil(container.notificationCountError)
    }
    override func setUp() {
        super.setUp()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [APIProtocol.self]
        session = URLSession(configuration: configuration)
    }
    override func tearDown() { session.invalidateAndCancel(); APIProtocol.handler = nil; super.tearDown() }
    private func client(token: String? = "control-secret") -> ApiClient {
        ApiClient(baseURL: URL(string: "https://team.example.com")!, session: session, authToken: token)
    }

    func testNativeSessionUsesBearerAndNoTokenInURL() async throws {
        APIProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/auth/session")
            XCTAssertNil(request.url?.query)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer control-secret")
            return (200, Data(#"{"user":{"id":"u","email":"e@example.com","name":"User","role":"member"},"device_id":"d"}"#.utf8))
        }
        let identity = try await client().currentSession()
        XCTAssertEqual(identity.deviceId, "d")
        XCTAssertFalse(identity.isAdministrator)
    }

    func testPairingDoesNotTransmitAnExistingBearerOrPersistNodeToken() async throws {
        APIProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/v1/devices/claim")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            XCTAssertNil(request.value(forHTTPHeaderField: "Idempotency-Key"))
            let body = try Self.body(request)
            XCTAssertEqual(body["platform"].text, "ios")
            XCTAssertEqual(body["code"].text, "ABCD-EFGH")
            XCTAssertEqual(body["display_name"].text, "Phone")
            return (201, Data(#"{"device":{"id":"d"},"control_token":"new-secret","node_token":"ignored-node"}"#.utf8))
        }
        let claim = try await client().claimPairing(code: "ABCD-EFGH", displayName: "Phone")
        XCTAssertEqual(claim.controlToken, "new-secret")
    }

    func testMutationKeepsWireKeysAndLogoutHandles204() async throws {
        APIProtocol.handler = { request in
            if request.url?.path == "/auth/logout" {
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer control-secret")
                return (204, Data())
            }
            XCTAssertNotNil(request.value(forHTTPHeaderField: "Idempotency-Key"))
            let body = try Self.body(request)
            XCTAssertEqual(body["depends_on_task_id"].text, "task_1")
            return (201, Data(#"{"dependency":{"id":"dep_1"}}"#.utf8))
        }
        let result = try await client().command(path: "/api/v1/tasks/task_2/dependencies", body: .object(["depends_on_task_id": .string("task_1"), "type": .string("blocks")]))
        XCTAssertEqual(result["dependency"]["id"].text, "dep_1")
        try await client().logout()
    }

    func testUnauthenticatedResponseNotifiesAppAndPreservesActionError() async throws {
        let expired = expectation(forNotification: .artooAuthenticationExpired, object: nil)
        APIProtocol.handler = { _ in (401, Data(#"{"error":{"message":"authentication required"}}"#.utf8)) }
        do { _ = try await client().currentSession(); XCTFail("Expired bearer must fail") }
        catch let error as ApiError { XCTAssertEqual(error, .http(status: 401, body: "authentication required")) }
        await fulfillment(of: [expired], timeout: 1)
    }

    func testRefusesCrossOriginResourceBeforeNetworkRequest() async {
        APIProtocol.handler = { _ in XCTFail("Must not reach the network"); return (200, Data()) }
        do { _ = try await client().resource(path: "//attacker.example/api"); XCTFail("Cross-origin URL must fail") }
        catch { XCTAssertTrue(error is ApiError) }
    }

    func testRoomPaginationEscapesOpaqueCursorsAndDecodesSequence() async throws {
        APIProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/v1/rooms/room_1/messages")
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
            XCTAssertEqual(query?.first { $0.name == "limit" }?.value, "50")
            XCTAssertEqual(query?.first { $0.name == "after" }?.value, "opaque+/=&cursor")
            return (200, Data(#"{"messages":[{"id":"m","room_id":"room_1","actor_type":"user","actor_id":"u","body":"Hello","sequence":123}],"next_before":"older","next_after":"newer","has_more":true}"#.utf8))
        }
        let page = try await client().messagePage(roomId: "room_1", after: "opaque+/=&cursor")
        XCTAssertEqual(page.messages.first?.sequence, 123)
        XCTAssertEqual(page.nextAfter, "newer"); XCTAssertEqual(page.nextBefore, "older"); XCTAssertEqual(page.hasMore, true)
    }

    func testInvalidatedClientCannotSendUnderAnOldIdentity() async {
        APIProtocol.handler = { _ in XCTFail("An invalidated session must not issue requests"); return (200, Data()) }
        let old = client(); old.invalidate()
        do { _ = try await old.command(path: "/api/v1/rooms/r/messages", body: .object(["body": .string("old")]), idempotencyKey: "old-send"); XCTFail("Old session accepted") }
        catch { XCTAssertTrue(error is CancellationError) }
    }

    @MainActor
    func testRoomDraftSurvivesRelaunchAndUnknownDeliveryRetriesSameBodyAndKey() async throws {
        let suite = "artoo.drafts.test.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite)); defer { defaults.removePersistentDomain(forName: suite) }
        let store = RoomDraftStore(defaults: defaults)
        let api = client()
        var attempts: [String] = []
        APIProtocol.handler = { request in
            if request.httpMethod == "GET" { return (200, Data(#"{"messages":[],"next_before":null,"next_after":null,"has_more":false}"#.utf8)) }
            attempts.append(try XCTUnwrap(request.value(forHTTPHeaderField: "Idempotency-Key")))
            XCTAssertEqual(try Self.body(request)["body"].text, "Keep my draft")
            if attempts.count == 1 { throw URLError(.timedOut) }
            return (201, Data(#"{"message":{"id":"m"}}"#.utf8))
        }
        let first = RoomMessagesViewModel(client: api, roomId: "room_1", drafts: store)
        first.configureDraft(server: "https://team.example.com", user: "user_1")
        first.draft.text = "Keep my draft"
        let failed = await first.send(); XCTAssertFalse(failed)
        XCTAssertEqual(first.draft.text, "Keep my draft"); XCTAssertNotNil(first.draft.pending)
        let restored = RoomMessagesViewModel(client: api, roomId: "room_1", drafts: store)
        restored.configureDraft(server: "https://team.example.com/", user: "user_1")
        XCTAssertEqual(restored.draft, first.draft)
        let succeeded = await restored.submitPending(); XCTAssertTrue(succeeded)
        XCTAssertEqual(attempts.count, 2); XCTAssertEqual(attempts[0], attempts[1])
        XCTAssertTrue(restored.draft.text.isEmpty); XCTAssertNil(restored.draft.pending)
        for scope in [("https://other.example.com", "user_1", "room_1"), ("https://team.example.com", "user_2", "room_1"), ("https://team.example.com", "user_1", "room_2")] {
            XCTAssertEqual(store.load(key: RoomDraftStore.key(server: scope.0, user: scope.1, room: scope.2)), RoomDraft())
        }
    }

    @MainActor
    func testRoomPagesMergeWithoutDuplicatesInSequenceOrder() async throws {
        APIProtocol.handler = { request in
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let older = query.contains { $0.name == "before" }
            let newer = query.contains { $0.name == "after" }
            let ids = older ? [1, 2, 3] : newer ? [4, 5] : [3, 4]
            let messages = ids.map { n in JSONValue.object(["id": .string("m_\(n)"), "room_id": .string("r"), "actor_type": .string("user"), "actor_id": .string("u"), "body": .string("Message \(n)"), "sequence": .number(Double(n)), "created_at": .string(n == 5 ? "2020" : "2026")]) }
            return (200, try JSONEncoder().encode(JSONValue.object(["messages": .array(messages), "next_before": older ? .null : .string("old"), "next_after": .string(newer ? "new5" : "new4"), "has_more": .bool(!older && !newer)])))
        }
        let model = RoomMessagesViewModel(client: client(), roomId: "r")
        await model.refresh(); XCTAssertEqual(model.messages.map(\.id), ["m_3", "m_4"]); XCTAssertTrue(model.hasOlder)
        await model.loadOlder(); XCTAssertFalse(model.hasOlder)
        await model.refresh(); XCTAssertEqual(model.messages.map(\.id), ["m_1", "m_2", "m_3", "m_4", "m_5"])
    }

    @MainActor
    func testAssistantUsesStableLogicalRequestIdAndRetainsWaitingAndFailureStates() async throws {
        let suite = "artoo.assistant.test.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite)); defer { defaults.removePersistentDomain(forName: suite) }
        let store = RoomDraftStore(defaults: defaults)
        let fixtureURL = try XCTUnwrap(Bundle(for: ApiClientTests.self).url(forResource: "assistant-turns", withExtension: "json"))
        let fixture = try Data(contentsOf: fixtureURL)
        var keys: [String] = []
        APIProtocol.handler = { request in
            if request.httpMethod == "GET" {
                return (200, request.url?.path.hasSuffix("assistant-turns") == true ? fixture : Data(#"{"messages":[],"has_more":false}"#.utf8))
            }
            XCTAssertEqual(request.url?.path, "/api/v1/rooms/room_1/assistant-turns")
            let body = try Self.body(request)
            let key = try XCTUnwrap(request.value(forHTTPHeaderField: "Idempotency-Key"))
            XCTAssertEqual(body["client_request_id"].text, key)
            XCTAssertEqual(body["agent_instance_id"].text, "agent_1")
            XCTAssertEqual(body["body"].text, "Explain the change")
            keys.append(key)
            if keys.count == 1 { throw URLError(.networkConnectionLost) }
            return (201, Data(#"{"turn":{"id":"turn_1"},"message":{"id":"message_1"}}"#.utf8))
        }
        let model = RoomMessagesViewModel(client: client(), roomId: "room_1", drafts: store)
        model.configureDraft(server: "https://team.example.com", user: "user_1")
        model.draft.text = "Explain the change"; model.draft.target = "assistant"; model.draft.agentInstanceId = "agent_1"
        let first = await model.send(); XCTAssertFalse(first)
        let second = await model.submitPending(); XCTAssertTrue(second)
        XCTAssertEqual(keys.count, 2); XCTAssertEqual(keys.first, keys.last)
        XCTAssertEqual(model.turns.map(\.status), ["waiting", "failed"])
        XCTAssertEqual(model.turns.last?.error, "Runtime unavailable")
        XCTAssertEqual(model.turns.first?.taskId, "task_1")
    }

    @MainActor
    func testThreadDraftAndSendAreScopedToRootWithRealUserMentions() async throws {
        let suite = "artoo.thread.test.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite)); defer { defaults.removePersistentDomain(forName: suite) }
        let store = RoomDraftStore(defaults: defaults)
        APIProtocol.handler = { request in
            if request.httpMethod == "GET" {
                let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
                XCTAssertEqual(query?.first { $0.name == "thread_root_id" }?.value, "message_root")
                return (200, Data(#"{"messages":[],"has_more":false}"#.utf8))
            }
            let body = try Self.body(request)
            XCTAssertEqual(body["thread_root_id"].text, "message_root")
            XCTAssertEqual(body["client_request_id"].text, request.value(forHTTPHeaderField: "Idempotency-Key"))
            XCTAssertEqual(body["mentions"].array.first?["actor_type"].text, "user")
            XCTAssertEqual(body["mentions"].array.first?["actor_id"].text, "user_teammate")
            return (201, Data(#"{"message":{"id":"reply"}}"#.utf8))
        }
        let model = RoomMessagesViewModel(client: client(), roomId: "r", threadRootId: "message_root", drafts: store)
        model.configureDraft(server: "https://team.example.com", user: "u")
        model.draft.text = "Please review"; model.draft.mentionedUserIds = ["user_teammate"]
        XCTAssertTrue(store.load(key: RoomDraftStore.key(server: "https://team.example.com", user: "u", room: "r")).text.isEmpty)
        XCTAssertEqual(store.load(key: RoomDraftStore.key(server: "https://team.example.com", user: "u", room: "r", threadRootId: "message_root")).text, "Please review")
        let result = await model.send(); XCTAssertTrue(result)
    }

    @MainActor
    func testAgentThreadSendAndTurnListPreserveThreadIsolation() async throws {
        let suite = "artoo.agent-thread.test.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite)); defer { defaults.removePersistentDomain(forName: suite) }
        let fixtureURL = try XCTUnwrap(Bundle(for: ApiClientTests.self).url(forResource: "assistant-turns", withExtension: "json"))
        let turns = try Data(contentsOf: fixtureURL)
        APIProtocol.handler = { request in
            if request.httpMethod == "GET" {
                let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
                XCTAssertEqual(query?.first { $0.name == "thread_root_id" }?.value, "message_root")
                return (200, request.url?.path.hasSuffix("assistant-turns") == true ? turns : Data(#"{"messages":[],"has_more":false}"#.utf8))
            }
            XCTAssertEqual(request.url?.path, "/api/v1/rooms/room_1/assistant-turns")
            XCTAssertEqual(try Self.body(request)["thread_root_id"].text, "message_root")
            return (201, Data(#"{"turn":{"id":"turn_thread"},"message":{"id":"message_thread"}}"#.utf8))
        }
        let model = RoomMessagesViewModel(client: client(), roomId: "room_1", threadRootId: "message_root", drafts: RoomDraftStore(defaults: defaults))
        model.configureDraft(server: "https://team.example.com", user: "u")
        model.draft.text = "Review this thread"; model.draft.target = "assistant"
        let result = await model.send(); XCTAssertTrue(result)
        XCTAssertEqual(model.turns.map(\.id), ["turn_thread"])
        XCTAssertEqual(model.turns.first?.threadRootId, "message_root")
    }

    @MainActor
    func testPlanningThreadRetainsUnknownIntentButOnlyAllowsTeamReply() async throws {
        let suite = "artoo.planning-thread.test.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite)); defer { defaults.removePersistentDomain(forName: suite) }
        let store = RoomDraftStore(defaults: defaults)
        var draft = RoomDraft(); draft.text = "Add acceptance checks"; draft.target = "assistant"
        draft.pending = RoomDraft.Submission(key: "original", text: draft.text, path: "/api/v1/rooms/r/assistant-turns", body: .object(["body": .string(draft.text)]))
        store.save(draft, key: RoomDraftStore.key(server: "https://team.example.com", user: "u", room: "r", threadRootId: "root"))
        let model = RoomMessagesViewModel(client: client(), roomId: "r", threadRootId: "root", drafts: store, allowsAssistantRequests: false)
        model.configureDraft(server: "https://team.example.com", user: "u")
        APIProtocol.handler = { _ in XCTFail("A planning thread must not replay a direct agent request"); throw URLError(.badURL) }
        let blocked = await model.submitPending(); XCTAssertFalse(blocked)
        XCTAssertEqual(model.draft.pending?.key, "original")
        model.keepPendingTextAsTeamReply()
        XCTAssertEqual(model.draft.text, draft.text); XCTAssertEqual(model.draft.target, "team"); XCTAssertNil(model.draft.pending)
        APIProtocol.handler = { request in
            if request.httpMethod == "GET" { return (200, Data(#"{"messages":[],"has_more":false}"#.utf8)) }
            XCTAssertEqual(request.url?.path, "/api/v1/rooms/r/messages")
            XCTAssertEqual(try Self.body(request)["thread_root_id"].text, "root")
            return (201, Data(#"{"message":{"id":"reply"}}"#.utf8))
        }
        let sent = await model.send(); XCTAssertTrue(sent)
        let root = Message(id: "root", roomId: "r", actorType: "user", actorId: "u", body: "Goal", payload: .object(["discussion_id": .string("discussion_1")]))
        XCTAssertTrue(root.isPlanningDiscussion)
    }

    @MainActor
    func testDaemonFailureAndStaleSnapshotAreUnknownRatherThanOffline() async throws {
        var disconnected = false
        APIProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/v1/daemons")
            if disconnected { throw URLError(.notConnectedToInternet) }
            return (200, Data(#"{"daemons":[{"computer_id":"c","display_name":"Workstation","status":"online","connected":true,"last_heartbeat_at":"2026-09-29T00:00:00Z","heartbeat_age_ms":200,"active_runs":2,"runtimes":[]}] }"#.utf8))
        }
        let model = DaemonStatusViewModel(client: client())
        await model.load(); XCTAssertEqual(model.status(computerId: "c"), "online")
        XCTAssertEqual(model.status(computerId: "c", now: Date().addingTimeInterval(13)), "unknown")
        disconnected = true; await model.load()
        XCTAssertEqual(model.status(computerId: "c"), "unknown")
        XCTAssertEqual(model.daemons.first?.activeRuns, 2); XCTAssertNotNil(model.error)
    }

    @MainActor
    func testThreadReplyCountDoesNotRegressWhenReplayFollowsNewerLiveEvent() async {
        APIProtocol.handler = { _ in (200, Data(#"{"messages":[{"id":"root","room_id":"r","actor_type":"user","actor_id":"u","body":"Topic","sequence":1,"reply_count":0}],"has_more":false}"#.utf8)) }
        let model = RoomMessagesViewModel(client: client(), roomId: "r")
        await model.refresh()
        for count in [3, 1] {
            model.applyRealtime([.object(["event": .object(["room_id": .string("r"), "payload": .object(["thread_root_id": .string("root"), "root_reply_count": .number(Double(count))])])])])
        }
        XCTAssertEqual(model.messages.first?.replyCount, 3)
    }

    @MainActor
    func testFailedWorkspaceCommandRetainsLoadedDataAndReportsFailure() async {
        APIProtocol.handler = { request in
            if request.httpMethod == "GET" { return (200, Data(#"{"goals":[{"id":"goal_1","title":"Ship","status":"running"}]}"#.utf8)) }
            return (409, Data(#"{"error":{"message":"The execution computer is offline"}}"#.utf8))
        }
        let model = WorkspaceViewModel(client: client(), path: "/api/v1/goals")
        await model.load()
        XCTAssertEqual(model.state.value?["goals"].records.first?.id, "goal_1")
        let succeeded = await model.perform(path: "/api/v1/goals/goal_1/pause")
        XCTAssertFalse(succeeded)
        XCTAssertEqual(model.state.value?["goals"].records.first?.id, "goal_1")
        XCTAssertTrue(model.actionError?.contains("offline") == true)
        XCTAssertFalse(model.busy)
    }

    @MainActor
    func testFailedApprovalResolutionReturnsFalseInsteadOfDismissingTheDecision() async {
        APIProtocol.handler = { _ in (409, Data(#"{"error":{"message":"Approval already resolved"}}"#.utf8)) }
        let model = InboxViewModel(client: client())
        let approval = Approval(id: "approval_1", action: "Merge", risk: .high, status: .pending)
        let succeeded = await model.resolve(approval, approve: true)
        XCTAssertFalse(succeeded)
        XCTAssertTrue(model.state.errorMessage?.contains("already resolved") == true)
        XCTAssertFalse(model.isResolving(approval))
    }

    @MainActor
    func testExecutionApprovalRequestUsesReadyTaskRouteAndPreservesFailure() async throws {
        var rejectRequest = true
        var requested = false
        APIProtocol.handler = { request in
            if request.httpMethod == "GET" {
                let approvals = requested ? #"[{"id":"approval_gate","task_id":"task_1","action":"execution.start","risk":"high","summary":"Review deployment","payload_ref":"execution-gate/current","status":"pending"}]"# : "[]"
                return (200, Data("{\"task\":{\"id\":\"task_1\",\"project_id\":\"proj_artoo\",\"title\":\"Deploy\",\"status\":\"ready\"},\"runs\":[],\"approvals\":\(approvals),\"artifacts\":[]}".utf8))
            }
            XCTAssertEqual(request.url?.path, "/api/v1/tasks/task_1/execution-approval")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer control-secret")
            XCTAssertNotNil(request.value(forHTTPHeaderField: "Idempotency-Key"))
            let body = try Self.body(request)
            XCTAssertEqual(body["summary"].text, "Review deployment")
            XCTAssertEqual(body["risk"].text, "high")
            if rejectRequest { return (409, Data(#"{"error":{"message":"Task changed; refresh before reviewing"}}"#.utf8)) }
            requested = true
            return (201, Data(#"{"approval":{"id":"approval_gate","action":"execution.start","status":"pending"}}"#.utf8))
        }
        let model = TaskDetailViewModel(client: client(), taskId: "task_1")
        await model.load()
        var draft = ExecutionApprovalDraft(); draft.summary = " Review deployment \n"; draft.risk = "high"
        let failed = await model.requestExecutionApproval(draft)
        XCTAssertFalse(failed)
        XCTAssertEqual(model.state.value?.task.status, .ready)
        XCTAssertTrue(model.actionError?.contains("Task changed") == true)
        XCTAssertFalse(model.actionInFlight)
        rejectRequest = false
        let succeeded = await model.requestExecutionApproval(draft)
        XCTAssertTrue(succeeded)
        XCTAssertEqual(model.executionApproval?.status, .pending)
        XCTAssertEqual(model.state.value?.task.status, .ready)
        XCTAssertEqual(model.availableActions, [])
    }

    @MainActor
    func testSuccessfulAssignmentDecodesRunEnvelopeAndReloadsAssignedTask() async throws {
        let fixtureURL = try XCTUnwrap(Bundle(for: ApiClientTests.self).url(forResource: "assignment-response", withExtension: "json"))
        let fixtureData = try Data(contentsOf: fixtureURL)
        let fixture = try JSONDecoder().decode(JSONValue.self, from: fixtureData)
        let decoded = try ArtooJSON.decoder().decode(AssignResponse.self, from: fixtureData)
        XCTAssertEqual(decoded.run.id, "run_assigned")
        XCTAssertEqual(decoded.schedulerDecision.id, "decision_1")
        XCTAssertEqual(decoded.schedulerDecision.score, 42)
        var assigned = false
        APIProtocol.handler = { request in
            if request.httpMethod == "GET" {
                let snapshot = JSONValue.object([
                    "task": .object(["id": .string("task_1"), "project_id": .string("proj_artoo"), "title": .string("Implement"), "status": .string(assigned ? "assigned" : "ready")]),
                    "runs": .array(assigned ? [fixture["run"]] : []), "approvals": .array([]), "artifacts": .array([])
                ])
                return (200, try JSONEncoder().encode(snapshot))
            }
            XCTAssertEqual(request.url?.path, "/api/v1/tasks/task_1/assign")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer control-secret")
            let body = try Self.body(request)
            XCTAssertEqual(body["mode"].text, "manual")
            XCTAssertEqual(body["agent_instance_id"].text, "instance_1")
            assigned = true
            return (200, fixtureData)
        }
        let model = TaskDetailViewModel(client: client(), taskId: "task_1")
        await model.load()
        await model.assign(mode: "manual", agentInstanceId: "instance_1")
        XCTAssertNil(model.actionError)
        XCTAssertEqual(model.state.value?.task.status, .assigned)
        XCTAssertEqual(model.state.value?.runs.first?.id, "run_assigned")
        XCTAssertFalse(model.actionInFlight)
    }

    private static func body(_ request: URLRequest) throws -> JSONValue {
        if let data = request.httpBody { return try JSONDecoder().decode(JSONValue.self, from: data) }
        guard let stream = request.httpBodyStream else { throw ApiError.decoding("Missing test body") }
        stream.open(); defer { stream.close() }
        var data = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable { let count = stream.read(&buffer, maxLength: buffer.count); if count <= 0 { break }; data.append(buffer, count: count) }
        return try JSONDecoder().decode(JSONValue.self, from: data)
    }
}
