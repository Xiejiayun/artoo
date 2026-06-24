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
            VStack(alignment: .leading, spacing: 8) {
                Text(task.title).font(.headline)
                HStack {
                    StatusBadge(task.status)
                    if let priority = task.priority {
                        PriorityBadge(priority)
                    }
                }
            }
            .padding(.vertical, 2)
        }
    }

    @ViewBuilder
    private func criteriaSection(_ task: TaskItem) -> some View {
        if let criteria = task.acceptanceCriteria, !criteria.isEmpty {
            Section("Acceptance criteria") {
                ForEach(Array(criteria.enumerated()), id: \.offset) { _, item in
                    Label(item, systemImage: "checkmark.circle")
                        .font(.callout)
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
                            if model.actionInFlight { ProgressView() }
                        }
                    }
                    .disabled(model.actionInFlight)
                }
                if let error = model.actionError {
                    Text(error).foregroundStyle(.red).font(.callout)
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
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(run.id).font(.subheadline)
                                if let runtime = run.runtimeId {
                                    Text(runtime).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            RunStatusBadge(run.status)
                        }
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
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(approval.action).font(.subheadline)
                            ApprovalStatusBadge(approval.status)
                        }
                        Spacer()
                        RiskBadge(approval.risk)
                    }
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
                        Text(artifact.type).font(.subheadline)
                        Text(artifact.uri)
                            .font(.caption)
                            .foregroundStyle(.secondary)
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
        Form {
            Section("Run") {
                LabeledContent("Id", value: run.id)
                LabeledContent("Status") { RunStatusBadge(run.status) }
                if let runtime = run.runtimeId { LabeledContent("Runtime", value: runtime) }
                if let computer = run.computerId { LabeledContent("Computer", value: computer) }
                if let agent = run.agentInstanceId { LabeledContent("Agent", value: agent) }
            }
            if let failureReason = run.failureReason, !failureReason.isEmpty {
                Section("Failure") { Text(failureReason).foregroundStyle(.red) }
            }
            Section("Timing") {
                if let createdAt = run.createdAt { LabeledContent("Created", value: createdAt) }
                if let startedAt = run.startedAt { LabeledContent("Started", value: startedAt) }
                if let endedAt = run.endedAt { LabeledContent("Ended", value: endedAt) }
                if let sequence = run.sequence { LabeledContent("Sequence", value: String(sequence)) }
            }
        }
        .navigationTitle("Run Summary")
        .navigationBarTitleDisplayMode(.inline)
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
