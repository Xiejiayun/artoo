import XCTest
@testable import Artoo

final class ConversationMetadataTests: XCTestCase {
    func testAuthorUsesTheCorrectDirectoryAndOnlyMarksTheCurrentUser() throws {
        let member = try XCTUnwrap(WorkspaceRecord(.object(["id": .string("shared_id"), "display_name": .string("Maya")])))
        let agent = try XCTUnwrap(WorkspaceRecord(.object(["id": .string("shared_id"), "display_name": .string("Build agent")])))
        XCTAssertEqual(ConversationMetadata.author(actorType: "user", actorId: "shared_id", members: [member], agents: [agent], currentUserId: "shared_id", currentUserName: "Maya"), "Maya (you)")
        XCTAssertEqual(ConversationMetadata.author(actorType: "agent", actorId: "shared_id", members: [member], agents: [agent], currentUserId: "shared_id", currentUserName: "Maya"), "Build agent")
        XCTAssertEqual(ConversationMetadata.author(actorType: "user", actorId: "removed_member", members: [member], agents: [agent], currentUserId: "shared_id", currentUserName: "Maya"), "user:removed_member")
        XCTAssertEqual(ConversationMetadata.author(actorType: "user", actorId: "shared_id", members: [], agents: [agent], currentUserId: "shared_id", currentUserName: "Maya"), "Maya (you)")
    }

    func testSystemAndMissingProfilesKeepTheirActorTypeUnambiguous() {
        XCTAssertEqual(ConversationMetadata.author(actorType: "system", actorId: "discussion-coordinator", members: [], agents: [], currentUserId: "discussion-coordinator", currentUserName: "Maya"), "Artoo")
        for actorType in ["user", "agent", "unknown"] {
            XCTAssertEqual(ConversationMetadata.author(actorType: actorType, actorId: "same_id", members: [], agents: [], currentUserId: nil, currentUserName: nil), "\(actorType):same_id")
        }
    }

    func testRuntimeInstanceAuthorsAndMentionsResolveTheLinkedAgentWithoutUsingMemberNames() throws {
        let member = try XCTUnwrap(WorkspaceRecord(.object(["id": .string("ai_planner"), "display_name": .string("Different person")])))
        let agent = try XCTUnwrap(WorkspaceRecord(.object(["id": .string("agent_planner"), "display_name": .string("Planning agent")])))
        // Match the production bootstrap: instances have agent_id and runtime,
        // but the human-readable name currently lives on the linked agent.
        let instance = try XCTUnwrap(WorkspaceRecord(.object(["id": .string("ai_planner"), "agent_id": .string("agent_planner"), "runtime": .string("codex")])))
        XCTAssertEqual(ConversationMetadata.author(actorType: "agent", actorId: instance.id, members: [member], agents: [agent], agentInstances: [instance], currentUserId: member.id, currentUserName: "Different person"), "Planning agent")
        XCTAssertEqual(ConversationMetadata.author(actorType: "user", actorId: member.id, members: [member], agents: [agent], agentInstances: [instance], currentUserId: nil, currentUserName: nil), "Different person")
        let payload: JSONValue = .object(["mentions": .array([.object(["actor_type": .string("agent"), "actor_id": .string(instance.id)])])])
        XCTAssertEqual(ConversationMetadata.mentionNames(payload, members: [member], agents: [agent], agentInstances: [instance], currentUserId: nil, currentUserName: nil), ["Planning agent"])
    }

    func testInstanceDisplayNameTakesPriorityAndMissingAgentProfilesKeepTheInstanceIdentity() throws {
        let agent = try XCTUnwrap(WorkspaceRecord(.object(["id": .string("agent_planner"), "display_name": .string("Planning agent")])))
        let named = try XCTUnwrap(WorkspaceRecord(.object(["id": .string("ai_named"), "agent_id": .string(agent.id), "display_name": .string("  Laptop planner  ")])))
        let blank = try XCTUnwrap(WorkspaceRecord(.object(["id": .string("ai_blank"), "agent_id": .string(agent.id), "display_name": .string("  ")])))
        let orphan = try XCTUnwrap(WorkspaceRecord(.object(["id": .string("ai_orphan"), "agent_id": .string("removed_agent"), "runtime": .string("codex")])))
        XCTAssertEqual(ConversationMetadata.agentName(named.id, agents: [agent], instances: [named]), "Laptop planner")
        XCTAssertEqual(ConversationMetadata.agentName(blank.id, agents: [agent], instances: [blank]), "Planning agent")
        XCTAssertEqual(ConversationMetadata.agentName(orphan.id, agents: [agent], instances: [orphan]), "agent:ai_orphan")
        XCTAssertEqual(ConversationMetadata.agentName(agent.id, agents: [agent], instances: [named]), "Planning agent")
    }

    func testMentionNamesResolveBothActorTypesAndIgnoreMalformedOrDuplicateReferences() throws {
        let member = try XCTUnwrap(WorkspaceRecord(.object(["id": .string("shared_id"), "display_name": .string("Maya")])))
        let agent = try XCTUnwrap(WorkspaceRecord(.object(["id": .string("shared_id"), "display_name": .string("Build agent")])))
        let person: JSONValue = .object(["actor_type": .string("user"), "actor_id": .string("shared_id")])
        let payload: JSONValue = .object(["mentions": .array([
            person, .object(["actor_type": .string("agent"), "actor_id": .string("shared_id")]),
            .object(["actor_type": .string("user"), "actor_id": .string("removed_member")]),
            .object(["actor_type": .string("agent"), "actor_id": .string("removed_agent")]),
            .object(["actor_type": .string("system"), "actor_id": .string("discussion-coordinator")]),
            person, .null, .string("invalid"), .object(["actor_id": .string("shared_id")]),
            .object(["actor_type": .string("user"), "actor_id": .number(1)]),
            .object(["actor_type": .string("user"), "actor_id": .string("")])
        ])])
        XCTAssertEqual(ConversationMetadata.mentionNames(payload, members: [member], agents: [agent], currentUserId: "shared_id", currentUserName: "Maya"),
                       ["Maya", "Build agent", "user:removed_member", "agent:removed_agent", "Artoo"])
        let emptyPayloads: [JSONValue?] = [nil, .null, .object([:]), .object(["mentions": .string("invalid")])]
        for empty in emptyPayloads {
            XCTAssertEqual(ConversationMetadata.mentionNames(empty, members: [], agents: [], currentUserId: nil, currentUserName: nil), [])
        }
    }

    func testDatabaseAndISOTimeRepresentTheSameInstantAcrossOffsets() throws {
        let instant = try XCTUnwrap(ConversationMetadata.parseTimestamp("2026-09-29T04:55:06.575Z"))
        for raw in ["2026-09-29 04:55:06.575+00", "2026-09-29T12:55:06.575+08:00", "2026-09-29 13:25:06.575+0830"] {
            let parsed = try XCTUnwrap(ConversationMetadata.parseTimestamp(raw), raw)
            XCTAssertEqual(parsed.timeIntervalSince1970, instant.timeIntervalSince1970, accuracy: 0.001)
        }
        XCTAssertNotNil(ConversationMetadata.parseTimestamp("2026-09-29T04:55:06Z"))
        XCTAssertNil(ConversationMetadata.parseTimestamp("unknown timestamp"))
    }

    func testTimestampUsesLocalZoneAndRetainsUnparseableServerValues() throws {
        let raw = "2026-09-29 04:55:06.575+00"
        let locale = Locale(identifier: "en_US")
        let utc = ConversationMetadata.timestamp(raw, locale: locale, timeZone: try XCTUnwrap(TimeZone(secondsFromGMT: 0)))
        let shanghai = ConversationMetadata.timestamp(raw, locale: locale, timeZone: try XCTUnwrap(TimeZone(identifier: "Asia/Shanghai")))
        XCTAssertTrue(utc.contains("4:55")); XCTAssertTrue(shanghai.contains("12:55"))
        XCTAssertNotEqual(utc, shanghai); XCTAssertFalse(shanghai.contains("+00"))
        XCTAssertEqual(ConversationMetadata.timestamp("pending server time"), "pending server time")
        XCTAssertEqual(ConversationMetadata.timestamp(nil), "")
    }
}
