import SwiftUI

struct CollaborationView: View {
    @EnvironmentObject private var container: AppContainer
    @StateObject private var model: WorkspaceViewModel
    @State private var decisions: [WorkspaceRecord] = []
    @State private var handoffs: [WorkspaceRecord] = []
    @State private var blockers: [WorkspaceRecord] = []
    @State private var agents: [WorkspaceRecord] = []
    @State private var message = ""
    @State private var summary = ""
    @State private var recipient = ""
    @State private var recordKind = "decisions"
    @State private var error: String?
    let roomId: String
    let taskId: String?
    init(client: ApiClientProtocol, roomId: String, taskId: String?) {
        self.roomId = roomId; self.taskId = taskId
        _model = StateObject(wrappedValue: WorkspaceViewModel(client: client, path: "/api/v1/rooms/\(apiPart(roomId))/messages"))
    }
    var body: some View {
        List {
            Section("Messages") {
                ForEach(model.state.value?["messages"].records ?? []) { item in
                    VStack(alignment: .leading, spacing: 5) {
                        Text(item["body"].text).textSelection(.enabled)
                        Text("\(item["actor_id"].text) · \(item["created_at"].text)").font(.caption).foregroundStyle(.secondary)
                    }
                }
                TextField("Message the team", text: $message, axis: .vertical).lineLimit(2...6)
                Button("Send") { Task {
                    if await model.perform(path: "/api/v1/rooms/\(apiPart(roomId))/messages", body: .object(["kind": .string("text"), "body": .string(message)])) { message = "" }
                } }.disabled(model.busy || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            Section("Decisions") { ForEach(decisions) { item in
                VStack(alignment: .leading) {
                    RecordRow(item: item)
                    if item.status == "proposed" { HStack { transition("Accept", item, "decisions", "accepted"); transition("Reject", item, "decisions", "rejected") } }
                }
            } }
            Section("Handoffs") { ForEach(handoffs) { item in
                VStack(alignment: .leading) {
                    RecordRow(item: item)
                    Text("\(item["sender_id"].text) → \(item["recipient_id"].text)").font(.caption)
                    if item.status == "open" { transition("Accept handoff", item, "handoffs", "accepted") }
                    if ["open", "accepted"].contains(item.status) { transition("Complete handoff", item, "handoffs", "completed") }
                }
            } }
            Section("Blockers") { ForEach(blockers) { item in
                VStack(alignment: .leading) { RecordRow(item: item); if item.status != "resolved" { transition("Resolve", item, "blockers", "resolved") } }
            } }
            Section("Record team work") {
                Picker("Record", selection: $recordKind) { Text("Decision").tag("decisions"); Text("Handoff").tag("handoffs"); Text("Blocker").tag("blockers") }
                TextField(recordKind == "handoffs" ? "Expected action" : "Summary", text: $summary, axis: .vertical).lineLimit(2...6)
                if recordKind == "handoffs" {
                    Picker("Recipient agent", selection: $recipient) {
                        Text("Choose agent").tag(""); ForEach(agents) { agent in Text(agent.title).tag(agent.id) }
                    }
                }
                Button("Create record") { Task { await createRecord() } }
                    .disabled(model.busy || summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (recordKind == "handoffs" && recipient.isEmpty))
            }
            if model.state.isLoading { ProgressView() }
            if let message = error ?? model.actionError ?? model.state.errorMessage { Text(message).foregroundStyle(.red) }
        }.navigationTitle("Team discussion").refreshable { await refresh() }.liveRefresh { await refresh() }
    }
    private func refresh() async {
        await model.load()
        do {
            async let d = model.client.resource(path: "/api/v1/rooms/\(apiPart(roomId))/decisions")
            async let h = model.client.resource(path: "/api/v1/rooms/\(apiPart(roomId))/handoffs")
            async let b = model.client.resource(path: "/api/v1/rooms/\(apiPart(roomId))/blockers")
            decisions = try await d["decisions"].records
            handoffs = try await h["handoffs"].records
            blockers = try await b["blockers"].records
            if agents.isEmpty { let bootstrap = try await model.client.resource(path: "/api/v1/bootstrap"); agents = bootstrap["agents"].records }
            error = nil
        } catch { self.error = String(describing: error) }
    }
    private func transition(_ title: String, _ item: WorkspaceRecord, _ kind: String, _ status: String) -> some View {
        Button(title) { Task { if await model.perform(path: "/api/v1/\(kind)/\(apiPart(item.id))", method: "PATCH", body: .object(["status": .string(status)])) { await refresh() } } }.disabled(model.busy)
    }
    private func createRecord() async {
        let actor = container.identity?.user.id ?? container.bootstrap.value?.actor.id ?? ""
        guard !actor.isEmpty else { error = "Please reconnect to verify your identity."; return }
        var body: [String: JSONValue] = [:]
        if let taskId { body["task_id"] = .string(taskId) }
        switch recordKind {
        case "decisions": body.merge(["summary": .string(summary), "actor_type": .string("user"), "actor_id": .string(actor)]) { _, new in new }
        case "handoffs": body.merge(["expected_action": .string(summary), "sender_type": .string("user"), "sender_id": .string(actor), "recipient_type": .string("agent"), "recipient_id": .string(recipient)]) { _, new in new }
        default: body.merge(["summary": .string(summary), "type": .string("human_input"), "owner_type": .string("user"), "owner_id": .string(actor), "source_kind": .string("manual")]) { _, new in new }
        }
        if await model.perform(path: "/api/v1/rooms/\(apiPart(roomId))/\(recordKind)", body: .object(body)) { summary = ""; await refresh() }
    }
}

struct DependenciesView: View {
    @StateObject private var model: WorkspaceViewModel
    @State private var tasks: [TaskItem] = []
    @State private var prerequisite = ""
    @State private var error: String?
    let taskId: String
    let projectId: String
    init(client: ApiClientProtocol, taskId: String, projectId: String) {
        self.taskId = taskId; self.projectId = projectId
        _model = StateObject(wrappedValue: WorkspaceViewModel(client: client, path: "/api/v1/tasks/\(apiPart(taskId))/dependencies"))
    }
    var body: some View {
        Form {
            Section("Dependencies") { ForEach(model.state.value?["dependencies"].records ?? []) { dependency in
                VStack(alignment: .leading) {
                    Text("\(dependency["from_task_id"].text) → \(dependency["to_task_id"].text)")
                    Text(dependency["type"].text).font(.caption)
                    Button("Remove", role: .destructive) { Task { await model.perform(path: "/api/v1/tasks/\(apiPart(taskId))/dependencies/\(apiPart(dependency.id))", method: "DELETE") } }.disabled(model.busy)
                }
            } }
            Section("Wait for another task") {
                Picker("Prerequisite", selection: $prerequisite) { Text("Choose task").tag(""); ForEach(tasks.filter { $0.id != taskId }) { task in Text(task.title).tag(task.id) } }
                Button("Add dependency") { Task { await model.perform(path: "/api/v1/tasks/\(apiPart(taskId))/dependencies", body: .object(["depends_on_task_id": .string(prerequisite), "type": .string("blocks")])) } }.disabled(model.busy || prerequisite.isEmpty)
            }
            if let message = error ?? model.actionError ?? model.state.errorMessage { Text(message).foregroundStyle(.red) }
        }.navigationTitle("Dependencies").liveRefresh {
            await model.load()
            do { tasks = try await model.client.listTasks(projectId: projectId); error = nil } catch { self.error = String(describing: error) }
        }
    }
}
