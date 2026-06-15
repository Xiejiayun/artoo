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
    func assign(taskId: String, request: AssignRequest) async throws -> TaskResponse
    func retry(taskId: String) async throws -> TaskResponse
    func review(taskId: String, request: ReviewRequest) async throws -> TaskResponse
    func listRuns(taskId: String) async throws -> [Run]
    func getRun(runId: String) async throws -> Run
    func listApprovals(status: String?) async throws -> [Approval]
    func resolveApproval(approvalId: String, request: ResolveApprovalRequest) async throws -> Approval
    func listMessages(roomId: String) async throws -> [Message]
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
// UNVERIFIED: authored on Windows without an iOS SDK. The request shapes mirror
// the v0.1 REST surface exercised by apps/web, but no call here has been run
// against a live server. Treat endpoint paths as the current best contract and
// reconcile against the server before shipping. See apps/ios/README.md.

public final class ApiClient: ApiClientProtocol, @unchecked Sendable {
    private let baseURL: URL
    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder
    /// Optional session token; bootstrap is unauthenticated in v0.1 embedded mode.
    private let authToken: String?

    public init(baseURL: URL, session: URLSession = .shared, authToken: String? = nil) {
        self.baseURL = baseURL
        self.session = session
        self.authToken = authToken
        self.decoder = ArtooJSON.decoder()
        self.encoder = ArtooJSON.encoder()
    }

    public convenience init?(baseURLString: String, authToken: String? = nil) {
        guard let url = URL(string: baseURLString) else { return nil }
        self.init(baseURL: url, authToken: authToken)
    }

    // MARK: Endpoints

    public func bootstrap() async throws -> Bootstrap {
        try await send(path: "/api/v1/bootstrap", method: "POST", body: EmptyBody())
    }

    public func listTasks(projectId: String) async throws -> [TaskItem] {
        let response: TasksResponse = try await send(
            path: "/api/v1/projects/\(escape(projectId))/tasks",
            method: "GET"
        )
        return response.tasks
    }

    public func createTask(projectId: String, request: CreateTaskRequest) async throws -> TaskResponse {
        try await send(
            path: "/api/v1/projects/\(escape(projectId))/tasks",
            method: "POST",
            body: request,
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

    public func assign(taskId: String, request: AssignRequest) async throws -> TaskResponse {
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
        let response: RunsResponse = try await send(
            path: "/api/v1/tasks/\(escape(taskId))/runs",
            method: "GET"
        )
        return response.runs
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
        let response: MessagesResponse = try await send(
            path: "/api/v1/rooms/\(escape(roomId))/messages",
            method: "GET"
        )
        return response.messages
    }

    // MARK: Request plumbing

    private struct EmptyBody: Encodable {}

    private func escape(_ component: String) -> String {
        component.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? component
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
            data = try encoder.encode(body)
        } catch {
            throw ApiError.decoding("Failed to encode request body: \(error)")
        }
        return try await perform(path: path, method: method, bodyData: data, idempotent: idempotent)
    }

    private func perform<Response: Decodable>(
        path: String,
        method: String,
        bodyData: Data?,
        idempotent: Bool
    ) async throws -> Response {
        guard let url = URL(string: path, relativeTo: baseURL) else {
            throw ApiError.invalidURL(baseURL.absoluteString + path)
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let authToken {
            request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        }
        if let bodyData {
            request.httpBody = bodyData
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if idempotent {
            request.setValue(UUID().uuidString, forHTTPHeaderField: "Idempotency-Key")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw ApiError.transport(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw ApiError.transport("Non-HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? ""
            throw ApiError.http(status: http.statusCode, body: body)
        }

        if data.isEmpty, let empty = EmptyResponse() as? Response {
            return empty
        }

        do {
            return try decoder.decode(Response.self, from: data)
        } catch {
            throw ApiError.decoding("\(error)")
        }
    }
}

/// Placeholder used when a 2xx response carries no body.
private struct EmptyResponse: Decodable {}
