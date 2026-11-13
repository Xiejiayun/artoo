import Foundation
import Combine

@MainActor
final class ReleaseViewModel: ObservableObject {
    enum Kind: Equatable { case staticSite, application }
    @Published private(set) var document: JSONValue?
    @Published private(set) var loading = false
    @Published private(set) var stopping = false
    @Published private(set) var syncError: String?
    @Published private(set) var stopError: String?
    @Published private(set) var stoppedAt: Date?
    let client: ApiClientProtocol
    let goalId: String
    let kind: Kind
    private var revision = 0
    private var stopKey: String?
    private var field: String { kind == .application ? "publication" : "release" }
    private var path: String { "/api/v1/goals/\(apiPart(goalId))/\(kind == .application ? "application-publication" : "release")" }
    var publication: JSONValue { document?[field] ?? .null }
    var canStop: Bool { kind == .application && publication != .null && !ReleasePresentation.isClosed(publication) && !stopping }

    init(client: ApiClientProtocol, goalId: String, kind: Kind) {
        self.client = client; self.goalId = goalId; self.kind = kind
    }

    func load() async {
        guard !loading, !stopping else { return }
        loading = true
        let current = revision
        defer { loading = false }
        do {
            let value = try await client.resource(path: path)
            try validate(value)
            guard revision == current else { return }
            document = value; syncError = nil
        } catch { if revision == current { syncError = String(describing: error) } }
    }

    func stop() async {
        guard canStop else { return }
        // Invalidate an older in-flight GET. Stop must not wait for that GET.
        revision += 1; stopping = true; stopError = nil; stoppedAt = Date()
        let key = stopKey ?? UUID().uuidString
        stopKey = key
        defer { stopping = false }
        do {
            let value = try await client.command(path: "\(path)/stop", method: "POST", body: .object([:]), idempotencyKey: key)
            try validate(value)
            document = value; syncError = nil; stopKey = nil
        } catch { stopError = String(describing: error) }
    }

    private func validate(_ value: JSONValue) throws {
        guard case let .object(fields) = value, let record = fields[field] else { throw ApiError.decoding("Missing publication envelope") }
        if record == .null { return }
        guard case .object = record, !record["id"].text.isEmpty, record["goal_id"] == .string(goalId),
              !record["status"].text.isEmpty else { throw ApiError.decoding("Publication does not match this goal") }
    }
}
