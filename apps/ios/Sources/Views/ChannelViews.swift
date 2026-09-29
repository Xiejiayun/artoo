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
    init(client: ApiClientProtocol) { _model = StateObject(wrappedValue: NotificationInboxViewModel(client: client)) }
    var body: some View {
        List {
            Text(container.notificationCountSummary).font(.caption).foregroundStyle(.secondary)
            ForEach(model.notifications) { item in
                NavigationLink { MentionDestination(client: model.client, notification: item) { updated, unreadCount in
                    model.recordRead(updated, unreadCount: unreadCount)
                    container.acceptNotificationCount(unreadCount, session: (model.client as? ApiClient)?.sessionID)
                } } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            if item["read_at"] == .null { Image(systemName: "circle.fill").foregroundStyle(.blue).font(.caption2) }
                            Text(item["body_preview"].text).lineLimit(3)
                        }
                        Text("\(item["actor_id"].text) · \(item["created_at"].text)").font(.caption).foregroundStyle(.secondary)
                        if !item["room_name"].text.isEmpty { Text(item["room_name"].text).font(.caption).foregroundStyle(.secondary) }
                    }
                }
            }
            if model.notifications.isEmpty && !model.loading { Text("No mentions yet.") }
            if model.hasMore { Button("Load earlier mentions") { Task { await model.loadEarlier() } }.disabled(model.loading) }
            if model.loading { ProgressView() }
            if let error = model.error ?? container.notificationCountError { Text(error).foregroundStyle(.red) }
        }.navigationTitle("Mentions").refreshable { await model.refresh(); await container.refreshNotificationCount() }.liveRefresh { await model.refresh() }
        .onChange(of: model.unreadCount) { _, count in
            if let count { container.acceptNotificationCount(count, session: (model.client as? ApiClient)?.sessionID) }
        }
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
    @EnvironmentObject private var container: AppContainer
    let client: ApiClientProtocol
    let notification: WorkspaceRecord
    let onRead: (WorkspaceRecord, Int) -> Void
    @State private var root: Message?
    @State private var focus: Message?
    @State private var error: String?
    var body: some View {
        Group {
            if let root {
                CollaborationView(client: client, roomId: notification["room_id"].text, taskId: nil, threadRoot: root, focusedMessage: focus)
                    .safeAreaInset(edge: .bottom) {
                        if let error { Text("Read status could not be confirmed: \(error)").font(.caption).foregroundStyle(.red).padding() }
                    }
            } else if let error { VStack { Text(error).foregroundStyle(.red); Button("Retry") { Task { await load() } } } }
            else { ProgressView("Opening mention…") }
        }.task { await load() }
    }
    private func load() async {
        do {
            let projectId = notification["project_id"].text
            if !projectId.isEmpty, container.bootstrap.value?.projects.contains(where: { $0.id == projectId }) == true { container.selectedProjectId = projectId }
            let room = apiPart(notification["room_id"].text)
            let selected = try await client.resource(path: "/api/v1/rooms/\(room)/messages/\(apiPart(notification["message_id"].text))")
            let message = try ArtooJSON.decoder().decode(MessageEnvelope.self, from: JSONEncoder().encode(selected)).message
            if let rootId = message.threadRootId {
                let response = try await client.resource(path: "/api/v1/rooms/\(room)/messages/\(apiPart(rootId))")
                root = try ArtooJSON.decoder().decode(MessageEnvelope.self, from: JSONEncoder().encode(response)).message
            } else { root = message }
            focus = message; error = nil
            let read = try await client.command(path: "/api/v1/notifications/\(apiPart(notification.id))/read", method: "POST", body: .object([:]))
            if let updated = WorkspaceRecord(read["notification"]), let count = Int(read["unread_count"].text) { onRead(updated, count) }
        } catch { self.error = String(describing: error) }
    }
}
