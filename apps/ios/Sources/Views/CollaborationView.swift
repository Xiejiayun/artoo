import SwiftUI

struct CollaborationView: View {
    private enum InputField: Hashable { case composer, recordSummary }
    @EnvironmentObject private var container: AppContainer
    @StateObject private var model: WorkspaceViewModel
    @StateObject private var chat: RoomMessagesViewModel
    @State private var decisions: [WorkspaceRecord] = []
    @State private var handoffs: [WorkspaceRecord] = []
    @State private var blockers: [WorkspaceRecord] = []
    @State private var agents: [WorkspaceRecord] = []
    @State private var agentInstances: [WorkspaceRecord] = []
    @State private var computers: [WorkspaceRecord] = []
    @State private var inventoryLoaded = false
    @State private var members: [WorkspaceRecord] = []
    @State private var summary = ""
    @State private var recipient = ""
    @State private var recordKind = "decisions"
    @State private var error: String?
    @FocusState private var focusedField: InputField?
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
            if let root = threadRoot { Section("Thread") { messageContent(root) } }
            if let focus = focusedMessage, focus.id != threadRoot?.id { Section("Mentioned reply") { messageContent(focus) } }
            Section(threadRoot == nil ? "Messages" : "Replies") {
                RealtimeStatusView(connection: container.realtime)
                if chat.hasOlder { Button("Load earlier messages") { Task { await chat.loadOlder() } }.disabled(chat.loading) }
                ForEach(chat.messages.filter { $0.id != focusedMessage?.id }) { item in
                    VStack(alignment: .leading, spacing: 5) {
                        messageContent(item)
                        if threadRoot == nil {
                            NavigationLink("\(item.replyCount ?? 0) replies · Open thread") {
                                CollaborationView(client: model.client, roomId: roomId, taskId: taskId, threadRoot: item)
                            }.accessibilityIdentifier("thread.\(item.id)")
                        }
                    }
                }
                if chat.hasNewer { Button("Load new messages") { Task { await chat.refresh() } }.disabled(chat.loading) }
                if chat.allowsAssistantRequests {
                Picker("Send to", selection: Binding(get: { chat.draft.target ?? "team" }, set: { chat.draft.target = $0 })) {
                    Text("Team discussion").tag("team"); Text("Agent").tag("assistant")
                }.disabled(chat.sending || chat.draft.pending != nil)
                    .accessibilityIdentifier("conversation.destination")
                } else {
                    Text("Agents take turns within this goal's discussion limits. Add a team reply to share constraints; manage the discussion from the goal.").font(.caption).foregroundStyle(.secondary)
                }
                if chat.allowsAssistantRequests && chat.draft.target == "assistant" {
                    Text("The agent can execute a task on an available computer. Existing execution approvals still apply.").font(.caption).foregroundStyle(.secondary)
                    NavigationLink {
                        ConversationAgentSelectionView(selection: Binding(get: { chat.draft.agentInstanceId ?? "" }, set: { chat.draft.agentInstanceId = $0 }),
                                                       instances: visibleAgentInstances, agents: agents, computers: computers)
                            .disabled(chat.sending || chat.draft.pending != nil)
                    } label: {
                        HStack {
                            Text("Agent")
                            Spacer()
                            Text(selectedAgentName).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                    .disabled(chat.sending || chat.draft.pending != nil)
                    .accessibilityIdentifier("conversation.agent")
                    .accessibilityLabel("Agent")
                    .accessibilityValue(selectedAgentAccessibilityValue)
                    if let selectedAgent {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(selectedAgent.context).font(.footnote).foregroundStyle(.secondary)
                            Text(selectedAgent.workspace).font(.footnote).foregroundStyle(.secondary).textSelection(.enabled)
                            if let identity = selectedAgent.identityDetail {
                                Text(identity).font(.footnote).foregroundStyle(.secondary).textSelection(.enabled)
                            }
                        }
                        .accessibilityIdentifier("conversation.agent.selected.details")
                    } else if let id = chat.draft.agentInstanceId, !id.isEmpty {
                        Text("Selected agent: \(id)").font(.footnote).foregroundStyle(.secondary)
                            .accessibilityIdentifier("conversation.agent.selected.details")
                    }
                    Button("Refresh agents") { Task { await refreshInventory() } }
                        .accessibilityIdentifier("conversation.agent.refresh")
                }
                TextField(chat.allowsAssistantRequests && chat.draft.target == "assistant" ? "Ask the agent" : "Message the team", text: $chat.draft.text, axis: .vertical).lineLimit(2...6)
                    .focused($focusedField, equals: .composer)
                    .disabled(chat.sending || chat.draft.pending != nil)
                    .accessibilityIdentifier("messageComposer")
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
                } }.disabled(chat.sending || chat.draft.pending != nil || chat.draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty).accessibilityIdentifier("sendMessage")
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
                        let request = AssistantRequestSummary(userMessageId: turn.userMessageId, roomId: turn.roomId,
                                                              threadRootId: turn.threadRootId, messages: chat.messages)
                        VStack(alignment: .leading, spacing: 6) {
                            AssistantRequestSummaryView(summary: request, turnId: turn.id)
                            Text(turn.status.capitalized).font(.subheadline)
                                .accessibilityIdentifier("conversation.turn.status.\(turn.id)")
                            if let message = turn.error, !message.isEmpty { Text(message).foregroundStyle(.red) }
                            if turn.status == "waiting" { Text("Waiting for an available agent or execution approval.").font(.caption) }
                            NavigationLink("Open execution task") { TaskDetailView(client: model.client, taskId: turn.taskId) }
                                .accessibilityIdentifier("conversation.turn.task.\(turn.id)")
                            if chat.allowsAssistantRequests { HStack {
                                if ["queued", "running", "waiting"].contains(turn.status) {
                                    Button("Cancel") { Task { await chat.changeTurn(turn, action: "cancel") } }
                                        .accessibilityIdentifier("conversation.turn.cancel.\(turn.id)")
                                }
                                if ["failed", "waiting"].contains(turn.status) {
                                    Button("Retry") { Task { await chat.changeTurn(turn, action: "retry") } }
                                        .accessibilityIdentifier("conversation.turn.retry.\(turn.id)")
                                }
                            }.buttonStyle(.borderless).disabled(chat.turnActionInFlight != nil) }
                        }
                        .accessibilityElement(children: .contain)
                        .accessibilityIdentifier("conversation.turn.\(turn.id)")
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
                    .focused($focusedField, equals: .recordSummary)
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
        }
        .scrollDismissesKeyboard(.interactively)
        .navigationTitle(threadRoot == nil ? "Team discussion" : "Thread").refreshable { await refresh() }.liveRefresh { await refresh() }
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                if focusedField != nil {
                    Spacer()
                    Button("Done") { focusedField = nil }
                        .accessibilityIdentifier("conversation.keyboard.done")
                }
            }
        }
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
    private func messageContent(_ message: Message) -> some View {
        let mentions = ConversationMetadata.mentionNames(message.payload, members: members, agents: agents, agentInstances: agentInstances,
            currentUserId: container.identity?.user.id ?? container.bootstrap.value?.user.id,
            currentUserName: container.identity?.user.name ?? container.bootstrap.value?.user.displayName)
        return VStack(alignment: .leading, spacing: 5) {
            MessageBodyView(message: message)
            ConversationMetadataView(actorType: message.actorType, actorId: message.actorId, createdAt: message.createdAt,
                                     members: members, agents: agents, agentInstances: agentInstances)
                .accessibilityIdentifier("messageAuthor.\(message.id)")
            if !mentions.isEmpty {
                let labels = mentions.map { "@\($0)" }.joined(separator: " ")
                Text(labels).font(.caption).foregroundStyle(.secondary)
                    .accessibilityLabel("Mentioned people").accessibilityValue(labels)
                    .accessibilityIdentifier("mentions.\(message.id)")
            }
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
            agents = bootstrap["agents"].records; agentInstances = bootstrap["agent_instances"].records
            computers = bootstrap["computers"].records; inventoryLoaded = true
        } catch { self.error = String(describing: error) }
    }
    private var visibleAgentInstances: [WorkspaceRecord] { agentInstances.filter { $0.status != "disabled" } }
    private var selectedAgent: AssigneeLabel? {
        agentInstances.first { $0.id == chat.draft.agentInstanceId }.map {
            AssigneeLabel(instance: $0, agents: agents, computers: computers, options: visibleAgentInstances)
        }
    }
    private var selectedAgentAccessibilityValue: String {
        if let selectedAgent { return selectedAgent.accessibilityValue }
        if let id = chat.draft.agentInstanceId, !id.isEmpty { return "Selected agent: \(id)" }
        return "Automatic selection"
    }
    private var selectedAgentName: String {
        if let selectedAgent { return selectedAgent.name }
        return chat.draft.agentInstanceId?.isEmpty == false ? "Selected agent" : "Automatic selection"
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

private struct ConversationAgentSelectionView: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var selection: String
    let instances: [WorkspaceRecord]
    let agents: [WorkspaceRecord]
    let computers: [WorkspaceRecord]

    var body: some View {
        List {
            Button { selection = ""; dismiss() } label: {
                HStack {
                    Text("Automatic selection")
                    Spacer()
                    if selection.isEmpty { Image(systemName: "checkmark").foregroundStyle(.tint).accessibilityHidden(true) }
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(selection.isEmpty ? "Selected" : "")
            .accessibilityIdentifier("conversation.agent.automatic")
            ForEach(instances) { instance in
                let label = AssigneeLabel(instance: instance, agents: agents, computers: computers, options: instances)
                Button { selection = instance.id; dismiss() } label: {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(label.name).font(.body)
                            Text(label.context).font(.caption).foregroundStyle(.secondary)
                            Text(label.workspace).font(.caption).foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                            if let identity = label.identityDetail { Text(identity).font(.caption).foregroundStyle(.secondary) }
                        }
                        Spacer()
                        if selection == instance.id { Image(systemName: "checkmark").foregroundStyle(.tint).accessibilityHidden(true) }
                    }
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(label.accessibilityValue)
                .accessibilityValue(selection == instance.id ? "Selected" : "")
                .accessibilityIdentifier("conversation.agent.option.\(instance.id)")
            }
        }
        .navigationTitle("Agent")
    }
}

private struct AssistantRequestSummaryView: View {
    let summary: AssistantRequestSummary
    let turnId: String
    @State private var showsOriginal = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(summary.text).font(.headline)
                .accessibilityIdentifier("conversation.turn.request.\(turnId)")
            if summary.isUnavailable {
                Text("Request: \(turnId)").font(.caption).foregroundStyle(.secondary)
                Text("Load more messages to find the original request.").font(.caption).foregroundStyle(.secondary)
            }
            if let original = summary.originalText {
                // Keep this action separate from selectable text in the List,
                // as with the existing original-message disclosures.
                Button {
                    showsOriginal.toggle()
                } label: {
                    HStack {
                        Text(showsOriginal ? "Hide full request" : "Show full request")
                        Spacer()
                        Image(systemName: showsOriginal ? "chevron.down" : "chevron.right").accessibilityHidden(true)
                    }
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityValue(showsOriginal ? "Expanded" : "Collapsed")
                .accessibilityIdentifier("conversation.turn.request.disclosure.\(turnId)")
                if showsOriginal {
                    Text(original).font(.subheadline).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("conversation.turn.request.original.\(turnId)")
                }
            }
        }
    }
}

struct ConversationMetadataView: View {
    @EnvironmentObject private var container: AppContainer
    let actorType: String
    let actorId: String
    let createdAt: String?
    let members: [WorkspaceRecord]
    let agents: [WorkspaceRecord]
    var agentInstances: [WorkspaceRecord] = []
    var body: some View {
        let author = ConversationMetadata.author(actorType: actorType, actorId: actorId, members: members, agents: agents, agentInstances: agentInstances,
            currentUserId: container.identity?.user.id ?? container.bootstrap.value?.user.id,
            currentUserName: container.identity?.user.name ?? container.bootstrap.value?.user.displayName)
        let timestamp = ConversationMetadata.timestamp(createdAt)
        Text(timestamp.isEmpty ? author : "\(author) · \(timestamp)").font(.caption).foregroundStyle(.secondary)
    }
}

private struct RealtimeStatusView: View {
    @ObservedObject var connection: RealtimeConnection
    var body: some View {
        Label(connection.connected ? "Live updates connected" : "Reconnecting · drafts saved on this phone", systemImage: connection.connected ? "bolt.horizontal.circle" : "wifi.exclamationmark")
            .font(.caption).foregroundStyle(.secondary)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("realtimeStatus").accessibilityValue(connection.connected ? "connected" : "reconnecting")
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
