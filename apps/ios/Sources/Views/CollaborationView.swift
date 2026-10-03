import SwiftUI

struct CollaborationView: View {
    private enum InputField: Hashable { case composer, recordSummary }
    @EnvironmentObject private var container: AppContainer
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.verticalSizeClass) private var verticalSizeClass
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
    @State private var showingWorkDetails = false
    @State private var scrollRequest = UUID()
    @State private var deliveryDetailsRequest = UUID()
    @State private var visibleMessageIDs = Set<String>()
    @State private var placedInitialHistory = false
    @State private var unseenMessageCount = 0
    @FocusState private var focusedField: InputField?
    let roomId: String
    let taskId: String?
    let threadRoot: Message?
    let focusedMessage: Message?
    let roomName: String
    let roomDescription: String
    init(client: ApiClientProtocol, roomId: String, taskId: String?, threadRoot: Message? = nil, focusedMessage: Message? = nil, roomName: String = "", roomDescription: String = "") {
        self.roomId = roomId; self.taskId = taskId
        self.threadRoot = threadRoot; self.focusedMessage = focusedMessage
        self.roomName = roomName; self.roomDescription = roomDescription
        _model = StateObject(wrappedValue: WorkspaceViewModel(client: client, path: "/api/v1/rooms/\(apiPart(roomId))/messages"))
        _chat = StateObject(wrappedValue: RoomMessagesViewModel(client: client, roomId: roomId, threadRootId: threadRoot?.id, allowsAssistantRequests: threadRoot?.isPlanningDiscussion != true))
    }
    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                List {
                    Section {
                        ArtooPageIntro(title: threadRoot == nil ? conversationTitle : "Keep the conversation together",
                                       message: roomDescription.isEmpty ? (threadRoot == nil ? "Share an update, ask a question, or turn a conversation into work." : "Replies here stay connected to the original message.") : roomDescription,
                                       systemImage: threadRoot == nil ? "number" : "bubble.left.and.bubble.right")
                            .listRowSeparator(.hidden)
                        if !chat.allowsAssistantRequests {
                            Text("Agents take turns within this goal's discussion limits. Add a team reply to share constraints; manage the discussion from the goal.")
                                .font(.caption).foregroundStyle(.secondary).listRowSeparator(.hidden)
                        }
                    }
                    if let root = threadRoot { Section("Original message") { messageContent(root).id(root.id) } }
                    if let focus = focusedMessage, focus.id != threadRoot?.id { Section("Mentioned reply") { messageContent(focus).id(focus.id) } }
                    Section {
                        if chat.hasOlder {
                            Button { Task { await chat.loadOlder() } } label: { Label("Load earlier messages", systemImage: "arrow.up") }
                                .frame(maxWidth: .infinity, minHeight: 44).disabled(chat.loading)
                        }
                        if chat.messages.isEmpty && !chat.loading {
                            EmptyStateView(systemImage: "bubble.left", title: threadRoot == nil ? "Start the conversation" : "Be the first to reply",
                                           message: "Share context with the team. Mention someone when you need their attention.")
                                .listRowSeparator(.hidden)
                        }
                        ForEach(Array(visibleMessages.enumerated()), id: \.element.id) { index, item in
                            VStack(alignment: .leading, spacing: 8) {
                                if startsNewDay(index) { messageDate(item) }
                                messageContent(item)
                                if threadRoot == nil {
                                    NavigationLink {
                                        CollaborationView(client: model.client, roomId: roomId, taskId: taskId, threadRoot: item,
                                                          roomName: roomName, roomDescription: roomDescription)
                                    } label: {
                                        Label((item.replyCount ?? 0) == 0 ? "Reply in thread" : "\(item.replyCount ?? 0) replies", systemImage: "bubble.left.and.bubble.right")
                                            .font(.caption.weight(.semibold)).foregroundStyle(ArtooTokens.ColorToken.accent)
                                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                            .contentShape(Rectangle())
                                    }
                                    .padding(.leading, 50)
                                    .buttonStyle(.plain)
                                    .accessibilityIdentifier("thread.\(item.id)")
                                }
                            }
                            .padding(.vertical, 5)
                            .id(item.id)
                            .onAppear {
                                visibleMessageIDs.insert(item.id)
                                if item.id == chat.messages.last?.id { unseenMessageCount = 0 }
                            }
                            .onDisappear { visibleMessageIDs.remove(item.id) }
                            .listRowSeparator(.hidden)
                        }
                        if chat.hasNewer { Button("Load new messages") { Task { await chat.refresh() } }.frame(minHeight: 44).disabled(chat.loading) }
                        if chat.loading { ProgressView("Loading conversation…") }
                    }
                    if chat.allowsAssistantRequests && chat.draft.target == "assistant" {
                        Section("Agent for this request") { assistantConfiguration }.id("assistantConfiguration")
                    }
                    assistantRequests
                    deliveryStatus
                    if let message = error ?? model.actionError ?? model.state.errorMessage {
                        Section { Text(message).font(.callout).foregroundStyle(ArtooTokens.ColorToken.danger) }
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .background(ArtooTokens.ColorToken.surfaceRaised)
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: scrollRequest) { _, _ in
                    unseenMessageCount = 0
                    if let last = chat.messages.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } }
                }
                .onChange(of: deliveryDetailsRequest) { _, _ in
                    withAnimation { proxy.scrollTo("deliveryStatus", anchor: .top) }
                }
                .onChange(of: chat.loading) { _, loading in
                    // A mention can target the root of a thread with no replies.
                    if !loading && chat.messages.isEmpty { placeInitialHistory(using: proxy) }
                }
                .onChange(of: chat.messages.map(\.id)) { previous, current in
                    guard let latest = current.last else { return }
                    if !placedInitialHistory {
                        placeInitialHistory(using: proxy)
                        return
                    }
                    guard previous.last != latest else { return } // Loading older history keeps the reader's place.
                    if previous.last.map({ visibleMessageIDs.contains($0) }) == true {
                        proxy.scrollTo(latest, anchor: .bottom)
                        unseenMessageCount = 0
                    } else {
                        let known = Set(previous)
                        unseenMessageCount += current.filter { !known.contains($0) }.count
                    }
                }
                .onChange(of: isAgentRequest) { _, selected in
                    if selected { withAnimation { proxy.scrollTo("assistantConfiguration", anchor: .bottom) } }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            composer
        }
        .modifier(ComposerKeyboardAvoidance(enabled: focusedField == .composer))
        .safeAreaInset(edge: .top, spacing: 0) {
            HStack(spacing: 8) {
                RealtimeStatusView(connection: container.realtime)
                Spacer(minLength: 0)
                if unseenMessageCount > 0 {
                    Button { scrollRequest = UUID() } label: {
                        Label("\(unseenMessageCount) new", systemImage: "arrow.down").font(.caption.weight(.semibold))
                            .frame(minHeight: 44)
                    }
                    .accessibilityLabel("\(unseenMessageCount) new messages. Jump to latest messages")
                    .accessibilityIdentifier("conversation.newMessages")
                }
            }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16).padding(.vertical, 8)
                .background(ArtooTokens.ColorToken.surfaceRaised)
                .overlay(alignment: .bottom) { Divider() }
        }
        .navigationTitle(threadRoot == nil ? conversationTitle : "Thread")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await refresh() }.liveRefresh { await refresh() }
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button { scrollRequest = UUID() } label: { Label("Latest messages", systemImage: "arrow.down.to.line") }
                    .accessibilityIdentifier("conversation.latest")
                if threadRoot == nil {
                    Button { showingWorkDetails = true } label: { Label("Channel details and work", systemImage: "info.circle") }
                        .accessibilityIdentifier("conversation.details")
                }
            }
        }
        .sheet(isPresented: $showingWorkDetails) { workDetails }
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

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if chat.allowsAssistantRequests {
                HStack {
                    Picker("Send to", selection: Binding(get: { chat.draft.target ?? "team" }, set: { chat.draft.target = $0 })) {
                        Text("Team discussion").tag("team"); Text("Agent").tag("assistant")
                    }
                    .pickerStyle(.menu)
                    .disabled(chat.sending || chat.draft.pending != nil)
                    .accessibilityIdentifier("conversation.destination")
                    Spacer(minLength: 0)
                    if !isAgentRequest { mentionMenu }
                    deliveryDetailsButton
                    composerDoneButton
                }.frame(minHeight: 44)
            } else {
                HStack {
                    Text("Reply to this discussion").font(.caption.weight(.medium)).foregroundStyle(.secondary)
                    Spacer()
                    mentionMenu
                    deliveryDetailsButton
                    composerDoneButton
                }
            }
            HStack(alignment: .bottom, spacing: 10) {
                TextField(isAgentRequest ? "Ask the agent" : (threadRoot == nil ? "Message the team" : "Reply in thread"), text: $chat.draft.text, axis: .vertical)
                    .lineLimit(1...(verticalSizeClass == .compact ? 1 : (dynamicTypeSize.isAccessibilitySize ? 2 : 5)))
                    .font(.body).padding(.vertical, 11).padding(.horizontal, 12)
                    .focused($focusedField, equals: .composer)
                    .disabled(chat.sending || chat.draft.pending != nil)
                    .accessibilityIdentifier("messageComposer")
                    .background(ArtooTokens.ColorToken.background, in: RoundedRectangle(cornerRadius: 14))
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(ArtooTokens.ColorToken.border.opacity(0.35), lineWidth: 1))
                Button {
                    guard canSend else { return }
                    Task {
                        await chat.send()
                        if chat.error == nil && chat.draft.pending == nil { scrollRequest = UUID() }
                    }
                } label: {
                    Group {
                        if chat.sending { ProgressView().tint(.white) }
                        else { Image(systemName: "arrow.up").font(.headline) }
                    }
                    .frame(width: 44, height: 44).foregroundStyle(.white)
                    .background(canSend ? Color.accentColor : ArtooTokens.ColorToken.neutral.opacity(0.35), in: RoundedRectangle(cornerRadius: 14))
                }
                .buttonStyle(.plain).disabled(!canSend)
                .accessibilityLabel(isAgentRequest ? "Send to agent" : "Send to team")
                .accessibilityIdentifier("sendMessage")
            }
        }
        .padding(.horizontal, 16).padding(.top, 4).padding(.bottom, 10)
        .background(ArtooTokens.ColorToken.surfaceRaised)
        .overlay(alignment: .top) { Divider() }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("conversation.composer")
    }

    @ViewBuilder private var composerDoneButton: some View {
        if focusedField == .composer {
            Button { focusedField = nil } label: {
                Text("Done")
                    .font(.body.weight(.semibold))
                    .fixedSize(horizontal: true, vertical: false)
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("conversation.keyboard.done")
        }
    }

    @ViewBuilder private var deliveryDetailsButton: some View {
        if chat.draft.pending != nil || chat.error != nil {
            Button { focusedField = nil; deliveryDetailsRequest = UUID() } label: {
                Label("Review message delivery", systemImage: "exclamationmark.circle.fill").labelStyle(.iconOnly)
                    .foregroundStyle(ArtooTokens.ColorToken.warning).frame(width: 44, height: 44)
            }.accessibilityIdentifier("conversation.deliveryDetails")
        }
    }

    @ViewBuilder private var deliveryStatus: some View {
        if chat.draft.pending != nil || chat.error != nil {
            Section("Message delivery") {
            if chat.draft.pending != nil {
                if chat.unsupportedPendingAssistant {
                    Text("An earlier agent request has unconfirmed delivery. Check this discussion's activity before keeping its text as a team reply.").font(.caption)
                    Button("Keep text as team reply") { chat.keepPendingTextAsTeamReply() }.frame(minHeight: 44).disabled(chat.sending)
                } else {
                    Button("Retry pending send") { Task { await chat.submitPending() } }.frame(minHeight: 44).disabled(chat.sending)
                    Text("Delivery is unconfirmed. Retrying uses the same send identifier to avoid a duplicate.").font(.caption)
                }
            }
            if let message = chat.error { Text(message).font(.caption).foregroundStyle(ArtooTokens.ColorToken.danger) }
            }.id("deliveryStatus")
        }
    }

    private var mentionMenu: some View {
        Menu {
            ForEach(members) { member in
                Toggle(member.title, isOn: Binding(get: { chat.draft.mentionedUserIds?.contains(member.id) == true }, set: { selected in toggleMention(member, selected: selected) }))
            }
        } label: { Label("Mention a teammate", systemImage: "at").labelStyle(.iconOnly).frame(width: 44, height: 44) }
        .disabled(chat.sending || chat.draft.pending != nil || members.isEmpty)
        .accessibilityIdentifier("conversation.mention")
        .accessibilityValue(members.filter { chat.draft.mentionedUserIds?.contains($0.id) == true }.map(\.title).joined(separator: ", "))
    }

    private var isAgentRequest: Bool { chat.allowsAssistantRequests && chat.draft.target == "assistant" }
    private var canSend: Bool {
        !chat.sending && chat.draft.pending == nil && !chat.draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && (!isAgentRequest || selectedAgentAvailability.allowsNewRequest)
    }
    private var conversationTitle: String { roomName.isEmpty ? "Team discussion" : "# \(roomName)" }
    private func placeInitialHistory(using proxy: ScrollViewProxy) {
        guard !placedInitialHistory else { return }
        if let focus = focusedMessage {
            placedInitialHistory = true
            proxy.scrollTo(focus.id, anchor: .center)
        } else if let latest = chat.messages.last {
            placedInitialHistory = true
            proxy.scrollTo(latest.id, anchor: .bottom)
        }
    }

    private var visibleMessages: [Message] {
        chat.messages.filter { $0.id != threadRoot?.id && $0.id != focusedMessage?.id }
    }

    private func startsNewDay(_ index: Int) -> Bool {
        guard index > 0 else { return true }
        let messages = visibleMessages
        guard let current = messages[index].createdAt.flatMap(ConversationMetadata.parseTimestamp),
              let previous = messages[index - 1].createdAt.flatMap(ConversationMetadata.parseTimestamp) else { return false }
        return !Calendar.autoupdatingCurrent.isDate(current, inSameDayAs: previous)
    }

    @ViewBuilder private func messageDate(_ message: Message) -> some View {
        if let date = message.createdAt.flatMap(ConversationMetadata.parseTimestamp) {
            HStack(spacing: 12) {
                Rectangle().fill(ArtooTokens.ColorToken.border.opacity(0.4)).frame(height: 1)
                Text(date, format: .dateTime.month(.abbreviated).day().year()).font(.caption.weight(.medium))
                    .foregroundStyle(.secondary).fixedSize()
                Rectangle().fill(ArtooTokens.ColorToken.border.opacity(0.4)).frame(height: 1)
            }.padding(.vertical, 10).accessibilityAddTraits(.isHeader)
        }
    }

    @ViewBuilder private var assistantConfiguration: some View {
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
                    if selectedAgentAvailability == .unavailable {
                        Label("This selected agent is no longer available. Choose another agent or Automatic selection before sending.", systemImage: "exclamationmark.circle")
                            .font(.subheadline).foregroundStyle(ArtooTokens.ColorToken.warning)
                            .accessibilityIdentifier("conversation.agent.unavailable")
                    } else if selectedAgentAvailability == .checking {
                        Text("Checking the selected agent. Refresh agents if the connection could not be confirmed.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
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
    }

    @ViewBuilder private var assistantRequests: some View {
            if !chat.turns.isEmpty || chat.turnError != nil {
                Section("Agent requests") {
                    ForEach(chat.turns) { turn in
                        let request = AssistantRequestSummary(userMessageId: turn.userMessageId, roomId: turn.roomId,
                                                              threadRootId: turn.threadRootId, messages: chat.messages)
                        VStack(alignment: .leading, spacing: 6) {
                            AssistantRequestSummaryView(summary: request, turnId: turn.id)
                            Text(turn.status.capitalized).font(.caption.weight(.semibold))
                                .padding(.horizontal, 8).padding(.vertical, 4)
                                .background(turnColor(turn.status).opacity(0.12), in: Capsule())
                                .foregroundStyle(turnColor(turn.status))
                                .accessibilityIdentifier("conversation.turn.status.\(turn.id)")
                            if let message = turn.error, !message.isEmpty { Text(message).foregroundStyle(.red) }
                            if turn.status == "waiting" { Text("Waiting for an available agent or execution approval.").font(.caption) }
                            NavigationLink("Open execution task") { TaskDetailView(client: model.client, taskId: turn.taskId) }
                                .frame(minHeight: 44)
                                .accessibilityIdentifier("conversation.turn.task.\(turn.id)")
                            if chat.allowsAssistantRequests { HStack {
                                if ["queued", "running", "waiting"].contains(turn.status) {
                                    Button("Cancel") { Task { await chat.changeTurn(turn, action: "cancel") } }
                                        .frame(minHeight: 44)
                                        .accessibilityIdentifier("conversation.turn.cancel.\(turn.id)")
                                }
                                if ["failed", "waiting"].contains(turn.status) {
                                    Button("Retry") { Task { await chat.changeTurn(turn, action: "retry") } }
                                        .frame(minHeight: 44)
                                        .accessibilityIdentifier("conversation.turn.retry.\(turn.id)")
                                }
                            }.buttonStyle(.borderless).disabled(chat.turnActionInFlight != nil) }
                        }
                        .padding(12)
                        .background(ArtooTokens.ColorToken.background, in: RoundedRectangle(cornerRadius: 14))
                        .listRowSeparator(.hidden)
                        .accessibilityElement(children: .contain)
                        .accessibilityIdentifier("conversation.turn.\(turn.id)")
                    }
                    if let message = chat.turnError { Text(message).foregroundStyle(.red) }
                }
            }
    }

    private var workDetails: some View {
        NavigationStack {
            List {
                Section {
                    ArtooPageIntro(title: conversationTitle, message: roomDescription.isEmpty ? "Capture decisions and handoffs so your team can pick up the work." : roomDescription, systemImage: "number")
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
                    .focused($focusedField, equals: .recordSummary)
                if recordKind == "handoffs" {
                    Picker("Recipient agent", selection: $recipient) {
                        Text("Choose agent").tag(""); ForEach(agents) { agent in Text(agent.title).tag(agent.id) }
                    }
                }
                Button("Create record") { Task { await createRecord() } }
                    .disabled(model.busy || summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (recordKind == "handoffs" && recipient.isEmpty))
            }
                if let message = error ?? model.actionError { Text(message).foregroundStyle(ArtooTokens.ColorToken.danger) }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Channel details").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { focusedField = nil; showingWorkDetails = false } }
                ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("Done") { focusedField = nil } }
            }
        }
    }

    private func turnColor(_ status: String) -> Color {
        switch status {
        case "completed": return ArtooTokens.ColorToken.success
        case "failed": return ArtooTokens.ColorToken.danger
        case "waiting": return ArtooTokens.ColorToken.warning
        case "running": return ArtooTokens.ColorToken.info
        default: return ArtooTokens.ColorToken.neutral
        }
    }

    private func messageContent(_ message: Message) -> some View {
        let author = ConversationMetadata.author(actorType: message.actorType, actorId: message.actorId,
            members: members, agents: agents, agentInstances: agentInstances,
            currentUserId: container.identity?.user.id ?? container.bootstrap.value?.user.id,
            currentUserName: container.identity?.user.name ?? container.bootstrap.value?.user.displayName, annotateSelf: false)
        let mentions = ConversationMetadata.mentionNames(message.payload, members: members, agents: agents, agentInstances: agentInstances,
            currentUserId: container.identity?.user.id ?? container.bootstrap.value?.user.id,
            currentUserName: container.identity?.user.name ?? container.bootstrap.value?.user.displayName)
        return HStack(alignment: .top, spacing: 10) {
            ArtooAvatar(name: author, systemImage: message.actorType == "agent" ? "sparkles" : (message.actorType == "system" ? "circle.hexagongrid" : nil))
            VStack(alignment: .leading, spacing: 6) {
                ConversationMetadataView(actorType: message.actorType, actorId: message.actorId, createdAt: message.createdAt,
                                         members: members, agents: agents, agentInstances: agentInstances, prominent: true)
                    .accessibilityIdentifier("messageAuthor.\(message.id)")
                MessageBodyView(message: message).font(.body).lineSpacing(3)
                if !mentions.isEmpty {
                    let labels = mentions.map { "@\($0)" }.joined(separator: " ")
                    Text(labels).font(.caption.weight(.medium)).foregroundStyle(ArtooTokens.ColorToken.accent)
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .background(ArtooTokens.ColorToken.accentSoft, in: RoundedRectangle(cornerRadius: 6))
                        .accessibilityLabel("Mentioned people").accessibilityValue(labels)
                        .accessibilityIdentifier("mentions.\(message.id)")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
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
        inventoryLoaded = false
        do {
            let bootstrap = try await model.client.resource(path: "/api/v1/bootstrap")
            agents = bootstrap["agents"].records; agentInstances = bootstrap["agent_instances"].records
            computers = bootstrap["computers"].records; inventoryLoaded = true
        } catch { self.error = String(describing: error) }
    }
    private var visibleAgentInstances: [WorkspaceRecord] { agentInstances.filter { $0.status != "disabled" } }
    private var selectedAgentAvailability: AgentSelectionAvailability {
        .resolve(instanceId: chat.draft.agentInstanceId, instances: agentInstances, loaded: inventoryLoaded)
    }
    private var selectedAgent: AssigneeLabel? {
        agentInstances.first { $0.id == chat.draft.agentInstanceId }.map {
            AssigneeLabel(instance: $0, agents: agents, computers: computers, options: visibleAgentInstances)
        }
    }
    private var selectedAgentAccessibilityValue: String {
        if selectedAgentAvailability == .unavailable { return "Unavailable agent: \(selectedAgent?.accessibilityValue ?? chat.draft.agentInstanceId ?? "")" }
        if selectedAgentAvailability == .checking { return "Checking selected agent: \(selectedAgent?.accessibilityValue ?? chat.draft.agentInstanceId ?? "")" }
        if let selectedAgent { return selectedAgent.accessibilityValue }
        if let id = chat.draft.agentInstanceId, !id.isEmpty { return "Selected agent: \(id)" }
        return "Automatic selection"
    }
    private var selectedAgentName: String {
        if selectedAgentAvailability == .unavailable { return "\(selectedAgent?.name ?? "Selected agent") (unavailable)" }
        if selectedAgentAvailability == .checking { return "Checking selected agent…" }
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
            if !selection.isEmpty && !instances.contains(where: { $0.id == selection }) {
                Label("Unavailable selected agent: \(selection). Choose an available agent or Automatic selection.", systemImage: "exclamationmark.circle")
                    .font(.subheadline).foregroundStyle(ArtooTokens.ColorToken.warning)
            }
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
    var prominent = false
    var body: some View {
        let author = ConversationMetadata.author(actorType: actorType, actorId: actorId, members: members, agents: agents, agentInstances: agentInstances,
            currentUserId: container.identity?.user.id ?? container.bootstrap.value?.user.id,
            currentUserName: container.identity?.user.name ?? container.bootstrap.value?.user.displayName)
        let timestamp = ConversationMetadata.timestamp(createdAt)
        let compactTimestamp = createdAt.flatMap(ConversationMetadata.parseTimestamp)?.formatted(date: .omitted, time: .shortened) ?? timestamp
        if prominent {
            (Text(author).font(.subheadline.weight(.semibold)).foregroundColor(.primary)
             + Text(compactTimestamp.isEmpty ? "" : " · \(compactTimestamp)").font(.caption).foregroundColor(.secondary))
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel(timestamp.isEmpty ? author : "\(author) · \(timestamp)")
        } else {
            Text(timestamp.isEmpty ? author : "\(author) · \(timestamp)").font(.caption).foregroundStyle(.secondary)
        }
    }
}

private struct RealtimeStatusView: View {
    @ObservedObject var connection: RealtimeConnection
    var body: some View {
        Label(connection.connected ? "Connected · messages update live" : "Reconnecting · drafts saved on this phone", systemImage: connection.connected ? "checkmark.circle.fill" : "wifi.exclamationmark")
            .font(.caption).foregroundStyle(connection.connected ? ArtooTokens.ColorToken.textMuted : ArtooTokens.ColorToken.warning)
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
