import Foundation

/// A historical worker report. It does not establish current file availability.
public struct WorkspaceRetention: Codable, Equatable, Hashable {
    public enum Outcome: String, Codable, CaseIterable {
        case completed, failed, cancelled
        case incompleteDelivery = "incomplete_delivery"
        case unconfirmed

        public var label: String {
            switch self {
            case .completed: return "Execution completed"
            case .failed: return "Execution failed"
            case .cancelled: return "Execution cancelled"
            case .incompleteDelivery: return "Delivery incomplete"
            case .unconfirmed: return "Outcome unconfirmed"
            }
        }
    }

    public let version: Int
    public let workspaceRoot: String
    public let workspaceBranch: String
    public let outcome: Outcome
    public let reporterComputerId: String
    public let eventId: String
    public let position: Int
    public let sequence: Int
    public let reportedAt: String

    private enum CodingKeys: String, CodingKey {
        case version, outcome, position, sequence
        case workspaceRoot = "workspace_root", workspaceBranch = "workspace_branch"
        case reporterComputerId = "reporter_computer_id", eventId = "event_id", reportedAt = "reported_at"
    }

    public init(from decoder: Decoder) throws {
        // Dictionary keys retain their wire spelling even with convertFromSnakeCase.
        // Unknown fields/versions are not silently promoted to trusted v1 evidence.
        let fields = try decoder.singleValueContainer().decode([String: JSONValue].self)
        let keys: Set<String> = ["version", "workspace_root", "workspace_branch", "outcome",
                                 "reporter_computer_id", "event_id", "position", "sequence", "reported_at"]
        guard Set(fields.keys) == keys,
              Self.integer(fields["version"], minimum: 1) == 1,
              case let .string(root)? = fields["workspace_root"], Self.bounded(root, maximum: 4096), !root.contains("\0"),
              case let .string(branch)? = fields["workspace_branch"], Self.bounded(branch, maximum: 1024),
              !branch.contains("\0"), branch == branch.trimmingCharacters(in: Self.branchWhitespace),
              case let .string(rawOutcome)? = fields["outcome"], let outcome = Outcome(rawValue: rawOutcome),
              case let .string(computer)? = fields["reporter_computer_id"], Self.bounded(computer, maximum: 256),
              case let .string(event)? = fields["event_id"], Self.bounded(event, maximum: 256),
              let position = Self.integer(fields["position"], minimum: 1),
              let sequence = Self.integer(fields["sequence"], minimum: 0),
              case let .string(time)? = fields["reported_at"], Self.validDateTime(time) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Invalid workspace retention v1 report"))
        }
        version = 1; workspaceRoot = root; workspaceBranch = branch; self.outcome = outcome
        reporterComputerId = computer; eventId = event; self.position = position; self.sequence = sequence; reportedAt = time
    }

    func matches(computerId: String?, workspaceRoot: String?, workspaceBranch: String?) -> Bool {
        guard let computerId, let workspaceRoot, let workspaceBranch else { return false }
        // Swift String equality normalizes Unicode; the server compares exact strings.
        return reporterComputerId.utf8.elementsEqual(computerId.utf8)
            && self.workspaceRoot.utf8.elementsEqual(workspaceRoot.utf8)
            && self.workspaceBranch.utf8.elementsEqual(workspaceBranch.utf8)
    }

    private static func bounded(_ value: String, maximum: Int) -> Bool {
        // Match JavaScript/Zod string length, including supplementary characters.
        (1...maximum).contains(value.utf16.count)
    }

    private static func integer(_ value: JSONValue?, minimum: Double) -> Int? {
        guard case let .number(number)? = value, number.isFinite, number >= minimum,
              number <= 9_007_199_254_740_991, number.rounded() == number else { return nil }
        return Int(number)
    }

    // ECMAScript trim whitespace, matching the shared branch schema.
    private static let branchWhitespace = CharacterSet(charactersIn: "\u{0009}\u{000A}\u{000B}\u{000C}\u{000D}\u{0020}\u{00A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}")

    private static func validDateTime(_ value: String) -> Bool {
        // z.string().datetime(): UTC Z, optional seconds/fraction, valid Gregorian
        // calendar date. Keep the exact server string; impose no freshness bound.
        guard value.range(of: #"^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]+)?)?Z\z"#, options: .regularExpression) != nil else { return false }
        let parts = value.prefix(10).split(separator: "-").compactMap { Int($0) }
        let leap = parts[0] % 4 == 0 && (parts[0] % 100 != 0 || parts[0] % 400 == 0)
        let days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
        return parts[2] <= days[parts[1] - 1]
    }
}

/// Values for display and copying are data, never a shell command or normalized path.
struct RunWorkspaceDetails {
    let report: WorkspaceRetention?
    let workspaceRoot: String?
    let workspaceBranch: String?
    let reporterDisplayName: String?

    init(run: Run, computers: [WorkspaceRecord] = []) {
        let report = run.workspaceRetention
        self.report = report
        workspaceRoot = report?.workspaceRoot ?? run.workspaceRoot
        workspaceBranch = report?.workspaceBranch ?? run.workspaceBranch
        let matches = computers.filter { $0.id.utf8.elementsEqual(report?.reporterComputerId.utf8 ?? "".utf8) }
        if report != nil, matches.count == 1, case let .string(name) = matches[0]["display_name"],
           !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            reporterDisplayName = name
        } else { reporterDisplayName = nil }
    }

    var heading: String { report == nil ? "Retention not reported" : "Work retention reported" }
    var workspaceLabel: String { report == nil ? "Planned workspace" : "Reported workspace" }
}
