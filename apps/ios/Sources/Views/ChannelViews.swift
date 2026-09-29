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
                        }
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
    @StateObject private var model: WorkspaceViewModel
    init(client: ApiClientProtocol) { _model = StateObject(wrappedValue: WorkspaceViewModel(client: client, path: "/api/v1/notifications")) }
    var body: some View {
        List {
            ForEach(model.state.value?["notifications"].records ?? []) { item in
                NavigationLink { MentionDestination(client: model.client, notification: item) } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            if item["read_at"] == .null { Image(systemName: "circle.fill").foregroundStyle(.blue).font(.caption2) }
                            Text(item["body_preview"].text).lineLimit(3)
                        }
                        Text("\(item["actor_id"].text) · \(item["created_at"].text)").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            if model.state.value?["notifications"].array.isEmpty == true { Text("No mentions yet.") }
            if model.state.isLoading { ProgressView() }
            if let error = model.actionError ?? model.state.errorMessage { Text(error).foregroundStyle(.red) }
        }.navigationTitle("Mentions").refreshable { await model.load() }.liveRefresh { await model.load() }
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
            let room = apiPart(notification["room_id"].text)
            let selected = try await client.resource(path: "/api/v1/rooms/\(room)/messages/\(apiPart(notification["message_id"].text))")
            let message = try ArtooJSON.decoder().decode(MessageEnvelope.self, from: JSONEncoder().encode(selected)).message
            if let rootId = message.threadRootId {
                let response = try await client.resource(path: "/api/v1/rooms/\(room)/messages/\(apiPart(rootId))")
                root = try ArtooJSON.decoder().decode(MessageEnvelope.self, from: JSONEncoder().encode(response)).message
            } else { root = message }
            focus = message; error = nil
            _ = try await client.command(path: "/api/v1/notifications/\(apiPart(notification.id))/read", method: "POST", body: .object([:]))
        } catch { self.error = String(describing: error) }
    }
}
