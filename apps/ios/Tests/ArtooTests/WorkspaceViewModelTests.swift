import XCTest
@testable import Artoo

@MainActor
final class WorkspaceViewModelTests: XCTestCase {
    func testFinalDiscussionRefreshDuringAnOlderLoadIsRetainedAndCoalesced() async {
        let stale = DeferredWorkspaceResponse()
        let latest = discussion(status: "ready", step: 3)
        var fetches = 0
        let client = WorkspaceTestClient { path in
            XCTAssertEqual(path, "/api/v1/goals/goal/discussions")
            fetches += 1
            if fetches == 1 { return try await stale.response() }
            return latest
        }
        let model = WorkspaceViewModel(client: client, path: "/api/v1/goals/goal/discussions")
        let directLoad = Task { await model.load() }
        await fulfillment(of: [stale.started], timeout: 2)

        // The direct load is outside LiveRefresh's coordinator. Realtime
        // invalidations must still survive while its old response is pending.
        let requested = expectation(description: "Final refresh requests entered the model")
        requested.expectedFulfillmentCount = 3
        let refreshes = (0..<3).map { _ in Task {
            requested.fulfill()
            await model.load()
        } }
        await fulfillment(of: [requested], timeout: 2)
        XCTAssertEqual(fetches, 1, "Overlapping refreshes must not start parallel GETs")
        stale.resolve(.success(discussion(status: "running", step: 2)))
        await directLoad.value
        for refresh in refreshes { await refresh.value }

        XCTAssertEqual(fetches, 2, "The last invalidation must trigger one fresh GET after the old snapshot")
        XCTAssertEqual(model.state.value, latest)
        XCTAssertNil(model.state.errorMessage)
    }

    func testQueuedRefreshStillRunsAfterTheOldRequestFailsOrItsCallerIsCancelled() async {
        let stale = DeferredWorkspaceResponse()
        let latest = discussion(status: "ready", step: 3)
        var fetches = 0
        let client = WorkspaceTestClient { _ in
            fetches += 1
            if fetches == 1 { return try await stale.response() }
            XCTAssertFalse(Task.isCancelled, "One departed caller cannot cancel another caller's pending refresh")
            return latest
        }
        let model = WorkspaceViewModel(client: client, path: "/api/v1/goals/goal/discussions")
        let directLoad = Task { await model.load() }
        await fulfillment(of: [stale.started], timeout: 2)
        let requested = expectation(description: "The final refresh entered the model")
        let refresh = Task {
            requested.fulfill()
            await model.load()
        }
        await fulfillment(of: [requested], timeout: 2)
        directLoad.cancel()
        stale.resolve(.failure(URLError(.networkConnectionLost)))
        await directLoad.value
        await refresh.value

        XCTAssertEqual(fetches, 2)
        XCTAssertEqual(model.state.value, latest)
        XCTAssertNil(model.state.errorMessage)
    }

    private func discussion(status: String, step: Int) -> JSONValue {
        .object(["discussions": .array([.object([
            "id": .string("discussion"), "status": .string(status),
            "current_step": .number(Double(step)), "total_steps": .number(3)
        ])])])
    }
}

@MainActor
private final class DeferredWorkspaceResponse {
    let started = XCTestExpectation(description: "An older request is in flight")
    private var continuation: CheckedContinuation<JSONValue, Error>?
    func response() async throws -> JSONValue {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            started.fulfill()
        }
    }
    func resolve(_ result: Result<JSONValue, Error>) {
        continuation?.resume(with: result)
        continuation = nil
    }
}

@MainActor
private final class WorkspaceTestClient: ApiClientProtocol {
    // This deterministic fixture has no moderated content.
    public func messageVisibility(roomId: String, messageIds: [String]) async throws -> [String] { [] }
    private let resourceHandler: @MainActor (String) async throws -> JSONValue
    private let preview = MockApiClient.demo()
    init(resource: @escaping @MainActor (String) async throws -> JSONValue) { resourceHandler = resource }
    func resource(path: String) async throws -> JSONValue { try await resourceHandler(path) }
    func bootstrap() async throws -> Bootstrap { try await preview.bootstrap() }
    func listTasks(projectId: String) async throws -> [TaskItem] { try await preview.listTasks(projectId: projectId) }
    func createTask(projectId: String, request: CreateTaskRequest) async throws -> TaskResponse { try await preview.createTask(projectId: projectId, request: request) }
    func getTask(taskId: String) async throws -> TaskSnapshot { try await preview.getTask(taskId: taskId) }
    func markReady(taskId: String) async throws -> TaskResponse { try await preview.markReady(taskId: taskId) }
    func assign(taskId: String, request: AssignRequest) async throws -> AssignResponse { try await preview.assign(taskId: taskId, request: request) }
    func retry(taskId: String) async throws -> TaskResponse { try await preview.retry(taskId: taskId) }
    func review(taskId: String, request: ReviewRequest) async throws -> TaskResponse { try await preview.review(taskId: taskId, request: request) }
    func listRuns(taskId: String) async throws -> [Run] { try await preview.listRuns(taskId: taskId) }
    func getRun(runId: String) async throws -> Run { try await preview.getRun(runId: runId) }
    func listApprovals(status: String?) async throws -> [Approval] { try await preview.listApprovals(status: status) }
    func resolveApproval(approvalId: String, request: ResolveApprovalRequest) async throws -> Approval { try await preview.resolveApproval(approvalId: approvalId, request: request) }
    func listMessages(roomId: String) async throws -> [Message] { try await preview.listMessages(roomId: roomId) }
}
