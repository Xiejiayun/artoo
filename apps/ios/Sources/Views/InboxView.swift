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
                    List {
                        ForEach(riskSections(approvals), id: \.risk.rawValue) { section in
                            Section {
                                ForEach(section.approvals) { approval in
                                    NavigationLink(value: approval) {
                                        ApprovalRow(approval: approval)
                                    }
                                }
                            } header: {
                                HStack {
                                    Text("\(section.risk.label) risk")
                                    Spacer()
                                    Text("\(section.approvals.count)")
                                        .font(ArtooTokens.Typography.caption)
                                        .foregroundStyle(ArtooTokens.ColorToken.textMuted)
                                }
                            }
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

    private func riskSections(_ approvals: [Approval]) -> [(risk: RiskLevel, approvals: [Approval])] {
        let order: [RiskLevel] = [.high, .medium, .low]
        var sections = order.compactMap { risk in
            let matches = approvals.filter { $0.risk == risk }
            return matches.isEmpty ? nil : (risk, matches)
        }
        let known = Set(order.map { $0.rawValue })
        let trailingRisks = Set(approvals.map(\.risk.rawValue)).subtracting(known).sorted()
        for riskRaw in trailingRisks {
            let risk = RiskLevel(rawValue: riskRaw)
            let matches = approvals.filter { $0.risk == risk }
            if !matches.isEmpty {
                sections.append((risk, matches))
            }
        }
        return sections
    }
}

private struct ApprovalRow: View {
    let approval: Approval

    var body: some View {
        VStack(alignment: .leading, spacing: ArtooTokens.Spacing.xs) {
            HStack(alignment: .firstTextBaseline, spacing: ArtooTokens.Spacing.xs) {
                Text(approval.action)
                    .font(ArtooTokens.Typography.subheadline.weight(.semibold))
                    .foregroundStyle(ArtooTokens.ColorToken.text)
                    .lineLimit(2)
                Spacer()
                ApprovalStatusBadge(approval.status)
                RiskBadge(approval.risk)
            }
            if let summary = approval.summary, !summary.isEmpty {
                Text(summary)
                    .font(ArtooTokens.Typography.caption)
                    .foregroundStyle(ArtooTokens.ColorToken.textMuted)
                    .lineLimit(2)
            }
            ArtooMetadataGrid([
                ("Task", approval.taskId),
                ("Run", approval.runId),
                ("Created", approval.createdAt)
            ])
        }
        .padding(.vertical, ArtooTokens.Spacing.xxs)
        .padding(.leading, ArtooTokens.Spacing.xs)
        .overlay(alignment: .leading) {
            RoundedRectangle(cornerRadius: ArtooTokens.Radius.pill)
                .fill(riskColor)
                .frame(width: 4)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(approval.action), \(approval.risk.label) risk, \(approval.status.label)")
    }

    private var riskColor: Color {
        switch approval.risk {
        case .high: return ArtooTokens.ColorToken.danger
        case .medium: return ArtooTokens.ColorToken.warning
        case .low: return ArtooTokens.ColorToken.neutral
        case .other: return ArtooTokens.ColorToken.neutral
        }
    }
}

public struct ApprovalDetailView: View {
    let approval: Approval
    @ObservedObject var model: InboxViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var comment: String = ""

    public var body: some View {
        List {
            Section("Decision") {
                ArtooSectionCard {
                    VStack(alignment: .leading, spacing: ArtooTokens.Spacing.sm) {
                        Text(approval.action)
                            .font(ArtooTokens.Typography.headline)
                            .foregroundStyle(ArtooTokens.ColorToken.text)
                            .fixedSize(horizontal: false, vertical: true)
                        HStack(spacing: ArtooTokens.Spacing.xs) {
                            ApprovalStatusBadge(approval.status)
                            RiskBadge(approval.risk)
                        }
                        ArtooMetadataGrid([
                            ("Task", approval.taskId),
                            ("Run", approval.runId),
                            ("Created", approval.createdAt)
                        ])
                    }
                }
                .listRowInsets(EdgeInsets(
                    top: ArtooTokens.Spacing.sm,
                    leading: ArtooTokens.Spacing.md,
                    bottom: ArtooTokens.Spacing.sm,
                    trailing: ArtooTokens.Spacing.md
                ))
                .listRowBackground(Color.clear)
            }
            if let summary = approval.summary, !summary.isEmpty {
                Section("Summary") { Text(summary) }
            }
            Section("Comment (optional)") {
                TextField("Add a note for the audit trail", text: $comment, axis: .vertical)
                    .lineLimit(1...4)
            }
            Section {
                decisionButton(.approved, systemImage: "checkmark.circle.fill")
                decisionButton(.needsMoreInfo, systemImage: "questionmark.circle.fill")
                decisionButton(.rejected, systemImage: "xmark.circle.fill", role: .destructive)
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Approval")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func decisionButton(_ decision: ApprovalDecision, systemImage: String, role: ButtonRole? = nil) -> some View {
        Button(role: role) {
            Task {
                await model.resolve(approval, decision: decision, comment: trimmedComment)
                dismiss()
            }
        } label: {
            HStack {
                Label(decision.label, systemImage: systemImage)
                Spacer()
                if model.isResolving(approval) {
                    ProgressView()
                }
            }
        }
        .disabled(model.isResolving(approval))
        .accessibilityHint("Resolves this approval as \(decision.label)")
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
