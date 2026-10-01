import SwiftUI

struct ChannelsView: View {
    @EnvironmentObject private var container: AppContainer
    @StateObject private var model: WorkspaceViewModel
    @State private var name = ""
    @State private var description = ""
    @State private var searchText = ""
    @State private var showingCreate = false
    let projectId: String
    init(client: ApiClientProtocol, projectId: String) {
        self.projectId = projectId
        _model = StateObject(wrappedValue: WorkspaceViewModel(client: client, path: "/api/v1/channels?project_id=\(apiPart(projectId))"))
    }
    var body: some View {
        NavigationStack {
            StateView(state: model.state, retry: { Task { await model.load() } }) { data in
                let channels = data["channels"].records
                let matches = channels.filter {
                    searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                    ($0["name"].text + " " + $0["description"].text).localizedCaseInsensitiveContains(searchText)
                }
                if channels.isEmpty {
                    EmptyStateView(systemImage: "bubble.left.and.bubble.right", title: "Your team's conversations start here",
                                   message: "Create a channel for a project, a topic, or the whole team. Keep replies together in threads.",
                                   actionTitle: "Create channel", action: { showingCreate = true })
                } else if matches.isEmpty {
                    EmptyStateView(systemImage: "magnifyingglass", title: "No channels found",
                                   message: "Try another name or topic.", actionTitle: "Clear search", action: { searchText = "" })
                } else {
                    List {
                        if let message = model.actionError {
                            Section {
                                Label(message, systemImage: "exclamationmark.circle").font(.callout).foregroundStyle(ArtooTokens.ColorToken.warning)
                                Button("Retry refresh") { Task { await model.load() } }.frame(minHeight: 44)
                            }
                        }
                        Section {
                            ArtooPageIntro(title: projectName, message: "A shared space for conversations, decisions, and the work that follows.", systemImage: "bubble.left.and.bubble.right.fill")
                                .listRowBackground(Color.clear)
                        }
                        Section {
                            ForEach(matches) { channel in
                                NavigationLink {
                                    CollaborationView(client: model.client, roomId: channel.id, taskId: nil,
                                                      roomName: channel["name"].text, roomDescription: channel["description"].text)
                                } label: {
                                    HStack(alignment: .top, spacing: ArtooTokens.Spacing.sm) {
                                        ArtooAvatar(name: channel["name"].text, systemImage: "number", size: 44)
                                        VStack(alignment: .leading, spacing: 5) {
                                            Text(channel["name"].text).font(.headline).foregroundStyle(ArtooTokens.ColorToken.text)
                                            Text(channel["description"].text.isEmpty ? "Open the conversation" : channel["description"].text)
                                                .font(.subheadline).foregroundStyle(ArtooTokens.ColorToken.textMuted).lineLimit(2)
                                        }
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                    }
                                    .padding(.vertical, 7)
                                }
                                .accessibilityIdentifier("channel.\(channel.id)")
                            }
                        } header: { ArtooSectionHeading(title: "Project channels", count: matches.count) }
                    }
                    .listStyle(.insetGrouped)
                }
            }
            .navigationTitle("Channels")
            .searchable(text: $searchText, prompt: "Find a channel or topic")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    NavigationLink { MentionsView(client: model.client) } label: { Label(container.mentionsTitle, systemImage: "at") }
                        .accessibilityHint(container.notificationCountSummary)
                }
                ToolbarItem(placement: .primaryAction) {
                    Button { showingCreate = true } label: { Label("Create channel", systemImage: "square.and.pencil") }
                        .accessibilityIdentifier("channel.create.open")
                }
            }
            .sheet(isPresented: $showingCreate) { createChannelSheet }
            .refreshable { await model.load() }.liveRefresh { await model.load() }
        }
    }

    private var projectName: String { container.bootstrap.value?.projects.first { $0.id == projectId }?.name ?? "Your workspace" }

    private var createChannelSheet: some View {
        NavigationStack {
            Form {
                Section {
                    ArtooPageIntro(title: "Bring the right people together", message: "Give this conversation a clear name and a purpose your team can recognize.", systemImage: "number")
                }
                Section("Channel name") {
                    TextField("e.g. product-design", text: $name).textInputAutocapitalization(.never)
                        .accessibilityIdentifier("channel.create.name")
                }
                Section("Topic · optional") {
                    TextField("What will your team discuss here?", text: $description, axis: .vertical).lineLimit(3...6)
                }
                if let message = model.actionError { Section { Text(message).foregroundStyle(ArtooTokens.ColorToken.danger) } }
            }
            .navigationTitle("New channel").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { showingCreate = false }.disabled(model.busy) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { Task {
                        if await model.perform(path: "/api/v1/channels", body: .object(["project_id": .string(projectId), "name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)), "description": .string(description)])) {
                            name = ""; description = ""; showingCreate = false
                        }
                    } }.disabled(model.busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier("channel.create.submit")
                }
            }
        }
        .interactiveDismissDisabled(model.busy)
    }
}

struct MentionsView: View {
    @EnvironmentObject private var container: AppContainer
    @StateObject private var model: NotificationInboxViewModel
    @State private var members: [WorkspaceRecord] = []
    init(client: ApiClientProtocol) { _model = StateObject(wrappedValue: NotificationInboxViewModel(client: client)) }
    var body: some View {
        List {
            Section {
                ArtooPageIntro(title: "Catch up where you're needed", message: "Mentions bring you back to the exact conversation, even across projects.", systemImage: "at")
                Text(container.notificationCountSummary).font(.caption).foregroundStyle(.secondary)
                    .accessibilityIdentifier("mentions.unreadSummary")
            }
            ForEach(model.notifications) { item in
                NavigationLink { MentionDestination(container: container, notification: item) { updated, unreadCount in
                    model.recordRead(updated, unreadCount: unreadCount)
                    container.acceptNotificationCount(unreadCount, session: (model.client as? ApiClient)?.sessionID)
                }.id(item.id) } label: {
                    HStack(alignment: .top, spacing: 12) {
                        ArtooAvatar(name: "Mention", systemImage: "at", color: item["read_at"] == .null ? ArtooTokens.ColorToken.accent : ArtooTokens.ColorToken.neutral)
                        VStack(alignment: .leading, spacing: 6) {
                        if !item["room_name"].text.isEmpty {
                            Label(item["room_name"].text, systemImage: "number").font(.caption.weight(.semibold)).foregroundStyle(ArtooTokens.ColorToken.accent)
                        }
                        HStack {
                            if item["read_at"] == .null { Image(systemName: "circle.fill").foregroundStyle(ArtooTokens.ColorToken.accent).font(.caption2).accessibilityIdentifier("mention.unread.\(item.id)") }
                            Text(item["body_preview"].text).lineLimit(3)
                        }
                        ConversationMetadataView(actorType: "user", actorId: item["actor_id"].text, createdAt: item["created_at"].text,
                                                 members: members, agents: [])
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(.vertical, 6)
                }.accessibilityIdentifier("mention.\(item.id)")
                    .accessibilityValue(item["read_at"] == .null ? "Unread" : "Read")
            }
            if model.notifications.isEmpty && !model.loading && model.error == nil {
                EmptyStateView(systemImage: "at", title: "You're all caught up", message: "When a teammate mentions you, their message will appear here.")
            }
            if model.hasMore { Button("Load earlier mentions") { Task { await model.loadEarlier() } }.disabled(model.loading) }
            if model.loading { ProgressView() }
            if let error = model.error ?? container.notificationCountError { Text(error).foregroundStyle(.red) }
        }.listStyle(.insetGrouped).navigationTitle("Mentions").refreshable { await refresh(); await container.refreshNotificationCount() }.liveRefresh { await refresh() }
        .onChange(of: model.unreadCount) { _, count in
            if let count { container.acceptNotificationCount(count, session: (model.client as? ApiClient)?.sessionID) }
        }
    }
    private func refresh() async {
        await model.refresh()
        do {
            let response = try await model.client.resource(path: "/api/v1/members")
            guard !Task.isCancelled else { return }
            members = response["members"].records
        } catch { /* Keep known names; unresolved people retain their actual IDs. */ }
    }
}

private struct MessageEnvelope: Decodable { let message: Message }

struct RoomThreadView: View {
    let client: ApiClientProtocol
    let roomId: String
    let rootId: String
    @State private var root: Message?
    @State private var error: String?
    var body: some View {
        Group {
            if let root { CollaborationView(client: client, roomId: roomId, taskId: nil, threadRoot: root) }
            else if let error { ErrorStateView(message: error, retry: { Task { await load() } }) }
            else { ProgressView("Opening discussion…") }
        }.task { await load() }
    }
    private func load() async {
        do {
            let value = try await client.resource(path: "/api/v1/rooms/\(apiPart(roomId))/messages/\(apiPart(rootId))")
            root = try ArtooJSON.decoder().decode(MessageEnvelope.self, from: JSONEncoder().encode(value)).message; error = nil
        } catch { self.error = String(describing: error) }
    }
}

private struct MentionDestination: View {
    let client: ApiClientProtocol
    let notification: WorkspaceRecord
    let onRead: (WorkspaceRecord, Int) -> Void
    @StateObject private var model: MentionDestinationViewModel
    init(container: AppContainer, notification: WorkspaceRecord, onRead: @escaping (WorkspaceRecord, Int) -> Void) {
        let client = container.client, session = container.sessionGeneration
        self.client = client; self.notification = notification; self.onRead = onRead
        _model = StateObject(wrappedValue: container.makeMentionDestinationModel(client: client, session: session))
    }
    var body: some View {
        Group {
            if model.projectResolved, let root = model.root {
                CollaborationView(client: client, roomId: model.roomId, taskId: nil, threadRoot: root, focusedMessage: model.focus)
                    .safeAreaInset(edge: .bottom) {
                        if let error = model.readError {
                            VStack(spacing: 8) {
                                Text("Read status could not be confirmed: \(error)").font(.caption).foregroundStyle(.red)
                                    .accessibilityIdentifier("mention.readError")
                                Button("Retry read") { Task { await model.retryRead(onRead: onRead) } }
                                    .disabled(model.markingRead).accessibilityIdentifier("retryMentionRead")
                            }.padding().frame(maxWidth: .infinity).background(.regularMaterial)
                        } else if model.markingRead { ProgressView("Confirming read status…").padding() }
                    }
            } else if let error = model.loadError {
                VStack {
                    Text(error).foregroundStyle(.red).accessibilityIdentifier("mention.open.error")
                    Button("Retry opening mention") { Task { await load() } }.disabled(model.loading).accessibilityIdentifier("retryOpenMention")
                }
            }
            else { ProgressView("Opening mention…") }
        }.task(id: notification.id) { await load() }.onDisappear { model.cancel() }
    }
    private func load() async {
        await model.load(notification, onRead: onRead)
    }
}
