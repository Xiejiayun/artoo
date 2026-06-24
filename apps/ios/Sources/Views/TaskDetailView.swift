import SwiftUI

/// Full task view: status, acceptance criteria, lifecycle actions, runs,
/// approvals, and artifacts. Drives the create → ready → assign → review loop.
public struct TaskDetailView: View {
    @StateObject private var model: TaskDetailViewModel
    @State private var showingAssign = false

    public init(client: ApiClientProtocol, taskId: String) {
        _model = StateObject(wrappedValue: TaskDetailViewModel(client: client, taskId: taskId))
    }

    public var body: some View {
        StateView(state: model.state, retry: { Task { await model.load() } }) { snapshot in
            List {
                headerSection(snapshot.task)
                if let description = snapshot.task.description, !description.isEmpty {
                    Section("Description") { Text(description) }
                }
                criteriaSection(snapshot.task)
                actionsSection
                runsSection(snapshot.runs)
                approvalsSection(snapshot.approvals)
                artifactsSection(snapshot.artifacts)
            }
            .listStyle(.insetGrouped)
        }
        .navigationTitle("Task")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(for: Run.self) { run in
            RunSummaryView(run: run)
        }
        .sheet(isPresented: $showingAssign) {
            AssignSheet { mode, agentInstanceId in
                Task { await model.assign(mode: mode, agentInstanceId: agentInstanceId) }
            }
        }
        .refreshable { await model.load() }
        .task { await model.load() }
    }

    // MARK: Sections

    private func headerSection(_ task: TaskItem) -> some View {
        Section {
            ArtooSectionCard {
                VStack(alignment: .leading, spacing: ArtooTokens.Spacing.sm) {
                    Text(task.title)
                        .font(ArtooTokens.Typography.headline)
                        .foregroundStyle(ArtooTokens.ColorToken.text)
                        .fixedSize(horizontal: false, vertical: true)

                    HStack(spacing: ArtooTokens.Spacing.xs) {
                        StatusBadge(task.status)
                        if let priority = task.priority {
                            PriorityBadge(priority)
                        }
                    }

                    ArtooMetadataGrid([
                        ("Assignee", task.assigneeId),
                        ("Type", task.assigneeType),
                        ("Updated", task.updatedAt),
                        ("Created", task.createdAt),
                        ("Task", task.id)
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
    }

    @ViewBuilder
    private func criteriaSection(_ task: TaskItem) -> some View {
        if let criteria = task.acceptanceCriteria, !criteria.isEmpty {
            Section("Acceptance criteria") {
                ForEach(Array(criteria.enumerated()), id: \.offset) { _, item in
                    Label(item, systemImage: "checkmark.circle")
                        .font(ArtooTokens.Typography.body)
                        .foregroundStyle(ArtooTokens.ColorToken.text)
                }
            }
        }
    }

    @ViewBuilder
    private var actionsSection: some View {
        let actions = model.availableActions
        if !actions.isEmpty || model.actionError != nil {
            Section("Actions") {
                ForEach(actions, id: \.self) { action in
                    Button {
                        perform(action)
                    } label: {
                        HStack {
                            Text(action.label)
                            Spacer()
                            if model.actionInFlight {
                                ProgressView()
                            } else {
                                Image(systemName: action.systemImage)
                                    .foregroundStyle(ArtooTokens.ColorToken.accent)
                                    .accessibilityHidden(true)
                            }
                        }
                    }
                    .disabled(model.actionInFlight)
                    .accessibilityHint(action.accessibilityHint)
                }
                if let error = model.actionError {
                    Text(error)
                        .foregroundStyle(ArtooTokens.ColorToken.danger)
                        .font(ArtooTokens.Typography.body)
                }
            }
        }
    }

    @ViewBuilder
    private func runsSection(_ runs: [Run]) -> some View {
        if !runs.isEmpty {
            Section("Runs") {
                ForEach(runs) { run in
                    NavigationLink(value: run) {
                        RunTimelineRow(run: run)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func approvalsSection(_ approvals: [Approval]) -> some View {
        if !approvals.isEmpty {
            Section("Approvals") {
                ForEach(approvals) { approval in
                    ApprovalCard(approval: approval)
                }
            }
        }
    }

    @ViewBuilder
    private func artifactsSection(_ artifacts: [Artifact]) -> some View {
        if !artifacts.isEmpty {
            Section("Artifacts") {
                ForEach(artifacts) { artifact in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(artifact.type)
                            .font(ArtooTokens.Typography.subheadline.weight(.semibold))
                        Text(artifact.uri)
                            .font(ArtooTokens.Typography.caption)
                            .foregroundStyle(ArtooTokens.ColorToken.textMuted)
                            .lineLimit(1)
                    }
                }
            }
        }
    }

    private func perform(_ action: TaskAction) {
        switch action {
        case .markReady: Task { await model.markReady() }
        case .retry: Task { await model.retry() }
        case .accept: Task { await model.review(accept: true) }
        case .requestChanges: Task { await model.review(accept: false) }
        case .assign: showingAssign = true
        }
    }
}

/// Minimal assign sheet: auto-schedule or pin an agent instance id. A richer
/// picker over the backed Agents inventory is a product follow-up.
private struct AssignSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var mode = "auto"
    @State private var agentInstanceId = ""
    let onAssign: (String, String?) -> Void

    var body: some View {
        NavigationStack {
            Form {
                Picker("Mode", selection: $mode) {
                    Text("Auto").tag("auto")
                    Text("Manual").tag("manual")
                }
                .pickerStyle(.segmented)
                if mode == "manual" {
                    TextField("Agent instance id", text: $agentInstanceId)
                        .autocorrectionDisabled()
                }
            }
            .navigationTitle("Assign Task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Assign") {
                        let trimmed = agentInstanceId.trimmingCharacters(in: .whitespaces)
                        onAssign(mode, trimmed.isEmpty ? nil : trimmed)
                        dismiss()
                    }
                    .disabled(mode == "manual" && agentInstanceId.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }
}

public struct RunSummaryView: View {
    let run: Run

    public init(run: Run) { self.run = run }

    public var body: some View {
        List {
            Section("Run") {
                ArtooSectionCard {
                    VStack(alignment: .leading, spacing: ArtooTokens.Spacing.sm) {
                        HStack(alignment: .firstTextBaseline) {
                            Text("Run \(run.sequence.map(String.init) ?? run.id)")
                                .font(ArtooTokens.Typography.headline)
                                .foregroundStyle(ArtooTokens.ColorToken.text)
                            Spacer()
                            RunStatusBadge(run.status)
                        }
                        ArtooMetadataGrid([
                            ("Run", run.id),
                            ("Task", run.taskId),
                            ("Runtime", run.runtimeId),
                            ("Computer", run.computerId),
                            ("Agent", run.agentInstanceId),
                            ("Context", run.contextPackId)
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
            if let failureReason = run.failureReason, !failureReason.isEmpty {
                Section("Failure") {
                    Label(failureReason, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(ArtooTokens.ColorToken.danger)
                        .font(ArtooTokens.Typography.body)
                }
            }
            Section("Timing") {
                if let createdAt = run.createdAt { LabeledContent("Created", value: createdAt) }
                if let startedAt = run.startedAt { LabeledContent("Started", value: startedAt) }
                if let endedAt = run.endedAt { LabeledContent("Ended", value: endedAt) }
                if let sequence = run.sequence { LabeledContent("Sequence", value: String(sequence)) }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Run Summary")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct RunTimelineRow: View {
    let run: Run

    var body: some View {
        HStack(alignment: .top, spacing: ArtooTokens.Spacing.sm) {
            VStack(spacing: ArtooTokens.Spacing.xxs) {
                Circle()
                    .fill(statusColor)
                    .frame(width: 12, height: 12)
                Rectangle()
                    .fill(statusColor.opacity(0.35))
                    .frame(width: 2, height: 34)
            }
            .padding(.top, ArtooTokens.Spacing.xxs)
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: ArtooTokens.Spacing.xs) {
                HStack(alignment: .firstTextBaseline) {
                    Text(run.id)
                        .font(ArtooTokens.Typography.subheadline.weight(.semibold))
                        .foregroundStyle(ArtooTokens.ColorToken.text)
                        .lineLimit(1)
                    Spacer()
                    RunStatusBadge(run.status)
                }
                ArtooMetadataGrid([
                    ("Runtime", run.runtimeId),
                    ("Agent", run.agentInstanceId),
                    ("Started", run.startedAt ?? run.createdAt)
                ])
                if let failure = run.failureReason, !failure.isEmpty {
                    Text(failure)
                        .font(ArtooTokens.Typography.caption)
                        .foregroundStyle(ArtooTokens.ColorToken.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.vertical, ArtooTokens.Spacing.xxs)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Run \(run.id), \(run.status.label)")
    }

    private var statusColor: Color {
        switch run.status {
        case .completed: return ArtooTokens.ColorToken.success
        case .failed, .cancelled: return ArtooTokens.ColorToken.danger
        case .awaitingInput, .paused: return ArtooTokens.ColorToken.warning
        case .running, .starting: return ArtooTokens.ColorToken.info
        case .queued, .other: return ArtooTokens.ColorToken.neutral
        }
    }
}

private struct ApprovalCard: View {
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
                    .fixedSize(horizontal: false, vertical: true)
            }
            ArtooMetadataGrid([
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
        .accessibilityLabel("\(approval.action), \(approval.status.label), \(approval.risk.label) risk")
    }

    private var riskColor: Color {
        switch approval.risk {
        case .high: return ArtooTokens.ColorToken.danger
        case .medium: return ArtooTokens.ColorToken.warning
        case .low, .other: return ArtooTokens.ColorToken.neutral
        }
    }
}

private extension TaskAction {
    var systemImage: String {
        switch self {
        case .markReady: return "checkmark.circle"
        case .assign: return "person.crop.circle.badge.plus"
        case .retry: return "arrow.clockwise.circle"
        case .accept: return "checkmark.seal"
        case .requestChanges: return "arrow.uturn.backward.circle"
        }
    }

    var accessibilityHint: String {
        switch self {
        case .markReady: return "Marks the task ready for assignment"
        case .assign: return "Opens assignment options"
        case .retry: return "Retries the blocked task"
        case .accept: return "Accepts the task review"
        case .requestChanges: return "Requests changes for this task"
        }
    }
}

#if DEBUG
struct TaskDetailView_Previews: PreviewProvider {
    static var previews: some View {
        NavigationStack {
            TaskDetailView(client: MockApiClient.demo(), taskId: "task_1")
        }
    }
}
#endif
