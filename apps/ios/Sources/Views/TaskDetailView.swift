import SwiftUI
import QuickLook
import UIKit

/// Full task view: status, acceptance criteria, lifecycle actions, runs,
/// approvals, and artifacts. Drives the create → ready → assign → review loop.
public struct TaskDetailView: View {
    private enum InputField: Hashable { case approval, review }
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @StateObject private var model: TaskDetailViewModel
    @State private var showingAssign = false
    @State private var artifactURL: URL?
    @State private var artifactError: String?
    @State private var downloading = false
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
                actionsSection
                if let description = snapshot.task.description, !description.isEmpty {
                    Section("Description") { Text(description) }
                }
                criteriaSection(snapshot.task)
                reviewHistorySection(snapshot)
                if snapshot.task.status == .ready { executionApprovalSection }
                if snapshot.task.status == .review {
                    Section("New review feedback") {
                        TextField("Comment or requested changes", text: $model.reviewComment, axis: .vertical).lineLimit(2...6)
                            .focused($focusedField, equals: .review)
                            .disabled(model.actionInFlight)
                            .accessibilityIdentifier("task.review.comment.\(model.taskId)")
                    }
                }
                Section("Team work") {
                    if let roomId = snapshot.room?.id ?? snapshot.task.roomId {
                        NavigationLink { CollaborationView(client: client, roomId: roomId, taskId: snapshot.task.id) } label: {
                            Label("Messages, decisions and blockers", systemImage: "bubble.left.and.bubble.right")
                        }
                    }
                    NavigationLink { DependenciesView(client: client, taskId: snapshot.task.id, projectId: snapshot.task.projectId) } label: {
                        Label("Dependencies", systemImage: "arrow.triangle.branch")
                    }
                }
                runsSection(snapshot.runs)
                approvalsSection(snapshot.approvals)
                artifactsSection(snapshot.artifacts, runs: snapshot.runs, taskId: snapshot.task.id)
                if let artifactError { Section { Text(artifactError).foregroundStyle(.red) } }
            }
            .listStyle(.insetGrouped)
            .scrollDismissesKeyboard(.interactively)
        }
        .navigationTitle("Task")
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            if let error = model.actionError {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(ArtooTokens.ColorToken.danger)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
                    .background(.regularMaterial)
                    .accessibilityIdentifier("task.action.error.\(model.taskId)")
            }
        }
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                if focusedField != nil {
                    Spacer()
                    Button("Done") { focusedField = nil }
                        .accessibilityIdentifier("task.detail.keyboard.done")
                }
            }
        }
        .sheet(isPresented: $showingAssign) {
            AssignSheet(client: client, model: model)
        }
        .refreshable { await model.load() }
        .liveRefresh { await model.load() }
        .quickLookPreview($artifactURL)
        .alert("Stop this execution?", isPresented: Binding(get: { model.stopConfirmation != nil }, set: { if !$0 { model.keepRunning() } }), presenting: model.stopConfirmation) { run in
            Button("Stop run and cancel task", role: .destructive) { Task { await model.cancel(runId: run.id) } }
                .accessibilityIdentifier("task.run.stop.confirm.\(run.id)")
            Button("Keep running", role: .cancel) { model.keepRunning() }
                .accessibilityIdentifier("task.run.stop.keep.\(run.id)")
        } message: { run in
            Text("\(run.displayTitle) · \(run.id)\n\nStopping this execution also cancels its task. Files already written to the workspace are kept for recovery. Existing artifacts remain available.")
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
                        .font(.title2.weight(.semibold))
                        .foregroundStyle(ArtooTokens.ColorToken.text)
                        .fixedSize(horizontal: false, vertical: true)

                    let badgeLayout = dynamicTypeSize.isAccessibilitySize
                        ? AnyLayout(VStackLayout(alignment: .leading, spacing: ArtooTokens.Spacing.xs))
                        : AnyLayout(HStackLayout(spacing: ArtooTokens.Spacing.xs))
                    badgeLayout {
                        StatusBadge(task.status)
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel("Task status")
                            .accessibilityValue(task.status.rawValue)
                            .accessibilityIdentifier("task.status.\(task.id)")
                        if let priority = task.priority {
                            PriorityBadge(priority)
                        }
                    }

                    Text(nextStep(task)).font(.subheadline).foregroundStyle(ArtooTokens.ColorToken.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                    DisclosureGroup("Task details") {
                        ArtooMetadataGrid([
                            ("Assignee", task.assigneeId ?? "Unassigned"),
                            ("Type", task.assigneeType),
                            ("Updated", ConversationMetadata.timestamp(task.updatedAt)),
                            ("Created", ConversationMetadata.timestamp(task.createdAt)),
                            ("Task", task.id)
                        ]).padding(.top, 8)
                    }.font(.subheadline).frame(minHeight: 44)
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

    private func nextStep(_ task: TaskItem) -> String {
        switch task.status {
        case .backlog: return "Check the outcome and acceptance criteria, then mark this task ready for assignment."
        case .ready: return model.executionBlocked ? "This task is ready. Assignment will unlock when its execution review is approved." : "Ready for assignment. Choose an agent or let the scheduler find a match."
        case .assigned: return "Assigned to an agent. Follow the conversation and execution activity below."
        case .running, .inProgress: return "Work is in progress. Review live execution activity and any requests for your input."
        case .awaitingApproval: return "Your decision is needed. Review the pending approval before work can continue."
        case .blocked: return "Work needs attention. Review the latest run and blockers before retrying."
        case .review: return "The work is ready for your review. Check the outputs and criteria, then accept or request changes."
        case .done: return "Work is complete. The conversation, outputs, and execution history remain available below."
        case .cancelled: return "This task was cancelled. Its conversation and execution history remain available below."
        case .other: return "Review the task details, conversation, and latest execution activity."
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
        if !actions.isEmpty {
            Section("Next step") {
                ForEach(actions, id: \.self) { action in
                    Button {
                        perform(action)
                    } label: {
                        HStack {
                            Label(action.label, systemImage: action.systemImage).font(.body.weight(.semibold))
                            Spacer()
                            if model.actionInFlight {
                                ProgressView()
                            } else {
                                Image(systemName: action.systemImage)
                                    .foregroundStyle(ArtooTokens.ColorToken.accent)
                                    .accessibilityHidden(true)
                            }
                        }
                        .frame(minHeight: 44)
                    }
                    .disabled(model.actionInFlight)
                    .accessibilityIdentifier("task.action.\(action.rawValue).\(model.taskId)")
                    .accessibilityHint(action.accessibilityHint)
                }
            }
        }
    }

    @ViewBuilder
    private func runsSection(_ runs: [Run]) -> some View {
        if !runs.isEmpty {
            Section("Runs") {
                ForEach(runs) { run in
                    NavigationLink {
                        RunSummaryView(run: run, client: client)
                    } label: {
                        RunTimelineRow(run: run)
                    }
                    .accessibilityIdentifier("task.run.\(run.id)")
                    if run.canStop {
                        Button("Stop \(run.displayTitle.lowercased())", role: .destructive) { model.requestStop(runId: run.id) }
                            .disabled(model.actionInFlight)
                            .accessibilityIdentifier("task.run.stop.request.\(run.id)")
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
    private func artifactsSection(_ artifacts: [Artifact], runs: [Run], taskId: String) -> some View {
        if !artifacts.isEmpty {
            Section("Artifacts") {
                ForEach(artifacts) { artifact in
                    VStack(alignment: .leading, spacing: ArtooTokens.Spacing.sm) {
                        Text(artifact.displayName)
                            .font(ArtooTokens.Typography.subheadline.weight(.semibold))
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("artifact.name.\(artifact.id)")
                        ArtifactProvenance(artifact: artifact, runs: runs)
                            .accessibilityIdentifier("artifact.details.\(artifact.id)")
                        if artifact.uri.hasPrefix("/api/v1/artifacts/") {
                            Button(downloading ? "Downloading…" : "Preview or share") { Task { await download(artifact) } }.disabled(downloading)
                                .accessibilityIdentifier("artifact.preview.\(artifact.id)")
                        } else if let url = URL(string: artifact.uri), url.scheme == "https" {
                            Link("Open artifact", destination: url)
                        } else { Text("This older artifact was not uploaded to the server.").font(.caption).foregroundStyle(.secondary) }
                    }
                }
            }
        } else {
            Section("Artifacts") {
                Text("No artifacts uploaded.")
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("task.artifacts.empty.\(taskId)")
            }
        }
    }

    @ViewBuilder
    private func reviewHistorySection(_ snapshot: TaskSnapshot) -> some View {
        if !snapshot.reviews.isEmpty {
            Section("Review history") {
                ForEach(snapshot.reviews) { review in
                    VStack(alignment: .leading, spacing: ArtooTokens.Spacing.sm) {
                        Label(review.outcomeLabel, systemImage: review.outcome == "accepted" ? "checkmark.seal" : "arrow.uturn.backward.circle")
                            .font(.headline)
                        Text(review.reviewerLabel).font(.subheadline)
                            .accessibilityIdentifier("task.review.reviewer.\(review.eventId)")
                        Text(ConversationMetadata.timestamp(review.occurredAt))
                            .font(.caption).foregroundStyle(.secondary)
                            .accessibilityValue(review.occurredAt)
                            .accessibilityIdentifier("task.review.date.\(review.eventId)")
                        Text(review.comment ?? "No written comment.")
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("task.review.feedback.\(review.eventId)")
                        if let ids = review.artifactIds {
                            Text(ids.isEmpty ? "No artifacts were recorded for this review." : "Artifacts included in this task review")
                                .font(.caption).foregroundStyle(.secondary)
                            ForEach(ids, id: \.self) { id in
                                if let artifact = snapshot.artifacts.first(where: { $0.id == id }) {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(artifact.displayName).font(.subheadline.weight(.semibold))
                                        ArtifactProvenance(artifact: artifact, runs: snapshot.runs)
                                    }
                                } else {
                                    Text("Artifact unavailable · \(id)").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        } else {
                            Text("Reviewed artifacts were not recorded for this earlier review.")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, ArtooTokens.Spacing.xs)
                }
            }
        }
    }

    private func perform(_ action: TaskAction) {
        switch action {
        case .markReady: Task { await model.markReady() }
        case .retry: Task { await model.retry() }
        case .accept, .requestChanges:
            let comment = model.reviewComment
            focusedField = nil
            Task { await model.review(accept: action == .accept, comment: comment.isEmpty ? nil : comment) }
        case .assign: showingAssign = true
        }
    }

    private func download(_ artifact: Artifact) async {
        downloading = true; artifactError = nil; defer { downloading = false }
        do { artifactURL = try await client.downloadArtifact(artifact: artifact) }
        catch { artifactError = String(describing: error) }
    }
}

private struct ArtifactProvenance: View {
    let artifact: Artifact
    let runs: [Run]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let runId = artifact.runId {
                Text("From \(artifact.originatingRun(in: runs)?.displayTitle.lowercased() ?? "execution")")
                Text(runId).textSelection(.enabled)
            } else {
                Text("Originating run was not recorded")
            }
            if let createdAt = artifact.createdAt { Text("Created \(createdAt)") }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
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
    @State private var branchBacked = false
    @State private var instances: [WorkspaceRecord] = []
    @State private var agents: [WorkspaceRecord] = []
    @State private var computers: [WorkspaceRecord] = []
    @State private var error: String?
    @State private var inventoryLoaded = false
    let client: ApiClientProtocol
    @ObservedObject var model: TaskDetailViewModel

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ArtooPageIntro(title: "Hand off with confidence", message: model.state.value?.task.title ?? "Choose how this task reaches an agent.", systemImage: "person.crop.circle.badge.plus")
                }
                Section {
                Picker("Mode", selection: $mode) {
                    Text("Auto").tag("auto")
                    Text("Manual").tag("manual")
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("task.assignment.mode")
                } header: { Text("Assignment") } footer: {
                    Text(mode == "auto" ? "The scheduler selects an eligible agent using the task's required capabilities and available capacity." : "Choose a specific agent. Check its computer, runtime, and workspace before assigning.")
                }
                Section {
                    Toggle("Use an isolated Git worktree", isOn: $branchBacked)
                        .accessibilityIdentifier("task.assignment.worktree")
                } header: { Text("Execution workspace") } footer: {
                    Text("Requires a Git repository on the execution computer. Completed, failed and stopped work remains in its worktree for recovery. Each isolated execution needs a new unused workspace location.")
                }
                if mode == "manual" {
                    Section("Agent") {
                    Picker("Agent instance", selection: $agentInstanceId) {
                        Text("Choose agent").tag("")
                        if selectedAvailability == .unavailable {
                            Text("Unavailable: \(selectedAssignee?.name ?? agentInstanceId)").tag(agentInstanceId)
                        } else if selectedAvailability == .checking && !visibleInstances.contains(where: { $0.id == agentInstanceId }) {
                            Text("Checking selected agent…").tag(agentInstanceId)
                        }
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
                    .accessibilityValue(selectedAvailability == .unavailable ? "Unavailable: \(selectedAssignee?.accessibilityValue ?? agentInstanceId)" : (selectedAssignee?.accessibilityValue ?? "Choose agent"))
                    if selectedAvailability == .unavailable {
                        Label("This selected agent is no longer available. Choose another agent or switch to Auto.", systemImage: "exclamationmark.circle")
                            .font(.subheadline).foregroundStyle(ArtooTokens.ColorToken.warning)
                            .accessibilityIdentifier("task.assignment.unavailable")
                    }
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
                    if !inventoryLoaded { ProgressView("Loading agents…") }
                    else if visibleInstances.isEmpty { Text("No enabled agents are available. Configure an agent in Team, then try again.").font(.subheadline).foregroundStyle(.secondary) }
                    }
                }
                if model.actionInFlight { ProgressView("Assigning task…").accessibilityIdentifier("task.assignment.progress") }
            }
            .disabled(model.actionInFlight)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if let message = model.actionError ?? error {
                    VStack(alignment: .leading, spacing: ArtooTokens.Spacing.sm) {
                        HStack(alignment: .top, spacing: ArtooTokens.Spacing.sm) {
                            Image(systemName: "exclamationmark.triangle")
                                .accessibilityHidden(true)
                            Text(message)
                                .fixedSize(horizontal: false, vertical: true)
                                .accessibilityIdentifier("task.assignment.error")
                        }
                        .font(.footnote)
                        .foregroundStyle(ArtooTokens.ColorToken.danger)
                        if error != nil {
                            Button("Reload agents") { Task { await loadInventory() } }
                                .frame(minHeight: 44)
                                .disabled(model.actionInFlight)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
                    .background(.regularMaterial)
                }
            }
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
                        guard canAssign else { return }
                        let selectedMode = mode
                        let selectedBranchBacked: Bool? = branchBacked ? true : nil
                        let selectedId = selectedMode == "manual" ? agentInstanceId : nil
                        Task {
                            if await model.assign(mode: selectedMode, agentInstanceId: selectedId, branchBacked: selectedBranchBacked) { dismiss() }
                        }
                    }
                    .disabled(!canAssign)
                    .accessibilityIdentifier("task.assignment.confirm")
                }
            }
            .task { await loadInventory() }
        }
        .interactiveDismissDisabled(model.actionInFlight)
    }

    private var visibleInstances: [WorkspaceRecord] { instances.filter { $0.status != "disabled" } }
    private var selectedAvailability: AgentSelectionAvailability {
        .resolve(instanceId: agentInstanceId, instances: instances, loaded: inventoryLoaded)
    }
    private var canAssign: Bool { !model.actionInFlight && (mode == "auto" || selectedAvailability == .available) }

    private func loadInventory() async {
        inventoryLoaded = false
        do {
            let bootstrap = try await client.resource(path: "/api/v1/bootstrap")
            instances = bootstrap["agent_instances"].records
            agents = bootstrap["agents"].records
            computers = bootstrap["computers"].records
            inventoryLoaded = true; error = nil
        } catch { self.error = String(describing: error) }
    }

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
    @State private var computers: [WorkspaceRecord] = []
    private let client: ApiClientProtocol?

    public init(run: Run, client: ApiClientProtocol? = nil) { _run = State(initialValue: run); self.client = client }

    public var body: some View {
        List {
            Section("Run") {
                ArtooSectionCard {
                    VStack(alignment: .leading, spacing: ArtooTokens.Spacing.sm) {
                        RunIdentityHeading(run: run).font(ArtooTokens.Typography.headline)
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
            workspaceSection
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
        .task {
            guard let client else { return }
            // A readable current name is optional; the report's stable ID remains visible.
            if let inventory = try? await client.resource(path: "/api/v1/bootstrap") {
                computers = inventory["computers"].records
            }
        }
    }

    private var workspaceSection: some View {
        let details = RunWorkspaceDetails(run: run, computers: computers)
        return Section("Work retention") {
            Text(details.heading).font(.headline)
                .accessibilityIdentifier("run.workspace.retention.\(run.id)")
            if let report = details.report {
                LabeledContent("Reported outcome", value: report.outcome.label)
                if let name = details.reporterDisplayName {
                    LabeledContent("Computer name (current)", value: name)
                }
                LabeledContent("Computer ID", value: report.reporterComputerId)
                    .textSelection(.enabled)
                LabeledContent("Server recorded", value: report.reportedAt)
                    .textSelection(.enabled)
                Text("This is the worker's report at that time. Current file availability has not been checked.")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                Text("No supported retention report is available for this run. Planned workspace details do not confirm files were created or kept.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let path = details.workspaceRoot {
                workspaceValue(details.workspaceLabel, value: path, copyLabel: "Copy workspace path", identifier: "path")
            }
            if let branch = details.workspaceBranch {
                workspaceValue(details.report == nil ? "Planned branch" : "Reported branch", value: branch, copyLabel: "Copy branch", identifier: "branch")
            }
        }
    }

    private func workspaceValue(_ label: String, value: String, copyLabel: String, identifier: String) -> some View {
        VStack(alignment: .leading, spacing: ArtooTokens.Spacing.xs) {
            Text(label).font(.subheadline)
            Text(value).font(.system(.footnote, design: .monospaced))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("run.workspace.\(identifier).\(run.id)")
            Button(copyLabel) { UIPasteboard.general.string = value }
                .accessibilityIdentifier("run.workspace.copy.\(identifier).\(run.id)")
        }
    }
}

private struct RunIdentityHeading: View {
    let run: Run

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: ArtooTokens.Spacing.sm) {
                Text(run.displayTitle)
                RunStatusBadge(run.status)
            }.fixedSize(horizontal: true, vertical: false)
            VStack(alignment: .leading, spacing: ArtooTokens.Spacing.xs) {
                Text(run.displayTitle).fixedSize(horizontal: false, vertical: true)
                RunStatusBadge(run.status)
            }
        }
        .foregroundStyle(ArtooTokens.ColorToken.text)
        .frame(maxWidth: .infinity, alignment: .leading)
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
                RunIdentityHeading(run: run).font(ArtooTokens.Typography.subheadline.weight(.semibold))
                ArtooMetadataGrid([
                    ("Run", run.id),
                    ("Runtime", run.runtimeId),
                    ("Agent", run.agentInstanceId),
                    ("Started", run.startedAt ?? run.createdAt)
                ])
                if run.workspaceRetention != nil {
                    Text("Work retention reported")
                        .font(ArtooTokens.Typography.caption).foregroundStyle(.secondary)
                }
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
