import XCTest
@testable import Artoo

final class PlanningInstructionTests: XCTestCase {
    private let marker: [String: JSONValue] = ["discussion_id": .string("discussion_1"), "discussion_step": .number(2),
                                               "assistant_turn_id": .string("turn_3"), "intent": .string("discussion")]
    private let original = "  You are participating in planning discussion discussion_1.\r\n保留原文 e\u{301}.\n{\"approval_gates\":[],\"write_scopes\":[]}\n  "

    private func message(payload: JSONValue?, actor: String = "system", actorId: String = "discussion-coordinator",
                         kind: String? = "text", root: String? = "root_1", body: String? = nil) -> Message {
        Message(id: "message_3", roomId: "room_1", actorType: actor, actorId: actorId, kind: kind,
                body: body ?? original, threadRootId: root, payload: payload)
    }

    func testCoordinatorProjectionPreservesExactOriginalAndRoundTripsWithoutMutatingTheMessage() throws {
        let source = message(payload: .object(marker))
        let projection = try XCTUnwrap(source.planningInstruction)
        XCTAssertEqual(projection.stepNumber, 3)
        XCTAssertEqual(projection.title, "Planning instruction · Step 3")
        XCTAssertEqual(projection.summary, "The agents use the goal and earlier replies to prepare a plan. You review a proposal before accepting it.")
        for _ in 0..<3 {
            XCTAssertEqual(source.planningInstruction, projection)
            XCTAssertEqual(Array(source.planningInstruction!.originalText.utf8), Array(original.utf8))
        }
        let restored = try ArtooJSON.decoder().decode(Message.self, from: ArtooJSON.encoder().encode(source))
        XCTAssertEqual(restored, source)
        XCTAssertEqual(Array(restored.body.utf8), Array(original.utf8))
        XCTAssertEqual(restored.planningInstruction, projection)
        XCTAssertEqual(restored.id, "message_3"); XCTAssertEqual(restored.threadRootId, "root_1")
    }

    func testUserRootsAgentRepliesAndOtherSystemActorsAreNeverReclassified() {
        for actor in ["user", "agent", "unknown"] {
            let source = message(payload: .object(marker), actor: actor)
            XCTAssertNil(source.planningInstruction); XCTAssertEqual(source.body, original)
        }
        for actorId in ["", "another-coordinator", " discussion-coordinator "] {
            XCTAssertNil(message(payload: .object(marker), actorId: actorId).planningInstruction)
        }
        for kind in [nil, "run_event", "system_notice", "future_kind"] as [String?] {
            XCTAssertNil(message(payload: .object(marker), kind: kind).planningInstruction)
        }
        for root in [nil, "", " \n", "\u{FEFF}"] as [String?] {
            XCTAssertNil(message(payload: .object(marker), root: root).planningInstruction)
        }
        let root = message(payload: .object(["discussion_id": .string("discussion_1"), "participants": .array([])]), actor: "user", root: nil)
        XCTAssertNil(root.planningInstruction); XCTAssertEqual(root.body, original)
    }

    func testMissingOrMalformedMetadataKeepsOriginalText() {
        for payload in [nil, .null, .array([]), .string("discussion"), .bool(true)] as [JSONValue?] {
            let source = message(payload: payload)
            XCTAssertNil(source.planningInstruction); XCTAssertEqual(source.body, original)
        }
        for key in marker.keys {
            var fields = marker; fields.removeValue(forKey: key)
            XCTAssertNil(message(payload: .object(fields)).planningInstruction, "Missing \(key) must fall back")
        }
        for key in ["discussion_id", "assistant_turn_id"] {
            for value in [JSONValue.string(""), .string(" \n"), .string("\u{FEFF}"), .number(1), .bool(true), .null, .array([])] {
                var fields = marker; fields[key] = value
                XCTAssertNil(message(payload: .object(fields)).planningInstruction, "Mistyped \(key) must not be coerced")
            }
        }
        for value in [JSONValue.string("other"), .string(" discussion "), .number(1), .bool(true), .null] {
            var fields = marker; fields["intent"] = value
            XCTAssertNil(message(payload: .object(fields)).planningInstruction)
        }
    }

    func testStepMustBeANonnegativeSafeIntegerBeforeAddingOne() throws {
        for value in [JSONValue.string("2"), .bool(true), .null, .number(-1), .number(0.5),
                      .number(9_007_199_254_740_991), .number(.infinity), .number(.nan)] {
            var fields = marker; fields["discussion_step"] = value
            XCTAssertNil(message(payload: .object(fields)).planningInstruction)
        }
        for (step, displayed) in [(0.0, 1), (9_007_199_254_740_990.0, 9_007_199_254_740_991)] {
            var fields = marker; fields["discussion_step"] = .number(step)
            XCTAssertEqual(try XCTUnwrap(message(payload: .object(fields)).planningInstruction).stepNumber, displayed)
        }
    }

    func testProjectionDoesNotParseBodyOrInferLifecycleState() throws {
        for body in ["ordinary instruction", "{invalid JSON", "approval_gates write_scopes", ""] {
            let source = message(payload: .object(marker), body: body)
            XCTAssertEqual(try XCTUnwrap(source.planningInstruction).originalText, body)
            XCTAssertEqual(source.body, body)
            XCTAssertNil(message(payload: .object([:]), body: body).planningInstruction)
        }
        var fields = marker; fields["future_metadata"] = .string("preserved")
        let source = message(payload: .object(fields))
        XCTAssertNotNil(source.planningInstruction)
        XCTAssertEqual(source.payload?["future_metadata"], .string("preserved"))
    }

    func testIdentifierWhitespaceMatchesWebWithoutNormalizingOpaqueValues() throws {
        // ECMAScript trim treats FEFF as whitespace and retains U+0085.
        var fields = marker
        fields["discussion_id"] = .string("\u{0085}")
        fields["assistant_turn_id"] = .string("\u{0085}")
        let source = message(payload: .object(fields), root: "\u{0085}")
        XCTAssertNotNil(source.planningInstruction)
        XCTAssertEqual(source.threadRootId, "\u{0085}")
        XCTAssertEqual(source.payload, .object(fields))
    }
}
