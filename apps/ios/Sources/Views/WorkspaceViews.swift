import SwiftUI

struct WorkspaceListView: View {
    @EnvironmentObject private var container: AppContainer
    @StateObject private var model: WorkspaceViewModel
    @State private var creating = false
    @State private var searchText = ""
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
            let records = document[kind.rawValue].records
            let matches = records.filter { searchText.isEmpty || ($0.title + " " + $0.status).localizedCaseInsensitiveContains(searchText) }
            List {
                if records.isEmpty {
                    EmptyStateView(systemImage: resourceIcon, title: "No \(kind.title.lowercased()) yet", message: resourceDescription)
                } else if matches.isEmpty {
                    EmptyStateView(systemImage: "magnifyingglass", title: "No matches", message: "Try a different name or status.", actionTitle: "Clear search", action: { searchText = "" })
                }
                ForEach(matches) { item in
                    NavigationLink {
                        if kind == .goals { GoalDetailView(client: model.client, goalId: item.id, projectId: projectId) }
                        else { LibraryDetailView(item: item, kind: kind, model: model, projectId: projectId) }
                    } label: {
                        HStack(alignment: .top, spacing: 12) {
                            ArtooAvatar(name: item.title, systemImage: resourceIcon)
                            VStack(alignment: .leading, spacing: 5) {
                                RecordRow(item: item)
                                if kind == .goals && !item["objective"].text.isEmpty {
                                    Text(item["objective"].text).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                                }
                                if kind == .skills && !item["version"].text.isEmpty {
                                    Text("Version \(item["version"].text)").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }.padding(.vertical, 4)
                    }
                        .accessibilityIdentifier("workspace.\(kind.rawValue).\(item.id)")
                }
                if let error = model.actionError { Text(error).foregroundStyle(.red) }
            }
            .listStyle(.insetGrouped)
        }
        .navigationTitle(kind.title)
        .searchable(text: $searchText, prompt: "Search \(kind.title.lowercased())")
        .toolbar { if kind != .skills || container.isAdministrator { Button("Add", systemImage: "plus") { creating = true } } }
        .sheet(isPresented: $creating) { CreateWorkspaceItem(kind: kind, projectId: projectId, model: model) }
        .refreshable { await model.load() }.liveRefresh { await model.load() }
    }

    private var resourceIcon: String { kind == .goals ? "target" : (kind == .memories ? "brain.head.profile" : "square.stack.3d.up") }
    private var resourceDescription: String {
        kind == .goals ? "Define an outcome for the team and turn it into a plan." :
            (kind == .memories ? "Keep useful context your team can return to." : "Add reusable capabilities for your agents.")
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
            if showStatus && !item.status.isEmpty {
                Text(item.status.replacingOccurrences(of: "_", with: " ").capitalized)
                    .font(.caption.weight(.medium)).foregroundStyle(ArtooTokens.ColorToken.neutral)
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .background(ArtooTokens.ColorToken.neutralSoft, in: Capsule())
            }
        }.padding(.vertical, 4).frame(maxWidth: .infinity, alignment: .leading)
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
                    Section("Goal name") { TextField("Title", text: $title) }
                    Section("Outcome") { TextField("Objective", text: $content, axis: .vertical).lineLimit(3...8) }
                    Section {
                        TextField("Acceptance criteria, one per line", text: $criteria, axis: .vertical).lineLimit(3...8)
                    } header: { Text("Success looks like") } footer: { Text("Describe the results the team should be able to verify.") }
                } else if kind == .memories {
                    Section {
                        TextField("What should the team remember?", text: $content, axis: .vertical).lineLimit(5...12)
                    } header: { Text("Knowledge to keep") } footer: {
                        Text("The memory is proposed for review before it can enter an execution context.")
                    }
                } else {
                    Section {
                        TextEditor(text: $content).font(.system(.body, design: .monospaced)).frame(minHeight: 260)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .accessibilityLabel("Skill manifest JSON")
                    } header: { Text("Skill manifest") } footer: {
                        Text("Paste the skill's manifest. The server validates its capabilities and permissions before installation.")
                    }
                }
                if let error = validation ?? model.actionError { Text(error).foregroundStyle(.red) }
            }.disabled(model.busy).scrollDismissesKeyboard(.interactively)
                .navigationTitle(kind == .goals ? "New goal" : (kind == .memories ? "Propose memory" : "Install skill"))
                .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(model.busy) }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { Task { await save() } }.disabled(model.busy || content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (kind == .goals && title.isEmpty)) }
            }
        }.interactiveDismissDisabled(model.busy)
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
            Section {
                if kind == .memories {
                    ArtooPageIntro(title: "Team memory", message: memoryGuidance(current.status), systemImage: "brain.head.profile")
                    LabeledContent("Status", value: current.status.replacingOccurrences(of: "_", with: " ").capitalized)
                } else { RecordRow(item: current) }
            }
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
                        Button("Replace memory") { Task {
                            _ = await model.perform(path: "/api/v1/memories/\(apiPart(item.id))/supersede", body: .object(["scope": .string("project"), "project_id": .string(projectId), "text": .string(replacement)]))
                        } }.disabled(model.busy || replacement.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty).frame(minHeight: 44)
                        Text("Replacing accepts the new content immediately and retires this memory from future execution context.").font(.footnote).foregroundStyle(.secondary)
                    }
                }
            } else {
                Section("Skill") {
                    ArtooMetadataGrid([("Version", current["version"].text), ("Enabled", current["enabled"].text)])
                }
                Section("Capabilities") {
                    if current["capabilities"].array.isEmpty { Text("No capabilities declared").foregroundStyle(.secondary) }
                    ForEach(Array(current["capabilities"].array.enumerated()), id: \.offset) { _, capability in
                        Label(capability.text, systemImage: "checkmark.circle").textSelection(.enabled)
                    }
                }
                SkillPermissionsView(summary: current["permission_summary"], manifest: current["manifest"])
            }
            if let error = model.actionError { Text(error).foregroundStyle(.red) }
        }.listStyle(.insetGrouped).navigationTitle(kind == .memories ? "Memory review" : "Skill details")
            .navigationBarTitleDisplayMode(.inline).scrollDismissesKeyboard(.interactively)
    }
    private func memoryGuidance(_ status: String) -> String {
        switch status {
        case "proposed": return "Review this context before agents can use it in their work."
        case "accepted": return "Available to the team. Replace this memory when its context changes."
        case "rejected": return "This proposal was rejected and is not used as accepted context."
        case "superseded": return "A newer memory has replaced this context."
        default: return "Shared context and its review state are kept here."
        }
    }
    private func action(_ title: String, path: String) -> some View {
        Button(title) { Task { await model.perform(path: path) } }.disabled(model.busy).frame(minHeight: 44)
    }
}

private struct SkillPermissionsView: View {
    let summary: JSONValue
    let manifest: JSONValue

    var body: some View {
        Section("Permissions and access") {
            if summary == .null {
                Text("No permission summary was reported.").foregroundStyle(.secondary)
            } else {
                if !summary["risk"].text.isEmpty { RiskBadge(RiskLevel(rawValue: summary["risk"].text)) }
                if summary["categories"].array.isEmpty && summary["approval_risks"].array.isEmpty {
                    Text("No additional permissions declared.").foregroundStyle(.secondary)
                }
                permissionGroup("Files to read", values: summary["filesystem"]["read"].array)
                permissionGroup("Files to write", values: summary["filesystem"]["write"].array)
                permissionGroup("Network destinations", values: summary["network"]["outbound"].array)
                permissionGroup("Secret references", values: summary["secrets"].array)
                permissionGroup("External services", values: summary["external_services"].array)
                riskGroup("High-risk actions", values: summary["high_risk_actions"].array)
                riskGroup("Approval requirements", values: summary["approval_risks"].array)
            }
        }
        Section("Technical details") {
            DisclosureGroup("Permission summary") { source(summary) }
            DisclosureGroup("Manifest source") { source(manifest) }
        }
    }

    @ViewBuilder private func permissionGroup(_ title: String, values: [JSONValue]) -> some View {
        if !values.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text(title).font(.subheadline.weight(.semibold))
                ForEach(Array(values.enumerated()), id: \.offset) { _, value in
                    Text(value.text).font(.system(.subheadline, design: .monospaced))
                        .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                }
            }.padding(.vertical, 4)
        }
    }

    @ViewBuilder private func riskGroup(_ title: String, values: [JSONValue]) -> some View {
        if !values.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text(title).font(.subheadline.weight(.semibold))
                ForEach(Array(values.enumerated()), id: \.offset) { _, value in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(value["action"].text).textSelection(.enabled)
                        RiskBadge(RiskLevel(rawValue: value["risk"].text))
                        if !value["reason"].text.isEmpty { Text(value["reason"].text).font(.footnote).foregroundStyle(.secondary) }
                    }
                }
            }.padding(.vertical, 4)
        }
    }

    private func source(_ value: JSONValue) -> some View {
        Text(value.pretty).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true).padding(.vertical, 8)
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
                Section {
                    Text(goal["title"].text).font(.title2.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                    LabeledContent("Status", value: goal["status"].text)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("Goal status")
                        .accessibilityValue(goal["status"].text)
                        .accessibilityIdentifier("goal.status.\(goalId)")
                    Text(goalGuidance(goal["status"].text)).font(.subheadline).foregroundStyle(.secondary)
                }
                Section("Outcome") { Text(goal["objective"].text).textSelection(.enabled) }
                if !goal["acceptance_criteria"].array.isEmpty {
                    Section("Success looks like") {
                        ForEach(Array(goal["acceptance_criteria"].array.enumerated()), id: \.offset) { _, item in
                            Label(item.text, systemImage: "checkmark.circle").fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                Section("Planning") {
                    NavigationLink("Discuss and break down with agents") { AgentDiscussionView(client: model.client, goalId: goalId, projectId: projectId) }
                        .accessibilityIdentifier("goal.discuss.\(goalId)")
                    if ["draft", "paused", "blocked"].contains(goal["status"].text) { Button("Propose a plan") { planning = true } }
                    if bundle["plans"].records.isEmpty { Text("Discuss the approach with agents or propose a plan yourself. Tasks are created only after you accept a plan.").font(.subheadline).foregroundStyle(.secondary) }
                }
                if !["completed", "cancelled", "archived"].contains(goal["status"].text) {
                    Section("Goal controls") {
                        if ["running", "awaiting_approval", "blocked"].contains(goal["status"].text) { goalAction("Pause", "pause") }
                        if goal["status"].text == "paused" { goalAction("Resume", "resume") }
                        if ["paused", "blocked"].contains(goal["status"].text) { goalAction("Reconcile from checkpoint", "reconcile") }
                        Button("Cancel goal", role: .destructive) { confirmingCancellation = true }
                            .disabled(model.busy).frame(minHeight: 44)
                            .accessibilityIdentifier("goal.cancel.request.\(goalId)")
                    }
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
                            VStack(alignment: .leading, spacing: 8) {
                                Text("\(index + 1). \(spec["title"].text)").font(.headline)
                                    .accessibilityIdentifier("plan.task.title.\(plan.id).\(index)")
                                Text(spec["acceptance_criteria"].array.map(\.text).joined(separator: "\n")).font(.subheadline)
                                    .accessibilityIdentifier("plan.task.criteria.\(plan.id).\(index)")
                                if !dependencies.isEmpty {
                                    Text("Depends on: \(dependencies.joined(separator: ", "))").font(.footnote).foregroundStyle(.secondary)
                                        .accessibilityIdentifier("plan.task.dependencies.\(plan.id).\(index)")
                                }
                            }.padding(.vertical, 4)
                        }
                        if plan.status == "proposed" {
                            Text("Review the outcome, criteria, and dependencies before creating these tasks.").font(.footnote).foregroundStyle(.secondary)
                            planAction("Accept and create tasks", id: plan.id, action: "accept")
                            planAction("Reject plan", id: plan.id, action: "reject")
                        }
                    }
                }
                Section("Tasks") {
                    if bundle["tasks"].array.isEmpty { Text("Accepted plans will create linked tasks here.").foregroundStyle(.secondary) }
                    ForEach(bundle["tasks"].array.compactMap { WorkspaceRecord($0["task"]) }) { task in
                        NavigationLink { TaskDetailView(client: model.client, taskId: task.id) } label: { RecordRow(item: task) }
                            .accessibilityIdentifier("goal.task.\(task.id)")
                    }
                }
                if !bundle["checkpoints"].records.isEmpty {
                    Section("Checkpoints") { ForEach(bundle["checkpoints"].records) { checkpoint in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(checkpoint["type"].text.replacingOccurrences(of: "_", with: " ").capitalized).font(.headline)
                            Text(checkpoint["summary"].text).font(.subheadline)
                            Text(ConversationMetadata.timestamp(checkpoint["created_at"].text)).font(.caption).foregroundStyle(.secondary)
                        }.padding(.vertical, 4)
                    } }
                }
                if let roomId = Optional(bundle["room"]["id"].text), !roomId.isEmpty {
                    NavigationLink("Team discussion") { CollaborationView(client: model.client, roomId: roomId, taskId: nil) }
                }
                Section("Audit history") {
                    Button("Prepare audit export") { Task { await exportAudit() } }.frame(minHeight: 44)
                    if let auditURL { ShareLink("Share audit", item: auditURL) }
                }
                if let error = model.actionError { Text(error).foregroundStyle(.red) }
                if let exportError { Text(exportError).foregroundStyle(.red) }
            }.listStyle(.insetGrouped)
        }.navigationTitle("Goal").navigationBarTitleDisplayMode(.inline).sheet(isPresented: $planning) { PlanEditor(goalId: goalId, model: model) }
            .alert("Cancel this goal?", isPresented: $confirmingCancellation) {
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
    private func goalGuidance(_ status: String) -> String {
        switch status {
        case "draft": return "Define the outcome, then review a plan before work begins."
        case "running": return "Work is underway. Follow linked tasks and the latest checkpoints."
        case "awaiting_approval": return "A decision is needed before this goal can continue."
        case "blocked": return "Review the blocked tasks and checkpoints to decide the next step."
        case "paused": return "Work is paused. Review the current plan before resuming."
        case "completed": return "The goal is complete. Its plan, work, and audit history remain available."
        case "cancelled": return "This goal was cancelled. Its history remains available."
        default: return "Keep the outcome, plan, and related work together."
        }
    }
    private func goalAction(_ title: String, _ action: String) -> some View {
        Button(title) { Task { await model.perform(path: "/api/v1/goals/\(apiPart(goalId))/\(action)") } }.disabled(model.busy).frame(minHeight: 44)
    }
    private func planAction(_ title: String, id: String, action: String) -> some View {
        Button(title) { Task { await model.perform(path: "/api/v1/plans/\(apiPart(id))/\(action)") } }.disabled(model.busy).frame(minHeight: 44)
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
                Section {
                    ArtooPageIntro(title: "Turn the outcome into clear steps", message: "Define a verifiable result for each task. This proposal will still need acceptance before work is created.", systemImage: "list.bullet.clipboard")
                }
                Section("Approach") { TextField("Plan rationale", text: $rationale, axis: .vertical).lineLimit(3...8) }
                ForEach($drafts) { $draft in
                    let index = drafts.firstIndex { $0.id == draft.id } ?? 0
                    Section("Task \(index + 1)") {
                        TextField("Title", text: $draft.title)
                        TextField("Acceptance criteria, one per line", text: $draft.criteria, axis: .vertical).lineLimit(2...6)
                        TextField("Capabilities, comma separated", text: $draft.capabilities).textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        if index > 0 { Toggle("Wait for the previous task", isOn: $draft.afterPrevious) }
                    }
                }
                Button("Add task", systemImage: "plus.circle") { drafts.append(PlanTaskDraft()) }.frame(minHeight: 44)
                if drafts.count > 1 { Button("Remove last task", role: .destructive) { drafts.removeLast() }.frame(minHeight: 44) }
                if let error = model.actionError { Text(error).foregroundStyle(.red) }
            }.disabled(model.busy).scrollDismissesKeyboard(.interactively)
                .navigationTitle("Propose plan").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(model.busy) }
                    ToolbarItem(placement: .confirmationAction) { Button("Propose") { Task {
                        let specs = drafts.enumerated().map { $0.element.spec(index: $0.offset) }
                        if await model.perform(path: "/api/v1/goals/\(apiPart(goalId))/plans", body: .object(["rationale": .string(rationale), "task_specs": .array(specs)])) { dismiss() }
                    } }.disabled(model.busy || !drafts.allSatisfy(\.valid)) }
                }
        }.interactiveDismissDisabled(model.busy)
    }
}
