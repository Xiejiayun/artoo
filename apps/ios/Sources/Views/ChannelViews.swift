import SwiftUI

struct ChannelsView: View {
    @StateObject private var model: WorkspaceViewModel
    @State private var name = ""
    @State private var description = ""
    let projectId: String
    init(client: ApiClientProtocol, projectId: String) {
        self.projectId = projectId
        _model = StateObject(wrappedValue: WorkspaceViewModel(client: client, path: "/api/v1/channels?project_id=\(apiPart(projectId))"))
    }
    var body: some View {
        NavigationStack {
            List {
                Section("Project channels") {
                    ForEach(model.state.value?["channels"].records ?? []) { channel in
                        NavigationLink { CollaborationView(client: model.client, roomId: channel.id, taskId: nil) } label: {
                            VStack(alignment: .leading) {
                                Label(channel["name"].text, systemImage: "number")
                                if !channel["description"].text.isEmpty { Text(channel["description"].text).font(.caption).foregroundStyle(.secondary) }
                            }
                        }.accessibilityIdentifier("channel.\(channel.id)")
                    }
                    if model.state.value?["channels"].array.isEmpty == true { Text("Create a channel for your project's discussions.") }
                }
                Section("Create channel") {
                    TextField("Channel name", text: $name)
                    TextField("Description", text: $description, axis: .vertical)
                    Button("Create channel") { Task {
                        if await model.perform(path: "/api/v1/channels", body: .object(["project_id": .string(projectId), "name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)), "description": .string(description)])) { name = ""; description = "" }
                    } }.disabled(model.busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                if model.state.isLoading { ProgressView() }
                if let message = model.actionError ?? model.state.errorMessage { Text(message).foregroundStyle(.red) }
            }.navigationTitle("Channels").refreshable { await model.load() }.liveRefresh { await model.load() }
        }
    }
}

struct MentionsView: View {
    @EnvironmentObject private var container: AppContainer
    @StateObject private var model: NotificationInboxViewModel
    @State private var members: [WorkspaceRecord] = []
    init(client: ApiClientProtocol) { _model = StateObject(wrappedValue: NotificationInboxViewModel(client: client)) }
    var body: some View {
        List {
            Text(container.notificationCountSummary).font(.caption).foregroundStyle(.secondary)
                .accessibilityIdentifier("mentions.unreadSummary")
            ForEach(model.notifications) { item in
                NavigationLink { MentionDestination(container: container, notification: item) { updated, unreadCount in
                    model.recordRead(updated, unreadCount: unreadCount)
                    container.acceptNotificationCount(unreadCount, session: (model.client as? ApiClient)?.sessionID)
                }.id(item.id) } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            if item["read_at"] == .null { Image(systemName: "circle.fill").foregroundStyle(.blue).font(.caption2).accessibilityIdentifier("mention.unread.\(item.id)") }
                            Text(item["body_preview"].text).lineLimit(3)
                        }
                        ConversationMetadataView(actorType: "user", actorId: item["actor_id"].text, createdAt: item["created_at"].text,
                                                 members: members, agents: [])
                        if !item["room_name"].text.isEmpty { Text(item["room_name"].text).font(.caption).foregroundStyle(.secondary) }
                    }
                }.accessibilityIdentifier("mention.\(item.id)")
                    .accessibilityValue(item["read_at"] == .null ? "Unread" : "Read")
            }
            if model.notifications.isEmpty && !model.loading { Text("No mentions yet.") }
            if model.hasMore { Button("Load earlier mentions") { Task { await model.loadEarlier() } }.disabled(model.loading) }
            if model.loading { ProgressView() }
            if let error = model.error ?? container.notificationCountError { Text(error).foregroundStyle(.red) }
        }.navigationTitle("Mentions").refreshable { await refresh(); await container.refreshNotificationCount() }.liveRefresh { await refresh() }
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
            else if let error { VStack { Text(error).foregroundStyle(.red); Button("Retry") { Task { await load() } } } }
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
