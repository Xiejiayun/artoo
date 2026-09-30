import Foundation

/// Presentation only. Instance identity and scheduling remain server-owned.
struct AssigneeLabel: Equatable {
    let name: String
    let computer: String
    let runtime: String
    let workspace: String
    let instanceIdentifier: String?

    init(instance: WorkspaceRecord, agents: [WorkspaceRecord], computers: [WorkspaceRecord], options: [WorkspaceRecord] = []) {
        let name = ConversationMetadata.agentName(instance.id, agents: agents, instances: [instance])
        let computerId = instance["computer_id"].text.trimmingCharacters(in: .whitespacesAndNewlines)
        let record = computers.first { $0.id == computerId }
        let computer = Self.nonempty(record?["display_name"].text) ?? Self.nonempty(record?["hostname"].text)
            ?? (computerId.isEmpty ? "Computer not specified" : "computer:\(computerId)")
        let runtime = Self.nonempty(instance["runtime"].text) ?? "Runtime not specified"
        let workspacePath = instance["workspace_root"].text
        // The selected path is copyable; trimming a valid directory name would
        // silently change its identity. Only a wholly blank value is missing.
        let workspace = Self.nonempty(workspacePath) == nil ? "Workspace not specified" : workspacePath
        self.name = name; self.computer = computer; self.runtime = runtime; self.workspace = workspace
        // Compare the rendered values, since names need not be unique even
        // across computers. The caller supplies its existing visible options.
        let collides = options.contains { other in
            guard other.id != instance.id else { return false }
            let label = Self(instance: other, agents: agents, computers: computers)
            return label.name == name && label.computer == computer && label.runtime == runtime
                && Self.nonempty(label.workspace) == Self.nonempty(workspace)
        }
        instanceIdentifier = collides ? instance.id : nil
    }

    var context: String { "\(computer) · \(runtime)" }
    var identityDetail: String? { instanceIdentifier.map { "Instance: \($0)" } }
    var accessibilityValue: String {
        [name, context, workspace, identityDetail].compactMap { $0 }.joined(separator: ", ")
    }

    private static func nonempty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
        return trimmed
    }
}
