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
            AssignSheet { type, id in
                Task { await model.assign(assigneeType: type, assigneeId: id) }
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
                        Text(priority.uppercased())
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.secondary)
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
                            Text(approval.status.label).font(.caption).foregroundStyle(.secondary)
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

/// Minimal assign sheet: pick an assignee type and id. A richer agent picker is
/// a follow-up once the agents/scheduler contracts (#15) land.
private struct AssignSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var assigneeType = "agent"
    @State private var assigneeId = ""
    let onAssign: (String, String) -> Void

    var body: some View {
        NavigationStack {
            Form {
                Picker("Type", selection: $assigneeType) {
                    Text("Agent").tag("agent")
                    Text("User").tag("user")
                }
                .pickerStyle(.segmented)
                TextField("Assignee id (e.g. agent_claude)", text: $assigneeId)
                    .autocorrectionDisabled()
            }
            .navigationTitle("Assign Task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Assign") {
                        onAssign(assigneeType, assigneeId.trimmingCharacters(in: .whitespaces))
                        dismiss()
                    }
                    .disabled(assigneeId.trimmingCharacters(in: .whitespaces).isEmpty)
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
            if let summary = run.summary, !summary.isEmpty {
                Section("Summary") { Text(summary) }
            }
            if let error = run.error, !error.isEmpty {
                Section("Error") { Text(error).foregroundStyle(.red) }
            }
            Section("Timing") {
                if let createdAt = run.createdAt { LabeledContent("Created", value: createdAt) }
                if let updatedAt = run.updatedAt { LabeledContent("Updated", value: updatedAt) }
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
