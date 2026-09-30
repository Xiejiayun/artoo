import XCTest
@testable import Artoo

@MainActor
final class ViewModelsTests: XCTestCase {

    func testInboxLoadsPendingApprovalsThenResolveClearsThem() async {
        let model = InboxViewModel(client: MockApiClient.demo())

        await model.load()
        let pending = model.state.value
        XCTAssertEqual(pending?.count, 1)
        let approval = try? XCTUnwrap(pending?.first)
        XCTAssertEqual(approval?.status, .pending)

        if let approval {
            await model.resolve(approval, approve: true)
        }
        // After approving, the pending list should be empty.
        XCTAssertEqual(model.state.value?.isEmpty, true)
    }

    func testInboxNeedsMoreInfoSurvivesReopeningAndCanBeApproved() async throws {
        let client = MockApiClient.demo()
        let model = InboxViewModel(client: client)

        await model.load()
        let approval = try XCTUnwrap(model.state.value?.first)
        let requested = await model.resolve(approval, decision: .needsMoreInfo, comment: "Need logs")
        XCTAssertTrue(requested)
        XCTAssertEqual(model.state.value?.map(\.id), [approval.id])
        XCTAssertEqual(model.state.value?.first?.status, .needsMoreInfo)

        let reopened = InboxViewModel(client: client)
        await reopened.load()
        let waiting = try XCTUnwrap(reopened.state.value?.first)
        XCTAssertEqual(waiting.id, approval.id)
        XCTAssertEqual(waiting.status, .needsMoreInfo)
        let approved = await reopened.resolve(waiting, decision: .approved, comment: "Logs reviewed")
        XCTAssertTrue(approved)
        XCTAssertEqual(reopened.state.value, [])
        let stored = try await client.listApprovals(status: nil)
        XCTAssertEqual(stored.first?.status, .approved)
    }

    func testInboxRetainsBothActionableStatesAndRemovesRejectedRequest() async throws {
        let bootstrap = try await MockApiClient.demo().bootstrap()
        let client = MockApiClient(bootstrap: bootstrap, approvals: [
            Approval(id: "pending", action: "Review", risk: .high, status: .pending),
            Approval(id: "waiting", action: "Review", risk: .medium, status: .needsMoreInfo),
            Approval(id: "done", action: "Review", risk: .low, status: .approved),
            Approval(id: "expired", action: "Review", risk: .low, status: .expired),
            Approval(id: "superseded", action: "execution.start", risk: .high, payloadRef: "execution-gate/superseded", status: .needsMoreInfo)
        ])
        let model = InboxViewModel(client: client)
        await model.load()
        XCTAssertEqual(model.state.value?.map(\.id), ["pending", "waiting"])
        let waiting = try XCTUnwrap(model.state.value?.first { $0.id == "waiting" })
        let rejected = await model.resolve(waiting, decision: .rejected, comment: "Not safe to continue")
        XCTAssertTrue(rejected)
        XCTAssertEqual(model.state.value?.map(\.id), ["pending"])
        let history = try await client.listApprovals(status: nil)
        XCTAssertEqual(history.first { $0.id == "waiting" }?.status, .rejected)
    }

    func testTasksGroupIntoOrderedColumns() async {
        let model = TasksViewModel(client: MockApiClient.demo(), projectId: "proj_artoo")
        await model.load()

        let columns = model.columns
        XCTAssertEqual(columns.count, 2)
        XCTAssertEqual(columns.first?.status, .backlog)
        XCTAssertEqual(columns.first?.tasks.first?.id, "task_2")
        XCTAssertEqual(columns.last?.status, .review)
    }

    func testTasksSearchAndStatusFilters() async {
        let model = TasksViewModel(client: MockApiClient.demo(), projectId: "proj_artoo")
        await model.load()

        let reviewMatches = model.columns(searchText: "inbox", statusRaw: TaskStatus.review.rawValue)
        XCTAssertEqual(reviewMatches.count, 1)
        XCTAssertEqual(reviewMatches.first?.status, .review)
        XCTAssertEqual(reviewMatches.first?.tasks.first?.id, "task_1")

        let filteredOut = model.columns(searchText: "inbox", statusRaw: TaskStatus.backlog.rawValue)
        XCTAssertTrue(filteredOut.isEmpty)
    }

    func testTasksColumnsKeepCancelledBeforeUnknownStatuses() async throws {
        let bootstrap = try await MockApiClient.demo().bootstrap()
        let client = MockApiClient(
            bootstrap: bootstrap,
            tasks: [
                TaskItem(id: "task_done", projectId: "proj_artoo", title: "Accepted", status: .done),
                TaskItem(id: "task_unknown", projectId: "proj_artoo", title: "Archived", status: .other("archived")),
                TaskItem(id: "task_cancelled", projectId: "proj_artoo", title: "Cancelled", status: .cancelled)
            ]
        )
        let model = TasksViewModel(client: client, projectId: "proj_artoo")

        await model.load()

        XCTAssertEqual(model.columns.map(\.status), [.done, .cancelled, .other("archived")])
        let cancelledOnly = model.columns(searchText: "", statusRaw: TaskStatus.cancelled.rawValue)
        XCTAssertEqual(cancelledOnly.map(\.status), [.cancelled])
        XCTAssertEqual(cancelledOnly.first?.tasks.first?.id, "task_cancelled")
    }

    func testCreateTaskAppendsBacklogTask() async {
        let model = TasksViewModel(client: MockApiClient.demo(), projectId: "proj_artoo")
        await model.load()

        let ok = await model.create(title: "Wire WS", description: nil, priority: "p2", acceptanceCriteria: [])
        XCTAssertTrue(ok)

        let backlog = model.columns.first { $0.status == .backlog }
        XCTAssertEqual(backlog?.tasks.contains { $0.title == "Wire WS" }, true)
    }

    func testCreateRejectsEmptyTitle() async {
        let model = TasksViewModel(client: MockApiClient.demo(), projectId: "proj_artoo")
        await model.load()

        let ok = await model.create(title: "   ", description: nil, priority: "p2", acceptanceCriteria: [])
        XCTAssertFalse(ok)
        XCTAssertEqual(model.state.errorMessage, "Title is required")
    }

    func testTaskDetailLifecycleActionsFollowStatus() async {
        let model = TaskDetailViewModel(client: MockApiClient.demo(), taskId: "task_2")

        await model.load()
        XCTAssertEqual(model.state.value?.task.status, .backlog)
        XCTAssertEqual(model.availableActions, [.markReady])

        await model.markReady()
        XCTAssertEqual(model.state.value?.task.status, .ready)
        XCTAssertEqual(model.availableActions, [.assign])

        await model.assign(mode: "manual", agentInstanceId: "instance_mock_coder")
        XCTAssertEqual(model.state.value?.task.status, .assigned)
        XCTAssertEqual(model.availableActions, [])
        XCTAssertEqual(model.state.value?.runs.isEmpty, false)
    }

    func testRunsOverviewBuildsFeedFromTaskSnapshots() async {
        let model = RunsOverviewViewModel(client: MockApiClient.demo(), projectId: "proj_artoo")

        await model.load()

        XCTAssertEqual(model.state.value?.count, 1)
        XCTAssertEqual(model.state.value?.first?.run.id, "run_1")
        XCTAssertEqual(model.state.value?.first?.task.id, "task_1")
    }

    func testExecutionGateKeepsReadyTaskUnassignableUntilApproved() async throws {
        let bootstrap = try await MockApiClient.demo().bootstrap()
        let task = TaskItem(id: "task_gate", projectId: "proj_artoo", title: "Reviewed execution", status: .ready)
        let statuses: [ApprovalStatus] = [.pending, .rejected, .needsMoreInfo, .expired, .approved]
        for status in statuses {
            let approval = Approval(id: "approval_gate", taskId: task.id, action: "execution.start", risk: .high, payloadRef: "execution-gate/current", status: status)
            let client = MockApiClient(bootstrap: bootstrap, tasks: [task], snapshots: [task.id: TaskSnapshot(task: task, approvals: [approval])])
            let model = TaskDetailViewModel(client: client, taskId: task.id)
            await model.load()
            XCTAssertEqual(model.state.value?.task.status, .ready)
            XCTAssertEqual(model.executionApproval?.status, status)
            XCTAssertEqual(model.executionBlocked, status != .approved)
            XCTAssertEqual(model.availableActions, status == .approved ? [.assign] : [])
        }
        let consumed = Approval(id: "approval_gate", taskId: task.id, runId: "prior_run", action: "execution.start", risk: .high, payloadRef: "execution-gate/current", status: .approved)
        let client = MockApiClient(bootstrap: bootstrap, tasks: [task], snapshots: [task.id: TaskSnapshot(task: task, approvals: [consumed])])
        let model = TaskDetailViewModel(client: client, taskId: task.id)
        await model.load()
        XCTAssertTrue(model.executionBlocked)
        XCTAssertEqual(model.availableActions, [])
    }

    func testSupersededApprovalHistoryDoesNotBlockTheCurrentApprovedRequest() async throws {
        let bootstrap = try await MockApiClient.demo().bootstrap()
        let task = TaskItem(id: "task_gate", projectId: "proj_artoo", title: "New reviewed execution", status: .ready)
        let previous = Approval(id: "old", taskId: task.id, runId: "prior_run", action: "execution.start", risk: .high, payloadRef: "execution-gate/superseded", status: .approved)
        let current = Approval(id: "new", taskId: task.id, action: "execution.start", risk: .high, payloadRef: "execution-gate/current", status: .approved)
        let client = MockApiClient(bootstrap: bootstrap, tasks: [task], snapshots: [task.id: TaskSnapshot(task: task, approvals: [previous, current])])
        let model = TaskDetailViewModel(client: client, taskId: task.id)
        await model.load()
        XCTAssertEqual(model.executionApproval?.id, "new")
        XCTAssertFalse(model.executionBlocked)
        XCTAssertEqual(model.availableActions, [.assign])
    }

    func testRetryReturnsBlockedTaskToReadyWithoutCreatingARun() async throws {
        let bootstrap = try await MockApiClient.demo().bootstrap()
        let task = TaskItem(id: "task_retry", projectId: "proj_artoo", title: "Retry failed work", status: .blocked)
        let model = TaskDetailViewModel(client: MockApiClient(bootstrap: bootstrap, tasks: [task]), taskId: task.id)
        await model.load()
        await model.retry()
        XCTAssertEqual(model.state.value?.task.status, .ready)
        XCTAssertEqual(model.state.value?.runs.count, 0)
        XCTAssertEqual(model.availableActions, [.assign])
    }

    func testReviewAcceptMovesTaskToDone() async {
        let model = TaskDetailViewModel(client: MockApiClient.demo(), taskId: "task_1")

        await model.load()
        XCTAssertEqual(model.state.value?.task.status, .review)
        XCTAssertEqual(model.availableActions, [.accept, .requestChanges])

        await model.review(accept: true)
        XCTAssertEqual(model.state.value?.task.status, .done)
    }
}
