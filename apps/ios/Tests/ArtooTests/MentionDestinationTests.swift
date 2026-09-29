import XCTest
@testable import Artoo

@MainActor
final class MentionDestinationTests: XCTestCase {
    func testLoadAndReadFailuresRecoverIndependentlyWithoutReplacingTheThread() async throws {
        let notification = try record()
        var failLoad = true, failRead = true
        var fetches = 0, reads = 0, confirmed = 0
        let model = MentionDestinationViewModel(resource: { path in
            fetches += 1
            if failLoad { throw URLError(.notConnectedToInternet) }
            return self.message(id: path.hasSuffix("/reply") ? "reply" : "root", thread: path.hasSuffix("/reply") ? "root" : nil)
        }, markRead: { path in
            reads += 1; XCTAssertEqual(path, "/api/v1/notifications/mention/read")
            if failRead { throw URLError(.networkConnectionLost) }
            return self.receipt(notification, unread: 4)
        })
        let onRead: (WorkspaceRecord, Int) -> Void = { row, count in
            confirmed += 1; XCTAssertEqual(row.id, notification.id); XCTAssertEqual(count, 4)
        }
        await model.load(notification, onRead: onRead)
        XCTAssertNotNil(model.loadError); XCTAssertNil(model.readError); XCTAssertNil(model.root); XCTAssertEqual(reads, 0)
        failLoad = false
        await model.load(notification, onRead: onRead)
        XCTAssertNil(model.loadError); XCTAssertNotNil(model.readError)
        let root = model.root, focus = model.focus
        XCTAssertEqual(root?.id, "root"); XCTAssertEqual(focus?.id, "reply")
        XCTAssertEqual(fetches, 3); XCTAssertEqual(reads, 1); XCTAssertEqual(confirmed, 0)
        failRead = false
        await model.retryRead(onRead: onRead)
        XCTAssertNil(model.readError); XCTAssertTrue(model.readConfirmed)
        XCTAssertEqual(model.root, root); XCTAssertEqual(model.focus, focus)
        XCTAssertEqual(fetches, 3, "Retry read must preserve the existing thread and its composer")
        XCTAssertEqual(reads, 2); XCTAssertEqual(confirmed, 1)
        await model.load(notification, onRead: onRead)
        XCTAssertEqual(reads, 2, "An already confirmed read must not be submitted again")
    }

    func testMismatchedMessageOrRootNeverMarksTheMentionRead() async throws {
        let notification = try record()
        let validMessage = message(id: "reply", thread: "root"), validRoot = message(id: "root")
        let pairs: [(JSONValue, JSONValue)] = [
            (message(id: "wrong", thread: "root"), validRoot),
            (message(id: "reply", room: "another_room", thread: "root"), validRoot),
            (message(id: "reply", thread: "another_root"), validRoot),
            (validMessage, message(id: "wrong")),
            (validMessage, message(id: "root", room: "another_room")),
            (validMessage, message(id: "root", thread: "nested_root"))
        ]
        for (selected, root) in pairs {
            var reads = 0
            let model = MentionDestinationViewModel(resource: { path in path.hasSuffix("/reply") ? selected : root }, markRead: { _ in reads += 1; return .null })
            await model.load(notification, onRead: { _, _ in XCTFail("A mismatched destination cannot update the inbox") })
            XCTAssertNotNil(model.loadError); XCTAssertNil(model.root); XCTAssertNil(model.focus)
            XCTAssertEqual(reads, 0)
        }
        let rootMention = try record(message: "reply", thread: nil)
        let model = MentionDestinationViewModel(resource: { _ in validMessage }, markRead: { _ in XCTFail("The notification's root/reply identity must match"); return .null })
        await model.load(rootMention, onRead: { _, _ in XCTFail("Unexpected confirmation") })
        XCTAssertNotNil(model.loadError)
    }

    func testOldMessageResponseCannotReplaceANewDestinationOrMarkItRead() async throws {
        let first = try record(id: "first", message: "old", thread: nil)
        let second = try record(id: "second", message: "new", thread: nil)
        let pending = DeferredMentionResponse()
        var confirmed: [String] = [], reads: [String] = []
        let model = MentionDestinationViewModel(resource: { path in
            if path.hasSuffix("/old") { return try await pending.response() }
            return self.message(id: "new")
        }, markRead: { path in reads.append(path); return self.receipt(second) })
        let oldRequest = Task { await model.load(first) { row, _ in confirmed.append(row.id) } }
        await fulfillment(of: [pending.started], timeout: 2)
        await model.load(second) { row, _ in confirmed.append(row.id) }
        pending.resolve(message(id: "old")); await oldRequest.value
        XCTAssertEqual(model.root?.id, "new"); XCTAssertEqual(model.focus?.id, "new")
        XCTAssertEqual(confirmed, ["second"]); XCTAssertEqual(reads, ["/api/v1/notifications/second/read"])
        XCTAssertNil(model.loadError)
    }

    func testOldReadConfirmationCannotChangeTheNewDestinationsUnreadState() async throws {
        let first = try record(id: "first", message: "old", thread: nil)
        let second = try record(id: "second", message: "new", thread: nil)
        let pending = DeferredMentionResponse()
        var confirmed: [String] = []
        let model = MentionDestinationViewModel(resource: { path in self.message(id: path.hasSuffix("/old") ? "old" : "new") }, markRead: { path in
            if path.contains("/first/") { return try await pending.response() }
            return self.receipt(second, unread: 2)
        })
        let oldRequest = Task { await model.load(first) { row, _ in confirmed.append(row.id) } }
        await fulfillment(of: [pending.started], timeout: 2)
        await model.load(second) { row, count in confirmed.append(row.id); XCTAssertEqual(count, 2) }
        pending.resolve(receipt(first, unread: 50)); await oldRequest.value
        XCTAssertEqual(model.root?.id, "new"); XCTAssertEqual(confirmed, ["second"])
        XCTAssertTrue(model.readConfirmed); XCTAssertNil(model.readError)
    }

    func testRepeatedRetryIsSingleFlightAndADepartedScreenIgnoresItsResponse() async throws {
        let notification = try record(message: "root", thread: nil)
        let pending = DeferredMentionResponse()
        var reads = 0, confirmed = 0
        let model = MentionDestinationViewModel(resource: { _ in self.message(id: "root") }, markRead: { _ in
            reads += 1
            if reads == 1 { throw URLError(.networkConnectionLost) }
            return try await pending.response()
        })
        await model.load(notification) { _, _ in confirmed += 1 }
        let retry = Task { await model.retryRead { _, _ in confirmed += 1 } }
        await fulfillment(of: [pending.started], timeout: 2)
        XCTAssertTrue(model.markingRead)
        await model.retryRead { _, _ in confirmed += 1 }
        XCTAssertEqual(reads, 2)
        model.cancel(); pending.resolve(receipt(notification)); await retry.value
        XCTAssertEqual(confirmed, 0); XCTAssertFalse(model.markingRead); XCTAssertFalse(model.readConfirmed)
        XCTAssertEqual(model.root?.id, "root")
    }

    func testDepartureDuringRootFetchNeverPublishesPartialContentOrMarksRead() async throws {
        let pending = DeferredMentionResponse()
        let notification = try record()
        var reads = 0
        let model = MentionDestinationViewModel(resource: { path in
            if path.hasSuffix("/reply") { return self.message(id: "reply", thread: "root") }
            return try await pending.response()
        }, markRead: { _ in reads += 1; return .null })
        let loading = Task { await model.load(notification) { _, _ in XCTFail("A departed destination must not update read state") } }
        await fulfillment(of: [pending.started], timeout: 2)
        model.cancel(); pending.resolve(message(id: "root")); await loading.value
        XCTAssertNil(model.root); XCTAssertNil(model.focus); XCTAssertFalse(model.loading); XCTAssertEqual(reads, 0)
    }

    func testInvalidReadReceiptsStayRetryableWithoutUpdatingTheInbox() async throws {
        let notification = try record(message: "root", thread: nil)
        let wrong = try record(id: "another_notification", message: "root", thread: nil)
        var responses = [receipt(wrong), receipt(notification, unread: -1), receipt(notification, unread: 3)]
        var confirmed = 0
        let model = MentionDestinationViewModel(resource: { _ in self.message(id: "root") }, markRead: { _ in responses.removeFirst() })
        let onRead: (WorkspaceRecord, Int) -> Void = { _, count in confirmed += 1; XCTAssertEqual(count, 3) }
        await model.load(notification, onRead: onRead)
        XCTAssertNotNil(model.readError); XCTAssertEqual(confirmed, 0)
        await model.retryRead(onRead: onRead)
        XCTAssertNotNil(model.readError); XCTAssertEqual(confirmed, 0)
        await model.retryRead(onRead: onRead)
        XCTAssertNil(model.readError); XCTAssertEqual(confirmed, 1); XCTAssertEqual(model.root?.id, "root")
    }

    private func record(id: String = "mention", message: String = "reply", thread: String? = "root") throws -> WorkspaceRecord {
        try XCTUnwrap(WorkspaceRecord(.object(["id": .string(id), "room_id": .string("room"), "message_id": .string(message),
                                             "thread_root_id": thread.map(JSONValue.string) ?? .null, "read_at": .null])))
    }
    private func message(id: String, room: String = "room", thread: String? = nil) -> JSONValue {
        .object(["message": .object(["id": .string(id), "room_id": .string(room), "actor_type": .string("user"),
                                     "actor_id": .string("user"), "body": .string(id), "thread_root_id": thread.map(JSONValue.string) ?? .null])])
    }
    private func receipt(_ notification: WorkspaceRecord, unread: Int = 0) -> JSONValue {
        guard case var .object(fields) = notification.value else { return .null }
        fields["read_at"] = .string("2026-09-29T00:00:00Z")
        return .object(["notification": .object(fields), "unread_count": .number(Double(unread))])
    }
}

@MainActor
private final class DeferredMentionResponse {
    let started = XCTestExpectation(description: "Request is in flight")
    private var continuation: CheckedContinuation<JSONValue, Error>?
    func response() async throws -> JSONValue {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation; started.fulfill()
        }
    }
    func resolve(_ value: JSONValue) { continuation?.resume(returning: value); continuation = nil }
}
