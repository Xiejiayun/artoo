import Foundation

// MARK: - Robust string-backed enums
//
// The artoo server is the source of truth for status vocabularies. Because this
// client is authored on Windows and cannot be compiled/round-tripped against a
// live server here, every status enum decodes unknown values into `.other(raw)`
// instead of throwing. That keeps the UI resilient if the server adds a status
// before this client is updated. See apps/ios/README.md (unverified status).

public enum TaskStatus: Equatable, Hashable {
    case backlog
    case ready
    case assigned
    case inProgress
    case blocked
    case review
    case accepted
    case done
    case cancelled
    case failed
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "backlog": self = .backlog
        case "ready": self = .ready
        case "assigned": self = .assigned
        case "in_progress": self = .inProgress
        case "blocked": self = .blocked
        case "review": self = .review
        case "accepted": self = .accepted
        case "done": self = .done
        case "cancelled", "canceled": self = .cancelled
        case "failed": self = .failed
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .backlog: return "backlog"
        case .ready: return "ready"
        case .assigned: return "assigned"
        case .inProgress: return "in_progress"
        case .blocked: return "blocked"
        case .review: return "review"
        case .accepted: return "accepted"
        case .done: return "done"
        case .cancelled: return "cancelled"
        case .failed: return "failed"
        case let .other(raw): return raw
        }
    }

    /// Human-facing label for column headers / badges.
    public var label: String {
        switch self {
        case .backlog: return "Backlog"
        case .ready: return "Ready"
        case .assigned: return "Assigned"
        case .inProgress: return "In Progress"
        case .blocked: return "Blocked"
        case .review: return "Review"
        case .accepted: return "Accepted"
        case .done: return "Done"
        case .cancelled: return "Cancelled"
        case .failed: return "Failed"
        case let .other(raw): return raw.capitalized
        }
    }
}

extension TaskStatus: Codable {
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = TaskStatus(rawValue: raw)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

public enum RunStatus: Equatable, Hashable {
    case queued
    case starting
    case running
    case completed
    case failed
    case cancelled
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "queued": self = .queued
        case "starting": self = .starting
        case "running": self = .running
        case "completed", "succeeded": self = .completed
        case "failed": self = .failed
        case "cancelled", "canceled": self = .cancelled
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .queued: return "queued"
        case .starting: return "starting"
        case .running: return "running"
        case .completed: return "completed"
        case .failed: return "failed"
        case .cancelled: return "cancelled"
        case let .other(raw): return raw
        }
    }

    public var label: String {
        switch self {
        case .queued: return "Queued"
        case .starting: return "Starting"
        case .running: return "Running"
        case .completed: return "Completed"
        case .failed: return "Failed"
        case .cancelled: return "Cancelled"
        case let .other(raw): return raw.capitalized
        }
    }
}

extension RunStatus: Codable {
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = RunStatus(rawValue: raw)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

public enum ApprovalStatus: Equatable, Hashable {
    case pending
    case approved
    case rejected
    case expired
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "pending": self = .pending
        case "approved": self = .approved
        case "rejected": self = .rejected
        case "expired": self = .expired
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .pending: return "pending"
        case .approved: return "approved"
        case .rejected: return "rejected"
        case .expired: return "expired"
        case let .other(raw): return raw
        }
    }

    public var label: String {
        switch self {
        case .pending: return "Pending"
        case .approved: return "Approved"
        case .rejected: return "Rejected"
        case .expired: return "Expired"
        case let .other(raw): return raw.capitalized
        }
    }
}

extension ApprovalStatus: Codable {
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ApprovalStatus(rawValue: raw)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

public enum RiskLevel: Equatable, Hashable {
    case low
    case medium
    case high
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "low": self = .low
        case "medium": self = .medium
        case "high": self = .high
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .low: return "low"
        case .medium: return "medium"
        case .high: return "high"
        case let .other(raw): return raw
        }
    }

    public var label: String {
        switch self {
        case .low: return "Low"
        case .medium: return "Medium"
        case .high: return "High"
        case let .other(raw): return raw.capitalized
        }
    }
}

extension RiskLevel: Codable {
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = RiskLevel(rawValue: raw)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

// MARK: - Core entities
//
// Property names are camelCase; the shared JSONDecoder uses
// `.convertFromSnakeCase` so e.g. `created_at` decodes into `createdAt`.
// Timestamps are kept as raw ISO-8601 strings to avoid brittle date parsing
// against a server we cannot round-trip with here.

public struct ActorRef: Codable, Equatable, Hashable {
    public let type: String
    public let id: String

    public init(type: String, id: String) {
        self.type = type
        self.id = id
    }
}

public struct Organization: Codable, Equatable, Identifiable {
    public let id: String
    public let name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

public struct UserAccount: Codable, Equatable, Identifiable {
    public let id: String
    public let email: String
    public let displayName: String
    public let role: String

    public init(id: String, email: String, displayName: String, role: String) {
        self.id = id
        self.email = email
        self.displayName = displayName
        self.role = role
    }
}

public struct ProjectRef: Codable, Equatable, Identifiable {
    public let id: String
    public let name: String
    public let defaultWorkspace: String?

    public init(id: String, name: String, defaultWorkspace: String? = nil) {
        self.id = id
        self.name = name
        self.defaultWorkspace = defaultWorkspace
    }
}

public struct Bootstrap: Codable, Equatable {
    public let organization: Organization
    public let user: UserAccount
    public let projects: [ProjectRef]
    public let actor: ActorRef

    public init(organization: Organization, user: UserAccount, projects: [ProjectRef], actor: ActorRef) {
        self.organization = organization
        self.user = user
        self.projects = projects
        self.actor = actor
    }
}

public struct TaskItem: Codable, Equatable, Hashable, Identifiable {
    public let id: String
    public let projectId: String
    public let parentTaskId: String?
    public let roomId: String?
    public let title: String
    public let description: String?
    public let status: TaskStatus
    public let priority: String?
    public let assigneeType: String?
    public let assigneeId: String?
    public let requiredCapabilities: [String]?
    public let acceptanceCriteria: [String]?
    public let createdAt: String?
    public let updatedAt: String?

    public init(
        id: String,
        projectId: String,
        parentTaskId: String? = nil,
        roomId: String? = nil,
        title: String,
        description: String? = nil,
        status: TaskStatus,
        priority: String? = nil,
        assigneeType: String? = nil,
        assigneeId: String? = nil,
        requiredCapabilities: [String]? = nil,
        acceptanceCriteria: [String]? = nil,
        createdAt: String? = nil,
        updatedAt: String? = nil
    ) {
        self.id = id
        self.projectId = projectId
        self.parentTaskId = parentTaskId
        self.roomId = roomId
        self.title = title
        self.description = description
        self.status = status
        self.priority = priority
        self.assigneeType = assigneeType
        self.assigneeId = assigneeId
        self.requiredCapabilities = requiredCapabilities
        self.acceptanceCriteria = acceptanceCriteria
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct Run: Codable, Equatable, Hashable, Identifiable {
    public let id: String
    public let taskId: String
    public let computerId: String?
    public let agentInstanceId: String?
    public let runtimeId: String?
    public let status: RunStatus
    public let summary: String?
    public let error: String?
    public let createdAt: String?
    public let updatedAt: String?

    public init(
        id: String,
        taskId: String,
        computerId: String? = nil,
        agentInstanceId: String? = nil,
        runtimeId: String? = nil,
        status: RunStatus,
        summary: String? = nil,
        error: String? = nil,
        createdAt: String? = nil,
        updatedAt: String? = nil
    ) {
        self.id = id
        self.taskId = taskId
        self.computerId = computerId
        self.agentInstanceId = agentInstanceId
        self.runtimeId = runtimeId
        self.status = status
        self.summary = summary
        self.error = error
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

public struct Approval: Codable, Equatable, Hashable, Identifiable {
    public let id: String
    public let taskId: String?
    public let runId: String?
    public let action: String
    public let risk: RiskLevel
    public let summary: String?
    public let status: ApprovalStatus
    public let createdAt: String?

    public init(
        id: String,
        taskId: String? = nil,
        runId: String? = nil,
        action: String,
        risk: RiskLevel,
        summary: String? = nil,
        status: ApprovalStatus,
        createdAt: String? = nil
    ) {
        self.id = id
        self.taskId = taskId
        self.runId = runId
        self.action = action
        self.risk = risk
        self.summary = summary
        self.status = status
        self.createdAt = createdAt
    }
}

public struct Artifact: Codable, Equatable, Identifiable {
    public let id: String
    public let taskId: String?
    public let runId: String?
    public let type: String
    public let uri: String
    public let checksum: String?
    public let createdAt: String?

    public init(
        id: String,
        taskId: String? = nil,
        runId: String? = nil,
        type: String,
        uri: String,
        checksum: String? = nil,
        createdAt: String? = nil
    ) {
        self.id = id
        self.taskId = taskId
        self.runId = runId
        self.type = type
        self.uri = uri
        self.checksum = checksum
        self.createdAt = createdAt
    }
}

public struct Room: Codable, Equatable, Identifiable {
    public let id: String
    public let taskId: String?
    public let title: String?

    public init(id: String, taskId: String? = nil, title: String? = nil) {
        self.id = id
        self.taskId = taskId
        self.title = title
    }
}

public struct Message: Codable, Equatable, Identifiable {
    public let id: String
    public let roomId: String
    public let authorType: String
    public let authorId: String
    public let kind: String?
    public let body: String
    public let createdAt: String?

    public init(
        id: String,
        roomId: String,
        authorType: String,
        authorId: String,
        kind: String? = nil,
        body: String,
        createdAt: String? = nil
    ) {
        self.id = id
        self.roomId = roomId
        self.authorType = authorType
        self.authorId = authorId
        self.kind = kind
        self.body = body
        self.createdAt = createdAt
    }
}

/// Aggregate returned by `GET /api/v1/tasks/:taskId`.
public struct TaskSnapshot: Codable, Equatable {
    public let task: TaskItem
    public let room: Room?
    public let runs: [Run]
    public let approvals: [Approval]
    public let artifacts: [Artifact]

    public init(
        task: TaskItem,
        room: Room? = nil,
        runs: [Run] = [],
        approvals: [Approval] = [],
        artifacts: [Artifact] = []
    ) {
        self.task = task
        self.room = room
        self.runs = runs
        self.approvals = approvals
        self.artifacts = artifacts
    }
}

// MARK: - Response envelopes

public struct TasksResponse: Codable, Equatable {
    public let tasks: [TaskItem]
    public init(tasks: [TaskItem]) { self.tasks = tasks }
}

public struct TaskResponse: Codable, Equatable {
    public let task: TaskItem
    public let run: Run?
    public init(task: TaskItem, run: Run? = nil) {
        self.task = task
        self.run = run
    }
}

public struct RunsResponse: Codable, Equatable {
    public let runs: [Run]
    public init(runs: [Run]) { self.runs = runs }
}

public struct RunResponse: Codable, Equatable {
    public let run: Run
    public init(run: Run) { self.run = run }
}

public struct ApprovalsResponse: Codable, Equatable {
    public let approvals: [Approval]
    public init(approvals: [Approval]) { self.approvals = approvals }
}

public struct ApprovalResponse: Codable, Equatable {
    public let approval: Approval
    public init(approval: Approval) { self.approval = approval }
}

public struct MessagesResponse: Codable, Equatable {
    public let messages: [Message]
    public init(messages: [Message]) { self.messages = messages }
}

// MARK: - Request bodies

public struct CreateTaskRequest: Codable, Equatable {
    public let title: String
    public let description: String?
    public let priority: String?
    public let acceptanceCriteria: [String]?

    public init(title: String, description: String? = nil, priority: String? = nil, acceptanceCriteria: [String]? = nil) {
        self.title = title
        self.description = description
        self.priority = priority
        self.acceptanceCriteria = acceptanceCriteria
    }
}

public struct AssignRequest: Codable, Equatable {
    public let assigneeType: String
    public let assigneeId: String

    public init(assigneeType: String, assigneeId: String) {
        self.assigneeType = assigneeType
        self.assigneeId = assigneeId
    }
}

public struct ReviewRequest: Codable, Equatable {
    /// "accept" or "request_changes".
    public let decision: String
    public let comment: String?

    public init(decision: String, comment: String? = nil) {
        self.decision = decision
        self.comment = comment
    }
}

public struct ResolveApprovalRequest: Codable, Equatable {
    /// "approve" or "reject".
    public let decision: String
    public let comment: String?

    public init(decision: String, comment: String? = nil) {
        self.decision = decision
        self.comment = comment
    }
}
