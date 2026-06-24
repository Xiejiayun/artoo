import SwiftUI

/// Approvals-first work surface: the primary reason a human opens the app is to
/// triage agent escalations. Lists pending approvals; each row opens a detail
/// with approve/reject.
public struct InboxView: View {
    @StateObject private var model: InboxViewModel

    public init(client: ApiClientProtocol) {
        _model = StateObject(wrappedValue: InboxViewModel(client: client))
    }

    public var body: some View {
        NavigationStack {
            StateView(state: model.state, retry: { Task { await model.load() } }) { approvals in
                if approvals.isEmpty {
                    EmptyStateView(
                        systemImage: "checkmark.seal",
                        title: "Inbox zero",
                        message: "No pending approvals. Agent escalations will appear here."
                    )
                } else {
                    List(approvals) { approval in
                        NavigationLink(value: approval) {
                            ApprovalRow(approval: approval)
                        }
                    }
                    .listStyle(.insetGrouped)
                }
            }
            .navigationTitle("Today")
            .navigationDestination(for: Approval.self) { approval in
                ApprovalDetailView(approval: approval, model: model)
            }
            .refreshable { await model.load() }
            .task { await model.load() }
        }
    }
}

private struct ApprovalRow: View {
    let approval: Approval

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(approval.action)
                    .font(.subheadline.weight(.semibold))
                Spacer()
                ApprovalStatusBadge(approval.status)
                RiskBadge(approval.risk)
            }
            if let summary = approval.summary, !summary.isEmpty {
                Text(summary)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, 4)
    }
}

public struct ApprovalDetailView: View {
    let approval: Approval
    @ObservedObject var model: InboxViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var comment: String = ""

    public var body: some View {
        Form {
            Section("Decision") {
                LabeledContent("Action", value: approval.action)
                LabeledContent("Risk") { RiskBadge(approval.risk) }
                LabeledContent("Status") { ApprovalStatusBadge(approval.status) }
            }
            if let summary = approval.summary, !summary.isEmpty {
                Section("Summary") { Text(summary) }
            }
            Section("Context") {
                if let taskId = approval.taskId { LabeledContent("Task", value: taskId) }
                if let runId = approval.runId { LabeledContent("Run", value: runId) }
                if let createdAt = approval.createdAt { LabeledContent("Created", value: createdAt) }
            }
            Section("Comment (optional)") {
                TextField("Add a note for the audit trail", text: $comment, axis: .vertical)
                    .lineLimit(1...4)
            }
            Section {
                Button {
                    Task {
                        await model.resolve(approval, approve: true, comment: trimmedComment)
                        dismiss()
                    }
                } label: {
                    Label("Approve", systemImage: "checkmark.circle.fill")
                }
                .disabled(model.isResolving(approval))

                Button(role: .destructive) {
                    Task {
                        await model.resolve(approval, approve: false, comment: trimmedComment)
                        dismiss()
                    }
                } label: {
                    Label("Reject", systemImage: "xmark.circle.fill")
                }
                .disabled(model.isResolving(approval))
            }
        }
        .navigationTitle("Approval")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var trimmedComment: String? {
        let trimmed = comment.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

#if DEBUG
struct InboxView_Previews: PreviewProvider {
    static var previews: some View {
        InboxView(client: MockApiClient.demo())
    }
}
#endif
