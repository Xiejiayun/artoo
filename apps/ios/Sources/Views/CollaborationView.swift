import SwiftUI

struct CollaborationView: View {
    @EnvironmentObject private var container: AppContainer
    @StateObject private var model: WorkspaceViewModel
    @StateObject private var chat: RoomMessagesViewModel
    @State private var decisions: [WorkspaceRecord] = []
    @State private var handoffs: [WorkspaceRecord] = []
    @State private var blockers: [WorkspaceRecord] = []
    @State private var agents: [WorkspaceRecord] = []
    @State private var agentInstances: [WorkspaceRecord] = []
    @State private var inventoryLoaded = false
    @State private var members: [WorkspaceRecord] = []
    @State private var summary = ""
    @State private var recipient = ""
    @State private var recordKind = "decisions"
    @State private var error: String?
    let roomId: String
    let taskId: String?
    let threadRoot: Message?
    let focusedMessage: Message?
    init(client: ApiClientProtocol, roomId: String, taskId: String?, threadRoot: Message? = nil, focusedMessage: Message? = nil) {
        self.roomId = roomId; self.taskId = taskId
        self.threadRoot = threadRoot; self.focusedMessage = focusedMessage
        _model = StateObject(wrappedValue: WorkspaceViewModel(client: client, path: "/api/v1/rooms/\(apiPart(roomId))/messages"))
        _chat = StateObject(wrappedValue: RoomMessagesViewModel(client: client, roomId: roomId, threadRootId: threadRoot?.id, allowsAssistantRequests: threadRoot?.isPlanningDiscussion != true))
    }
    var body: some View {
        List {
            if let root = threadRoot { Section("Thread") { Text(root.body).textSelection(.enabled); Text(root.actorId).font(.caption) } }
            if let focus = focusedMessage, focus.id != threadRoot?.id { Section("Mentioned reply") { Text(focus.body).textSelection(.enabled); Text(focus.actorId).font(.caption) } }
            Section(threadRoot == nil ? "Messages" : "Replies") {
                RealtimeStatusView(connection: container.realtime)
                if chat.hasOlder { Button("Load earlier messages") { Task { await chat.loadOlder() } }.disabled(chat.loading) }
                ForEach(chat.messages.filter { $0.id != focusedMessage?.id }) { item in
                    VStack(alignment: .leading, spacing: 5) {
                        Text(item.body).textSelection(.enabled)
                        Text("\(item.actorType == "agent" ? "Agent" : "Team") · \(item.actorId) · \(item.createdAt ?? "")").font(.caption).foregroundStyle(.secondary)
                        if threadRoot == nil {
                            NavigationLink("\(item.replyCount ?? 0) replies · Open thread") {
                                CollaborationView(client: model.client, roomId: roomId, taskId: taskId, threadRoot: item)
                            }
                        }
                    }
                }
                if chat.hasNewer { Button("Load new messages") { Task { await chat.refresh() } }.disabled(chat.loading) }
                if chat.allowsAssistantRequests {
                Picker("Send to", selection: Binding(get: { chat.draft.target ?? "team" }, set: { chat.draft.target = $0 })) {
                    Text("Team discussion").tag("team"); Text("Agent").tag("assistant")
                }.disabled(chat.sending || chat.draft.pending != nil)
                } else {
                    Text("Agents take turns within this goal's discussion limits. Add a team reply to share constraints; manage the discussion from the goal.").font(.caption).foregroundStyle(.secondary)
                }
                if chat.allowsAssistantRequests && chat.draft.target == "assistant" {
                    Text("The agent can execute a task on an available computer. Existing execution approvals still apply.").font(.caption).foregroundStyle(.secondary)
                    Picker("Agent", selection: Binding(get: { chat.draft.agentInstanceId ?? "" }, set: { chat.draft.agentInstanceId = $0 })) {
                        Text("Automatic selection").tag("")
                        ForEach(agentInstances.filter { $0.status != "disabled" }) { instance in
                            Text("\(instance["runtime"].text) · \(instance.title)").tag(instance.id)
                        }
                    }.disabled(chat.sending || chat.draft.pending != nil)
                    Button("Refresh agents") { Task { await refreshInventory() } }
                }
                TextField(chat.allowsAssistantRequests && chat.draft.target == "assistant" ? "Ask the agent" : "Message the team", text: $chat.draft.text, axis: .vertical).lineLimit(2...6)
                    .disabled(chat.sending || chat.draft.pending != nil)
                if !chat.allowsAssistantRequests || chat.draft.target != "assistant" {
                    Menu("@ Mention a teammate") {
                        ForEach(members) { member in
                            Toggle(member.title, isOn: Binding(get: { chat.draft.mentionedUserIds?.contains(member.id) == true }, set: { selected in toggleMention(member, selected: selected) }))
                        }
                    }.disabled(chat.sending || chat.draft.pending != nil || members.isEmpty)
                    if !(chat.draft.mentionedUserIds ?? []).isEmpty {
                        Text("Mentions: " + members.filter { chat.draft.mentionedUserIds?.contains($0.id) == true }.map(\.title).joined(separator: ", ")).font(.caption)
                    }
                }
                Button(chat.allowsAssistantRequests && chat.draft.target == "assistant" ? "Send to agent" : "Send to team") { Task {
                    await chat.send()
                } }.disabled(chat.sending || chat.draft.pending != nil || chat.draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if chat.draft.pending != nil {
                    if chat.unsupportedPendingAssistant {
                        Text("An earlier agent request has unconfirmed delivery. Check this discussion's activity before keeping its text as a team reply.").font(.caption)
                        Button("Keep text as team reply") { chat.keepPendingTextAsTeamReply() }.disabled(chat.sending)
                    } else {
                    Button("Retry pending send") { Task { await chat.submitPending() } }.disabled(chat.sending)
                    Text("Delivery is unconfirmed. Retrying uses the same send identifier to avoid a duplicate.").font(.caption)
                    }
                }
                if chat.loading || chat.sending { ProgressView() }
                if let message = chat.error { Text(message).foregroundStyle(.red) }
            }
            if !chat.turns.isEmpty || chat.turnError != nil {
                Section("Agent requests") {
                    ForEach(chat.turns) { turn in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(turn.status.capitalized).font(.headline)
                            if let message = turn.error, !message.isEmpty { Text(message).foregroundStyle(.red) }
                            if turn.status == "waiting" { Text("Waiting for an available agent or execution approval.").font(.caption) }
                            NavigationLink("Open execution task") { TaskDetailView(client: model.client, taskId: turn.taskId) }
                            if chat.allowsAssistantRequests { HStack {
                                if ["queued", "running", "waiting"].contains(turn.status) {
                                    Button("Cancel") { Task { await chat.changeTurn(turn, action: "cancel") } }
                                }
                                if ["failed", "waiting"].contains(turn.status) {
                                    Button("Retry") { Task { await chat.changeTurn(turn, action: "retry") } }
                                }
                            }.disabled(chat.turnActionInFlight != nil) }
                        }
                    }
                    if let message = chat.turnError { Text(message).foregroundStyle(.red) }
                }
            }
            if threadRoot == nil {
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
            }
            if model.state.isLoading { ProgressView() }
            if let message = error ?? model.actionError ?? model.state.errorMessage { Text(message).foregroundStyle(.red) }
        }.navigationTitle(threadRoot == nil ? "Team discussion" : "Thread").refreshable { await refresh() }.liveRefresh { await refresh() }
        .onAppear {
            chat.configureDraft(server: container.serverURL, user: container.identity?.user.id ?? "")
            container.realtime.watch("room:\(roomId)")
        }
        .onDisappear { container.realtime.unwatch("room:\(roomId)") }
        .onReceive(NotificationCenter.default.publisher(for: .artooRealtimeChanged).receive(on: RunLoop.main)) { notification in
            guard notification.object as? String == (container.client as? ApiClient)?.sessionID else { return }
            chat.applyRealtime(notification.userInfo?["events"] as? [JSONValue] ?? [])
        }
    }
    private func refresh() async {
        await chat.refresh()
        await chat.refreshTurns()
        if !inventoryLoaded { await refreshInventory() }
        if members.isEmpty {
            do { let response = try await model.client.resource(path: "/api/v1/members"); members = response["members"].records }
            catch { self.error = String(describing: error) }
        }
        guard threadRoot == nil else { return }
        await chat.reconcileReplyCounts()
        do {
            async let d = model.client.resource(path: "/api/v1/rooms/\(apiPart(roomId))/decisions")
            async let h = model.client.resource(path: "/api/v1/rooms/\(apiPart(roomId))/handoffs")
            async let b = model.client.resource(path: "/api/v1/rooms/\(apiPart(roomId))/blockers")
            decisions = try await d["decisions"].records
            handoffs = try await h["handoffs"].records
            blockers = try await b["blockers"].records
            error = nil
        } catch { self.error = String(describing: error) }
    }
    private func toggleMention(_ member: WorkspaceRecord, selected: Bool) {
        var ids = Set(chat.draft.mentionedUserIds ?? [])
        if selected { ids.insert(member.id) } else { ids.remove(member.id) }
        chat.draft.mentionedUserIds = ids.sorted()
        if selected, !chat.draft.text.contains("@\(member.title)") { chat.draft.text += " @\(member.title) " }
    }
    private func refreshInventory() async {
        do {
            let bootstrap = try await model.client.resource(path: "/api/v1/bootstrap")
            agents = bootstrap["agents"].records; agentInstances = bootstrap["agent_instances"].records; inventoryLoaded = true
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

private struct RealtimeStatusView: View {
    @ObservedObject var connection: RealtimeConnection
    var body: some View {
        Label(connection.connected ? "Live updates connected" : "Reconnecting · drafts saved on this phone", systemImage: connection.connected ? "bolt.horizontal.circle" : "wifi.exclamationmark")
            .font(.caption).foregroundStyle(.secondary)
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
