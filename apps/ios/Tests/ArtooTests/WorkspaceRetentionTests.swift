import XCTest
@testable import Artoo

final class WorkspaceRetentionTests: XCTestCase {
    private let root = " /tmp/工作/cafe\u{0301}/$(not-a-command);'\n "
    private let branch = "artoo/run-cafe\u{0301}"

    private var report: [String: Any] {
        ["version": 1, "workspace_root": root, "workspace_branch": branch,
         "outcome": "completed", "reporter_computer_id": "computer_1", "event_id": "event_1",
         "position": 24, "sequence": 3, "reported_at": "2026-10-01T11:12:13.123Z"]
    }

    private func decode(_ report: Any? = nil, run overrides: [String: Any] = [:]) throws -> Run {
        var object: [String: Any] = ["id": "run_1", "task_id": "task_1", "status": "failed",
                                     "computer_id": "computer_1", "workspace_root": root, "workspace_branch": branch]
        if let report { object["workspace_retention"] = report }
        object.merge(overrides) { _, new in new }
        return try ArtooJSON.decoder().decode(Run.self, from: JSONSerialization.data(withJSONObject: object))
    }

    func testLegacyMissingAndNullRetentionRemainUnknownWithPlannedIdentity() throws {
        for value in [nil, NSNull()] as [Any?] {
            let run = try decode(value)
            XCTAssertNil(run.workspaceRetention)
            XCTAssertEqual(run.status, .failed)
            let details = RunWorkspaceDetails(run: run)
            XCTAssertEqual(details.heading, "Retention not reported")
            XCTAssertEqual(details.workspaceLabel, "Planned workspace")
            XCTAssertTrue(try XCTUnwrap(details.workspaceRoot).utf8.elementsEqual(root.utf8))
        }
        let old = try ArtooJSON.decoder().decode(Run.self, from: Data(#"{"id":"old","task_id":"t","status":"completed"}"#.utf8))
        XCTAssertNil(old.workspaceRoot); XCTAssertNil(old.workspaceBranch); XCTAssertNil(old.workspaceRetention)
    }

    func testMalformedUnknownAndIncompleteReportsDoNotLoseTheRun() throws {
        var invalid: [Any] = ["legacy output: retained", 1, false, [], [:]]
        for (key, value) in [("version", 2), ("version", "1"), ("outcome", "deleted"), ("outcome", NSNull())] as [(String, Any)] {
            var copy = report; copy[key] = value; invalid.append(copy)
        }
        for key in report.keys { var copy = report; copy.removeValue(forKey: key); invalid.append(copy) }
        var extra = report; extra["exists_now"] = true; invalid.append(extra)
        var alias = report; alias["workspaceRoot"] = alias.removeValue(forKey: "workspace_root"); invalid.append(alias)
        for value in invalid {
            let run = try decode(value)
            XCTAssertEqual(run.id, "run_1"); XCTAssertEqual(run.status, .failed)
            XCTAssertNil(run.workspaceRetention, "Malformed metadata must degrade to unknown")
        }
    }

    func testAllOutcomesRoundTripWithoutReplacingAuthoritativeRunStatus() throws {
        for outcome in WorkspaceRetention.Outcome.allCases {
            var payload = report; payload["outcome"] = outcome.rawValue
            let run = try decode(payload, run: ["organization_id": "org", "agent_instance_id": "ai", "runtime_id": "rt",
                                              "scheduler_decision_id": "s", "model_profile_id": "m", "effort_profile_id": "e",
                                              "context_pack_id": "ctx", "started_at": "start", "ended_at": "end",
                                              "failure_reason": "delivery failed", "sequence": 5, "created_at": "created"])
            XCTAssertEqual(run.status, .failed)
            XCTAssertEqual(run.workspaceRetention?.outcome, outcome)
            let encoded = try ArtooJSON.encoder().encode(run)
            let decoded = try ArtooJSON.decoder().decode(Run.self, from: encoded)
            XCTAssertEqual(decoded, run)
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
            let saved = try XCTUnwrap(object["workspace_retention"] as? [String: Any])
            XCTAssertEqual(saved["reported_at"] as? String, payload["reported_at"] as? String)
            XCTAssertEqual(Set(saved.keys), Set(payload.keys))
        }
    }

    func testSafeIntegerBoundsRejectBooleanFractionalNegativeAndOverflowIdentity() throws {
        for key in ["position", "sequence"] {
            for value in [true, "3", 1.5, -1, 9_007_199_254_740_992.0] as [Any] {
                var payload = report; payload[key] = value
                XCTAssertNil(try decode(payload).workspaceRetention, "\(key): \(value)")
            }
            var maximum = report; maximum[key] = 9_007_199_254_740_991.0
            XCTAssertNotNil(try decode(maximum).workspaceRetention)
        }
        var zero = report; zero["position"] = 0; XCTAssertNil(try decode(zero).workspaceRetention)
        zero = report; zero["sequence"] = 0; XCTAssertEqual(try decode(zero).workspaceRetention?.sequence, 0)
        zero = report; zero["version"] = true; XCTAssertNil(try decode(zero).workspaceRetention)
    }

    func testStringBoundsUseWireUTF16LengthAndPreserveExactPath() throws {
        for (key, maximum) in [("workspace_root", 4096), ("workspace_branch", 1024), ("reporter_computer_id", 256), ("event_id", 256)] {
            for bad in ["", String(repeating: "x", count: maximum + 1), String(repeating: "😀", count: maximum / 2 + 1)] {
                var payload = report; payload[key] = bad
                var identity: [String: Any] = [:]
                if key == "reporter_computer_id" { identity["computer_id"] = bad }
                else if key != "event_id" { identity[key] = bad }
                XCTAssertNil(try decode(payload, run: identity).workspaceRetention, key)
            }
            let valid = String(repeating: "😀", count: maximum / 2)
            var payload = report; payload[key] = valid
            var identity: [String: Any] = [:]
            if key == "reporter_computer_id" { identity["computer_id"] = valid }
            else if key != "event_id" { identity[key] = valid }
            XCTAssertNotNil(try decode(payload, run: identity).workspaceRetention, key)
        }
        for key in ["workspace_root", "workspace_branch"] {
            var payload = report; payload[key] = "path\0suffix"
            XCTAssertNil(try decode(payload, run: [key: "path\0suffix"]).workspaceRetention)
        }
        for bad in [" branch", "branch\n", "\u{FEFF}branch", "branch\u{00A0}"] {
            var payload = report; payload["workspace_branch"] = bad
            XCTAssertNil(try decode(payload, run: ["workspace_branch": bad]).workspaceRetention)
        }
    }

    func testCalendarValidationMatchesUTCWireDatesWithoutInventingFreshnessLimit() throws {
        for valid in ["0000-02-29T00:00Z", "2000-02-29T23:59:59Z", "2026-10-01T11:12Z",
                      "2026-10-01T11:12:13.123456789Z", "9999-12-31T23:59:59Z"] {
            var payload = report; payload["reported_at"] = valid
            XCTAssertEqual(try decode(payload).workspaceRetention?.reportedAt, valid)
        }
        for bad in ["2026-02-29T00:00Z", "1900-02-29T00:00Z", "2026-04-31T00:00Z", "2026-13-01T00:00Z",
                    "2026-10-01T24:00Z", "2026-10-01T11:60Z", "2026-10-01T11:12:60Z", "2026-10-01T11:12:13+00:00",
                    "2026-10-01 11:12:13Z", "2026-10-01T11:12:13Z\n", "not a date"] {
            var payload = report; payload["reported_at"] = bad
            XCTAssertNil(try decode(payload).workspaceRetention, bad)
        }
    }

    func testReportMustMatchAllPersistedRunIdentityWithoutUnicodeNormalization() throws {
        for (key, replacement) in [("computer_id", "computer_2"), ("workspace_root", root + "/"), ("workspace_branch", branch + "-other")] {
            XCTAssertNil(try decode(report, run: [key: replacement]).workspaceRetention, key)
            XCTAssertNil(try decode(report, run: [key: NSNull()]).workspaceRetention, key)
        }
        XCTAssertNil(try decode(report, run: ["workspace_root": root.precomposedStringWithCanonicalMapping]).workspaceRetention)
        XCTAssertNil(try decode(report, run: ["workspace_branch": branch.precomposedStringWithCanonicalMapping]).workspaceRetention)
        let trusted = try XCTUnwrap(try decode(report).workspaceRetention)
        let rebound = Run(id: "another", taskId: "task", computerId: "computer_2", status: .running,
                          workspaceRoot: root, workspaceBranch: branch, workspaceRetention: trusted)
        XCTAssertNil(rebound.workspaceRetention); XCTAssertEqual(rebound.status, .running)
    }

    func testRunAndTaskColdReadEnvelopesExposeTheSameReport() throws {
        let run = try decode(report)
        let data = try ArtooJSON.encoder().encode(run)
        let object = try JSONSerialization.jsonObject(with: data)
        let runResponse = try ArtooJSON.decoder().decode(RunResponse.self, from: JSONSerialization.data(withJSONObject: ["run": object]))
        let snapshot: [String: Any] = ["task": ["id": "task_1", "project_id": "p", "title": "Task", "status": "blocked"],
                                        "runs": [object], "approvals": [], "artifacts": []]
        let taskResponse = try ArtooJSON.decoder().decode(TaskSnapshot.self, from: JSONSerialization.data(withJSONObject: snapshot))
        XCTAssertEqual(try XCTUnwrap(runResponse.run.workspaceRetention), try XCTUnwrap(taskResponse.runs.first?.workspaceRetention))
        var malformed = snapshot
        malformed["runs"] = [["id": "r", "task_id": "task_1", "status": "completed", "workspace_retention": ["version": 99]]]
        let unknown = try ArtooJSON.decoder().decode(TaskSnapshot.self, from: JSONSerialization.data(withJSONObject: malformed))
        XCTAssertEqual(unknown.runs.count, 1); XCTAssertNil(unknown.runs[0].workspaceRetention)
    }

    func testDisplayAndClipboardInputsKeepExactDataAndOnlyUniqueCurrentComputerName() throws {
        let run = try decode(report)
        let computer = try XCTUnwrap(WorkspaceRecord(.object(["id": .string("computer_1"), "display_name": .string("Build Mac")])) )
        let details = RunWorkspaceDetails(run: run, computers: [computer])
        XCTAssertEqual(details.heading, "Work retention reported")
        XCTAssertEqual(details.workspaceLabel, "Reported workspace")
        XCTAssertEqual(details.reporterDisplayName, "Build Mac")
        XCTAssertEqual(details.report?.reporterComputerId, "computer_1")
        // These exact values are assigned to UIPasteboard, without command generation.
        XCTAssertEqual(Array(try XCTUnwrap(details.workspaceRoot).utf8), Array(root.utf8))
        XCTAssertEqual(Array(try XCTUnwrap(details.workspaceBranch).utf8), Array(branch.utf8))
        XCTAssertNil(RunWorkspaceDetails(run: run, computers: [computer, computer]).reporterDisplayName)
        XCTAssertNil(RunWorkspaceDetails(run: run).reporterDisplayName)
        let renamed = try XCTUnwrap(WorkspaceRecord(.object(["id": .string("computer_1"), "display_name": .string("Renamed Mac")])))
        XCTAssertEqual(RunWorkspaceDetails(run: run, computers: [renamed]).reporterDisplayName, "Renamed Mac")
        XCTAssertEqual(RunWorkspaceDetails(run: run, computers: [renamed]).report?.reporterComputerId, "computer_1")
        let planned = RunWorkspaceDetails(run: try decode())
        XCTAssertEqual(Array(try XCTUnwrap(planned.workspaceRoot).utf8), Array(root.utf8))
        XCTAssertEqual(Array(try XCTUnwrap(planned.workspaceBranch).utf8), Array(branch.utf8))
    }
}
