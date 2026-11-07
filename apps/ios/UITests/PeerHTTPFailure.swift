import Foundation

/// Test diagnostics only. Never render origins, credentials, IDs, queries or raw error text.
enum PeerHTTPFailure {
    private static let routes = ["/node/start", "/node/stop", "/api/v1/daemons", "/api/v1/tasks",
        "/api/v1/tasks/:id", "/api/v1/tasks/:id/dependencies", "/api/v1/approvals", "/api/v1/devices",
        "/api/v1/devices/pairings", "/api/v1/rooms/:id/messages", "/api/v1/goals/:id/audit-bundle",
        "/api/v1/goals/:id/discussions"]
    private static let apiCodes: Set<String> = ["validation_error", "not_found", "permission_denied", "ai_consent_required",
        "ai_sharing_unconfigured", "conflict", "invalid_state", "runtime_unavailable", "computer_offline",
        "approval_required", "rate_limited", "internal_error"]
    private static let phases: Set<String> = ["node_start", "node_stop", "presence_read", "presence_check",
        "presence_wait", "final_presence_read", "record_transition"]
    private static let kinds: Set<String> = ["error", "type_error", "range_error", "assertion", "abort", "timeout",
        "verification_cleanup", "unknown"]
    private static let codes: Set<String> = ["unknown", "presence_timeout", "daemon_http_error", "ERR_ASSERTION",
        "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOENT", "EACCES", "EPERM",
        "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET"]

    static func description(request: URLRequest, status: Int, data: Data) -> String {
        let method = request.httpMethod ?? "GET"
        let safeMethod = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].contains(method) ? method : "OTHER"
        let path = request.url?.path.split(separator: "/", omittingEmptySubsequences: false) ?? []
        let route = routes.first { template in
            let parts = template.split(separator: "/", omittingEmptySubsequences: false)
            return parts.count == path.count && zip(parts, path).allSatisfy { expected, actual in
                expected == actual || (expected == ":id" && !actual.isEmpty)
            }
        } ?? "[unrecognized endpoint]"
        var result = "Authenticated peer request failed: \(safeMethod) \(route) HTTP \(status)"
        // The size bound also prevents diagnostics from parsing arbitrary large error bodies.
        guard data.count <= 16384, let body = try? JSONDecoder().decode(Envelope.self, from: data) else { return result }
        if let code = body.error?.code, apiCodes.contains(code) { result += "; api=\(code)" }
        if let item = body.diagnostic, item.version == 1, ["start", "stop"].contains(item.action),
           phases.contains(item.phase), kinds.contains(item.kind), codes.contains(item.code),
           item.upstream_status == nil || (400...599).contains(item.upstream_status!) {
            result += "; fixture action=\(item.action) phase=\(item.phase) kind=\(item.kind) code=\(item.code)"
            if let upstream = item.upstream_status { result += " upstream_status=\(upstream)" }
        }
        return result
    }

    private struct APIError: Decodable { let code: String }
    private struct NodeDiagnostic: Decodable {
        let version: Int; let action: String; let phase: String; let kind: String; let code: String
        let upstream_status: Int?
    }
    private struct Envelope: Decodable {
        let error: APIError?; let diagnostic: NodeDiagnostic?
        private enum CodingKeys: String, CodingKey { case error, diagnostic }
        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            error = try? container.decode(APIError.self, forKey: .error)
            diagnostic = try? container.decode(NodeDiagnostic.self, forKey: .diagnostic)
        }
    }
}
