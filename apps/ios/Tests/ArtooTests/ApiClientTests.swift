import XCTest
@testable import Artoo

private final class APIProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (Int, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            guard let handler = Self.handler, let url = request.url else { throw ApiError.transport("No test handler") }
            let (status, data) = try handler(request)
            let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

final class ApiClientTests: XCTestCase {
    private var session: URLSession!
    override func setUp() {
        super.setUp()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [APIProtocol.self]
        session = URLSession(configuration: configuration)
    }
    override func tearDown() { session.invalidateAndCancel(); APIProtocol.handler = nil; super.tearDown() }
    private func client(token: String? = "control-secret") -> ApiClient {
        ApiClient(baseURL: URL(string: "https://team.example.com")!, session: session, authToken: token)
    }

    func testNativeSessionUsesBearerAndNoTokenInURL() async throws {
        APIProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/auth/session")
            XCTAssertNil(request.url?.query)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer control-secret")
            return (200, Data(#"{"user":{"id":"u","email":"e@example.com","name":"User","role":"member"},"device_id":"d"}"#.utf8))
        }
        let identity = try await client().currentSession()
        XCTAssertEqual(identity.deviceId, "d")
        XCTAssertFalse(identity.isAdministrator)
    }

    func testPairingDoesNotTransmitAnExistingBearerOrPersistNodeToken() async throws {
        APIProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/v1/devices/claim")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            XCTAssertNil(request.value(forHTTPHeaderField: "Idempotency-Key"))
            let body = try Self.body(request)
            XCTAssertEqual(body["platform"].text, "ios")
            XCTAssertEqual(body["code"].text, "ABCD-EFGH")
            XCTAssertEqual(body["display_name"].text, "Phone")
            return (201, Data(#"{"device":{"id":"d"},"control_token":"new-secret","node_token":"ignored-node"}"#.utf8))
        }
        let claim = try await client().claimPairing(code: "ABCD-EFGH", displayName: "Phone")
        XCTAssertEqual(claim.controlToken, "new-secret")
    }

    func testMutationKeepsWireKeysAndLogoutHandles204() async throws {
        APIProtocol.handler = { request in
            if request.url?.path == "/auth/logout" {
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer control-secret")
                return (204, Data())
            }
            XCTAssertNotNil(request.value(forHTTPHeaderField: "Idempotency-Key"))
            let body = try Self.body(request)
            XCTAssertEqual(body["depends_on_task_id"].text, "task_1")
            return (201, Data(#"{"dependency":{"id":"dep_1"}}"#.utf8))
        }
        let result = try await client().command(path: "/api/v1/tasks/task_2/dependencies", body: .object(["depends_on_task_id": .string("task_1"), "type": .string("blocks")]))
        XCTAssertEqual(result["dependency"]["id"].text, "dep_1")
        try await client().logout()
    }

    func testUnauthenticatedResponseNotifiesAppAndPreservesActionError() async throws {
        let expired = expectation(forNotification: .artooAuthenticationExpired, object: nil)
        APIProtocol.handler = { _ in (401, Data(#"{"error":{"message":"authentication required"}}"#.utf8)) }
        do { _ = try await client().currentSession(); XCTFail("Expired bearer must fail") }
        catch let error as ApiError { XCTAssertEqual(error, .http(status: 401, body: "authentication required")) }
        await fulfillment(of: [expired], timeout: 1)
    }

    func testRefusesCrossOriginResourceBeforeNetworkRequest() async {
        APIProtocol.handler = { _ in XCTFail("Must not reach the network"); return (200, Data()) }
        do { _ = try await client().resource(path: "//attacker.example/api"); XCTFail("Cross-origin URL must fail") }
        catch { XCTAssertTrue(error is ApiError) }
    }

    @MainActor
    func testFailedWorkspaceCommandRetainsLoadedDataAndReportsFailure() async {
        APIProtocol.handler = { request in
            if request.httpMethod == "GET" { return (200, Data(#"{"goals":[{"id":"goal_1","title":"Ship","status":"running"}]}"#.utf8)) }
            return (409, Data(#"{"error":{"message":"The execution computer is offline"}}"#.utf8))
        }
        let model = WorkspaceViewModel(client: client(), path: "/api/v1/goals")
        await model.load()
        XCTAssertEqual(model.state.value?["goals"].records.first?.id, "goal_1")
        let succeeded = await model.perform(path: "/api/v1/goals/goal_1/pause")
        XCTAssertFalse(succeeded)
        XCTAssertEqual(model.state.value?["goals"].records.first?.id, "goal_1")
        XCTAssertTrue(model.actionError?.contains("offline") == true)
        XCTAssertFalse(model.busy)
    }

    @MainActor
    func testFailedApprovalResolutionReturnsFalseInsteadOfDismissingTheDecision() async {
        APIProtocol.handler = { _ in (409, Data(#"{"error":{"message":"Approval already resolved"}}"#.utf8)) }
        let model = InboxViewModel(client: client())
        let approval = Approval(id: "approval_1", action: "Merge", risk: .high, status: .pending)
        let succeeded = await model.resolve(approval, approve: true)
        XCTAssertFalse(succeeded)
        XCTAssertTrue(model.state.errorMessage?.contains("already resolved") == true)
        XCTAssertFalse(model.isResolving(approval))
    }

    @MainActor
    func testExecutionApprovalRequestUsesReadyTaskRouteAndPreservesFailure() async throws {
        var rejectRequest = true
        var requested = false
        APIProtocol.handler = { request in
            if request.httpMethod == "GET" {
                let approvals = requested ? #"[{"id":"approval_gate","task_id":"task_1","action":"execution.start","risk":"high","summary":"Review deployment","payload_ref":"execution-gate/current","status":"pending"}]"# : "[]"
                return (200, Data("{\"task\":{\"id\":\"task_1\",\"project_id\":\"proj_artoo\",\"title\":\"Deploy\",\"status\":\"ready\"},\"runs\":[],\"approvals\":\(approvals),\"artifacts\":[]}".utf8))
            }
            XCTAssertEqual(request.url?.path, "/api/v1/tasks/task_1/execution-approval")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer control-secret")
            XCTAssertNotNil(request.value(forHTTPHeaderField: "Idempotency-Key"))
            let body = try Self.body(request)
            XCTAssertEqual(body["summary"].text, "Review deployment")
            XCTAssertEqual(body["risk"].text, "high")
            if rejectRequest { return (409, Data(#"{"error":{"message":"Task changed; refresh before reviewing"}}"#.utf8)) }
            requested = true
            return (201, Data(#"{"approval":{"id":"approval_gate","action":"execution.start","status":"pending"}}"#.utf8))
        }
        let model = TaskDetailViewModel(client: client(), taskId: "task_1")
        await model.load()
        var draft = ExecutionApprovalDraft(); draft.summary = " Review deployment \n"; draft.risk = "high"
        let failed = await model.requestExecutionApproval(draft)
        XCTAssertFalse(failed)
        XCTAssertEqual(model.state.value?.task.status, .ready)
        XCTAssertTrue(model.actionError?.contains("Task changed") == true)
        XCTAssertFalse(model.actionInFlight)
        rejectRequest = false
        let succeeded = await model.requestExecutionApproval(draft)
        XCTAssertTrue(succeeded)
        XCTAssertEqual(model.executionApproval?.status, .pending)
        XCTAssertEqual(model.state.value?.task.status, .ready)
        XCTAssertEqual(model.availableActions, [])
    }

    @MainActor
    func testSuccessfulAssignmentDecodesRunEnvelopeAndReloadsAssignedTask() async throws {
        let fixtureURL = try XCTUnwrap(Bundle(for: ApiClientTests.self).url(forResource: "assignment-response", withExtension: "json"))
        let fixtureData = try Data(contentsOf: fixtureURL)
        let fixture = try JSONDecoder().decode(JSONValue.self, from: fixtureData)
        let decoded = try ArtooJSON.decoder().decode(AssignResponse.self, from: fixtureData)
        XCTAssertEqual(decoded.run.id, "run_assigned")
        XCTAssertEqual(decoded.schedulerDecision.id, "decision_1")
        XCTAssertEqual(decoded.schedulerDecision.score, 42)
        var assigned = false
        APIProtocol.handler = { request in
            if request.httpMethod == "GET" {
                let snapshot = JSONValue.object([
                    "task": .object(["id": .string("task_1"), "project_id": .string("proj_artoo"), "title": .string("Implement"), "status": .string(assigned ? "assigned" : "ready")]),
                    "runs": .array(assigned ? [fixture["run"]] : []), "approvals": .array([]), "artifacts": .array([])
                ])
                return (200, try JSONEncoder().encode(snapshot))
            }
            XCTAssertEqual(request.url?.path, "/api/v1/tasks/task_1/assign")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer control-secret")
            let body = try Self.body(request)
            XCTAssertEqual(body["mode"].text, "manual")
            XCTAssertEqual(body["agent_instance_id"].text, "instance_1")
            assigned = true
            return (200, fixtureData)
        }
        let model = TaskDetailViewModel(client: client(), taskId: "task_1")
        await model.load()
        await model.assign(mode: "manual", agentInstanceId: "instance_1")
        XCTAssertNil(model.actionError)
        XCTAssertEqual(model.state.value?.task.status, .assigned)
        XCTAssertEqual(model.state.value?.runs.first?.id, "run_assigned")
        XCTAssertFalse(model.actionInFlight)
    }

    private static func body(_ request: URLRequest) throws -> JSONValue {
        if let data = request.httpBody { return try JSONDecoder().decode(JSONValue.self, from: data) }
        guard let stream = request.httpBodyStream else { throw ApiError.decoding("Missing test body") }
        stream.open(); defer { stream.close() }
        var data = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable { let count = stream.read(&buffer, maxLength: buffer.count); if count <= 0 { break }; data.append(buffer, count: count) }
        return try JSONDecoder().decode(JSONValue.self, from: data)
    }
}
