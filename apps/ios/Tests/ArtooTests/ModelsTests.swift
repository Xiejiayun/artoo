import XCTest
@testable import Artoo

final class ModelsTests: XCTestCase {
    private let decoder = ArtooJSON.decoder()

    func testDecodesTaskListWithSnakeCaseKeys() throws {
        let json = """
        {
          "tasks": [
            {
              "id": "task_1",
              "project_id": "proj_artoo",
              "room_id": "room_1",
              "title": "Build inbox",
              "description": "Approvals-first surface",
              "status": "review",
              "priority": "p1",
              "acceptance_criteria": ["lists approvals", "resolve works"],
              "created_at": "2026-06-15T20:00:00.000Z",
              "updated_at": "2026-06-15T20:05:00.000Z"
            }
          ]
        }
        """
        let response = try decoder.decode(TasksResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.tasks.count, 1)
        let task = try XCTUnwrap(response.tasks.first)
        XCTAssertEqual(task.id, "task_1")
        XCTAssertEqual(task.projectId, "proj_artoo")
        XCTAssertEqual(task.roomId, "room_1")
        XCTAssertEqual(task.status, .review)
        XCTAssertEqual(task.acceptanceCriteria, ["lists approvals", "resolve works"])
    }

    func testDecodesTaskSnapshot() throws {
        let json = """
        {
          "task": {
            "id": "task_1",
            "project_id": "proj_artoo",
            "title": "Build inbox",
            "status": "assigned"
          },
          "room": { "id": "room_1", "task_id": "task_1", "type": "task", "name": "Inbox" },
          "runs": [
            {
              "id": "run_1",
              "task_id": "task_1",
              "status": "completed",
              "failure_reason": null,
              "started_at": "2026-06-15T20:01:00.000Z",
              "ended_at": "2026-06-15T20:02:00.000Z",
              "sequence": 4
            }
          ],
          "approvals": [
            { "id": "appr_1", "task_id": "task_1", "action": "merge", "risk": "medium", "status": "pending" }
          ],
          "artifacts": [
            { "id": "art_1", "task_id": "task_1", "type": "pull_request", "uri": "https://x/pr/1" }
          ]
        }
        """
        let snapshot = try decoder.decode(TaskSnapshot.self, from: Data(json.utf8))
        XCTAssertEqual(snapshot.task.status, .assigned)
        XCTAssertEqual(snapshot.room?.id, "room_1")
        XCTAssertEqual(snapshot.room?.name, "Inbox")
        XCTAssertEqual(snapshot.runs.first?.status, .completed)
        XCTAssertEqual(snapshot.runs.first?.sequence, 4)
        XCTAssertEqual(snapshot.runs.first?.endedAt, "2026-06-15T20:02:00.000Z")
        XCTAssertEqual(snapshot.approvals.first?.risk, .medium)
        XCTAssertEqual(snapshot.artifacts.first?.type, "pull_request")
    }

    func testUnknownStatusFallsBackToOtherInsteadOfThrowing() throws {
        let json = """
        { "id": "task_x", "project_id": "p", "title": "t", "status": "quantum_superposition" }
        """
        let task = try decoder.decode(TaskItem.self, from: Data(json.utf8))
        XCTAssertEqual(task.status, .other("quantum_superposition"))
        XCTAssertEqual(task.status.label, "Quantum_superposition")
    }

    func testEncodesCreateTaskRequestAsSnakeCase() throws {
        let request = CreateTaskRequest(
            projectId: "proj_artoo",
            title: "New",
            description: "desc",
            priority: "p1",
            acceptanceCriteria: ["one"]
        )
        let data = try ArtooJSON.encoder().encode(request)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["project_id"] as? String, "proj_artoo")
        XCTAssertEqual(object["title"] as? String, "New")
        XCTAssertEqual(object["priority"] as? String, "p1")
        XCTAssertNotNil(object["acceptance_criteria"], "camelCase property must serialize to snake_case key")
    }

    func testRiskAndRunStatusDecodeKnownValues() throws {
        XCTAssertEqual(try decoder.decode(RiskLevel.self, from: Data("\"high\"".utf8)), .high)
        XCTAssertEqual(try decoder.decode(RunStatus.self, from: Data("\"running\"".utf8)), .running)
        XCTAssertEqual(try decoder.decode(ApprovalStatus.self, from: Data("\"approved\"".utf8)), .approved)
    }
}
