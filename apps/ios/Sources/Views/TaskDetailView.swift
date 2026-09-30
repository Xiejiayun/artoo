import SwiftUI
import QuickLook

/// Full task view: status, acceptance criteria, lifecycle actions, runs,
/// approvals, and artifacts. Drives the create → ready → assign → review loop.
public struct TaskDetailView: View {
    private enum InputField: Hashable { case approval, review }
    @StateObject private var model: TaskDetailViewModel
    @State private var showingAssign = false
    @State private var cancellingRun: Run?
    @State private var artifactURL: URL?
    @State private var artifactError: String?
    @State private var downloading = false
    @State private var reviewComment = ""
    @State private var executionApprovalDraft = ExecutionApprovalDraft()
    @State private var executionApprovalExpanded = false
    @FocusState private var focusedField: InputField?
    private let client: ApiClientProtocol

    public init(client: ApiClientProtocol, taskId: String) {
        self.client = client
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
                if snapshot.task.status == .ready { executionApprovalSection }
                if snapshot.task.status == .review {
                    Section("Review feedback") {
                        TextField("Comment or requested changes", text: $reviewComment, axis: .vertical).lineLimit(2...6)
                            .focused($focusedField, equals: .review)
                            .accessibilityIdentifier("task.review.comment.\(model.taskId)")
                    }
                }
                Section("Team work") {
                    if let roomId = snapshot.room?.id ?? snapshot.task.roomId {
                        NavigationLink("Messages, decisions and blockers") { CollaborationView(client: client, roomId: roomId, taskId: snapshot.task.id) }
                    }
                    NavigationLink("Dependencies") { DependenciesView(client: client, taskId: snapshot.task.id, projectId: snapshot.task.projectId) }
                }
                actionsSection
                runsSection(snapshot.runs)
                approvalsSection(snapshot.approvals)
                artifactsSection(snapshot.artifacts)
                if let artifactError { Section { Text(artifactError).foregroundStyle(.red) } }
            }
            .listStyle(.insetGrouped)
            .scrollDismissesKeyboard(.interactively)
        }
        .navigationTitle("Task")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                if focusedField != nil {
                    Spacer()
                    Button("Done") { focusedField = nil }
                        .accessibilityIdentifier("task.detail.keyboard.done")
                }
            }
        }
        .navigationDestination(for: Run.self) { run in
            RunSummaryView(run: run, client: client)
        }
        .sheet(isPresented: $showingAssign) {
            AssignSheet(client: client, model: model)
        }
        .refreshable { await model.load() }
        .liveRefresh { await model.load() }
        .quickLookPreview($artifactURL)
        .confirmationDialog("Stop this execution?", isPresented: Binding(get: { cancellingRun != nil }, set: { if !$0 { cancellingRun = nil } })) {
            Button("Stop run", role: .destructive) { if let run = cancellingRun { Task { await model.cancel(runId: run.id); cancellingRun = nil } } }
        }
    }

    // MARK: Sections

    private var executionApprovalSection: some View {
        Section("Execution approval") {
            if let approval = model.executionApproval {
                NavigationLink { TaskApprovalDetail(approval: approval, client: client) } label: { ApprovalCard(approval: approval) }
                if approval.status == .approved && approval.runId != nil {
                    Text("Approved for a prior run. Submit a new review request before assigning another execution.").font(.caption).foregroundStyle(.secondary)
                } else {
                    Text(model.executionBlocked ? "Assignment is blocked until this review is approved. The task stays Ready." : "Execution is approved. This task can now be assigned once.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            } else {
                Text("Request a review before assigning work that needs human approval. Once requested, execution waits for approval.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            DisclosureGroup(isExpanded: $executionApprovalExpanded) {
                TextField("Describe the work and its risk", text: $executionApprovalDraft.summary, axis: .vertical).lineLimit(3...8)
                    .focused($focusedField, equals: .approval)
                    .accessibilityIdentifier("task.approval.summary.\(model.taskId)")
                Picker("Risk", selection: $executionApprovalDraft.risk) {
                    Text("Low").tag("low"); Text("Medium").tag("medium"); Text("High").tag("high")
                }.pickerStyle(.segmented)
                    .accessibilityIdentifier("task.approval.risk.\(model.taskId)")
                if model.executionApproval != nil {
                    Text("Submitting again creates a new pending review and keeps previous decisions in the history.").font(.caption).foregroundStyle(.secondary)
                }
                Button("Request approval") {
                    // End editing so the submitted approval and root tabs are
                    // reachable while the request is being confirmed.
                    focusedField = nil
                    Task {
                        if await model.requestExecutionApproval(executionApprovalDraft) {
                            executionApprovalDraft = ExecutionApprovalDraft()
                            executionApprovalExpanded = false
                        }
                    }
                }.disabled(model.actionInFlight || !executionApprovalDraft.valid)
                    .accessibilityIdentifier("task.approval.request.\(model.taskId)")
            } label: {
                Text(model.executionApproval == nil ? "Request execution review" : "Submit an updated review request")
                    .accessibilityIdentifier("task.approval.disclosure.\(model.taskId)")
            }
        }
    }

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
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel("Task status")
                            .accessibilityValue(task.status.rawValue)
                            .accessibilityIdentifier("task.status.\(task.id)")
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
                    .accessibilityIdentifier("task.action.\(action.rawValue).\(model.taskId)")
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
                    if [.queued, .starting, .running, .awaitingInput, .paused].contains(run.status) {
                        Button("Stop \(run.id)", role: .destructive) { cancellingRun = run }.disabled(model.actionInFlight)
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
                    NavigationLink { TaskApprovalDetail(approval: approval, client: client) } label: { ApprovalCard(approval: approval) }
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
                        if artifact.uri.hasPrefix("/api/v1/artifacts/") {
                            Button(downloading ? "Downloading…" : "Preview or share") { Task { await download(artifact) } }.disabled(downloading)
                                .accessibilityIdentifier("artifact.preview.\(artifact.id)")
                        } else if let url = URL(string: artifact.uri), url.scheme == "https" {
                            Link("Open artifact", destination: url)
                        } else { Text("This older artifact was not uploaded to the server.").font(.caption).foregroundStyle(.secondary) }
                    }
                }
            }
        }
    }

    private func perform(_ action: TaskAction) {
        switch action {
        case .markReady: Task { await model.markReady() }
        case .retry: Task { await model.retry() }
        case .accept: Task { await model.review(accept: true, comment: reviewComment.isEmpty ? nil : reviewComment) }
        case .requestChanges: Task { await model.review(accept: false, comment: reviewComment.isEmpty ? nil : reviewComment) }
        case .assign: showingAssign = true
        }
    }

    private func download(_ artifact: Artifact) async {
        downloading = true; artifactError = nil; defer { downloading = false }
        do { artifactURL = try await client.downloadArtifact(artifact: artifact) }
        catch { artifactError = String(describing: error) }
    }
}

private struct TaskApprovalDetail: View {
    let approval: Approval
    @StateObject private var model: InboxViewModel
    init(approval: Approval, client: ApiClientProtocol) { self.approval = approval; _model = StateObject(wrappedValue: InboxViewModel(client: client)) }
    var body: some View { ApprovalDetailView(approval: approval, model: model) }
}

/// Auto-schedule or select an available instance from the server inventory.
private struct AssignSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var mode = "auto"
    @State private var agentInstanceId = ""
    @State private var instances: [WorkspaceRecord] = []
    @State private var agents: [WorkspaceRecord] = []
    @State private var computers: [WorkspaceRecord] = []
    @State private var error: String?
    let client: ApiClientProtocol
    @ObservedObject var model: TaskDetailViewModel

    var body: some View {
        NavigationStack {
            Form {
                Picker("Mode", selection: $mode) {
                    Text("Auto").tag("auto")
                    Text("Manual").tag("manual")
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("task.assignment.mode")
                if mode == "manual" {
                    Picker("Agent instance", selection: $agentInstanceId) {
                        Text("Choose agent").tag("")
                        ForEach(visibleInstances) { instance in
                            let label = AssigneeLabel(instance: instance, agents: agents, computers: computers, options: visibleInstances)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(label.name).font(.body)
                                Text(label.context).font(.caption).foregroundStyle(.secondary)
                                Text(label.workspace).font(.caption).foregroundStyle(.secondary)
                                    .lineLimit(2).truncationMode(.middle)
                                if let identity = label.identityDetail {
                                    Text(identity).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                                .accessibilityElement(children: .combine)
                                .tag(instance.id)
                                .accessibilityIdentifier("task.assignment.option.\(instance.id)")
                        }
                    }
                    .pickerStyle(.navigationLink)
                    .accessibilityIdentifier("task.assignment.instance")
                    .accessibilityValue(selectedAssignee?.accessibilityValue ?? "Choose agent")
                    if let selectedAssignee {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(selectedAssignee.context).font(.footnote).foregroundStyle(.secondary)
                            Text(selectedAssignee.workspace).font(.footnote).foregroundStyle(.secondary).textSelection(.enabled)
                            if let identity = selectedAssignee.identityDetail {
                                Text(identity).font(.footnote).foregroundStyle(.secondary).textSelection(.enabled)
                            }
                        }
                        .accessibilityIdentifier("task.assignment.selected.details")
                    }
                }
                if let message = model.actionError ?? error {
                    Text(message).foregroundStyle(.red)
                        .accessibilityIdentifier("task.assignment.error")
                }
                if model.actionInFlight { ProgressView("Assigning task…").accessibilityIdentifier("task.assignment.progress") }
            }
            .disabled(model.actionInFlight)
            .navigationTitle("Assign Task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(model.actionInFlight)
                        .accessibilityIdentifier("task.assignment.cancel")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Assign") {
                        let selectedMode = mode
                        let trimmed = agentInstanceId.trimmingCharacters(in: .whitespaces)
                        Task {
                            if await model.assign(mode: selectedMode, agentInstanceId: trimmed.isEmpty ? nil : trimmed) { dismiss() }
                        }
                    }
                    .disabled(model.actionInFlight || (mode == "manual" && agentInstanceId.trimmingCharacters(in: .whitespaces).isEmpty))
                    .accessibilityIdentifier("task.assignment.confirm")
                }
            }
            .task {
                do {
                    let bootstrap = try await client.resource(path: "/api/v1/bootstrap")
                    instances = bootstrap["agent_instances"].records
                    agents = bootstrap["agents"].records
                    computers = bootstrap["computers"].records
                }
                catch { self.error = String(describing: error) }
            }
        }
        .interactiveDismissDisabled(model.actionInFlight)
    }

    private var visibleInstances: [WorkspaceRecord] { instances.filter { $0.status != "disabled" } }

    private var selectedAssignee: AssigneeLabel? {
        instances.first { $0.id == agentInstanceId }.map {
            AssigneeLabel(instance: $0, agents: agents, computers: computers, options: visibleInstances)
        }
    }
}

public struct RunSummaryView: View {
    @State private var run: Run
    @State private var loadError: String?
    @State private var usage: RunUsage?
    @State private var usageError: String?
    @State private var usageLoaded = false
    private let client: ApiClientProtocol?

    public init(run: Run, client: ApiClientProtocol? = nil) { _run = State(initialValue: run); self.client = client }

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
            Section("Provider usage") {
                if let usage {
                    LabeledContent("Input tokens", value: usage.inputTokens.map(String.init) ?? "Unavailable")
                    LabeledContent("Output tokens", value: usage.outputTokens.map(String.init) ?? "Unavailable")
                    LabeledContent("Cached input tokens", value: usage.cachedInputTokens.map(String.init) ?? "Unavailable")
                    LabeledContent("Cost (USD)", value: usage.costUsd.map { String(format: "%.6f", $0) } ?? "Unavailable")
                    Text("Reported by the provider · \(usage.updatedAt)").font(.caption).foregroundStyle(.secondary)
                } else if !usageLoaded && client != nil {
                    ProgressView("Loading usage…")
                } else {
                    Text("Usage unavailable. The provider has not supplied verified measurements.").foregroundStyle(.secondary)
                }
                if let usageError { Text(usageError).font(.caption).foregroundStyle(.red) }
            }
            if let loadError { Section { Text(loadError).foregroundStyle(.red) } }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Run Summary")
        .navigationBarTitleDisplayMode(.inline)
        .liveRefresh {
            guard let client else { return }
            do { run = try await client.getRun(runId: run.id); loadError = nil }
            catch { loadError = String(describing: error) }
            do {
                let value = try await client.resource(path: "/api/v1/runs/\(apiPart(run.id))/usage")
                usage = try ArtooJSON.decoder().decode(RunUsageResponse.self, from: JSONEncoder().encode(value)).usage
                usageError = nil
            } catch { usage = nil; usageError = "Usage could not be confirmed: \(error)" }
            usageLoaded = true
        }
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
            Text(approval.actionLabel)
                .font(ArtooTokens.Typography.subheadline.weight(.semibold))
                .foregroundStyle(ArtooTokens.ColorToken.text)
                .lineLimit(2)
            ApprovalBadges(approval: approval)
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
        .accessibilityLabel("\(approval.actionLabel), \(approval.status.label), \(approval.risk.label) risk")
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
