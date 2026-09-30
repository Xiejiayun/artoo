import SwiftUI

struct WorkspaceListView: View {
    @EnvironmentObject private var container: AppContainer
    @StateObject private var model: WorkspaceViewModel
    @State private var creating = false
    let kind: WorkspaceKind
    let projectId: String
    let embedded: Bool
    init(kind: WorkspaceKind, client: ApiClientProtocol, projectId: String, embedded: Bool = false) {
        self.kind = kind; self.projectId = projectId; self.embedded = embedded
        _model = StateObject(wrappedValue: WorkspaceViewModel(client: client, path: "/api/v1/\(kind.rawValue)?project_id=\(apiPart(projectId))"))
    }
    var body: some View { Group { if embedded { content } else { NavigationStack { content } } } }
    private var content: some View {
        StateView(state: model.state, retry: { Task { await model.load() } }) { document in
            List {
                if document[kind.rawValue].records.isEmpty { Text("No \(kind.title.lowercased()) yet").foregroundStyle(.secondary) }
                ForEach(document[kind.rawValue].records) { item in
                    NavigationLink {
                        if kind == .goals { GoalDetailView(client: model.client, goalId: item.id, projectId: projectId) }
                        else { LibraryDetailView(item: item, kind: kind, model: model, projectId: projectId) }
                    } label: { RecordRow(item: item) }
                        .accessibilityIdentifier("workspace.\(kind.rawValue).\(item.id)")
                }
                if let error = model.actionError { Text(error).foregroundStyle(.red) }
            }
        }
        .navigationTitle(kind.title)
        .toolbar { if kind != .skills || container.isAdministrator { Button("Add", systemImage: "plus") { creating = true } } }
        .sheet(isPresented: $creating) { CreateWorkspaceItem(kind: kind, projectId: projectId, model: model) }
        .refreshable { await model.load() }.liveRefresh { await model.load() }
    }
}

struct RecordRow: View {
    let item: WorkspaceRecord
    let showStatus: Bool
    init(item: WorkspaceRecord, showStatus: Bool = true) {
        self.item = item; self.showStatus = showStatus
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(item.title).font(.headline).lineLimit(3)
            HStack { if showStatus && !item.status.isEmpty { Text(item.status.replacingOccurrences(of: "_", with: " ")) }; Text(item.id).lineLimit(1) }
                .font(.caption).foregroundStyle(.secondary)
        }.padding(.vertical, 4)
    }
}

private struct CreateWorkspaceItem: View {
    @Environment(\.dismiss) private var dismiss
    let kind: WorkspaceKind
    let projectId: String
    @ObservedObject var model: WorkspaceViewModel
    @State private var title = ""
    @State private var content = ""
    @State private var criteria = ""
    @State private var validation: String?
    var body: some View {
        NavigationStack {
            Form {
                if kind == .goals {
                    TextField("Title", text: $title)
                    TextField("Objective", text: $content, axis: .vertical).lineLimit(3...8)
                    TextField("Acceptance criteria, one per line", text: $criteria, axis: .vertical).lineLimit(3...8)
                } else if kind == .memories {
                    TextField("What should the team remember?", text: $content, axis: .vertical).lineLimit(5...12)
                    Text("The memory is proposed for review before it can enter an execution context.").font(.caption)
                } else {
                    Text("Paste the skill's manifest. The server validates its capabilities and permissions before installation.")
                    TextEditor(text: $content).font(.system(.body, design: .monospaced)).frame(minHeight: 260)
                }
                if let error = validation ?? model.actionError { Text(error).foregroundStyle(.red) }
            }.navigationTitle("Add \(kind.title)")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { Task { await save() } }.disabled(model.busy || content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (kind == .goals && title.isEmpty)) }
            }
        }
    }
    private func save() async {
        validation = nil
        let body: JSONValue
        if kind == .goals { body = .object(["project_id": .string(projectId), "title": .string(title), "objective": .string(content), "acceptance_criteria": .strings(nonemptyLines(criteria))]) }
        else if kind == .memories { body = .object(["scope": .string("project"), "project_id": .string(projectId), "text": .string(content)]) }
        else {
            do { let manifest = try JSONDecoder().decode(JSONValue.self, from: Data(content.utf8)); body = .object(["project_id": .string(projectId), "manifest": manifest, "enabled": .bool(true)]) }
            catch { validation = "The manifest must be valid JSON."; return }
        }
        if await model.perform(path: "/api/v1/\(kind == .skills ? "skills/install" : kind.rawValue)", body: body) { dismiss() }
    }
}

private struct LibraryDetailView: View {
    let item: WorkspaceRecord
    let kind: WorkspaceKind
    @ObservedObject var model: WorkspaceViewModel
    let projectId: String
    @State private var replacement = ""
    var body: some View {
        let current = model.state.value?[kind.rawValue].records.first(where: { $0.id == item.id }) ?? item
        List {
            Section { RecordRow(item: current) }
            if kind == .memories {
                Section("Content") { Text(current["text"].text).textSelection(.enabled) }
                if current.status == "proposed" {
                    Section("Review") {
                        action("Accept", path: "/api/v1/memories/\(apiPart(item.id))/accept")
                        action("Reject", path: "/api/v1/memories/\(apiPart(item.id))/reject")
                    }
                }
                if current.status == "accepted" {
                    Section("Replace with updated memory") {
                        TextField("Replacement content", text: $replacement, axis: .vertical).lineLimit(3...8)
                        Button("Propose replacement") { Task {
                            _ = await model.perform(path: "/api/v1/memories/\(apiPart(item.id))/supersede", body: .object(["scope": .string("project"), "project_id": .string(projectId), "text": .string(replacement)]))
                        } }.disabled(model.busy || replacement.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
            } else {
                Section("Skill") {
                    LabeledContent("Version", value: current["version"].text)
                    LabeledContent("Enabled", value: current["enabled"].text)
                    Text(current["capabilities"].array.map(\.text).joined(separator: ", "))
                }
                Section("Permissions") { Text(current["permission_summary"].pretty).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
                Section("Manifest") { Text(current["manifest"].pretty).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
            }
            if let error = model.actionError { Text(error).foregroundStyle(.red) }
        }.navigationTitle(kind == .memories ? "Memory review" : "Skill details")
    }
    private func action(_ title: String, path: String) -> some View {
        Button(title) { Task { await model.perform(path: path) } }.disabled(model.busy)
    }
}

struct GoalDetailView: View {
    @StateObject private var model: WorkspaceViewModel
    @State private var planning = false
    @State private var confirmingCancellation = false
    @State private var auditURL: URL?
    @State private var exportError: String?
    let goalId: String
    let projectId: String
    init(client: ApiClientProtocol, goalId: String, projectId: String) {
        self.goalId = goalId; self.projectId = projectId
        _model = StateObject(wrappedValue: WorkspaceViewModel(client: client, path: "/api/v1/goals/\(apiPart(goalId))/audit-bundle"))
    }
    var body: some View {
        StateView(state: model.state, retry: { Task { await model.load() } }) { document in
            let bundle = document["bundle"]
            let goal = bundle["goal"]
            List {
                Section(goal["title"].text) {
                    Text(goal["objective"].text)
                    LabeledContent("Status", value: goal["status"].text)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("Goal status")
                        .accessibilityValue(goal["status"].text)
                        .accessibilityIdentifier("goal.status.\(goalId)")
                    ForEach(Array(goal["acceptance_criteria"].array.enumerated()), id: \.offset) { _, item in Label(item.text, systemImage: "checkmark.circle") }
                }
                Section("Actions") {
                    NavigationLink("Discuss and break down with agents") { AgentDiscussionView(client: model.client, goalId: goalId, projectId: projectId) }
                        .accessibilityIdentifier("goal.discuss.\(goalId)")
                    if ["draft", "paused", "blocked"].contains(goal["status"].text) { Button("Propose a plan") { planning = true } }
                    if ["running", "awaiting_approval", "blocked"].contains(goal["status"].text) { goalAction("Pause", "pause") }
                    if goal["status"].text == "paused" { goalAction("Resume", "resume") }
                    if ["paused", "blocked"].contains(goal["status"].text) { goalAction("Reconcile from checkpoint", "reconcile") }
                    if !["completed", "cancelled", "archived"].contains(goal["status"].text) {
                        Button("Cancel goal", role: .destructive) { confirmingCancellation = true }
                            .disabled(model.busy)
                            .accessibilityIdentifier("goal.cancel.request.\(goalId)")
                    }
                    Button("Prepare audit export") { Task { await exportAudit() } }
                    if let auditURL { ShareLink("Share audit", item: auditURL) }
                }
                ForEach(bundle["plans"].records) { plan in
                    Section("Plan \(plan["version"].text) · \(plan.status)") {
                        Text(plan["rationale"].text)
                        ForEach(Array(plan["task_specs"].array.enumerated()), id: \.offset) { index, spec in
                            let dependencies = spec["dependencies"].array.map { dependency in
                                let ref = dependency["ref"].text
                                if let source = Int(ref), plan["task_specs"].array.indices.contains(source) {
                                    return plan["task_specs"].array[source]["title"].text
                                }
                                return "Task \(ref)"
                            }
                            VStack(alignment: .leading) {
                                Text("\(index + 1). \(spec["title"].text)").font(.headline)
                                    .accessibilityIdentifier("plan.task.title.\(plan.id).\(index)")
                                Text(spec["acceptance_criteria"].array.map(\.text).joined(separator: "\n")).font(.caption)
                                    .accessibilityIdentifier("plan.task.criteria.\(plan.id).\(index)")
                                if !dependencies.isEmpty {
                                    Text("Depends on: \(dependencies.joined(separator: ", "))").font(.caption)
                                        .accessibilityIdentifier("plan.task.dependencies.\(plan.id).\(index)")
                                }
                            }
                        }
                        if plan.status == "proposed" {
                            planAction("Accept and create tasks", id: plan.id, action: "accept")
                            planAction("Reject plan", id: plan.id, action: "reject")
                        }
                    }
                }
                Section("Tasks") {
                    ForEach(bundle["tasks"].array.compactMap { WorkspaceRecord($0["task"]) }) { task in
                        NavigationLink { TaskDetailView(client: model.client, taskId: task.id) } label: { RecordRow(item: task) }
                            .accessibilityIdentifier("goal.task.\(task.id)")
                    }
                }
                Section("Checkpoints") { ForEach(bundle["checkpoints"].records) { checkpoint in
                    VStack(alignment: .leading) { Text(checkpoint["type"].text); Text(checkpoint["summary"].text).font(.caption); Text(checkpoint["created_at"].text).font(.caption).foregroundStyle(.secondary) }
                } }
                if let roomId = Optional(bundle["room"]["id"].text), !roomId.isEmpty {
                    NavigationLink("Team discussion") { CollaborationView(client: model.client, roomId: roomId, taskId: nil) }
                }
                if let error = model.actionError { Text(error).foregroundStyle(.red) }
                if let exportError { Text(exportError).foregroundStyle(.red) }
            }
        }.navigationTitle("Goal").sheet(isPresented: $planning) { PlanEditor(goalId: goalId, model: model) }
            .confirmationDialog("Cancel this goal?", isPresented: $confirmingCancellation, titleVisibility: .visible) {
                Button("Cancel goal", role: .destructive) {
                    Task { await model.perform(path: "/api/v1/goals/\(apiPart(goalId))/cancel") }
                }.disabled(model.busy).accessibilityIdentifier("goal.cancel.confirm.\(goalId)")
                Button("Keep goal", role: .cancel) { confirmingCancellation = false }
                    .accessibilityIdentifier("goal.cancel.dismiss.\(goalId)")
            } message: {
                Text("This cancels the goal and its unfinished tasks. Active runs must stop before cancellation completes. A cancelled goal cannot be resumed.")
            }
            .refreshable { await model.load() }.liveRefresh { await model.load() }
    }
    private func goalAction(_ title: String, _ action: String) -> some View {
        Button(title) { Task { await model.perform(path: "/api/v1/goals/\(apiPart(goalId))/\(action)") } }.disabled(model.busy)
    }
    private func planAction(_ title: String, id: String, action: String) -> some View {
        Button(title) { Task { await model.perform(path: "/api/v1/plans/\(apiPart(id))/\(action)") } }.disabled(model.busy)
            .accessibilityIdentifier("plan.\(action).\(id)")
    }
    private func exportAudit() async {
        exportError = nil
        do {
            let audit = try await model.client.resource(path: "/api/v1/goals/\(apiPart(goalId))/audit-bundle/export")
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("goal-audit-\(UUID().uuidString).json")
            try Data(audit.pretty.utf8).write(to: url, options: [.atomic, .completeFileProtection]); auditURL = url
        } catch { auditURL = nil; exportError = String(describing: error) }
    }
}

private struct PlanEditor: View {
    @Environment(\.dismiss) private var dismiss
    let goalId: String
    @ObservedObject var model: WorkspaceViewModel
    @State private var rationale = ""
    @State private var drafts = [PlanTaskDraft()]
    var body: some View {
        NavigationStack {
            Form {
                TextField("Plan rationale", text: $rationale, axis: .vertical)
                ForEach($drafts) { $draft in
                    Section("Task") {
                        TextField("Title", text: $draft.title)
                        TextField("Acceptance criteria, one per line", text: $draft.criteria, axis: .vertical).lineLimit(2...6)
                        TextField("Capabilities, comma separated", text: $draft.capabilities).textInputAutocapitalization(.never)
                        Toggle("Wait for the previous task", isOn: $draft.afterPrevious)
                    }
                }
                Button("Add task") { drafts.append(PlanTaskDraft()) }
                if drafts.count > 1 { Button("Remove last task", role: .destructive) { drafts.removeLast() } }
                if let error = model.actionError { Text(error).foregroundStyle(.red) }
            }.navigationTitle("Propose plan")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) { Button("Propose") { Task {
                        let specs = drafts.enumerated().map { $0.element.spec(index: $0.offset) }
                        if await model.perform(path: "/api/v1/goals/\(apiPart(goalId))/plans", body: .object(["rationale": .string(rationale), "task_specs": .array(specs)])) { dismiss() }
                    } }.disabled(model.busy || !drafts.allSatisfy(\.valid)) }
                }
        }
    }
}
