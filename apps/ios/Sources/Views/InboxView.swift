import SwiftUI

/// Approvals-first work surface: the primary reason a human opens the app is to
/// triage agent escalations. Keeps pending and needs-information approvals
/// reachable until a final decision; each row opens approve/reject details.
public struct InboxView: View {
    @EnvironmentObject private var container: AppContainer
    @StateObject private var model: InboxViewModel
    private let client: ApiClientProtocol

    public init(client: ApiClientProtocol) {
        self.client = client
        _model = StateObject(wrappedValue: InboxViewModel(client: client))
    }

    public var body: some View {
        NavigationStack {
            StateView(state: model.state, retry: { Task { await model.load() } }) { approvals in
                if approvals.isEmpty {
                    EmptyStateView(
                        systemImage: "checkmark.seal",
                        title: "No approvals need attention",
                        message: "Pending reviews and requests for more information appear here. Mentions are available from the @ button."
                    )
                } else {
                    List {
                        Section {
                            ArtooPageIntro(title: "Keep work moving", message: "Review the decisions waiting on you, with the highest risk first.", systemImage: "tray.full.fill")
                                .listRowBackground(Color.clear)
                        }
                        ForEach(riskSections(approvals), id: \.risk.rawValue) { section in
                            Section {
                                ForEach(section.approvals) { approval in
                                    NavigationLink(value: approval) {
                                        ApprovalRow(approval: approval)
                                    }
                                    .accessibilityIdentifier("inbox.approval.\(approval.id)")
                                }
                            } header: {
                                ArtooSectionHeading(title: "\(section.risk.label) risk", count: section.approvals.count)
                            }
                        }
                    }
                    .listStyle(.insetGrouped)
                }
            }
            .navigationTitle("Today")
            .toolbar { ToolbarItem(placement: .topBarTrailing) { NavigationLink { MentionsView(client: client) } label: {
                Label(container.mentionsTitle, systemImage: "at")
                    .accessibilityHint(container.notificationCountSummary)
            }.accessibilityIdentifier("inbox.mentions") } }
            .navigationDestination(for: Approval.self) { approval in
                ApprovalDetailView(approval: approval, model: model)
            }
            .refreshable { await model.load() }
            .liveRefresh { await model.load() }
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
            Text(approval.actionLabel)
                .font(ArtooTokens.Typography.subheadline.weight(.semibold))
                .foregroundStyle(ArtooTokens.ColorToken.text)
                .lineLimit(2)
            ApprovalBadges(approval: approval)
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
        .padding(.vertical, ArtooTokens.Spacing.xs)
        .padding(.leading, ArtooTokens.Spacing.xs)
        .overlay(alignment: .leading) {
            RoundedRectangle(cornerRadius: ArtooTokens.Radius.pill)
                .fill(riskColor)
                .frame(width: 4)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(approval.actionLabel), \(approval.risk.label) risk, \(approval.status.label)")
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
                        Text(approval.actionLabel)
                            .font(ArtooTokens.Typography.headline)
                            .foregroundStyle(ArtooTokens.ColorToken.text)
                            .fixedSize(horizontal: false, vertical: true)
                        ApprovalBadges(approval: approval)
                        ArtooMetadataGrid([
                            ("Task", approval.taskId),
                            ("Run", approval.runId),
                ("Created", ConversationMetadata.timestamp(approval.createdAt))
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
                Section("Summary") { Text(summary).accessibilityIdentifier("approval.summary.\(approval.id)") }
            }
            if approval.action == "execution.start" {
                Section { Text("This review allows one execution of the ready task. Retrying requires a new review. It does not approve individual commands during execution.").font(.caption).foregroundStyle(.secondary) }
            }
            if (approval.status == .pending || approval.status == .needsMoreInfo) && approval.payloadRef != "execution-gate/superseded" {
                Section("Comment (optional)") {
                    TextField("Add a note for the audit trail", text: $comment, axis: .vertical)
                        .lineLimit(1...4)
                }
                Section {
                    decisionButton(.approved, systemImage: "checkmark.circle.fill")
                    if approval.status == .pending { decisionButton(.needsMoreInfo, systemImage: "questionmark.circle.fill") }
                    decisionButton(.rejected, systemImage: "xmark.circle.fill", role: .destructive)
                }
            }
            if let error = model.state.errorMessage { Section { Text(error).foregroundStyle(.red) } }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Approval")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func decisionButton(_ decision: ApprovalDecision, systemImage: String, role: ButtonRole? = nil) -> some View {
        Button(role: role) {
            Task {
                if await model.resolve(approval, decision: decision, comment: trimmedComment) { dismiss() }
            }
        } label: {
            HStack {
                Label(decision.label, systemImage: systemImage)
                Spacer()
                if model.isResolving(approval) {
                    ProgressView()
                }
            }
            .frame(minHeight: 44)
        }
        .disabled(model.isResolving(approval))
        .accessibilityIdentifier("approval.decision.\(decision.rawValue).\(approval.id)")
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
        InboxView(client: MockApiClient.demo()).environmentObject(AppContainer(config: AppConfig(useMock: true)))
    }
}
#endif
