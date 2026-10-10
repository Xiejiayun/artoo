import Foundation

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// MARK: - API errors

public enum ApiError: Error, Equatable, CustomStringConvertible {
    case invalidURL(String)
    case transport(String)
    case http(status: Int, body: String)
    case decoding(String)
    case notImplemented(String)

    public var description: String {
        switch self {
        case let .invalidURL(url): return "Invalid URL: \(url)"
        case let .transport(message): return "Network error: \(message)"
        case let .http(status, body): return "HTTP \(status): \(body)"
        case let .decoding(message): return "Decoding error: \(message)"
        case let .notImplemented(message): return "Not implemented: \(message)"
        }
    }
}

// MARK: - Client protocol
//
// Views and view models depend on this protocol, never on the concrete
// URLSession client. That keeps every screen previewable and testable with
// `MockApiClient` and means the unverified live client can be swapped without
// touching UI code.

public protocol ApiClientProtocol: Sendable {
    func bootstrap() async throws -> Bootstrap
    func listTasks(projectId: String) async throws -> [TaskItem]
    func createTask(projectId: String, request: CreateTaskRequest) async throws -> TaskResponse
    func getTask(taskId: String) async throws -> TaskSnapshot
    func markReady(taskId: String) async throws -> TaskResponse
    func assign(taskId: String, request: AssignRequest) async throws -> AssignResponse
    func retry(taskId: String) async throws -> TaskResponse
    func review(taskId: String, request: ReviewRequest) async throws -> TaskResponse
    func listRuns(taskId: String) async throws -> [Run]
    func getRun(runId: String) async throws -> Run
    func listApprovals(status: String?) async throws -> [Approval]
    func resolveApproval(approvalId: String, request: ResolveApprovalRequest) async throws -> Approval
    func listMessages(roomId: String) async throws -> [Message]
    func messagePage(roomId: String, before: String?, after: String?, threadRootId: String?) async throws -> MessagesResponse
    func messageVisibility(roomId: String, messageIds: [String]) async throws -> [String]
    func resource(path: String) async throws -> JSONValue
    func command(path: String, method: String, body: JSONValue) async throws -> JSONValue
    func command(path: String, method: String, body: JSONValue, idempotencyKey: String) async throws -> JSONValue
    func downloadArtifact(artifact: Artifact) async throws -> URL
}

public extension ApiClientProtocol {
    func messagePage(roomId: String, before: String? = nil, after: String? = nil, threadRootId: String? = nil) async throws -> MessagesResponse {
        MessagesResponse(messages: try await listMessages(roomId: roomId))
    }
    func command(path: String, method: String = "POST", body: JSONValue, idempotencyKey: String) async throws -> JSONValue {
        try await command(path: path, method: method, body: body)
    }
    func resource(path: String) async throws -> JSONValue { throw ApiError.notImplemented("This preview fixture has no workspace resources") }
    func command(path: String, method: String = "POST", body: JSONValue = .object([:])) async throws -> JSONValue {
        throw ApiError.notImplemented("This preview fixture has no workspace commands")
    }
    func downloadArtifact(artifact: Artifact) async throws -> URL { throw ApiError.notImplemented("Fixture artifact download") }
}

// MARK: - JSON coders

public enum ArtooJSON {
    public static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }

    public static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        return encoder
    }
}

// MARK: - Live URLSession client
//
// Contracts are checked against the server on Windows; Xcode/runtime execution
// remains a separate Mac verification gate (see README.md).

public final class ApiClient: ApiClientProtocol, @unchecked Sendable {
    private let baseURL: URL
    private let session: URLSession
    private let authToken: String?
    public let sessionID = UUID().uuidString
    private let stateLock = NSLock()
    private var invalidated = false
    private var consentHandler: (@Sendable () async -> Bool)?

    public func setAIConsentHandler(_ handler: (@Sendable () async -> Bool)?) {
        stateLock.lock(); defer { stateLock.unlock() }
        consentHandler = handler
    }
    private func currentConsentHandler() -> (@Sendable () async -> Bool)? {
        stateLock.lock(); defer { stateLock.unlock() }
        return invalidated ? nil : consentHandler
    }

    public func invalidate() {
        stateLock.lock(); invalidated = true; consentHandler = nil; stateLock.unlock()
        session.invalidateAndCancel()
    }
    private func requireActive() throws {
        stateLock.lock(); defer { stateLock.unlock() }
        if invalidated { throw CancellationError() }
    }

    public init(baseURL: URL, session: URLSession? = nil, authToken: String? = nil) {
        self.baseURL = baseURL
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.timeoutIntervalForRequest = 30
        self.session = session ?? URLSession(configuration: configuration, delegate: SameOriginRedirectPolicy(), delegateQueue: nil)
        self.authToken = authToken
    }

    public convenience init?(baseURLString: String, authToken: String? = nil) {
        guard let url = URL(string: baseURLString) else { return nil }
        self.init(baseURL: url, authToken: authToken)
    }

    // MARK: Endpoints

    public func bootstrap() async throws -> Bootstrap {
        try await send(path: "/api/v1/bootstrap", method: "GET")
    }

    public func listTasks(projectId: String) async throws -> [TaskItem] {
        let response: TasksResponse = try await send(
            path: "/api/v1/tasks?project_id=\(escape(projectId))",
            method: "GET"
        )
        return response.tasks
    }

    public func createTask(projectId: String, request: CreateTaskRequest) async throws -> TaskResponse {
        try await send(
            path: "/api/v1/tasks",
            method: "POST",
            body: request.withProjectId(projectId),
            idempotent: true
        )
    }

    public func getTask(taskId: String) async throws -> TaskSnapshot {
        try await send(path: "/api/v1/tasks/\(escape(taskId))", method: "GET")
    }

    public func markReady(taskId: String) async throws -> TaskResponse {
        try await send(
            path: "/api/v1/tasks/\(escape(taskId))/ready",
            method: "POST",
            body: EmptyBody(),
            idempotent: true
        )
    }

    public func assign(taskId: String, request: AssignRequest) async throws -> AssignResponse {
        try await send(
            path: "/api/v1/tasks/\(escape(taskId))/assign",
            method: "POST",
            body: request,
            idempotent: true
        )
    }

    public func retry(taskId: String) async throws -> TaskResponse {
        try await send(
            path: "/api/v1/tasks/\(escape(taskId))/retry",
            method: "POST",
            body: EmptyBody(),
            idempotent: true
        )
    }

    public func review(taskId: String, request: ReviewRequest) async throws -> TaskResponse {
        try await send(
            path: "/api/v1/tasks/\(escape(taskId))/review",
            method: "POST",
            body: request,
            idempotent: true
        )
    }

    public func listRuns(taskId: String) async throws -> [Run] {
        (try await getTask(taskId: taskId)).runs
    }

    public func getRun(runId: String) async throws -> Run {
        let response: RunResponse = try await send(
            path: "/api/v1/runs/\(escape(runId))",
            method: "GET"
        )
        return response.run
    }

    public func listApprovals(status: String?) async throws -> [Approval] {
        var path = "/api/v1/approvals"
        if let status, !status.isEmpty {
            path += "?status=\(escape(status))"
        }
        let response: ApprovalsResponse = try await send(path: path, method: "GET")
        return response.approvals
    }

    public func resolveApproval(approvalId: String, request: ResolveApprovalRequest) async throws -> Approval {
        let response: ApprovalResponse = try await send(
            path: "/api/v1/approvals/\(escape(approvalId))/resolve",
            method: "POST",
            body: request,
            idempotent: true
        )
        return response.approval
    }

    public func listMessages(roomId: String) async throws -> [Message] {
        try await messagePage(roomId: roomId, before: nil, after: nil).messages
    }

    public func messagePage(roomId: String, before: String? = nil, after: String? = nil, threadRootId: String? = nil) async throws -> MessagesResponse {
        var path = "/api/v1/rooms/\(escape(roomId))/messages?limit=50"
        if let before { path += "&before=\(escape(before))" }
        if let after { path += "&after=\(escape(after))" }
        if let threadRootId { path += "&thread_root_id=\(escape(threadRootId))" }
        return try await send(path: path, method: "GET")
    }

    private struct MessageVisibilityResponse: Decodable { let removedMessageIds: [String] }
    public func messageVisibility(roomId: String, messageIds: [String]) async throws -> [String] {
        let response: MessageVisibilityResponse = try await send(path: "/api/v1/rooms/\(escape(roomId))/messages/visibility", method: "POST",
            body: JSONValue.object(["message_ids": .strings(messageIds)]))
        return response.removedMessageIds
    }

    public func currentSession() async throws -> SessionIdentity {
        try await send(path: "/auth/session", method: "GET")
    }

    public func claimPairing(code: String, displayName: String) async throws -> PairingClaim {
        try await send(path: "/api/v1/devices/claim", method: "POST", body: JSONValue.object([
            "code": .string(code), "platform": .string("ios"), "display_name": .string(displayName),
            "app_version": .string(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.0")
        ]))
    }

    public func logout() async throws {
        let _: EmptyResponse = try await send(path: "/auth/logout", method: "POST", body: EmptyBody())
    }

    public func revokeAndInvalidate() async throws {
        // End local authority before awaiting a potentially offline server.
        invalidate()
        let revoker = ApiClient(baseURL: baseURL, authToken: authToken)
        defer { revoker.invalidate() }
        try await revoker.logout()
    }

    public func resource(path: String) async throws -> JSONValue { try await send(path: path, method: "GET") }

    public func command(path: String, method: String = "POST", body: JSONValue = .object([:])) async throws -> JSONValue {
        try await send(path: path, method: method, body: body, idempotent: true)
    }

    public func command(path: String, method: String = "POST", body: JSONValue, idempotencyKey: String) async throws -> JSONValue {
        try await perform(path: path, method: method, bodyData: ArtooJSON.encoder().encode(body), idempotent: true, idempotencyKey: idempotencyKey)
    }

    public func downloadArtifact(artifact: Artifact) async throws -> URL {
        let (data, response) = try await requestData(path: "/api/v1/artifacts/\(escape(artifact.id))/content",
            method: "GET", bodyData: nil, idempotent: false)
        let filename = response.suggestedFilename ?? "artifact"
        let component = URL(fileURLWithPath: filename).lastPathComponent
        let safeName = ["", ".", ".."].contains(component) ? "artifact" : component
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("artoo-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(safeName)
        try data.write(to: url, options: [.atomic, .completeFileProtection])
        return url
    }

    // MARK: Request plumbing

    private struct EmptyBody: Encodable {}

    private func escape(_ component: String) -> String {
        component.addingPercentEncoding(withAllowedCharacters: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? component
    }

    /// GET helper (no body).
    private func send<Response: Decodable>(path: String, method: String) async throws -> Response {
        try await perform(path: path, method: method, bodyData: nil, idempotent: false)
    }

    /// Mutation helper with an encodable body.
    private func send<Body: Encodable, Response: Decodable>(
        path: String,
        method: String,
        body: Body,
        idempotent: Bool = false
    ) async throws -> Response {
        let data: Data
        do {
            data = try ArtooJSON.encoder().encode(body)
        } catch {
            throw ApiError.decoding("Failed to encode request body: \(error)")
        }
        return try await perform(path: path, method: method, bodyData: data, idempotent: idempotent)
    }

    private func perform<Response: Decodable>(
        path: String,
        method: String,
        bodyData: Data?,
        idempotent: Bool,
        idempotencyKey: String? = nil
    ) async throws -> Response {
        let (data, _) = try await requestData(path: path, method: method, bodyData: bodyData, idempotent: idempotent, idempotencyKey: idempotencyKey)
        if data.isEmpty {
            if let empty = EmptyResponse() as? Response { return empty }
            if let empty = JSONValue.null as? Response { return empty }
        }
        do { return try ArtooJSON.decoder().decode(Response.self, from: data) }
        catch { throw ApiError.decoding("\(error)") }
    }

    private func requestData(path: String, method: String, bodyData: Data?, idempotent: Bool, idempotencyKey: String? = nil) async throws -> (Data, HTTPURLResponse) {
        try requireActive()
        guard path.hasPrefix("/"), !path.hasPrefix("//"), let url = URL(string: path, relativeTo: baseURL)?.absoluteURL,
              url.scheme == baseURL.scheme, url.host == baseURL.host, url.port == baseURL.port else {
            throw ApiError.invalidURL(baseURL.absoluteString + path)
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let authToken, path != "/api/v1/devices/claim" {
            request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        }
        if let bodyData {
            request.httpBody = bodyData
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if idempotent {
            request.setValue(idempotencyKey ?? UUID().uuidString, forHTTPHeaderField: "Idempotency-Key")
        }

        return try await execute(request, allowConsent: !path.hasPrefix("/api/v1/privacy/"))
    }

    private func execute(_ request: URLRequest, allowConsent: Bool) async throws -> (Data, HTTPURLResponse) {
        try requireActive()
        try Task.checkCancellation()
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw ApiError.transport(error.localizedDescription)
        }
        try requireActive()

        guard let http = response as? HTTPURLResponse else {
            throw ApiError.transport("Non-HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401, authToken != nil {
                NotificationCenter.default.post(name: .artooAuthenticationExpired, object: sessionID)
            }
            let errorBody = try? JSONDecoder().decode(JSONValue.self, from: data)
            if allowConsent, http.statusCode == 428, errorBody?["error"]["code"].text == "ai_consent_required",
               let handler = currentConsentHandler(), await handler() {
                try requireActive()
                try Task.checkCancellation()
                // Retry the exact body and idempotency key only once, on this connection.
                return try await execute(request, allowConsent: false)
            }
            let body = errorBody?["error"]["message"].text ?? "Request failed"
            throw ApiError.http(status: http.statusCode, body: body)
        }
        return (data, http)
    }
}

/// Placeholder used when a 2xx response carries no body.
private struct EmptyResponse: Decodable {}

final class SameOriginRedirectPolicy: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        // The API has no redirect endpoints. Rejecting redirects also prevents
        // credential or download data from crossing origins or downgrading TLS.
        completionHandler(nil)
    }
}
