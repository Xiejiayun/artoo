import XCTest
@testable import Artoo

final class AssigneeLabelTests: XCTestCase {
    private func record(_ fields: [String: JSONValue]) throws -> WorkspaceRecord {
        try XCTUnwrap(WorkspaceRecord(.object(fields)))
    }

    func testExplicitAgentBecomesUnavailableWhenDisabledRemovedOrReplacedBySameName() throws {
        let selected = try record(["id": .string("ai_selected"), "display_name": .string("Coding agent"), "status": .string("idle")])
        let disabled = try record(["id": .string(selected.id), "display_name": .string("Coding agent"), "status": .string("disabled")])
        let replacement = try record(["id": .string("ai_different"), "display_name": .string("Coding agent"), "status": .string("idle")])
        XCTAssertEqual(AgentSelectionAvailability.resolve(instanceId: selected.id, instances: [selected], loaded: true), .available)
        for inventory in [[disabled], [], [replacement]] {
            let availability = AgentSelectionAvailability.resolve(instanceId: selected.id, instances: inventory, loaded: true)
            XCTAssertEqual(availability, .unavailable, "A refresh must retain the explicit identity instead of selecting another agent or Auto")
            XCTAssertFalse(availability.allowsNewRequest)
        }
    }

    func testSavedManualSelectionWaitsForVerifiedInventoryAndAutoRemainsExplicit() {
        let checking = AgentSelectionAvailability.resolve(instanceId: "ai_saved", instances: [], loaded: false)
        XCTAssertEqual(checking, .checking)
        XCTAssertFalse(checking.allowsNewRequest, "A persisted manual draft must not silently fall back to automatic assignment during loading")
        XCTAssertEqual(AgentSelectionAvailability.resolve(instanceId: nil, instances: [], loaded: false), .automatic)
        XCTAssertEqual(AgentSelectionAvailability.resolve(instanceId: "", instances: [], loaded: true), .automatic)
        XCTAssertTrue(AgentSelectionAvailability.automatic.allowsNewRequest)
    }

    func testProductionInstanceResolvesAgentComputerRuntimeAndWorkspace() throws {
        let instance = try record(["id": .string("ai_executor"), "agent_id": .string("agent_executor"),
                                   "computer_id": .string("computer_mac"), "runtime": .string("codex"),
                                   "workspace_root": .string("/Users/member/Projects/Artoo")])
        let agent = try record(["id": .string("agent_executor"), "display_name": .string("Release engineer")])
        let computer = try record(["id": .string("computer_mac"), "display_name": .string("Studio Mac"), "hostname": .string("studio.local")])
        let label = AssigneeLabel(instance: instance, agents: [agent], computers: [computer])
        XCTAssertEqual(label.name, "Release engineer")
        XCTAssertEqual(label.context, "Studio Mac · codex")
        XCTAssertEqual(label.workspace, "/Users/member/Projects/Artoo")
        XCTAssertEqual(label.accessibilityValue, "Release engineer, Studio Mac · codex, /Users/member/Projects/Artoo")
        XCTAssertFalse(label.accessibilityValue.contains(instance.id), "Known names should not be replaced by opaque instance IDs")
        XCTAssertNil(label.identityDetail)
    }

    func testBlankComputerDisplayNameFallsBackToTrimmedHostname() throws {
        let instance = try record(["id": .string("ai_windows"), "agent_id": .string("agent_coder"),
                                   "computer_id": .string("computer_windows"), "runtime": .string(" copilot "),
                                   "workspace_root": .string("C:\\Projects\\Artoo")])
        let agent = try record(["id": .string("agent_coder"), "display_name": .string("  Coding agent \n")])
        let computer = try record(["id": .string("computer_windows"), "display_name": .string(" \n"), "hostname": .string(" workstation.local ")])
        let label = AssigneeLabel(instance: instance, agents: [agent], computers: [computer])
        XCTAssertEqual(label.name, "Coding agent")
        XCTAssertEqual(label.context, "workstation.local · copilot")
        XCTAssertEqual(label.workspace, "C:\\Projects\\Artoo", "Server workspace syntax must be retained across platforms")
    }

    func testMissingDirectoriesRetainOpaqueIdentityOnlyAsFallback() throws {
        let instance = try record(["id": .string("ai_orphan"), "agent_id": .string("removed_agent"),
                                   "computer_id": .string("removed_computer"), "runtime": .string(" \n"), "workspace_root": .null])
        let label = AssigneeLabel(instance: instance, agents: [], computers: [])
        XCTAssertEqual(label.name, "agent:ai_orphan")
        XCTAssertEqual(label.computer, "computer:removed_computer")
        XCTAssertEqual(label.runtime, "Runtime not specified")
        XCTAssertEqual(label.workspace, "Workspace not specified")
    }

    func testSignificantWorkspaceWhitespaceIsPreservedAndVisuallyAmbiguousOptionsUseIDs() throws {
        let agent = try record(["id": .string("agent_coder"), "display_name": .string("Coding agent")])
        let computer = try record(["id": .string("computer_mac"), "display_name": .string("Studio Mac")])
        let ordinary = try record(["id": .string("ai_ordinary"), "agent_id": .string(agent.id),
                                   "computer_id": .string(computer.id), "runtime": .string("codex"),
                                   "workspace_root": .string("/work/release")])
        let trailingSpace = try record(["id": .string("ai_trailing_space"), "agent_id": .string(agent.id),
                                        "computer_id": .string(computer.id), "runtime": .string("codex"),
                                        "workspace_root": .string("/work/release ")])
        let options = [ordinary, trailingSpace]
        let a = AssigneeLabel(instance: ordinary, agents: [agent], computers: [computer], options: options)
        let b = AssigneeLabel(instance: trailingSpace, agents: [agent], computers: [computer], options: options)
        XCTAssertEqual(a.workspace, "/work/release")
        XCTAssertEqual(b.workspace, "/work/release ", "A copyable path must retain its exact server value")
        XCTAssertTrue(b.accessibilityValue.contains("/work/release , Instance: ai_trailing_space"))
        XCTAssertEqual(a.instanceIdentifier, ordinary.id)
        XCTAssertEqual(b.instanceIdentifier, trailingSpace.id)
    }

    func testIncompleteInstanceDoesNotInventAComputerOrWorkspace() throws {
        let instance = try record(["id": .string("ai_incomplete"), "workspace_root": .string("  ")])
        let label = AssigneeLabel(instance: instance, agents: [], computers: [])
        XCTAssertEqual(label.computer, "Computer not specified")
        XCTAssertEqual(label.runtime, "Runtime not specified")
        XCTAssertEqual(label.workspace, "Workspace not specified")
    }

    func testSameNamedAgentsRemainDistinguishableByComputerAndWorkspace() throws {
        let agent = try record(["id": .string("agent_coder"), "display_name": .string("Coding agent")])
        let mac = try record(["id": .string("computer_mac"), "display_name": .string("Studio Mac")])
        let laptop = try record(["id": .string("computer_laptop"), "display_name": .string("Travel Mac")])
        let first = try record(["id": .string("ai_first"), "agent_id": .string(agent.id), "computer_id": .string(mac.id),
                               "runtime": .string("codex"), "workspace_root": .string("/work/api")])
        let second = try record(["id": .string("ai_second"), "agent_id": .string(agent.id), "computer_id": .string(laptop.id),
                                "runtime": .string("codex"), "workspace_root": .string("/work/mobile")])
        let a = AssigneeLabel(instance: first, agents: [agent], computers: [mac, laptop], options: [first, second])
        let b = AssigneeLabel(instance: second, agents: [agent], computers: [mac, laptop], options: [first, second])
        XCTAssertEqual(a.name, b.name)
        XCTAssertNotEqual(a.context, b.context)
        XCTAssertNotEqual(a.workspace, b.workspace)
        XCTAssertNotEqual(a.accessibilityValue, b.accessibilityValue)
        XCTAssertNil(a.identityDetail); XCTAssertNil(b.identityDetail)
    }

    func testDuplicateRegistrationsUseTheirFullStableInstanceIDs() throws {
        let firstAgent = try record(["id": .string("agent_first"), "display_name": .string("Coding agent")])
        let secondAgent = try record(["id": .string("agent_second"), "display_name": .string(" Coding agent ")])
        let computer = try record(["id": .string("computer_mac"), "display_name": .string("Studio Mac")])
        let first = try record(["id": .string("ai_01K6B76TCKQ2A8TSN548A4S111"), "agent_id": .string(firstAgent.id),
                               "computer_id": .string(computer.id), "runtime": .string("codex"), "workspace_root": .string("/work/api")])
        let second = try record(["id": .string("ai_01K6B76TCKQ2A8TSN548A4S112"), "agent_id": .string(secondAgent.id),
                                "computer_id": .string(computer.id), "runtime": .string("codex"), "workspace_root": .string("/work/api")])
        let agents = [firstAgent, secondAgent]
        let a = AssigneeLabel(instance: first, agents: agents, computers: [computer], options: [first, second])
        let b = AssigneeLabel(instance: second, agents: agents, computers: [computer], options: [first, second])
        XCTAssertEqual(a.name, b.name); XCTAssertEqual(a.context, b.context); XCTAssertEqual(a.workspace, b.workspace)
        XCTAssertEqual(a.identityDetail, "Instance: \(first.id)")
        XCTAssertEqual(b.identityDetail, "Instance: \(second.id)")
        XCTAssertTrue(a.accessibilityValue.hasSuffix("Instance: \(first.id)"))
        XCTAssertTrue(b.accessibilityValue.hasSuffix("Instance: \(second.id)"))
        XCTAssertNotEqual(a.accessibilityValue, b.accessibilityValue, "Common ULID prefixes must not make two options ambiguous")
        XCTAssertEqual(a, AssigneeLabel(instance: first, agents: agents, computers: [computer], options: [second, first]),
                       "Inventory ordering must not change a selected instance's visible identity")
    }

    func testDuplicateComputerNamesAlsoDisambiguateOtherwiseMatchingOptions() throws {
        let agent = try record(["id": .string("agent_coder"), "display_name": .string("Coding agent")])
        let firstComputer = try record(["id": .string("computer_first"), "display_name": .string("Studio Mac"), "hostname": .string("first.local")])
        let secondComputer = try record(["id": .string("computer_second"), "display_name": .string(" Studio Mac "), "hostname": .string("second.local")])
        let first = try record(["id": .string("ai_first"), "agent_id": .string(agent.id), "computer_id": .string(firstComputer.id),
                               "runtime": .string("codex"), "workspace_root": .string("/work/api")])
        let second = try record(["id": .string("ai_second"), "agent_id": .string(agent.id), "computer_id": .string(secondComputer.id),
                                "runtime": .string("codex"), "workspace_root": .string("/work/api")])
        let computers = [firstComputer, secondComputer]
        let a = AssigneeLabel(instance: first, agents: [agent], computers: computers, options: [first, second])
        let b = AssigneeLabel(instance: second, agents: [agent], computers: computers, options: [first, second])
        XCTAssertEqual(a.context, b.context)
        XCTAssertEqual(a.instanceIdentifier, first.id); XCTAssertEqual(b.instanceIdentifier, second.id)
        XCTAssertNotEqual(a.accessibilityValue, b.accessibilityValue)
    }

    func testDifferentRuntimeOrWorkspaceKeepsReadableLabelsWithoutExtraIdentity() throws {
        let agent = try record(["id": .string("agent_coder"), "display_name": .string("Coding agent")])
        let computer = try record(["id": .string("computer_mac"), "display_name": .string("Studio Mac")])
        let first = try record(["id": .string("ai_first"), "agent_id": .string(agent.id), "computer_id": .string(computer.id),
                               "runtime": .string("codex"), "workspace_root": .string("/work/api")])
        let otherRuntime = try record(["id": .string("ai_runtime"), "agent_id": .string(agent.id), "computer_id": .string(computer.id),
                                      "runtime": .string("copilot"), "workspace_root": .string("/work/api")])
        let otherWorkspace = try record(["id": .string("ai_workspace"), "agent_id": .string(agent.id), "computer_id": .string(computer.id),
                                        "runtime": .string("codex"), "workspace_root": .string("/work/mobile")])
        let options = [first, otherRuntime, otherWorkspace]
        for instance in options {
            let label = AssigneeLabel(instance: instance, agents: [agent], computers: [computer], options: options)
            XCTAssertNil(label.instanceIdentifier); XCTAssertNil(label.identityDetail)
            XCTAssertFalse(label.accessibilityValue.contains(instance.id))
        }
    }
}
