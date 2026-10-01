import XCTest
@testable import Artoo

private final class TaskExecutionProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (Int, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            guard let handler = Self.handler, let url = request.url else { throw ApiError.transport("Missing test transport") }
            let (status, data) = try handler(request)
            let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

final class TaskExecutionTests: XCTestCase {
    private var session: URLSession!
    private let comment = "  Keep the original report.\nCorrect the café total — 42.\n"

    override func setUp() {
        super.setUp()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [TaskExecutionProtocol.self]
        session = URLSession(configuration: configuration)
    }

    override func tearDown() {
        session.invalidateAndCancel()
        TaskExecutionProtocol.handler = nil
        super.tearDown()
    }

    private func client() -> ApiClient {
        ApiClient(baseURL: URL(string: "https://artoo.example.test")!, session: session, authToken: "test-control")
    }

    func testOlderSnapshotAndArtifactRemainReadableWithoutNewFields() throws {
        let data = Data(#"{"task":{"id":"task_1","project_id":"project_1","title":"Report","status":"ready"},"runs":[],"approvals":[],"artifacts":[{"id":"old","type":"report","uri":"/opaque/stored-blob"}]}"#.utf8)
        let snapshot = try ArtooJSON.decoder().decode(TaskSnapshot.self, from: data)
        XCTAssertEqual(snapshot.reviews, [])
        XCTAssertNil(snapshot.versionCursor)
        XCTAssertNil(snapshot.artifacts[0].metadata)
        XCTAssertEqual(snapshot.artifacts[0].displayName, "Report")
        XCTAssertNil(snapshot.artifacts[0].originatingRun(in: []))
    }

    func testReviewHistoryKeepsExactCommentsAttributionAndLegacyUnknowns() throws {
        let known = Self.review(comment: comment, artifactIds: .strings(["artifact_old", "artifact_fixed"]))
        let legacy: JSONValue = .object([
            "event_id": .string("event_legacy"), "position": .number(4), "task_id": .string("task_1"),
            "outcome": .string("accepted"), "comment": .null,
            "actor": .object(["type": .string("system"), "id": .string("automatic")]),
            "actor_name": .null, "occurred_at": .string("2026-09-30T01:00:00.000Z")
        ])
        let snapshot = try ArtooJSON.decoder().decode(TaskSnapshot.self, from: Self.snapshot(status: "ready", version: 31, reviews: [legacy, known]))
        XCTAssertEqual(snapshot.versionCursor, 31)
        XCTAssertEqual(snapshot.reviews.map(\.eventId), ["event_legacy", "event_review"])
        XCTAssertEqual(snapshot.reviews.map(\.position), [4, 30])
        XCTAssertNil(snapshot.reviews[0].artifactIds, "Missing provenance must not be inferred from other artifacts")
        XCTAssertNil(snapshot.reviews[0].comment)
        XCTAssertEqual(snapshot.reviews[0].reviewerLabel, "System · automatic")
        XCTAssertEqual(snapshot.reviews[1].comment, comment)
        XCTAssertEqual(snapshot.reviews[1].actor, ActorRef(type: "user", id: "reviewer_1"))
        XCTAssertEqual(snapshot.reviews[1].reviewerLabel, "Jia")
        XCTAssertEqual(snapshot.reviews[1].occurredAt, "2026-10-01T01:02:03.456Z")
        XCTAssertEqual(snapshot.reviews[1].artifactIds, ["artifact_old", "artifact_fixed"])
        XCTAssertEqual(snapshot.reviews[1].outcomeLabel, "Changes requested")
        let empty = try ArtooJSON.decoder().decode(TaskReview.self, from: JSONEncoder().encode(Self.review(comment: "", artifactIds: .array([]))))
        XCTAssertEqual(empty.artifactIds, [], "Known empty and legacy unknown are different")
        XCTAssertEqual(empty.comment, "")
    }

    func testArtifactNameAndProvenanceUseMetadataAndExactRunIdentity() throws {
        let data = Data(#"{"id":"artifact_old","run_id":"run_old","type":"file","uri":"/api/v1/artifacts/opaque/content","created_at":"2026-10-01T01:01:02.003Z","metadata":{"filename":"original report.md","bytes":100}}"#.utf8)
        let artifact = try ArtooJSON.decoder().decode(Artifact.self, from: data)
        let runs = [Run(id: "run_fixed", taskId: "task_1", status: .completed, sequence: 3), Run(id: "run_old", taskId: "task_1", status: .completed, sequence: 1)]
        XCTAssertEqual(artifact.displayName, "original report.md")
        XCTAssertEqual(artifact.createdAt, "2026-10-01T01:01:02.003Z")
        XCTAssertEqual(artifact.originatingRun(in: runs)?.id, "run_old")
        XCTAssertEqual(artifact.originatingRun(in: runs)?.displayTitle, "Execution")
        XCTAssertEqual(artifact.uri, "/api/v1/artifacts/opaque/content")
        let unnamed = Artifact(id: "unnamed", type: "test_report", uri: "/private/guess.txt", metadata: .object(["filename": .number(123)]))
        XCTAssertEqual(unnamed.displayName, "Test Report")
        XCTAssertNil(unnamed.originatingRun(in: runs), "A missing run must never fall back to the first run")
        XCTAssertEqual(Run(id: "opaque-long-identity", taskId: "task_1", status: .running).displayTitle, "Execution")
    }

    func testReviewVersionAndWorktreeOptInEncodeWithoutChangingLegacyRequests() throws {
        let review = try JSONDecoder().decode(JSONValue.self, from: ArtooJSON.encoder().encode(ReviewRequest(outcome: "changes_requested", comment: comment, baseVersion: 31)))
        XCTAssertEqual(review["base_version"], .number(31))
        XCTAssertEqual(review["comment"], .string(comment))
        let legacyReview = try JSONDecoder().decode(JSONValue.self, from: ArtooJSON.encoder().encode(ReviewRequest(outcome: "accepted")))
        XCTAssertEqual(legacyReview, .object(["outcome": .string("accepted")]))
        let ordinary = try JSONDecoder().decode(JSONValue.self, from: ArtooJSON.encoder().encode(AssignRequest(mode: "manual", agentInstanceId: "instance_1")))
        XCTAssertEqual(ordinary, .object(["mode": .string("manual"), "agent_instance_id": .string("instance_1")]))
        let isolated = try JSONDecoder().decode(JSONValue.self, from: ArtooJSON.encoder().encode(AssignRequest(mode: "manual", agentInstanceId: "instance_1", branchBacked: true)))
        XCTAssertEqual(isolated["branch_backed"], .bool(true))
    }

    @MainActor
    func testAcceptedReviewSendsLoadedVersionClearsDraftAndHistorySurvivesNewModel() async throws {
        var accepted = false
        var status = "review"
        var submissions = 0
        let exactComment = comment
        TaskExecutionProtocol.handler = { request in
            if request.httpMethod == "GET" {
                return (200, try Self.snapshot(status: status, version: accepted ? 31 : 29, reviews: accepted ? [Self.review(comment: exactComment)] : []))
            }
            XCTAssertEqual(request.url?.path, "/api/v1/tasks/task_1/review")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-control")
            let body = try Self.body(request)
            XCTAssertEqual(body["base_version"], .number(29))
            XCTAssertEqual(body["comment"], .string(exactComment))
            XCTAssertEqual(body["outcome"], .string("changes_requested"))
            submissions += 1; accepted = true; status = "ready"
            return (200, Self.taskResponse(status: status))
        }
        let model = TaskDetailViewModel(client: client(), taskId: "task_1")
        await model.load()
        model.reviewComment = comment
        let succeeded = await model.review(accept: false, comment: comment)
        XCTAssertTrue(succeeded)
        XCTAssertEqual(model.reviewComment, "")
        XCTAssertEqual(model.state.value?.reviews.first?.comment, comment)
        for nextStatus in ["ready", "blocked", "review", "cancelled"] {
            status = nextStatus
            let reopened = TaskDetailViewModel(client: client(), taskId: "task_1")
            await reopened.load()
            XCTAssertEqual(reopened.state.value?.reviews.first?.comment, comment)
            XCTAssertEqual(reopened.state.value?.task.status.rawValue, nextStatus)
        }
        XCTAssertEqual(submissions, 1, "Reloading and reopening must not repeat the review")
    }

    @MainActor
    func testConflictRefreshesSnapshotAndPreservesDraftAndOriginalCommandError() async throws {
        var submitted = false
        let exactComment = comment
        TaskExecutionProtocol.handler = { request in
            if request.httpMethod == "GET" {
                return (200, try Self.snapshot(status: submitted ? "ready" : "review", version: submitted ? 40 : 29, reviews: submitted ? [Self.review(comment: "Another review")] : []))
            }
            XCTAssertEqual(try Self.body(request)["base_version"], .number(29))
            submitted = true
            return (409, Data(#"{"error":{"message":"Task changed since this review was loaded"}}"#.utf8))
        }
        let model = TaskDetailViewModel(client: client(), taskId: "task_1")
        await model.load(); model.reviewComment = exactComment
        let succeeded = await model.review(accept: false, comment: exactComment)
        XCTAssertFalse(succeeded)
        XCTAssertEqual(model.reviewComment, exactComment)
        XCTAssertEqual(model.state.value?.versionCursor, 40)
        XCTAssertEqual(model.state.value?.task.status, .ready)
        XCTAssertEqual(model.state.value?.reviews.first?.comment, "Another review")
        XCTAssertEqual(model.actionError, "HTTP 409: Task changed since this review was loaded")
        XCTAssertFalse(model.actionInFlight)
    }

    @MainActor
    func testReviewCommandOutcomeAndDraftSurviveRefreshFailure() async throws {
        for acceptsCommand in [true, false] {
            var submissions = 0
            TaskExecutionProtocol.handler = { request in
                if request.httpMethod == "GET" {
                    if submissions > 0 { return (503, Data(#"{"error":{"message":"Snapshot unavailable"}}"#.utf8)) }
                    return (200, try Self.snapshot(status: "review", version: 29))
                }
                submissions += 1
                return acceptsCommand ? (200, Self.taskResponse(status: "ready")) : (409, Data(#"{"error":{"message":"Review rejected"}}"#.utf8))
            }
            let model = TaskDetailViewModel(client: client(), taskId: "task_1")
            await model.load(); model.reviewComment = comment
            let succeeded = await model.review(accept: false, comment: comment)
            XCTAssertEqual(succeeded, acceptsCommand)
            XCTAssertEqual(model.reviewComment, acceptsCommand ? "" : comment)
            XCTAssertEqual(model.state.errorMessage, "HTTP 503: Snapshot unavailable")
            XCTAssertEqual(model.actionError, acceptsCommand ? nil : "HTTP 409: Review rejected")
            await model.load()
            XCTAssertEqual(submissions, 1)
        }
    }

    @MainActor
    func testPendingReviewRejectsDuplicateAndDoesNotClearANewerDraft() async throws {
        let arrived = expectation(description: "Review reached transport")
        let release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        var submissions = 0
        TaskExecutionProtocol.handler = { request in
            if request.httpMethod == "GET" { return (200, try Self.snapshot(status: submissions > 0 ? "ready" : "review", version: 29)) }
            submissions += 1
            arrived.fulfill()
            guard release.wait(timeout: .now() + 5) == .success else { throw ApiError.transport("Review response not released") }
            return (200, Self.taskResponse(status: "ready"))
        }
        let model = TaskDetailViewModel(client: client(), taskId: "task_1")
        await model.load(); model.reviewComment = comment
        let submittedComment = comment
        let pending = Task { await model.review(accept: false, comment: submittedComment) }
        await fulfillment(of: [arrived], timeout: 2)
        XCTAssertTrue(model.actionInFlight)
        model.reviewComment = "A newer unsent draft"
        let duplicate = await model.review(accept: true, comment: "duplicate")
        XCTAssertFalse(duplicate)
        XCTAssertTrue(model.actionInFlight)
        release.signal()
        let succeeded = await pending.value
        XCTAssertTrue(succeeded)
        XCTAssertEqual(model.reviewComment, "A newer unsent draft")
        XCTAssertEqual(submissions, 1)
        XCTAssertFalse(model.actionInFlight)
    }

    @MainActor
    func testStopCanBeDismissedAndOnlyCancelsCapturedRun() async throws {
        var paths: [String] = []
        TaskExecutionProtocol.handler = { request in
            if request.httpMethod == "GET" {
                return (200, try Self.snapshot(status: paths.isEmpty ? "running" : "cancelled", runs: [Self.run("old", status: "failed"), Self.run("exact", status: paths.isEmpty ? "running" : "cancelled")]))
            }
            paths.append(request.url!.path)
            return (200, Data("{}".utf8))
        }
        let model = TaskDetailViewModel(client: client(), taskId: "task_1")
        await model.load()
        model.requestStop(runId: "old")
        XCTAssertNil(model.stopConfirmation)
        model.requestStop(runId: "exact")
        XCTAssertEqual(model.stopConfirmation?.id, "exact")
        model.keepRunning()
        XCTAssertNil(model.stopConfirmation)
        XCTAssertEqual(paths, [])
        model.requestStop(runId: "exact")
        await model.cancel(runId: try XCTUnwrap(model.stopConfirmation?.id))
        XCTAssertEqual(paths, ["/api/v1/runs/exact/cancel"])
        XCTAssertEqual(model.state.value?.task.status, .cancelled)
    }

    @MainActor
    func testEndedOrReplacedRunInvalidatesStopWithoutCancellingTheNewRun() async throws {
        for oldRunRemains in [true, false] {
            var refreshed = false
            var cancels = 0
            TaskExecutionProtocol.handler = { request in
                guard request.httpMethod == "GET" else { cancels += 1; return (200, Data("{}".utf8)) }
                let runs = refreshed ? (oldRunRemains ? [Self.run("old", status: "completed"), Self.run("new", status: "running")] : [Self.run("new", status: "running")]) : [Self.run("old", status: "running")]
                return (200, try Self.snapshot(status: "running", runs: runs))
            }
            let model = TaskDetailViewModel(client: client(), taskId: "task_1")
            await model.load(); model.requestStop(runId: "old")
            XCTAssertEqual(model.stopConfirmation?.id, "old")
            refreshed = true; await model.load()
            XCTAssertNil(model.stopConfirmation)
            await model.cancel(runId: "old")
            XCTAssertEqual(cancels, 0)
            XCTAssertEqual(model.state.value?.runs.last?.id, "new")
        }
    }

    @MainActor
    func testWorktreeSelectionReachesProductionAssignmentRequest() async throws {
        var body: JSONValue?
        TaskExecutionProtocol.handler = { request in
            if request.httpMethod == "GET" { return (200, try Self.snapshot(status: "assigned", runs: [Self.run("assigned", status: "queued")])) }
            XCTAssertEqual(request.url?.path, "/api/v1/tasks/task_1/assign")
            body = try Self.body(request)
            return (200, Data(#"{"run":{"id":"assigned","task_id":"task_1","status":"queued"},"scheduler_decision":{"id":"decision_1","reason":"Selected instance","score":1}}"#.utf8))
        }
        let model = TaskDetailViewModel(client: client(), taskId: "task_1")
        let succeeded = await model.assign(mode: "manual", agentInstanceId: "isolated_instance", branchBacked: true)
        XCTAssertTrue(succeeded)
        XCTAssertEqual(body?["branch_backed"], .bool(true))
        XCTAssertEqual(body?["agent_instance_id"], .string("isolated_instance"))
        XCTAssertEqual(model.state.value?.runs.first?.id, "assigned")
    }

    private static func review(comment: String, artifactIds: JSONValue = .strings(["artifact_old"])) -> JSONValue {
        .object(["event_id": .string("event_review"), "position": .number(30), "task_id": .string("task_1"),
                 "outcome": .string("changes_requested"), "comment": .string(comment),
                 "actor": .object(["type": .string("user"), "id": .string("reviewer_1")]), "actor_name": .string("Jia"),
                 "occurred_at": .string("2026-10-01T01:02:03.456Z"), "artifact_ids": artifactIds])
    }

    private static func run(_ id: String, status: String) -> JSONValue {
        .object(["id": .string(id), "task_id": .string("task_1"), "status": .string(status)])
    }

    private static func snapshot(status: String, version: Int? = nil, reviews: [JSONValue] = [], runs: [JSONValue] = []) throws -> Data {
        var value: [String: JSONValue] = [
            "task": .object(["id": .string("task_1"), "project_id": .string("project_1"), "title": .string("Report"), "status": .string(status)]),
            "runs": .array(runs), "approvals": .array([]), "artifacts": .array([]), "reviews": .array(reviews)
        ]
        if let version { value["version_cursor"] = .number(Double(version)) }
        return try JSONEncoder().encode(JSONValue.object(value))
    }

    private static func taskResponse(status: String) -> Data {
        Data("{\"task\":{\"id\":\"task_1\",\"project_id\":\"project_1\",\"title\":\"Report\",\"status\":\"\(status)\"}}".utf8)
    }

    private static func body(_ request: URLRequest) throws -> JSONValue {
        if let data = request.httpBody { return try JSONDecoder().decode(JSONValue.self, from: data) }
        guard let stream = request.httpBodyStream else { throw ApiError.decoding("Missing request body") }
        stream.open(); defer { stream.close() }
        var data = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return try JSONDecoder().decode(JSONValue.self, from: data)
    }
}
