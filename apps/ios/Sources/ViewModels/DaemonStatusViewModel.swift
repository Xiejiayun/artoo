import Foundation
import Combine

public struct DaemonStatus: Decodable, Equatable, Identifiable {
    public var id: String { computerId }
    public let computerId: String
    public let displayName: String
    public let status: String
    public let connected: Bool
    public let lastHeartbeatAt: String?
    public let heartbeatAgeMs: Double?
    public let activeRuns: Int
    public let runtimes: [JSONValue]
}
private struct DaemonResponse: Decodable { let daemons: [DaemonStatus] }

@MainActor
public final class DaemonStatusViewModel: ObservableObject {
    @Published public private(set) var daemons: [DaemonStatus] = []
    @Published public private(set) var error: String?
    @Published public private(set) var lastConfirmed: Date?
    private let client: ApiClientProtocol
    private var loading = false
    public init(client: ApiClientProtocol) { self.client = client }
    public func load() async {
        guard !loading else { return }; loading = true
        defer { loading = false }
        do {
            let value = try await client.resource(path: "/api/v1/daemons")
            daemons = try ArtooJSON.decoder().decode(DaemonResponse.self, from: JSONEncoder().encode(value)).daemons
            lastConfirmed = Date(); error = nil
        } catch { self.error = String(describing: error); lastConfirmed = nil }
    }
    public func status(computerId: String, now: Date = Date()) -> String {
        guard error == nil, let lastConfirmed, now.timeIntervalSince(lastConfirmed) <= 12,
              let daemon = daemons.first(where: { $0.computerId == computerId }) else { return "unknown" }
        return ["online", "reconnecting", "offline", "stale", "disabled"].contains(daemon.status) ? daemon.status : "unknown"
    }
}
