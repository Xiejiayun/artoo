import SwiftUI

/// Shared by room messages, thread roots/replies and focused mentions through
/// CollaborationView. The original reply stays unchanged and selectable.
struct MessageBodyView: View {
    let message: Message

    var body: some View {
        if let draft = message.discussionPlanDraft {
            DiscussionPlanDraftView(draft: draft, message: message)
        } else {
            Text(message.body).textSelection(.enabled)
                .accessibilityIdentifier("message.\(message.id)")
        }
    }
}

private struct DiscussionPlanDraftView: View {
    let draft: DiscussionPlanDraft
    let message: Message
    @State private var showsOriginal = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 12) {
                Text("Suggested plan").font(.headline)
                    .accessibilityIdentifier("message.plan.title.\(message.id)")
                if !draft.rationale.isEmpty {
                    Text(draft.rationale)
                        .accessibilityIdentifier("message.plan.rationale.\(message.id)")
                }
                ForEach(Array(draft.taskSpecs.enumerated()), id: \.offset) { index, task in
                    taskDetails(task, index: index)
                }
            }
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)

            // Keep the whole row a single accessible action. DisclosureGroup
            // in a selectable List cell can expose a synthetic outer button
            // whose activation point differs from its nested chevron.
            Button {
                showsOriginal.toggle()
            } label: {
                HStack {
                    Text(showsOriginal ? "Hide original reply" : "Show original reply")
                    Spacer()
                    Image(systemName: showsOriginal ? "chevron.down" : "chevron.right")
                        .foregroundStyle(.tint)
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(showsOriginal ? "Hide original reply" : "Show original reply")
            .accessibilityValue(showsOriginal ? "Expanded" : "Collapsed")
            .accessibilityIdentifier("message.plan.original.\(message.id)")

            if showsOriginal {
                Text(message.body).font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("message.\(message.id)")
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
    }

    private func taskDetails(_ task: DiscussionPlanDraft.TaskSpec, index: Int) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("\(index + 1). \(task.title)").font(.headline)
                .accessibilityIdentifier("message.plan.task.title.\(message.id).\(index)")
            if !task.description.isEmpty {
                Text(task.description).font(.subheadline)
                    .accessibilityIdentifier("message.plan.task.description.\(message.id).\(index)")
            }
            Text("Acceptance criteria").font(.caption).foregroundStyle(.secondary)
            ForEach(Array(task.acceptanceCriteria.enumerated()), id: \.offset) { criterionIndex, criterion in
                Text(criterion).font(.subheadline)
                    .accessibilityIdentifier("message.plan.task.criterion.\(message.id).\(index).\(criterionIndex)")
            }
            ForEach(Array(task.dependencies.enumerated()), id: \.offset) { dependencyIndex, dependency in
                Text(draft.dependencyLabel(dependency)).font(.subheadline)
                    .accessibilityIdentifier("message.plan.task.dependency.\(message.id).\(index).\(dependencyIndex)")
            }
            if !task.requiredCapabilities.isEmpty {
                Text("Capabilities: \(task.requiredCapabilities.joined(separator: ", "))").font(.caption)
                    .accessibilityIdentifier("message.plan.task.capabilities.\(message.id).\(index)")
            }
            if !task.expectedArtifacts.isEmpty {
                Text("Expected outputs").font(.caption).foregroundStyle(.secondary)
                ForEach(Array(task.expectedArtifacts.enumerated()), id: \.offset) { artifactIndex, artifact in
                    Text(artifact.description.isEmpty ? artifact.type : "\(artifact.type): \(artifact.description)").font(.subheadline)
                        .accessibilityIdentifier("message.plan.task.artifact.\(message.id).\(index).\(artifactIndex)")
                }
            }
        }
    }
}
