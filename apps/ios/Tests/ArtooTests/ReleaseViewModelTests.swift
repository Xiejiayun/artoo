import XCTest
@testable import Artoo

@MainActor
final class ReleaseViewModelTests: XCTestCase {
    func testStopDoesNotWaitForStatusAndOlderGetCannotUndoConfirmedClosure() async throws {
        let client = PublicationRaceClient()
        let model = ReleaseViewModel(client: client, goalId: "goal", kind: .application)
        await model.load()
        let oldRead = Task { await model.load() }
        await fulfillment(of: [client.readStarted], timeout: 2)
        await model.stop()
        XCTAssertFalse(model.canStop)
        XCTAssertEqual(model.publication["current_state"], .string("closed-normal"))
        client.finishOldRead()
        await oldRead.value
        XCTAssertEqual(model.publication["current_state"], .string("closed-normal"))
        XCTAssertNil(model.stopError)
    }
}

@MainActor
private final class PublicationRaceClient: ApiClientProtocol {
    let readStarted = XCTestExpectation(description: "Status GET is suspended")
    private let preview = MockApiClient.demo()
    private var reads = 0
    private var continuation: CheckedContinuation<JSONValue, Never>?
    private func snapshot(_ state: String) -> JSONValue {
        .object(["publication": .object(["id": .string("publication"), "goal_id": .string("goal"), "status": .string("published"),
            "current_state": .string(state), "latest_observation": state == "closed-normal" ? .object(["closure": .object([:])]) : .null])])
    }
    func resource(path: String) async throws -> JSONValue {
        reads += 1
        if reads == 1 { return snapshot("healthy") }
        return await withCheckedContinuation { continuation in self.continuation = continuation; readStarted.fulfill() }
    }
    func finishOldRead() { continuation?.resume(returning: snapshot("healthy")); continuation = nil }
    func command(path: String, method: String, body: JSONValue) async throws -> JSONValue {
        XCTAssertEqual(path, "/api/v1/goals/goal/application-publication/stop")
        XCTAssertEqual(method, "POST")
        return snapshot("closed-normal")
    }
    func messageVisibility(roomId: String, messageIds: [String]) async throws -> [String] { [] }
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
