import Foundation

/// A server-validated final discussion reply. This is presentation data, not a
/// proposed/accepted plan, and decoding it never performs a workspace action.
struct DiscussionPlanDraft: Decodable, Equatable {
    struct TaskSpec: Decodable, Equatable {
        let title: String
        let description: String
        let acceptanceCriteria: [String]
        let requiredCapabilities: [String]
        let dependencies: [Dependency]
        let approvalGates: [String]
        let writeScopes: [String]
        let expectedArtifacts: [ExpectedArtifact]
    }

    struct Dependency: Decodable, Equatable {
        let ref: String
        let type: Kind

        enum Kind: String, Decodable {
            case blocks
            case artifactRequired = "artifact_required"
            case contractRequired = "contract_required"
            case reviewRequired = "review_required"
            case softContext = "soft_context"

            var label: String {
                switch self {
                case .blocks: return "Depends on"
                case .artifactRequired: return "Requires artifact from"
                case .contractRequired: return "Requires contract from"
                case .reviewRequired: return "Requires review from"
                case .softContext: return "Uses context from"
                }
            }
        }
    }

    struct ExpectedArtifact: Decodable, Equatable {
        let type: String
        let description: String
    }

    let version: Int
    let discussionId: String
    let goalId: String
    let rationale: String
    let taskSpecs: [TaskSpec]

    fileprivate var isValid: Bool {
        guard version == 1, !discussionId.isEmpty, !goalId.isEmpty, rationale.utf16.count <= 20_000,
              (1...50).contains(taskSpecs.count) else { return false }
        var prerequisites = Array(repeating: [Int](), count: taskSpecs.count)
        for (index, task) in taskSpecs.enumerated() {
            guard !task.title.isEmpty, !task.acceptanceCriteria.isEmpty,
                  task.acceptanceCriteria.allSatisfy({ !$0.isEmpty }),
                  task.approvalGates.isEmpty, task.writeScopes.isEmpty else { return false }
            for dependency in task.dependencies {
                // The server normalizes validated refs to canonical indices.
                guard let source = Int(dependency.ref), String(source) == dependency.ref,
                      taskSpecs.indices.contains(source), source != index else { return false }
                prerequisites[index].append(source)
            }
        }
        var visiting = Set<Int>(), visited = Set<Int>()
        func isAcyclic(_ index: Int) -> Bool {
            if visiting.contains(index) { return false }
            if visited.contains(index) { return true }
            visiting.insert(index)
            for source in prerequisites[index] where !isAcyclic(source) { return false }
            visiting.remove(index)
            visited.insert(index)
            return true
        }
        return taskSpecs.indices.allSatisfy(isAcyclic)
    }

    func dependencyLabel(_ dependency: Dependency) -> String {
        let name: String
        if let index = Int(dependency.ref), taskSpecs.indices.contains(index) {
            name = "\(index + 1). \(taskSpecs[index].title)"
        } else { name = "Task reference \(dependency.ref)" }
        return "\(dependency.type.label): \(name)"
    }
}

extension Message {
    var discussionPlanDraft: DiscussionPlanDraft? {
        guard actorType == "agent", kind == "text", let metadata = payload?["discussion_plan"],
              let data = try? JSONEncoder().encode(metadata),
              let draft = try? ArtooJSON.decoder().decode(DiscussionPlanDraft.self, from: data), draft.isValid else { return nil }
        return draft
    }
}
