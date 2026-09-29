import Foundation
import Combine

@MainActor
final class MentionDestinationViewModel: ObservableObject {
    @Published private(set) var root: Message?
    @Published private(set) var focus: Message?
    @Published private(set) var loading = false
    @Published private(set) var markingRead = false
    @Published private(set) var loadError: String?
    @Published private(set) var readError: String?
    private(set) var readConfirmed = false
    var roomId: String { target?.roomId ?? "" }

    private struct Target: Equatable {
        let notificationId: String
        let roomId: String
        let messageId: String
        let threadRootId: String?
        init(_ notification: WorkspaceRecord) throws {
            notificationId = notification.id
            roomId = notification["room_id"].text
            messageId = notification["message_id"].text
            if case let .string(id) = notification["thread_root_id"], !id.isEmpty { threadRootId = id }
            else if notification["thread_root_id"] == .null { threadRootId = nil }
            else { throw ApiError.decoding("The mention has an invalid thread reference.") }
            guard !roomId.isEmpty, !messageId.isEmpty else { throw ApiError.decoding("The mention has no message destination.") }
        }
    }
    private struct MessageEnvelope: Decodable { let message: Message }
    private struct ReadEnvelope: Decodable { let notification: JSONValue; let unreadCount: Int }
    private var target: Target?
    private var generation = UUID()
    private let resource: @MainActor (String) async throws -> JSONValue
    private let markRead: @MainActor (String) async throws -> JSONValue

    convenience init(client: ApiClientProtocol) {
        self.init(resource: { try await client.resource(path: $0) },
                  markRead: { try await client.command(path: $0, method: "POST", body: .object([:])) })
    }
    init(resource: @escaping @MainActor (String) async throws -> JSONValue, markRead: @escaping @MainActor (String) async throws -> JSONValue) {
        self.resource = resource; self.markRead = markRead
    }

    func load(_ notification: WorkspaceRecord, onRead: (WorkspaceRecord, Int) -> Void) async {
        let selected: Target
        do { selected = try Target(notification) }
        catch {
            cancel(); target = nil; root = nil; focus = nil; readError = nil; readConfirmed = false
            loadError = String(describing: error); return
        }
        if target != selected {
            cancel(); target = selected; root = nil; focus = nil
            loadError = nil; readError = nil; readConfirmed = false
        }
        guard !loading else { return }
        if root != nil { await retryRead(onRead: onRead); return }
        let request = generation
        loading = true; loadError = nil
        defer { if request == generation { loading = false } }
        do {
            let message = try await fetchMessage(selected.messageId, roomId: selected.roomId)
            guard isCurrent(request) else { return }
            guard message.id == selected.messageId, message.roomId == selected.roomId,
                  message.threadRootId == selected.threadRootId else {
                throw ApiError.decoding("The selected message does not match this mention.")
            }
            let rootMessage: Message
            if let rootId = selected.threadRootId { rootMessage = try await fetchMessage(rootId, roomId: selected.roomId) }
            else { rootMessage = message }
            guard isCurrent(request) else { return }
            try validate(message: message, root: rootMessage, target: selected)
            root = rootMessage; focus = message; loading = false
            await retryRead(onRead: onRead)
        } catch {
            guard isCurrent(request) else { return }
            loadError = String(describing: error); loading = false
        }
    }

    func retryRead(onRead: (WorkspaceRecord, Int) -> Void) async {
        guard !loading, !markingRead, !readConfirmed, let target, let root, let focus else { return }
        let request = generation
        markingRead = true; readError = nil
        defer { if request == generation { markingRead = false } }
        do {
            try validate(message: focus, root: root, target: target)
            guard isCurrent(request) else { return }
            let value = try await markRead("/api/v1/notifications/\(apiPart(target.notificationId))/read")
            guard isCurrent(request) else { return }
            let receipt = try ArtooJSON.decoder().decode(ReadEnvelope.self, from: JSONEncoder().encode(value))
            guard let updated = WorkspaceRecord(receipt.notification), try Target(updated) == target,
                  !updated["read_at"].text.isEmpty, receipt.unreadCount >= 0 else {
                throw ApiError.decoding("The read confirmation does not match this mention.")
            }
            readConfirmed = true
            onRead(updated, receipt.unreadCount)
        } catch {
            guard isCurrent(request) else { return }
            readError = String(describing: error)
        }
    }

    // A departed screen or changed destination must not apply an old response
    // to its content, notification row, or global unread count.
    func cancel() { generation = UUID(); loading = false; markingRead = false }

    private func isCurrent(_ request: UUID) -> Bool { request == generation && !Task.isCancelled }
    private func fetchMessage(_ id: String, roomId: String) async throws -> Message {
        let value = try await resource("/api/v1/rooms/\(apiPart(roomId))/messages/\(apiPart(id))")
        return try ArtooJSON.decoder().decode(MessageEnvelope.self, from: JSONEncoder().encode(value)).message
    }
    private func validate(message: Message, root: Message, target: Target) throws {
        guard message.id == target.messageId, message.roomId == target.roomId, message.threadRootId == target.threadRootId,
              root.id == (target.threadRootId ?? target.messageId), root.roomId == target.roomId, root.threadRootId == nil else {
            throw ApiError.decoding("The message and thread do not match this mention.")
        }
    }
}
