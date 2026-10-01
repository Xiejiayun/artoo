import XCTest
@testable import Artoo

final class AssistantRequestSummaryTests: XCTestCase {
    private let planning: JSONValue = .object(["discussion_id": .string("discussion_1"), "discussion_step": .number(2),
                                               "assistant_turn_id": .string("turn_3"), "intent": .string("discussion")])

    private func message(id: String = "request_1", room: String = "room_1", root: String? = nil,
                         actor: String = "user", actorId: String = "user_1", body: String,
                         payload: JSONValue? = nil) -> Message {
        Message(id: id, roomId: room, actorType: actor, actorId: actorId, kind: "text", body: body,
                threadRootId: root, payload: payload)
    }

    private func summary(_ messages: [Message], root: String? = nil) -> AssistantRequestSummary {
        AssistantRequestSummary(userMessageId: "request_1", roomId: "room_1", threadRootId: root, messages: messages)
    }

    func testSummaryUsesTheLinkedRequestInsteadOfTheLatestMessage() {
        let request = message(body: "  Review the release\n\tand list remaining risks.  ")
        let later = message(id: "request_2", body: "Cancel this unrelated request")
        let label = summary([request, later])
        XCTAssertEqual(label.text, "Review the release and list remaining risks.")
        XCTAssertEqual(label.originalText, request.body, "Whitespace-normalized previews must still expose the exact original request")
        XCTAssertFalse(label.isUnavailable)
        XCTAssertEqual(request.body, "  Review the release\n\tand list remaining risks.  ", "Presentation must not change the persisted request")
    }

    func testValidPlanningInstructionNeverRepeatsTheInternalPromptInTheRequestRow() {
        let raw = String(repeating: "internal approval_gates/write_scopes instruction\n", count: 20)
        let request = message(root: "root_1", actor: "system", actorId: "discussion-coordinator", body: raw, payload: planning)
        let label = summary([request], root: "root_1")
        XCTAssertEqual(label.text, request.planningInstruction?.title)
        XCTAssertEqual(label.text, "Planning instruction · Step 3")
        XCTAssertNil(label.originalText, "Original coordinator text remains in the dedicated message disclosure")
        XCTAssertFalse(label.isUnavailable)
        XCTAssertFalse(label.text.contains("approval_gates"))
    }

    func testUserTextCannotBeReclassifiedByPlanningWordsOrCopiedMetadata() {
        let raw = "Planning instruction · Step 3: discuss approval_gates and write_scopes"
        let request = message(root: "root_1", body: raw, payload: planning)
        let label = summary([request], root: "root_1")
        XCTAssertNil(request.planningInstruction)
        XCTAssertEqual(label.text, raw)
        XCTAssertFalse(label.isUnavailable)
    }

    func testMalformedCoordinatorMetadataUsesTheSameFallbackAsMessagePresentation() {
        let request = message(root: "root_1", actor: "system", actorId: "discussion-coordinator",
                              body: "Unrecognized coordinator record", payload: .object(["discussion_step": .number(2)]))
        XCTAssertNil(request.planningInstruction)
        XCTAssertEqual(summary([request], root: "root_1").text, request.body)
    }

    func testMissingOrDifferentScopeDoesNotGuessFromAnotherMessage() {
        let unrelated = [message(id: "other", body: "Unrelated body"),
                         message(room: "other_room", body: "Private room body"),
                         message(root: "other_thread", body: "Other thread body")]
        for candidates in [[], unrelated] {
            let label = summary(candidates)
            XCTAssertTrue(label.isUnavailable)
            XCTAssertEqual(label.text, "Request message unavailable")
            XCTAssertNil(label.originalText)
        }
        XCTAssertTrue(summary([message(body: "Channel root")], root: "thread_1").isUnavailable)
    }

    func testDuplicateMatchingIdentityIsAmbiguousInsteadOfChoosingOneBody() {
        let label = summary([message(body: "First body"), message(body: "Conflicting body")])
        XCTAssertTrue(label.isUnavailable)
        XCTAssertNil(label.originalText)
    }

    func testLongUnicodeRequestHasAGraphemeSafePreviewAndExactOriginalDisclosure() throws {
        let fragment = "👩🏽‍💻e\u{301}"
        let raw = "  " + String(repeating: fragment, count: 100) + "\r\n保留全部原文  "
        let label = summary([message(body: raw)])
        XCTAssertEqual(label.text, String(repeating: fragment, count: 90) + "…")
        XCTAssertEqual(label.text.count, 181)
        XCTAssertEqual(Array(try XCTUnwrap(label.originalText).utf8), Array(raw.utf8))
        XCTAssertFalse(label.isUnavailable)
    }

    func testShortQuotedDoubleSpacesRemainDistinguishableThroughExactOriginalText() throws {
        let doubleSpace = #"echo "a  b""#
        let singleSpace = #"echo "a b""#
        let doubleLabel = summary([message(body: doubleSpace)])
        let singleLabel = summary([message(body: singleSpace)])
        XCTAssertEqual(doubleLabel.text, singleLabel.text, "The compact preview may normalize whitespace")
        XCTAssertEqual(Array(try XCTUnwrap(doubleLabel.originalText).utf8), Array(doubleSpace.utf8))
        XCTAssertNil(singleLabel.originalText, "An unchanged short request does not need another copy")
        XCTAssertNotEqual(doubleLabel.originalText, singleLabel.text, "The disclosure must retain the significant second space")
    }

    func testShortMultilineRequestRetainsNewlinesAndIndentationInItsOriginalDisclosure() throws {
        let raw = "if ready; then\n  echo \"ship it\"\nfi"
        let label = summary([message(body: raw)])
        XCTAssertEqual(label.text, "if ready; then echo \"ship it\" fi")
        XCTAssertLessThan(label.text.count, 180)
        XCTAssertEqual(Array(try XCTUnwrap(label.originalText).utf8), Array(raw.utf8))
    }

    func testPreviewBoundaryAndEmptyBodyRemainTruthful() {
        let boundary = String(repeating: "x", count: 180)
        let exact = summary([message(body: boundary)])
        XCTAssertEqual(exact.text, boundary)
        XCTAssertNil(exact.originalText)
        let empty = summary([message(body: " \n\t ")])
        XCTAssertEqual(empty.text, "Empty request")
        XCTAssertFalse(empty.isUnavailable)
        XCTAssertEqual(empty.originalText, " \n\t ")
    }
}
