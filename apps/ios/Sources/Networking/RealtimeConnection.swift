import Foundation
import Combine

/// Small transport seam: native tests can exercise reconnect/replay without a real socket.
@MainActor
public protocol RealtimeSocket: AnyObject {
    var closeCode: Int { get }
    func start()
    func send(_ text: String) async throws
    func receive() async throws -> Data
    func close()
}

@MainActor
final class NativeRealtimeSocket: RealtimeSocket {
    private let task: URLSessionWebSocketTask
    private let session: URLSession
    init(request: URLRequest) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        session = URLSession(configuration: configuration, delegate: SameOriginRedirectPolicy(), delegateQueue: nil)
        task = session.webSocketTask(with: request)
    }
    var closeCode: Int { task.closeCode.rawValue }
    func start() { task.resume() }
    func send(_ text: String) async throws { try await task.send(.string(text)) }
    func receive() async throws -> Data {
        let message = try await task.receive()
        switch message {
        case let .data(data): return data
        case let .string(text): return Data(text.utf8)
        @unknown default: throw ApiError.transport("Unsupported realtime frame")
        }
    }
    func close() { task.cancel(with: .goingAway, reason: nil); session.invalidateAndCancel() }
}

@MainActor
public final class RealtimeConnection: ObservableObject {
    public typealias Factory = @MainActor (URLRequest) -> RealtimeSocket
    @Published public private(set) var connected = false
    public private(set) var cursor: Int = 0
    private let factory: Factory
    private let retryDelay: Double
    private var request: URLRequest?
    private var socket: RealtimeSocket?
    private var loop: Task<Void, Never>?
    private var generation = UUID()
    private var sessionID = ""
    private var topics = Set<String>()
    private var extraTopics: [String: Int] = [:]
    private var active = true
    private var seen = Set<String>()
    private var seenOrder: [String] = []
    private var notificationTask: Task<Void, Never>?
    private var pendingFrames: [JSONValue] = []

    public init(factory: Factory? = nil, retryDelay: Double = 1) {
        self.factory = factory ?? { NativeRealtimeSocket(request: $0) }; self.retryDelay = retryDelay
    }
    public static func authenticatedRequest(origin: URL, controlToken: String) throws -> URLRequest {
        let origin = try ServerAddress.validate(origin.absoluteString, allowLocalHTTP: true)
        guard var components = URLComponents(url: origin, resolvingAgainstBaseURL: false) else { throw ApiError.invalidURL("Invalid server") }
        components.scheme = origin.scheme == "https" ? "wss" : "ws"
        components.path = "/api/v1/ws"
        guard let url = components.url else { throw ApiError.invalidURL("Invalid realtime endpoint") }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(controlToken)", forHTTPHeaderField: "Authorization")
        return request
    }
    public func configure(origin: URL, controlToken: String, sessionID: String, topics: [String]) throws {
        stop()
        request = try Self.authenticatedRequest(origin: origin, controlToken: controlToken)
        self.sessionID = sessionID; self.topics = Set(topics)
        cursor = 0; seen.removeAll(); seenOrder.removeAll()
        start()
    }
    public func setActive(_ value: Bool) {
        guard active != value else { return }; active = value
        if value { start() } else { disconnect() }
    }
    public func updateTopics(_ values: [String]) {
        let updated = Set(values)
        guard updated != topics else { return }
        topics = updated; disconnect(); start()
    }
    public func watch(_ topic: String) {
        extraTopics[topic, default: 0] += 1
        // A fresh subscription must get current REST state; a global cursor is
        // only a replay hint and never a substitute for a room's own cursor.
        if extraTopics[topic] == 1 { resubscribe() }
    }
    public func unwatch(_ topic: String) {
        guard let count = extraTopics[topic] else { return }
        if count > 1 { extraTopics[topic] = count - 1; return }
        extraTopics.removeValue(forKey: topic)
        let current = socket; let expected = generation
        Task { [weak self] in
            guard let self, expected == self.generation, let current else { return }
            try? await current.send(JSONValue.object(["type": .string("unsubscribe"), "topics": .strings([topic])]).wireText)
        }
    }
    public func stop() {
        disconnect(); request = nil; sessionID = ""; topics.removeAll(); extraTopics.removeAll()
        cursor = 0; seen.removeAll(); seenOrder.removeAll()
    }
    private func disconnect() {
        generation = UUID(); loop?.cancel(); loop = nil; socket?.close(); socket = nil; connected = false
        notificationTask?.cancel(); notificationTask = nil
        pendingFrames.removeAll()
    }
    private func subscription() -> String {
        JSONValue.object(["type": .string("subscribe"), "topics": .strings(Array(topics.union(extraTopics.keys)).sorted()),
                          "since_cursor": .number(Double(cursor))]).wireText
    }
    private func resubscribe() {
        let current = socket; let expected = generation
        Task { [weak self] in
            guard let self, expected == self.generation, let current else { return }
            try? await current.send(self.subscription())
        }
    }
    private func start() {
        guard active, loop == nil, let request else { return }
        let expected = generation
        loop = Task { [weak self] in
            guard let self else { return }
            var failures = 0
            while !Task.isCancelled && self.generation == expected && self.active {
                let current = self.factory(request); self.socket = current; current.start()
                do {
                    try await current.send(self.subscription())
                    guard self.generation == expected, !Task.isCancelled else { current.close(); return }
                    self.connected = true
                    // REST reconciliation also covers replay/live interleaving,
                    // a first connection, and silent gaps in best-effort replay.
                    self.notify()
                    while !Task.isCancelled && self.generation == expected {
                        let data = try await current.receive()
                        guard self.generation == expected, !Task.isCancelled else { return }
                        failures = 0
                        self.ingest(data)
                    }
                } catch {
                    guard self.generation == expected, !Task.isCancelled else { return }
                    self.connected = false
                    let denied = current.closeCode == 1008 || current.closeCode == 4001 || current.closeCode == 4003
                    current.close(); self.socket = nil
                    if denied {
                        NotificationCenter.default.post(name: .artooAuthenticationExpired, object: self.sessionID)
                        self.loop = nil; return
                    }
                }
                failures += 1
                do { try await Task.sleep(for: .seconds(min(30, self.retryDelay * pow(2, Double(min(failures - 1, 5)))))) }
                catch { return }
            }
        }
    }
    private func ingest(_ data: Data) {
        guard let frame = try? JSONDecoder().decode(JSONValue.self, from: data), frame["type"].text == "event",
              let position = Int(frame["cursor"].text), position >= 0 else { return }
        if frame["event"]["type"].text == "sync.required" {
            cursor = max(cursor, position); notify(); return
        }
        let topic = frame["topic"].text
        guard topics.contains(topic) || extraTopics[topic] != nil else { return }
        cursor = max(cursor, position)
        // Replay can arrive after a newer live event. Dedupe event ids rather
        // than discarding every position below the current high-water mark.
        let id = frame["event"]["id"].text.isEmpty ? String(position) : frame["event"]["id"].text
        guard seen.insert(id).inserted else { return }
        seenOrder.append(id)
        if seenOrder.count > 2048 { seen.remove(seenOrder.removeFirst()) }
        if pendingFrames.count < 256 { pendingFrames.append(frame) }
        guard notificationTask == nil else { return }
        let expected = generation
        notificationTask = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            guard let self, self.generation == expected else { return }
            self.notificationTask = nil; self.notify(topic: topic)
        }
    }
    private func notify(topic: String? = nil) {
        let frames = pendingFrames; pendingFrames.removeAll()
        NotificationCenter.default.post(name: .artooRealtimeChanged, object: sessionID, userInfo: ["topic": topic ?? "", "events": frames])
    }
}

private extension JSONValue {
    var wireText: String { String(data: (try? JSONEncoder().encode(self)) ?? Data(), encoding: .utf8) ?? "{}" }
}

public extension Notification.Name {
    static let artooRealtimeChanged = Notification.Name("artoo.realtimeChanged")
}
