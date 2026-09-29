import Foundation
import Combine

public struct RoomDraft: Codable, Equatable {
    public var text = ""
    public var pending: Submission?
    public var target: String? = "team"
    public var agentInstanceId: String?
    public var mentionedUserIds: [String]?
    public struct Submission: Codable, Equatable {
        public let key: String
        public let text: String
        public let path: String
        public let body: JSONValue
    }
}

public struct AssistantTurn: Codable, Equatable, Identifiable {
    public let id: String
    public let roomId: String
    public let threadRootId: String?
    public let taskId: String
    public let runId: String?
    public let userMessageId: String
    public let responseMessageId: String?
    public let status: String
    public let error: String?
    public let createdAt: String
    public let updatedAt: String
}

private struct AssistantTurnsResponse: Decodable { let turns: [AssistantTurn] }

/// Drafts contain no credentials, are namespaced by origin/user/room, and are
/// never replayed automatically when connectivity or identity changes.
@MainActor
public final class RoomDraftStore {
    private let defaults: UserDefaults
    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    public static func key(server: String, user: String, room: String, threadRootId: String? = nil) -> String {
        let origin = URL(string: server).flatMap { url -> String? in
            guard let scheme = url.scheme, let host = url.host else { return nil }
            return "\(scheme.lowercased())://\(host.lowercased()):\(url.port ?? (scheme == "https" ? 443 : 80))"
        } ?? server
        let scope = [origin, user, room] + (threadRootId.map { ["thread", $0] } ?? [])
        let bytes = (try? JSONEncoder().encode(scope)) ?? Data()
        return "artoo.room-draft.v1." + bytes.base64EncodedString()
    }
    public func load(key: String) -> RoomDraft {
        guard let data = defaults.data(forKey: key), let draft = try? JSONDecoder().decode(RoomDraft.self, from: data) else { return RoomDraft() }
        return draft
    }
    public func save(_ draft: RoomDraft, key: String) {
        if draft.text.isEmpty && draft.pending == nil { defaults.removeObject(forKey: key) }
        else if let data = try? JSONEncoder().encode(draft) { defaults.set(data, forKey: key) }
    }
}

@MainActor
public final class RoomMessagesViewModel: ObservableObject {
    @Published public private(set) var messages: [Message] = []
    @Published public private(set) var turns: [AssistantTurn] = []
    @Published public private(set) var turnActionInFlight: String?
    @Published public private(set) var turnError: String?
    @Published public private(set) var loading = false
    @Published public private(set) var sending = false
    @Published public private(set) var error: String?
    @Published public private(set) var hasOlder = false
    @Published public private(set) var hasNewer = false
    @Published public var draft = RoomDraft() { didSet { persist() } }
    public let roomId: String
    public let threadRootId: String?
    public let client: ApiClientProtocol
    public let allowsAssistantRequests: Bool
    public var unsupportedPendingAssistant: Bool { !allowsAssistantRequests && draft.pending?.path.hasSuffix("/assistant-turns") == true }
    private let drafts: RoomDraftStore
    private var scope: String?
    private var before: String?
    private var after: String?
    private var initialized = false
    private var refreshPending = false
    private var turnLoading = false
    private var turnRefreshPending = false
    private var turnKeys: [String: String] = [:]
    public init(client: ApiClientProtocol, roomId: String, threadRootId: String? = nil, drafts: RoomDraftStore? = nil, allowsAssistantRequests: Bool = true) {
        self.client = client; self.roomId = roomId; self.threadRootId = threadRootId; self.drafts = drafts ?? RoomDraftStore()
        self.allowsAssistantRequests = allowsAssistantRequests
    }
    public func configureDraft(server: String, user: String) {
        guard !server.isEmpty, !user.isEmpty else { return }
        let key = RoomDraftStore.key(server: server, user: user, room: roomId, threadRootId: threadRootId)
        guard key != scope else { return }
        scope = key; draft = drafts.load(key: key)
        if !allowsAssistantRequests, draft.pending == nil { draft.target = "team" }
    }
    public func keepPendingTextAsTeamReply() {
        guard unsupportedPendingAssistant, !sending else { return }
        draft.pending = nil; draft.target = "team"; error = nil
    }
    private func persist() { if let scope { drafts.save(draft, key: scope) } }
    public func refresh() async {
        guard !loading else { refreshPending = true; return }
        loading = true; error = nil
        do {
            for _ in 0..<5 {
                let page = try await client.messagePage(roomId: roomId, before: nil, after: initialized ? after : nil, threadRootId: threadRootId)
                let initial = !initialized || after == nil
                merge(page.messages)
                if initial { before = page.nextBefore; hasOlder = page.hasMore == true }
                after = page.nextAfter ?? after; initialized = true
                hasNewer = !initial && page.hasMore == true
                if !hasNewer { break }
            }
        } catch { self.error = String(describing: error) }
        loading = false
        if refreshPending { refreshPending = false; await refresh() }
    }
    public func loadOlder() async {
        guard !loading, let before, hasOlder else { return }
        loading = true; error = nil
        do {
            let page = try await client.messagePage(roomId: roomId, before: before, after: nil, threadRootId: threadRootId)
            merge(page.messages); self.before = page.nextBefore; hasOlder = page.hasMore == true
        } catch { self.error = String(describing: error) }
        loading = false
        if refreshPending { refreshPending = false; await refresh() }
    }
    @discardableResult
    public func send() async -> Bool {
        let text = draft.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sending, scope != nil, draft.pending != nil || !text.isEmpty else { return false }
        guard allowsAssistantRequests || draft.target != "assistant" else { error = "Agents in this discussion are coordinated from the goal. Add a team reply to contribute."; return false }
        guard draft.pending != nil || text.utf16.count <= 20_000 else { error = "Messages must be 20,000 characters or fewer."; return false }
        if draft.pending == nil {
            let key = UUID().uuidString
            let assistant = draft.target == "assistant"
            var body: [String: JSONValue] = assistant ? ["body": .string(text), "client_request_id": .string(key)] : ["kind": .string("text"), "body": .string(text)]
            if let threadRootId { body["thread_root_id"] = .string(threadRootId) }
            if !assistant {
                body["client_request_id"] = .string(key)
                body["mentions"] = .array((draft.mentionedUserIds ?? []).map { .object(["actor_type": .string("user"), "actor_id": .string($0)]) })
            }
            if assistant, let agent = draft.agentInstanceId, !agent.isEmpty { body["agent_instance_id"] = .string(agent) }
            draft.pending = RoomDraft.Submission(key: key, text: text,
                path: "/api/v1/rooms/\(apiPart(roomId))/\(assistant ? "assistant-turns" : "messages")", body: .object(body))
        }
        return await submitPending()
    }
    @discardableResult
    public func submitPending() async -> Bool {
        guard !sending, scope != nil, let pending = draft.pending else { return false }
        guard !unsupportedPendingAssistant else { error = "Direct agent requests are unavailable in a planning discussion. Check the discussion before keeping this text as a team reply."; return false }
        sending = true; error = nil
        defer { sending = false }
        do {
            _ = try await client.command(path: pending.path, method: "POST", body: pending.body, idempotencyKey: pending.key)
            if draft.text.trimmingCharacters(in: .whitespacesAndNewlines) == pending.text { draft.text = "" }
            draft.pending = nil
            draft.mentionedUserIds = nil
            await refresh()
            if pending.path.hasSuffix("/assistant-turns") { await refreshTurns() }
            return true
        } catch {
            if case let ApiError.http(status, _) = error, [400, 422].contains(status) {
                // Validation failures did not create a send; allow correction.
                draft.pending = nil; self.error = String(describing: error)
            } else { self.error = "\(error) Retry keeps the same send identifier." }
            return false
        }
    }
    public func applyRealtime(_ frames: [JSONValue]) {
        for frame in frames where frame["event"]["room_id"].text == roomId {
            let payload = frame["event"]["payload"]
            guard let count = Int(payload["root_reply_count"].text),
                  let index = messages.firstIndex(where: { $0.id == payload["thread_root_id"].text }) else { continue }
            // Replay may arrive behind live; reply counts only increase.
            messages[index].replyCount = max(messages[index].replyCount ?? 0, count)
        }
    }
    public func reconcileReplyCounts() async {
        guard threadRootId == nil, initialized else { return }
        do {
            let page = try await client.messagePage(roomId: roomId, before: nil, after: nil, threadRootId: nil)
            merge(page.messages)
        } catch { self.error = String(describing: error) }
    }
    public func refreshTurns() async {
        guard !turnLoading else { turnRefreshPending = true; return }
        turnLoading = true
        do {
            let query = threadRootId.map { "?thread_root_id=\(apiPart($0))" } ?? ""
            let value = try await client.resource(path: "/api/v1/rooms/\(apiPart(roomId))/assistant-turns\(query)")
            turns = try ArtooJSON.decoder().decode(AssistantTurnsResponse.self, from: JSONEncoder().encode(value)).turns.filter { $0.threadRootId == threadRootId }
            turnError = nil
        } catch { turnError = String(describing: error) }
        turnLoading = false
        if turnRefreshPending { turnRefreshPending = false; await refreshTurns() }
    }
    public func changeTurn(_ turn: AssistantTurn, action: String) async {
        guard allowsAssistantRequests else { turnError = "Manage this discussion from its goal."; return }
        guard turnActionInFlight == nil, ["cancel", "retry"].contains(action) else { return }
        let actionId = "\(turn.id)/\(action)"
        let key = turnKeys[actionId] ?? UUID().uuidString; turnKeys[actionId] = key
        turnActionInFlight = actionId; turnError = nil
        defer { turnActionInFlight = nil }
        do {
            _ = try await client.command(path: "/api/v1/assistant-turns/\(apiPart(turn.id))/\(action)", method: "POST", body: .object([:]), idempotencyKey: key)
            turnKeys.removeValue(forKey: actionId)
            await refreshTurns(); await refresh()
        } catch { turnError = String(describing: error) }
    }
    private func merge(_ incoming: [Message]) {
        var byId = Dictionary(uniqueKeysWithValues: messages.map { ($0.id, $0) })
        for var item in incoming {
            if let previous = byId[item.id]?.replyCount { item.replyCount = max(previous, item.replyCount ?? 0) }
            byId[item.id] = item
        }
        messages = byId.values.sorted {
            if let left = $0.sequence, let right = $1.sequence, left != right { return left < right }
            if ($0.sequence == nil) != ($1.sequence == nil) { return $0.sequence == nil }
            if $0.createdAt != $1.createdAt { return ($0.createdAt ?? "") < ($1.createdAt ?? "") }
            return $0.id < $1.id
        }
    }
}
