import SwiftUI

public struct DiscussionParticipantDraft: Identifiable, Equatable {
    public let id = UUID()
    public var agentInstanceId = ""
    public var role = ""
    public init(role: String = "") { self.role = role }
}

public struct AgentDiscussionDraft: Equatable {
    public var participants = [DiscussionParticipantDraft(role: "Planner"), DiscussionParticipantDraft(role: "Reviewer")]
    public var rounds = 2
    public var maxMinutes = 15
    public var roomId = ""
    public init() {}
    public var valid: Bool {
        (2...6).contains(participants.count) && (1...3).contains(rounds) && (2...60).contains(maxMinutes)
        && participants.allSatisfy { !$0.agentInstanceId.isEmpty && !$0.role.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.role.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count <= 200 }
        && Set(participants.map(\.agentInstanceId)).count == participants.count
    }
    public var body: JSONValue {
        var fields: [String: JSONValue] = ["participants": .array(participants.map { .object(["agent_instance_id": .string($0.agentInstanceId), "role": .string($0.role.trimmingCharacters(in: .whitespacesAndNewlines))]) }),
                                           "rounds": .number(Double(rounds)), "max_minutes": .number(Double(maxMinutes))]
        if !roomId.isEmpty { fields["room_id"] = .string(roomId) }
        return .object(fields)
    }
}

struct AgentDiscussionView: View {
    @StateObject private var model: WorkspaceViewModel
    @State private var draft = AgentDiscussionDraft()
    @State private var instances: [WorkspaceRecord] = []
    @State private var agents: [WorkspaceRecord] = []
    @State private var computers: [WorkspaceRecord] = []
    @State private var inventoryLoaded = false
    @State private var loadingInventory = false
    @State private var channels: [WorkspaceRecord] = []
    @State private var error: String?
    @State private var starting = false
    @State private var pendingStart: (key: String, body: JSONValue)?
    let goalId: String
    let projectId: String
    init(client: ApiClientProtocol, goalId: String, projectId: String) {
        self.goalId = goalId; self.projectId = projectId
        _model = StateObject(wrappedValue: WorkspaceViewModel(client: client, path: "/api/v1/goals/\(apiPart(goalId))/discussions"))
    }
    var body: some View {
        List {
            Section {
                ArtooPageIntro(title: "Build the plan together", message: "Choose 2–6 distinct agents and give each a role. Review their proposed plan before it creates tasks.", systemImage: "person.2.wave.2")
            }
            Section("Planning team") {
                ForEach($draft.participants) { $participant in
                    let index = draft.participants.firstIndex { $0.id == participant.id } ?? 0
                    let availability = AgentSelectionAvailability.resolve(instanceId: participant.agentInstanceId, instances: instances, loaded: inventoryLoaded)
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Participant \(index + 1)").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                        Picker("Agent instance", selection: $participant.agentInstanceId) {
                            Text("Choose an agent").tag("")
                            if availability == .unavailable { Text("Unavailable: \(participant.agentInstanceId)").tag(participant.agentInstanceId) }
                            else if availability == .checking && !visibleInstances.contains(where: { $0.id == participant.agentInstanceId }) {
                                Text("Checking selected agent…").tag(participant.agentInstanceId)
                            }
                            ForEach(visibleInstances) { instance in
                                let label = AssigneeLabel(instance: instance, agents: agents, computers: computers, options: visibleInstances)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(label.name).font(.body)
                                    Text(label.context).font(.caption).foregroundStyle(.secondary)
                                    Text(label.workspace).font(.caption).foregroundStyle(.secondary)
                                        .lineLimit(2).truncationMode(.middle)
                                    if let identity = label.identityDetail { Text(identity).font(.caption).foregroundStyle(.secondary) }
                                }.accessibilityElement(children: .combine).tag(instance.id)
                                    .accessibilityIdentifier("discussion.agentOption.\(instance.id)")
                            }
                        }.pickerStyle(.navigationLink).accessibilityIdentifier("discussion.participant.\(index).instance")
                        if availability == .unavailable {
                            Label("Choose another agent. This selection is no longer available.", systemImage: "exclamationmark.circle")
                                .font(.footnote).foregroundStyle(ArtooTokens.ColorToken.warning)
                        }
                        TextField("Role, such as planner or reviewer", text: $participant.role)
                            .accessibilityIdentifier("discussion.participant.\(index).role")
                    }.padding(.vertical, 4)
                }
                if Set(draft.participants.map(\.agentInstanceId).filter { !$0.isEmpty }).count < draft.participants.filter({ !$0.agentInstanceId.isEmpty }).count {
                    Label("Choose a different agent for each role.", systemImage: "person.crop.circle.badge.exclamationmark")
                        .font(.footnote).foregroundStyle(ArtooTokens.ColorToken.warning)
                }
                if draft.participants.count < 6 { Button("Add participant", systemImage: "plus.circle") { draft.participants.append(DiscussionParticipantDraft()) }.frame(minHeight: 44) }
                if draft.participants.count > 2 { Button("Remove last participant") { draft.participants.removeLast() }.frame(minHeight: 44) }
                if loadingInventory { ProgressView("Loading agents…") }
                else if !inventoryLoaded { Text("Refresh the agent inventory before starting a new discussion.").font(.footnote).foregroundStyle(.secondary) }
                else if visibleInstances.count < 2 { Text("Configure at least two enabled agents in Team before starting a discussion.").font(.footnote).foregroundStyle(.secondary) }
                Button("Refresh agents and channels") { Task { await loadInventory() } }.disabled(loadingInventory).frame(minHeight: 44)
            }.disabled(starting || pendingStart != nil)
            Section("Discussion limits") {
                Stepper("Rounds: \(draft.rounds)", value: $draft.rounds, in: 1...3)
                    .accessibilityIdentifier("discussion.rounds").accessibilityValue("\(draft.rounds)")
                Stepper("Time limit: \(draft.maxMinutes) minutes", value: $draft.maxMinutes, in: 2...60)
                    .accessibilityIdentifier("discussion.minutes").accessibilityValue("\(draft.maxMinutes)")
                Picker("Discussion location", selection: $draft.roomId) {
                    Text("Goal room").tag("")
                    ForEach(channels) { channel in Text("#\(channel["name"].text)").tag(channel.id) }
                }
            }.disabled(starting || pendingStart != nil)
            Section {
                Button(pendingStart == nil ? "Start agent discussion" : "Retry starting discussion") { Task { await start() } }
                    .font(.body.weight(.semibold)).frame(minHeight: 44)
                    .disabled(starting || (pendingStart == nil && !canStart))
                    .accessibilityIdentifier("discussion.start")
                if pendingStart != nil { Text("The outcome is not confirmed. Retry preserves the original request. Check the discussions below before starting other work.").font(.caption) }
            }
            ForEach(model.state.value?["discussions"].records ?? []) { discussion in
                Section("Discussion · \(discussion.status)") {
                    LabeledContent("Progress", value: "\(discussion["current_step"].text) / \(discussion["total_steps"].text)")
                        .accessibilityIdentifier("discussion.progress.\(discussion.id)")
                        .accessibilityValue("\(discussion["current_step"].text) / \(discussion["total_steps"].text)")
                    ArtooMetadataGrid([("Deadline", ConversationMetadata.timestamp(discussion["deadline_at"].text))])
                    ForEach(Array(discussion["participants"].array.enumerated()), id: \.offset) { _, participant in
                        Text("\(participant["role"].text): \(ConversationMetadata.agentName(participant["agent_instance_id"].text, agents: agents, instances: instances))").font(.caption)
                    }
                    if !discussion["error"].text.isEmpty { Text(discussion["error"].text).foregroundStyle(.red) }
                    NavigationLink("Open agent discussion thread") {
                        RoomThreadView(client: model.client, roomId: discussion["room_id"].text, rootId: discussion["thread_root_id"].text)
                    }.accessibilityIdentifier("discussion.thread.\(discussion.id)")
                    if ["running", "stopping"].contains(discussion.status) {
                        Button(discussion.status == "stopping" ? "Stopping…" : "Stop discussion", role: .destructive) { Task {
                            await model.perform(path: "/api/v1/discussions/\(apiPart(discussion.id))/cancel")
                        } }.disabled(model.busy || discussion.status == "stopping")
                    }
                    if discussion.status == "ready" && discussion["plan_id"].text.isEmpty {
                        Button("Create plan proposal") { Task { await model.perform(path: "/api/v1/discussions/\(apiPart(discussion.id))/propose-plan") } }.disabled(model.busy)
                            .accessibilityIdentifier("discussion.propose.\(discussion.id)")
                    }
                    if !discussion["plan_id"].text.isEmpty {
                        NavigationLink("Review proposed plan") { GoalDetailView(client: model.client, goalId: goalId, projectId: projectId) }
                            .accessibilityIdentifier("discussion.review.\(discussion.id)")
                        Text("Accepting the plan is a separate human decision.").font(.caption)
                    }
                }
            }
            if model.state.isLoading || starting { ProgressView() }
            if let message = error ?? model.actionError ?? model.state.errorMessage { Text(message).foregroundStyle(.red) }
        }.listStyle(.insetGrouped).scrollDismissesKeyboard(.interactively)
            .navigationTitle("Agent planning").navigationBarTitleDisplayMode(.inline).refreshable { await model.load(); await loadInventory() }
            .liveRefresh { await model.load() }.task { await loadInventory() }
    }
    private var visibleInstances: [WorkspaceRecord] { instances.filter { $0.status != "disabled" } }
    private var canStart: Bool {
        draft.valid && draft.participants.allSatisfy {
            AgentSelectionAvailability.resolve(instanceId: $0.agentInstanceId, instances: instances, loaded: inventoryLoaded) == .available
        }
    }
    private func loadInventory() async {
        guard !loadingInventory else { return }
        loadingInventory = true; inventoryLoaded = false; defer { loadingInventory = false }
        do {
            async let bootstrap = model.client.resource(path: "/api/v1/bootstrap")
            async let projectChannels = model.client.resource(path: "/api/v1/channels?project_id=\(apiPart(projectId))")
            let inventory = try await bootstrap
            instances = inventory["agent_instances"].records; agents = inventory["agents"].records; computers = inventory["computers"].records
            channels = try await projectChannels["channels"].records
            inventoryLoaded = true
            error = nil
        } catch { self.error = String(describing: error) }
    }
    private func start() async {
        guard !starting, pendingStart != nil || canStart else { return }
        if pendingStart == nil { pendingStart = (UUID().uuidString, draft.body) }
        guard let request = pendingStart else { return }
        starting = true; error = nil; defer { starting = false }
        do {
            _ = try await model.client.command(path: "/api/v1/goals/\(apiPart(goalId))/discussions", method: "POST", body: request.body, idempotencyKey: request.key)
            pendingStart = nil; await model.load()
        } catch {
            if case let ApiError.http(status, _) = error, [400, 422].contains(status) { pendingStart = nil }
            self.error = String(describing: error)
        }
    }
}
