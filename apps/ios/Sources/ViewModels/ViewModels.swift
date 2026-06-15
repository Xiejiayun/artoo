import Foundation

/// Generic async-load state shared by every screen. `.loaded` carries data even
/// while a refresh is in flight, so the UI never blanks during pull-to-refresh.
public enum ViewState<Value: Equatable>: Equatable {
    case idle
    case loading
    case loaded(Value)
    case failed(String)

    public var value: Value? {
        if case let .loaded(value) = self { return value }
        return nil
    }

    public var isLoading: Bool {
        if case .loading = self { return true }
        return false
    }

    public var errorMessage: String? {
        if case let .failed(message) = self { return message }
        return nil
    }
}

private func describe(_ error: Error) -> String {
    if let apiError = error as? ApiError { return apiError.description }
    return error.localizedDescription
}

// MARK: - Inbox (approvals-first)

@MainActor
public final class InboxViewModel: ObservableObject {
    @Published public private(set) var state: ViewState<[Approval]> = .idle
    /// IDs currently being resolved, to disable their buttons.
    @Published public private(set) var resolving: Set<String> = []

    private let client: ApiClientProtocol

    public init(client: ApiClientProtocol) {
        self.client = client
    }

    public func load() async {
        if state.value == nil { state = .loading }
        do {
            let approvals = try await client.listApprovals(status: "pending")
            state = .loaded(approvals)
        } catch {
            state = .failed(describe(error))
        }
    }

    public func resolve(_ approval: Approval, approve: Bool, comment: String? = nil) async {
        resolving.insert(approval.id)
        defer { resolving.remove(approval.id) }
        do {
            _ = try await client.resolveApproval(
                approvalId: approval.id,
                request: ResolveApprovalRequest(decision: approve ? "approve" : "reject", comment: comment)
            )
            await load()
        } catch {
            state = .failed(describe(error))
        }
    }

    public func isResolving(_ approval: Approval) -> Bool {
        resolving.contains(approval.id)
    }
}

// MARK: - Tasks (list + create)

@MainActor
public final class TasksViewModel: ObservableObject {
    @Published public private(set) var state: ViewState<[TaskItem]> = .idle
    @Published public var creating = false

    public let projectId: String
    private let client: ApiClientProtocol

    public init(client: ApiClientProtocol, projectId: String) {
        self.client = client
        self.projectId = projectId
    }

    public func load() async {
        if state.value == nil { state = .loading }
        do {
            let tasks = try await client.listTasks(projectId: projectId)
            state = .loaded(tasks)
        } catch {
            state = .failed(describe(error))
        }
    }

    /// Groups the loaded tasks by status, preserving a stable column order.
    public var columns: [(status: TaskStatus, tasks: [TaskItem])] {
        let tasks = state.value ?? []
        let order: [TaskStatus] = [.backlog, .ready, .assigned, .inProgress, .blocked, .review, .accepted, .done]
        var byStatus: [String: [TaskItem]] = [:]
        for task in tasks {
            byStatus[task.status.rawValue, default: []].append(task)
        }
        var result: [(TaskStatus, [TaskItem])] = []
        for status in order {
            if let group = byStatus[status.rawValue], !group.isEmpty {
                result.append((status, group))
            }
        }
        // Any status not in the canonical order (e.g. `.other`) trails alphabetically.
        let known = Set(order.map { $0.rawValue })
        for key in byStatus.keys.sorted() where !known.contains(key) {
            if let group = byStatus[key], !group.isEmpty {
                result.append((TaskStatus(rawValue: key), group))
            }
        }
        return result
    }

    @discardableResult
    public func create(title: String, description: String?, priority: String?, acceptanceCriteria: [String]) async -> Bool {
        creating = true
        defer { creating = false }
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            state = .failed("Title is required")
            return false
        }
        do {
            _ = try await client.createTask(
                projectId: projectId,
                request: CreateTaskRequest(
                    title: trimmed,
                    description: description?.isEmpty == true ? nil : description,
                    priority: priority,
                    acceptanceCriteria: acceptanceCriteria.isEmpty ? nil : acceptanceCriteria
                )
            )
            await load()
            return true
        } catch {
            state = .failed(describe(error))
            return false
        }
    }
}

// MARK: - Task detail (snapshot + lifecycle actions)

@MainActor
public final class TaskDetailViewModel: ObservableObject {
    @Published public private(set) var state: ViewState<TaskSnapshot> = .idle
    @Published public private(set) var actionInFlight = false
    @Published public private(set) var actionError: String?

    public let taskId: String
    private let client: ApiClientProtocol

    public init(client: ApiClientProtocol, taskId: String) {
        self.client = client
        self.taskId = taskId
    }

    public func load() async {
        if state.value == nil { state = .loading }
        do {
            let snapshot = try await client.getTask(taskId: taskId)
            state = .loaded(snapshot)
        } catch {
            state = .failed(describe(error))
        }
    }

    public func markReady() async { await run { try await self.client.markReady(taskId: self.taskId) } }
    public func retry() async { await run { try await self.client.retry(taskId: self.taskId) } }

    public func assign(assigneeType: String, assigneeId: String) async {
        await run {
            try await self.client.assign(
                taskId: self.taskId,
                request: AssignRequest(assigneeType: assigneeType, assigneeId: assigneeId)
            )
        }
    }

    public func review(accept: Bool, comment: String? = nil) async {
        await run {
            try await self.client.review(
                taskId: self.taskId,
                request: ReviewRequest(decision: accept ? "accept" : "request_changes", comment: comment)
            )
        }
    }

    /// Lifecycle actions a human can take given the current status.
    public var availableActions: [TaskAction] {
        guard let status = state.value?.task.status else { return [] }
        switch status {
        case .backlog: return [.markReady]
        case .ready: return [.assign]
        case .assigned, .inProgress: return [.retry]
        case .review: return [.accept, .requestChanges]
        case .blocked, .failed: return [.retry]
        default: return []
        }
    }

    private func run(_ operation: @escaping () async throws -> TaskResponse) async {
        actionInFlight = true
        actionError = nil
        defer { actionInFlight = false }
        do {
            _ = try await operation()
            await load()
        } catch {
            actionError = describe(error)
        }
    }
}

public enum TaskAction: String, Equatable {
    case markReady
    case assign
    case retry
    case accept
    case requestChanges

    public var label: String {
        switch self {
        case .markReady: return "Mark Ready"
        case .assign: return "Assign"
        case .retry: return "Retry"
        case .accept: return "Accept"
        case .requestChanges: return "Request Changes"
        }
    }
}
