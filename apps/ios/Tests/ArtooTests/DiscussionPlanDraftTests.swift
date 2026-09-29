import XCTest
@testable import Artoo

final class DiscussionPlanDraftTests: XCTestCase {
    func testServerMetadataPreservesEveryTaskDetailAndOriginalReply() throws {
        let message = try fixtureMessage()
        let draft = try XCTUnwrap(message.discussionPlanDraft)
        XCTAssertEqual(draft.version, 1)
        XCTAssertEqual(draft.discussionId, "discussion_1")
        XCTAssertEqual(draft.goalId, "goal_1")
        XCTAssertEqual(draft.rationale, "先实现，再独立验证。")
        XCTAssertEqual(draft.taskSpecs.map(\.title), ["实现接口", "验证接口"])
        XCTAssertEqual(draft.taskSpecs[0].description, "保留 Unicode 与多行描述。\nReturn the documented response.")
        XCTAssertEqual(draft.taskSpecs[0].acceptanceCriteria, ["响应符合契约", "拒绝未认证请求"])
        XCTAssertEqual(draft.taskSpecs[0].requiredCapabilities, ["code.read"])
        XCTAssertEqual(draft.taskSpecs[0].expectedArtifacts.first?.type, "patch")
        XCTAssertEqual(draft.taskSpecs[0].expectedArtifacts.first?.description, "Reviewed implementation")
        XCTAssertEqual(draft.dependencyLabel(draft.taskSpecs[1].dependencies[0]), "Depends on: 1. 实现接口")
        let original = message.body
        XCTAssertTrue(original.hasPrefix("  ```json\n"))
        XCTAssertTrue(original.hasSuffix("\n```  "))
        for _ in 0..<3 { XCTAssertEqual(message.discussionPlanDraft, draft) }
        XCTAssertEqual(message.body, original, "Rendering metadata must not replace or reserialize the original reply")
        let restored = try ArtooJSON.decoder().decode(Message.self, from: ArtooJSON.encoder().encode(message))
        XCTAssertEqual(restored.body, original)
        XCTAssertEqual(restored.discussionPlanDraft, draft)
    }

    func testPlanShapedBodiesNeverTriggerPresentationWithoutAgentTextMetadata() throws {
        let source = try fixtureMessage()
        for body in [source.body, "{\"task_specs\":[]}", "{invalid json", "ordinary reply"] {
            let message = copy(source, body: body, payload: .object([:]))
            XCTAssertNil(message.discussionPlanDraft)
            XCTAssertEqual(message.body, body)
        }
        for actor in ["user", "system", "unknown"] {
            XCTAssertNil(copy(source, actor: actor).discussionPlanDraft)
        }
        for kind in [nil, "run_event", "system_notice", "future_kind"] as [String?] {
            let message = Message(id: source.id, roomId: source.roomId, actorType: "agent", actorId: source.actorId,
                                  kind: kind, body: source.body, payload: source.payload)
            XCTAssertNil(message.discussionPlanDraft)
        }
    }

    func testInvalidMetadataFallsBackWithoutBreakingMessageDecoding() throws {
        let source = try fixtureMessage()
        var invalid: [JSONValue] = [.null, .string("{malformed"), .array([]), .bool(true)]
        let metadata = try metadataObject(source)
        for (key, values) in [
            "version": [JSONValue.number(2), .number(1.5), .string("1"), .bool(true)],
            "discussion_id": [.string(""), .number(1), .null],
            "goal_id": [.string(""), .bool(true), .null],
            "rationale": [.number(5), .null, .string(String(repeating: "😀", count: 10_001))],
            "task_specs": [.array([]), .null, .string("not tasks")]
        ] {
            for value in values { var changed = metadata; changed[key] = value; invalid.append(.object(changed)) }
        }
        for key in metadata.keys { var changed = metadata; changed.removeValue(forKey: key); invalid.append(.object(changed)) }
        for value in invalid {
            let message = copy(source, payload: .object(["discussion_plan": value]))
            let decoded = try ArtooJSON.decoder().decode(Message.self, from: ArtooJSON.encoder().encode(message))
            XCTAssertNil(decoded.discussionPlanDraft, "Invalid metadata must remain an ordinary message: \(value)")
            XCTAssertEqual(decoded.body, source.body)
        }
    }

    func testIncompleteOrMistypedTaskDetailsAreNotSilentlyCoerced() throws {
        let source = try fixtureMessage()
        let task = try firstTaskObject(source)
        for key in task.keys {
            var changed = task; changed.removeValue(forKey: key)
            XCTAssertNil(try replacingTask(source, with: .object(changed)).discussionPlanDraft, "Missing \(key) must fall back")
        }
        for (key, values) in [
            "title": [JSONValue.string(""), .number(1), .null],
            "description": [.bool(true), .null],
            "acceptance_criteria": [.array([]), .strings([""]), .array([.number(1)]), .null],
            "required_capabilities": [.array([.number(1)]), .string("code.read")],
            "dependencies": [.array([.object(["ref": .number(0), "type": .string("blocks")])]), .null],
            "approval_gates": [.strings(["review"])],
            "write_scopes": [.strings(["src/"])],
            "expected_artifacts": [.array([.object(["type": .string("patch")])]), .array([.object(["type": .bool(true), "description": .string("")])])]
        ] {
            for value in values {
                var changed = task; changed[key] = value
                XCTAssertNil(try replacingTask(source, with: .object(changed)).discussionPlanDraft, "Invalid \(key) must fall back")
            }
        }
    }

    func testDependencyGraphAndSupportedRelationsMatchTheServerContract() throws {
        let source = try fixtureMessage()
        for (type, label) in [("blocks", "Depends on"), ("artifact_required", "Requires artifact from"),
                              ("contract_required", "Requires contract from"), ("review_required", "Requires review from"), ("soft_context", "Uses context from")] {
            let message = try replacingDependencies(source, taskIndex: 1, refs: [("0", type)])
            let draft = try XCTUnwrap(message.discussionPlanDraft)
            XCTAssertEqual(draft.dependencyLabel(draft.taskSpecs[1].dependencies[0]), "\(label): 1. 实现接口")
        }
        for ref in ["", "00", "+0", "0.0", "0e0", "0x0", " 0 ", "-1", "1", "2", "9999999999999999999999999"] {
            XCTAssertNil(try replacingDependencies(source, taskIndex: 1, refs: [(ref, "blocks")]).discussionPlanDraft)
        }
        XCTAssertNil(try replacingDependencies(source, taskIndex: 1, refs: [("0", "unknown")]).discussionPlanDraft)
        let cyclic = try replacingDependencies(source, taskIndex: 0, refs: [("1", "blocks")])
        XCTAssertNil(cyclic.discussionPlanDraft, "A cycle must not be shown as a validated suggested plan")
    }

    func testTaskCountAndRationaleLimitsMatchTheServerContract() throws {
        let source = try fixtureMessage()
        var metadata = try metadataObject(source)
        let task = JSONValue.object(try firstTaskObject(source))
        metadata["task_specs"] = .array(Array(repeating: task, count: 50))
        metadata["rationale"] = .string(String(repeating: "😀", count: 10_000))
        XCTAssertNotNil(copy(source, payload: .object(["discussion_plan": .object(metadata)])).discussionPlanDraft)
        metadata["task_specs"] = .array(Array(repeating: task, count: 51))
        XCTAssertNil(copy(source, payload: .object(["discussion_plan": .object(metadata)])).discussionPlanDraft)
    }

    private func fixtureMessage() throws -> Message {
        let url = try XCTUnwrap(Bundle(for: DiscussionPlanDraftTests.self).url(forResource: "discussion-plan-message", withExtension: "json"))
        return try ArtooJSON.decoder().decode(Message.self, from: Data(contentsOf: url))
    }

    private func metadataObject(_ message: Message) throws -> [String: JSONValue] {
        guard let payload = message.payload, case let .object(value) = payload["discussion_plan"] else { throw FixtureError.malformed }
        return value
    }

    private func firstTaskObject(_ message: Message) throws -> [String: JSONValue] {
        let metadata = try metadataObject(message)
        guard case let .object(task)? = metadata["task_specs"]?.array.first else { throw FixtureError.malformed }
        return task
    }

    private func replacingTask(_ message: Message, with task: JSONValue) throws -> Message {
        var metadata = try metadataObject(message)
        var tasks = try XCTUnwrap(metadata["task_specs"]?.array)
        tasks[0] = task; metadata["task_specs"] = .array(tasks)
        return copy(message, payload: .object(["discussion_plan": .object(metadata)]))
    }

    private func replacingDependencies(_ message: Message, taskIndex: Int, refs: [(String, String)]) throws -> Message {
        var metadata = try metadataObject(message)
        var tasks = try XCTUnwrap(metadata["task_specs"]?.array)
        guard case var .object(task) = tasks[taskIndex] else { throw FixtureError.malformed }
        task["dependencies"] = .array(refs.map { .object(["ref": .string($0.0), "type": .string($0.1)]) })
        tasks[taskIndex] = .object(task); metadata["task_specs"] = .array(tasks)
        return copy(message, payload: .object(["discussion_plan": .object(metadata)]))
    }

    private func copy(_ message: Message, actor: String? = nil, body: String? = nil, payload: JSONValue? = nil) -> Message {
        Message(id: message.id, roomId: message.roomId, actorType: actor ?? message.actorType, actorId: message.actorId,
                kind: message.kind, body: body ?? message.body, payload: payload ?? message.payload)
    }

    private enum FixtureError: Error { case malformed }
}
