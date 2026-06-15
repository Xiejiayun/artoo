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

    func testTasksGroupIntoOrderedColumns() async {
        let model = TasksViewModel(client: MockApiClient.demo(), projectId: "proj_artoo")
        await model.load()

        let columns = model.columns
        XCTAssertEqual(columns.count, 2)
        XCTAssertEqual(columns.first?.status, .backlog)
        XCTAssertEqual(columns.first?.tasks.first?.id, "task_2")
        XCTAssertEqual(columns.last?.status, .review)
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

    func testReviewAcceptMovesTaskToDone() async {
        let model = TaskDetailViewModel(client: MockApiClient.demo(), taskId: "task_1")

        await model.load()
        XCTAssertEqual(model.state.value?.task.status, .review)
        XCTAssertEqual(model.availableActions, [.accept, .requestChanges])

        await model.review(accept: true)
        XCTAssertEqual(model.state.value?.task.status, .done)
    }
}
