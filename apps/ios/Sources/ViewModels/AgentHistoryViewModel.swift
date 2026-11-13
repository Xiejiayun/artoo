import Foundation
import Combine

struct NativeHistoryEntry: Identifiable, Equatable {
    let id: String
    let value: JSONValue
}

@MainActor
final class AgentHistoryViewModel: ObservableObject {
    enum Mode { case executions(projectId: String), events(runId: String) }
    @Published private(set) var rows: [NativeHistoryEntry] = []
    @Published private(set) var document: JSONValue?
    @Published private(set) var loading = false
    @Published private(set) var error: String?
    @Published private(set) var hasMore = false
    let client: ApiClientProtocol
    let agentId: String
    let mode: Mode
    private var cursor: JSONValue = .null
    private var seenCursors: Set<String> = []
    private var refreshPending = false

    init(client: ApiClientProtocol, agentId: String, mode: Mode) {
        self.client = client; self.agentId = agentId; self.mode = mode
    }

    func refresh() async {
        guard !loading else { refreshPending = true; return }
        await load(earlier: false)
    }

    func loadEarlier() async {
        guard !loading, hasMore else { return }
        await load(earlier: true)
    }

    private func load(earlier: Bool) async {
        loading = true
        let before = earlier ? cursor : .null
        do {
            let value = try await client.resource(path: path(before: before))
            let page = try parse(value, before: before)
            if earlier && page.cursor != .null && seenCursors.contains(page.cursor.text) {
                throw ApiError.decoding("History returned a repeated cursor")
            }
            var ids = Set(earlier ? rows.map(\.id) : [])
            let added = page.rows.filter { ids.insert($0.id).inserted }
            rows = earlier ? rows + added : added
            document = value; cursor = page.cursor; hasMore = cursor != .null
            if !earlier { seenCursors.removeAll() }
            if cursor != .null { seenCursors.insert(cursor.text) }
            error = nil
        } catch { self.error = String(describing: error) }
        loading = false
        if refreshPending { refreshPending = false; await refresh() }
    }

    private func path(before: JSONValue) -> String {
        let base = "/api/v1/agents/\(apiPart(agentId))/history"
        switch mode {
        case let .executions(projectId):
            var path = "\(base)?limit=20"
            if !projectId.isEmpty { path += "&project_id=\(apiPart(projectId))" }
            if before != .null { path += "&before_run_id=\(apiPart(before.text))" }
            return path
        case let .events(runId):
            return "\(base)/\(apiPart(runId))?limit=50" + (before == .null ? "" : "&before=\(apiPart(before.text))")
        }
    }

    private func parse(_ value: JSONValue, before: JSONValue) throws -> (rows: [NativeHistoryEntry], cursor: JSONValue) {
        guard value["version"] == .number(1), value["agent_id"] == .string(agentId), case let .object(fields) = value else {
            throw ApiError.decoding("History version or agent identity does not match")
        }
        let values: [JSONValue], next: JSONValue
        switch mode {
        case .executions:
            guard case let .array(items) = value["runs"], let candidate = fields["next_before_run_id"] else {
                throw ApiError.decoding("Invalid execution history page")
            }
            switch candidate {
            case .null: break
            case let .string(id):
                guard !id.isEmpty, id == items.last?["run"]["id"].text else { throw ApiError.decoding("Invalid execution cursor") }
            default: throw ApiError.decoding("Invalid execution cursor")
            }
            values = items; next = candidate
        case let .events(runId):
            guard value["execution"]["run"]["id"] == .string(runId), case let .array(items) = value["events"],
                  let candidate = fields["next_before"], candidate == .null || candidate == items.last?["position"] else {
                throw ApiError.decoding("Invalid execution event page")
            }
            var ceiling = before == .null ? Double.infinity : number(before)
            for item in items {
                let position = number(item["position"])
                guard position > 0, position <= 9_007_199_254_740_991, position.rounded() == position, position < ceiling else {
                    throw ApiError.decoding("Invalid event history position")
                }
                ceiling = position
            }
            values = items; next = candidate
        }
        guard next == .null || (next != before && !values.isEmpty) else { throw ApiError.decoding("History cursor did not advance") }
        let entries = try values.map { value -> NativeHistoryEntry in
            let id: String
            let identity: JSONValue
            switch mode { case .executions: identity = value["run"]["id"]; case .events: identity = value["id"] }
            guard case let .string(identifier) = identity, !identifier.isEmpty else { throw ApiError.decoding("Missing history record identity") }
            id = identifier
            return NativeHistoryEntry(id: id, value: value)
        }
        guard Set(entries.map(\.id)).count == entries.count else { throw ApiError.decoding("Duplicate history records") }
        return (entries, next)
    }

    private func number(_ value: JSONValue) -> Double { if case let .number(number) = value { return number }; return .nan }
}
