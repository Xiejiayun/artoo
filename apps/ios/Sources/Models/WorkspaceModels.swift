import Foundation

/// Preserves extensible server records without silently discarding new fields.
public enum JSONValue: Codable, Equatable, Sendable {
    case object([String: JSONValue]), array([JSONValue]), string(String), number(Double), bool(Bool), null

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let v = try? value.decode(Bool.self) { self = .bool(v) }
        else if let v = try? value.decode(Double.self) { self = .number(v) }
        else if let v = try? value.decode(String.self) { self = .string(v) }
        else if let v = try? value.decode([JSONValue].self) { self = .array(v) }
        else { self = .object(try value.decode([String: JSONValue].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case let .object(v): try value.encode(v)
        case let .array(v): try value.encode(v)
        case let .string(v): try value.encode(v)
        case let .number(v): try value.encode(v)
        case let .bool(v): try value.encode(v)
        case .null: try value.encodeNil()
        }
    }
    public subscript(key: String) -> JSONValue {
        if case let .object(value) = self { return value[key] ?? .null }
        return .null
    }
    public var text: String {
        switch self {
        case let .string(value): return value
        case let .number(value): return value.rounded() == value ? String(format: "%.0f", value) : String(value)
        case let .bool(value): return value ? "Yes" : "No"
        default: return ""
        }
    }
    public var array: [JSONValue] { if case let .array(values) = self { return values }; return [] }
    public var bool: Bool { if case let .bool(value) = self { return value }; return false }
    public var records: [WorkspaceRecord] { array.compactMap(WorkspaceRecord.init) }
    public var pretty: String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return (try? encoder.encode(self)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }
    public static func strings(_ items: [String]) -> JSONValue { .array(items.map(JSONValue.string)) }
}

public struct WorkspaceRecord: Equatable, Identifiable, Sendable {
    public let id: String
    public let value: JSONValue
    public init?(_ value: JSONValue) {
        guard !value["id"].text.isEmpty else { return nil }
        id = value["id"].text; self.value = value
    }
    public subscript(key: String) -> JSONValue { value[key] }
    public var title: String {
        for key in ["title", "display_name", "name", "summary", "expected_action", "text", "runtime"] {
            if !self[key].text.isEmpty { return self[key].text }
        }
        return id
    }
    public var status: String { self["status"].text.isEmpty ? self["trust"].text : self["status"].text }
}

public struct SessionIdentity: Codable, Equatable, Sendable {
    public struct User: Codable, Equatable, Sendable {
        public let id: String
        public let email: String
        public let name: String
        public let role: String
    }
    public let user: User
    public let deviceId: String?
    public var isAdministrator: Bool { ["owner", "admin"].contains(user.role) }
}

public struct PairingClaim: Decodable {
    public struct Device: Decodable { public let id: String }
    public let device: Device
    public let controlToken: String
    // The iOS app deliberately does not decode or store the compute node token.
}

public struct StoredConnection: Codable, Equatable, Sendable {
    public let serverURL: String
    public let controlToken: String
    public let deviceId: String
}

public enum ServerAddress {
    /// Restrict production credentials to HTTPS; local HTTP is an explicit development choice.
    public static func validate(_ raw: String, allowLocalHTTP: Bool = false) throws -> URL {
        guard let components = URLComponents(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = components.scheme?.lowercased(), let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil, components.query == nil, components.fragment == nil,
              components.path.isEmpty || components.path == "/" else { throw ApiError.invalidURL("Enter the server origin, such as https://artoo.example.com") }
        let local = host == "localhost" || host == "127.0.0.1" || host == "::1" || host.hasSuffix(".local")
        guard scheme == "https" || (scheme == "http" && allowLocalHTTP && local), let url = components.url else {
            throw ApiError.invalidURL("Use HTTPS. Local HTTP is available only for a local development server.")
        }
        return url
    }
}

public extension Notification.Name {
    static let artooAuthenticationExpired = Notification.Name("artoo.authenticationExpired")
}
