import XCTest
@testable import Artoo

final class NativeConnectionTests: XCTestCase {
    func testProductionStartsDisconnectedWithoutMockFallback() async {
        await MainActor.run {
            let container = AppContainer(config: AppConfig(), credentials: MemoryCredentials())
            XCTAssertFalse(container.config.useMock)
            XCTAssertFalse(container.isAuthenticated)
            XCTAssertTrue(container.client is ApiClient)
        }
    }

    func testServerOriginPolicyRejectsCredentialAndPathInjection() throws {
        XCTAssertEqual(try ServerAddress.validate(" https://team.example.com ").host, "team.example.com")
        XCTAssertNoThrow(try ServerAddress.validate("http://computer.local:4000", allowLocalHTTP: true))
        for invalid in ["http://team.example.com", "https://user:secret@team.example.com", "https://team.example.com/api",
                        "https://team.example.com?token=secret", "https://team.example.com#token", "file:///tmp/token", "//team.example.com"] {
            XCTAssertThrowsError(try ServerAddress.validate(invalid), invalid)
        }
        XCTAssertThrowsError(try ServerAddress.validate("http://localhost:4000"))
        XCTAssertThrowsError(try ServerAddress.validate("http://team.example.com", allowLocalHTTP: true))
    }

    func testSessionRoleAndDeviceClaimDecodeWithoutRetainingNodeCredential() throws {
        let session = try ArtooJSON.decoder().decode(SessionIdentity.self, from: Data(#"{"user":{"id":"u","email":"owner@example.com","name":"Owner","role":"owner"},"device_id":"device_1"}"#.utf8))
        XCTAssertTrue(session.isAdministrator)
        XCTAssertEqual(session.deviceId, "device_1")
        let claim = try ArtooJSON.decoder().decode(PairingClaim.self, from: Data(#"{"device":{"id":"device_1"},"control_token":"control-secret","node_token":"compute-secret"}"#.utf8))
        XCTAssertEqual(claim.controlToken, "control-secret")
        XCTAssertEqual(claim.device.id, "device_1")
    }

    func testExtensibleRecordsPreserveServerSnakeCaseKeysAndUnknownFields() throws {
        let response = try ArtooJSON.decoder().decode(JSONValue.self, from: Data(#"{"goals":[{"id":"goal_1","current_plan_id":"plan_1","title":"Ship","status":"running","future_field":{"retry_count":2}}]}"#.utf8))
        let goal = try XCTUnwrap(response["goals"].records.first)
        XCTAssertEqual(goal["current_plan_id"].text, "plan_1")
        XCTAssertEqual(goal["future_field"]["retry_count"].text, "2")
        XCTAssertEqual(goal.title, "Ship")
    }

    func testPlanTasksCarryServerDependencyTypeAndNonemptyAcceptanceCriteria() throws {
        var draft = PlanTaskDraft()
        XCTAssertFalse(draft.valid)
        draft.title = "Implement"; draft.criteria = " Tests pass \n \n API works "; draft.afterPrevious = true
        XCTAssertTrue(draft.valid)
        let spec = draft.spec(index: 2)
        XCTAssertEqual(spec["acceptance_criteria"].array.map(\.text), ["Tests pass", "API works"])
        XCTAssertEqual(spec["dependencies"].array.first?["ref"].text, "1")
        XCTAssertEqual(spec["dependencies"].array.first?["type"].text, "blocks")
        XCTAssertTrue(draft.spec(index: 0)["dependencies"].array.isEmpty)
    }

    func testApiComponentsCannotInjectQueryOrPathSegments() {
        XCTAssertEqual(apiPart("task/a?x=1&y=2"), "task%2Fa%3Fx%3D1%26y%3D2")
    }

    func testExecutionApprovalDraftRequiresSummaryAndServerRiskVocabulary() {
        var draft = ExecutionApprovalDraft()
        XCTAssertFalse(draft.valid)
        draft.summary = " Review deployment permissions \n"; draft.risk = "high"
        XCTAssertTrue(draft.valid)
        XCTAssertEqual(draft.body["summary"].text, "Review deployment permissions")
        XCTAssertEqual(draft.body["risk"].text, "high")
        draft.risk = "critical"; XCTAssertFalse(draft.valid)
        draft.risk = "low"; draft.summary = String(repeating: "x", count: 4001); XCTAssertFalse(draft.valid)
    }

    func testKeychainRoundTripAndRevocationClearsOnlyTestCredential() throws {
        let store = KeychainCredentialStore(service: "dev.artoo.test.\(UUID().uuidString)")
        defer { try? store.clear() }
        XCTAssertNil(try store.load())
        let connection = StoredConnection(serverURL: "https://team.example.com", controlToken: "test-control", deviceId: "device_test")
        try store.save(connection)
        XCTAssertEqual(try store.load(), connection)
        try store.clear()
        XCTAssertNil(try store.load())
    }
}

private final class MemoryCredentials: CredentialStore {
    private var value: StoredConnection?
    func load() throws -> StoredConnection? { value }
    func save(_ connection: StoredConnection) throws { value = connection }
    func clear() throws { value = nil }
}
