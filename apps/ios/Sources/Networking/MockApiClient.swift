import Foundation

/// In-memory client used by SwiftUI previews and unit tests. Deterministic:
/// holds a mutable task/approval store so view-model state transitions can be
/// exercised without a server. Construct with `.demo` for populated fixtures.
public actor MockApiClient: ApiClientProtocol {
    private var tasks: [TaskItem]
    private var snapshots: [String: TaskSnapshot]
    private var approvals: [Approval]
    private var runs: [String: Run]
    private let bootstrapValue: Bootstrap

    public init(
        bootstrap: Bootstrap,
        tasks: [TaskItem] = [],
        snapshots: [String: TaskSnapshot] = [:],
        approvals: [Approval] = [],
        runs: [String: Run] = [:]
    ) {
        self.bootstrapValue = bootstrap
        self.tasks = tasks
        self.snapshots = snapshots
        self.approvals = approvals
        self.runs = runs
    }

    public func bootstrap() async throws -> Bootstrap { bootstrapValue }

    public func listTasks(projectId: String) async throws -> [TaskItem] {
        tasks.filter { $0.projectId == projectId }
    }

    public func createTask(projectId: String, request: CreateTaskRequest) async throws -> TaskResponse {
        let task = TaskItem(
            id: "task_\(tasks.count + 1)",
            projectId: projectId,
            title: request.title,
            description: request.description,
            status: .backlog,
            priority: request.priority,
            acceptanceCriteria: request.acceptanceCriteria
        )
        tasks.append(task)
        snapshots[task.id] = TaskSnapshot(task: task)
        return TaskResponse(task: task)
    }

    public func getTask(taskId: String) async throws -> TaskSnapshot {
        if let snapshot = snapshots[taskId] { return snapshot }
        if let task = tasks.first(where: { $0.id == taskId }) {
            return TaskSnapshot(task: task)
        }
        throw ApiError.http(status: 404, body: "task not found")
    }

    public func markReady(taskId: String) async throws -> TaskResponse {
        try transition(taskId: taskId, to: .ready)
    }

    public func assign(taskId: String, request: AssignRequest) async throws -> TaskResponse {
        let response = try transition(taskId: taskId, to: .assigned)
        let run = Run(
            id: "run_\(runs.count + 1)",
            taskId: taskId,
            agentInstanceId: request.agentInstanceId,
            status: .running
        )
        runs[run.id] = run
        if var snapshot = snapshots[taskId] {
            snapshot = TaskSnapshot(
                task: response.task,
                room: snapshot.room,
                runs: snapshot.runs + [run],
                approvals: snapshot.approvals,
                artifacts: snapshot.artifacts
            )
            snapshots[taskId] = snapshot
        }
        return TaskResponse(task: response.task, run: run)
    }

    public func retry(taskId: String) async throws -> TaskResponse {
        try transition(taskId: taskId, to: .assigned)
    }

    public func review(taskId: String, request: ReviewRequest) async throws -> TaskResponse {
        let target: TaskStatus = request.outcome == "accepted" ? .done : .ready
        return try transition(taskId: taskId, to: target)
    }

    public func listRuns(taskId: String) async throws -> [Run] {
        runs.values.filter { $0.taskId == taskId }.sorted { $0.id < $1.id }
    }

    public func getRun(runId: String) async throws -> Run {
        guard let run = runs[runId] else { throw ApiError.http(status: 404, body: "run not found") }
        return run
    }

    public func listApprovals(status: String?) async throws -> [Approval] {
        guard let status, !status.isEmpty else { return approvals }
        return approvals.filter { $0.status.rawValue == status }
    }

    public func resolveApproval(approvalId: String, request: ResolveApprovalRequest) async throws -> Approval {
        guard let index = approvals.firstIndex(where: { $0.id == approvalId }) else {
            throw ApiError.http(status: 404, body: "approval not found")
        }
        let existing = approvals[index]
        let resolved = Approval(
            id: existing.id,
            taskId: existing.taskId,
            runId: existing.runId,
            action: existing.action,
            risk: existing.risk,
            summary: existing.summary,
            status: request.decision == "approved" ? .approved : request.decision == "needs_more_info" ? .needsMoreInfo : .rejected,
            createdAt: existing.createdAt
        )
        approvals[index] = resolved
        return resolved
    }

    public func listMessages(roomId: String) async throws -> [Message] {
        snapshots.values
            .compactMap { $0.room }
            .first { $0.id == roomId }
            .map { _ in [] } ?? []
    }

    // MARK: Helpers

    @discardableResult
    private func transition(taskId: String, to status: TaskStatus) throws -> TaskResponse {
        guard let index = tasks.firstIndex(where: { $0.id == taskId }) else {
            throw ApiError.http(status: 404, body: "task not found")
        }
        let existing = tasks[index]
        let updated = TaskItem(
            id: existing.id,
            projectId: existing.projectId,
            parentTaskId: existing.parentTaskId,
            roomId: existing.roomId,
            title: existing.title,
            description: existing.description,
            status: status,
            priority: existing.priority,
            assigneeType: existing.assigneeType,
            assigneeId: existing.assigneeId,
            requiredCapabilities: existing.requiredCapabilities,
            acceptanceCriteria: existing.acceptanceCriteria,
            createdAt: existing.createdAt,
            updatedAt: existing.updatedAt
        )
        tasks[index] = updated
        if let snapshot = snapshots[taskId] {
            snapshots[taskId] = TaskSnapshot(
                task: updated,
                room: snapshot.room,
                runs: snapshot.runs,
                approvals: snapshot.approvals,
                artifacts: snapshot.artifacts
            )
        } else {
            snapshots[taskId] = TaskSnapshot(task: updated)
        }
        return TaskResponse(task: updated)
    }
}

// MARK: - Demo fixtures

public extension MockApiClient {
    static func demo() -> MockApiClient {
        let bootstrap = Bootstrap(
            organization: Organization(id: "org_default", name: "artoo"),
            user: UserAccount(id: "user_1", email: "jeremy@artoo.dev", displayName: "Jeremy", role: "owner"),
            projects: [ProjectRef(id: "proj_artoo", name: "artoo")],
            actor: ActorRef(type: "user", id: "user_1")
        )

        let inboxTask = TaskItem(
            id: "task_1",
            projectId: "proj_artoo",
            roomId: "room_1",
            title: "Build the Inbox work surface",
            description: "Approvals-first surface so a human can triage agent escalations.",
            status: .review,
            priority: "p1",
            acceptanceCriteria: ["Pending approvals are listed", "Approve/reject resolves the item"],
            createdAt: "2026-06-15T20:00:00.000Z",
            updatedAt: "2026-06-15T20:05:00.000Z"
        )
        let backlogTask = TaskItem(
            id: "task_2",
            projectId: "proj_artoo",
            title: "Wire the Tasks board",
            description: "List + create tasks against the v0.1 API.",
            status: .backlog,
            priority: "p2",
            createdAt: "2026-06-15T20:01:00.000Z"
        )

        let run = Run(
            id: "run_1",
            taskId: "task_1",
            agentInstanceId: "agent_claude",
            runtimeId: "claude-code",
            status: .completed,
            startedAt: "2026-06-15T20:02:00.000Z",
            endedAt: "2026-06-15T20:03:00.000Z",
            sequence: 4,
            createdAt: "2026-06-15T20:02:00.000Z"
        )

        let approval = Approval(
            id: "appr_1",
            taskId: "task_1",
            runId: "run_1",
            action: "merge_pull_request",
            risk: .medium,
            summary: "Merge feature/task-1 into main",
            status: .pending,
            createdAt: "2026-06-15T20:03:00.000Z"
        )

        let snapshot = TaskSnapshot(
            task: inboxTask,
            room: Room(id: "room_1", taskId: "task_1", type: "task", name: "Inbox work surface"),
            runs: [run],
            approvals: [approval],
            artifacts: [
                Artifact(
                    id: "art_1",
                    taskId: "task_1",
                    runId: "run_1",
                    type: "pull_request",
                    uri: "https://example.com/pr/1",
                    createdAt: "2026-06-15T20:04:00.000Z"
                )
            ]
        )

        return MockApiClient(
            bootstrap: bootstrap,
            tasks: [inboxTask, backlogTask],
            snapshots: ["task_1": snapshot, "task_2": TaskSnapshot(task: backlogTask)],
            approvals: [approval],
            runs: ["run_1": run]
        )
    }
}
