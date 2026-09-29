import Foundation
import Combine

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

public struct RunFeedItem: Equatable, Identifiable, Hashable {
    public let run: Run
    public let task: TaskItem

    public var id: String { run.id }
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

    @discardableResult
    public func resolve(_ approval: Approval, approve: Bool, comment: String? = nil) async -> Bool {
        await resolve(approval, decision: approve ? .approved : .rejected, comment: comment)
    }

    @discardableResult
    public func resolve(_ approval: Approval, decision: ApprovalDecision, comment: String? = nil) async -> Bool {
        guard !resolving.contains(approval.id) else { return false }
        resolving.insert(approval.id)
        defer { resolving.remove(approval.id) }
        do {
            _ = try await client.resolveApproval(
                approvalId: approval.id,
                request: ResolveApprovalRequest(decision: decision.rawValue, comment: comment)
            )
            await load()
            return true
        } catch {
            state = .failed(describe(error))
            return false
        }
    }

    public func isResolving(_ approval: Approval) -> Bool {
        resolving.contains(approval.id)
    }
}

public enum ApprovalDecision: String, Equatable, CaseIterable {
    case approved
    case rejected
    case needsMoreInfo = "needs_more_info"

    public var label: String {
        switch self {
        case .approved: return "Approve"
        case .rejected: return "Reject"
        case .needsMoreInfo: return "Need Info"
        }
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
        columns(searchText: "", statusRaw: nil)
    }

    public func columns(searchText: String, statusRaw: String?) -> [(status: TaskStatus, tasks: [TaskItem])] {
        let tasks = state.value ?? []
        let normalizedSearch = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let filtered = tasks.filter { task in
            let matchesStatus = statusRaw == nil || task.status.rawValue == statusRaw
            guard matchesStatus else { return false }
            guard !normalizedSearch.isEmpty else { return true }
            let haystack = [
                task.title,
                task.description ?? "",
                task.assigneeId ?? "",
                task.priority ?? "",
                task.status.label
            ].joined(separator: " ").lowercased()
            return haystack.contains(normalizedSearch)
        }
        let order: [TaskStatus] = [.backlog, .ready, .assigned, .running, .awaitingApproval, .blocked, .review, .done, .cancelled]
        var byStatus: [String: [TaskItem]] = [:]
        for task in filtered {
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
    public func create(title: String, description: String?, priority: String?, acceptanceCriteria: [String], requiredCapabilities: [String] = []) async -> Bool {
        guard !creating else { return false }
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
                    acceptanceCriteria: acceptanceCriteria.isEmpty ? nil : acceptanceCriteria,
                    requiredCapabilities: requiredCapabilities
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

    public func assign(mode: String = "auto", agentInstanceId: String? = nil) async {
        await run {
            try await self.client.assign(
                taskId: self.taskId,
                request: AssignRequest(mode: mode, agentInstanceId: agentInstanceId)
            )
        }
    }

    public func review(accept: Bool, comment: String? = nil) async {
        await run {
            try await self.client.review(
                taskId: self.taskId,
                request: ReviewRequest(outcome: accept ? "accepted" : "changes_requested", comment: comment)
            )
        }
    }

    public func cancel(runId: String) async {
        guard !actionInFlight else { return }; actionInFlight = true; actionError = nil
        defer { actionInFlight = false }
        do { _ = try await client.command(path: "/api/v1/runs/\(apiPart(runId))/cancel", method: "POST", body: .object([:])); await load() }
        catch { actionError = describe(error) }
    }

    public var executionApproval: Approval? {
        state.value?.approvals.first { $0.isActiveExecutionGate }
    }

    public var executionBlocked: Bool {
        let history = state.value?.approvals.filter { $0.action == "execution.start" } ?? []
        let current = history.filter(\.isActiveExecutionGate)
        return (!history.isEmpty && current.count != 1) || current.contains {
            $0.payloadRef != "execution-gate/current" || $0.status != .approved || $0.runId != nil
        }
    }

    @discardableResult
    public func requestExecutionApproval(_ draft: ExecutionApprovalDraft) async -> Bool {
        guard !actionInFlight else { return false }
        guard state.value?.task.status == .ready, draft.valid else {
            actionError = "A ready task, a summary of 1–4000 characters and a risk level are required."
            return false
        }
        actionInFlight = true; actionError = nil
        defer { actionInFlight = false }
        do {
            _ = try await client.command(path: "/api/v1/tasks/\(apiPart(taskId))/execution-approval", method: "POST", body: draft.body)
            await load()
            return true
        } catch { actionError = describe(error); return false }
    }

    /// Lifecycle actions a human can take given the current status.
    public var availableActions: [TaskAction] {
        guard let status = state.value?.task.status else { return [] }
        switch status {
        case .backlog: return [.markReady]
        case .ready: return executionBlocked ? [] : [.assign]
        case .blocked: return [.retry]
        case .review: return [.accept, .requestChanges]
        default: return []
        }
    }

    private func run<Response>(_ operation: @escaping () async throws -> Response) async {
        guard !actionInFlight else { return }
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

// MARK: - Runs overview

@MainActor
public final class RunsOverviewViewModel: ObservableObject {
    @Published public private(set) var state: ViewState<[RunFeedItem]> = .idle

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
            var items: [RunFeedItem] = []
            for task in tasks {
                let snapshot = try await client.getTask(taskId: task.id)
                items.append(contentsOf: snapshot.runs.map { RunFeedItem(run: $0, task: snapshot.task) })
            }
            state = .loaded(items.sorted(by: sortRuns))
        } catch {
            state = .failed(describe(error))
        }
    }

    private func sortRuns(_ lhs: RunFeedItem, _ rhs: RunFeedItem) -> Bool {
        let left = lhs.run.startedAt ?? lhs.run.createdAt ?? lhs.run.id
        let right = rhs.run.startedAt ?? rhs.run.createdAt ?? rhs.run.id
        return left > right
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
