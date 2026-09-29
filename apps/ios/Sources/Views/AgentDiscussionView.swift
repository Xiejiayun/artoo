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
            Section("Discuss and break down this goal") {
                Text("Choose 2–6 distinct agent instances and their roles. Their discussion produces a proposed plan for your review before tasks are created.").font(.caption)
                ForEach($draft.participants) { $participant in
                    VStack(alignment: .leading) {
                        Picker("Agent instance", selection: $participant.agentInstanceId) {
                            Text("Choose an agent").tag("")
                            ForEach(instances.filter { $0.status != "disabled" }) { instance in
                                Text("\(instance["runtime"].text) · \(instance.title)").tag(instance.id)
                            }
                        }
                        TextField("Role, such as planner or reviewer", text: $participant.role)
                    }
                }
                if draft.participants.count < 6 { Button("Add participant") { draft.participants.append(DiscussionParticipantDraft()) } }
                if draft.participants.count > 2 { Button("Remove last participant") { draft.participants.removeLast() } }
                Stepper("Rounds: \(draft.rounds)", value: $draft.rounds, in: 1...3)
                Stepper("Time limit: \(draft.maxMinutes) minutes", value: $draft.maxMinutes, in: 2...60)
                Picker("Discussion location", selection: $draft.roomId) {
                    Text("Goal room").tag("")
                    ForEach(channels) { channel in Text("#\(channel["name"].text)").tag(channel.id) }
                }
                Button("Refresh agents and channels") { Task { await loadInventory() } }
            }.disabled(starting || pendingStart != nil)
            Section {
                Button(pendingStart == nil ? "Start agent discussion" : "Retry starting discussion") { Task { await start() } }
                    .disabled(starting || (pendingStart == nil && !draft.valid))
                if pendingStart != nil { Text("The outcome is not confirmed. Retry preserves the original request. Check the discussions below before starting other work.").font(.caption) }
            }
            ForEach(model.state.value?["discussions"].records ?? []) { discussion in
                Section("Discussion · \(discussion.status)") {
                    LabeledContent("Progress", value: "\(discussion["current_step"].text) / \(discussion["total_steps"].text)")
                    LabeledContent("Deadline", value: discussion["deadline_at"].text)
                    ForEach(Array(discussion["participants"].array.enumerated()), id: \.offset) { _, participant in
                        Text("\(participant["role"].text): \(participant["agent_instance_id"].text)").font(.caption)
                    }
                    if !discussion["error"].text.isEmpty { Text(discussion["error"].text).foregroundStyle(.red) }
                    NavigationLink("Open agent discussion thread") {
                        RoomThreadView(client: model.client, roomId: discussion["room_id"].text, rootId: discussion["thread_root_id"].text)
                    }
                    if ["running", "stopping"].contains(discussion.status) {
                        Button(discussion.status == "stopping" ? "Stopping…" : "Stop discussion", role: .destructive) { Task {
                            await model.perform(path: "/api/v1/discussions/\(apiPart(discussion.id))/cancel")
                        } }.disabled(model.busy || discussion.status == "stopping")
                    }
                    if discussion.status == "ready" && discussion["plan_id"].text.isEmpty {
                        Button("Create plan proposal") { Task { await model.perform(path: "/api/v1/discussions/\(apiPart(discussion.id))/propose-plan") } }.disabled(model.busy)
                    }
                    if !discussion["plan_id"].text.isEmpty {
                        NavigationLink("Review proposed plan") { GoalDetailView(client: model.client, goalId: goalId, projectId: projectId) }
                        Text("Accepting the plan is a separate human decision.").font(.caption)
                    }
                }
            }
            if model.state.isLoading || starting { ProgressView() }
            if let message = error ?? model.actionError ?? model.state.errorMessage { Text(message).foregroundStyle(.red) }
        }.navigationTitle("Agent planning").refreshable { await model.load(); await loadInventory() }
            .liveRefresh { await model.load() }.task { await loadInventory() }
    }
    private func loadInventory() async {
        do {
            async let bootstrap = model.client.resource(path: "/api/v1/bootstrap")
            async let projectChannels = model.client.resource(path: "/api/v1/channels?project_id=\(apiPart(projectId))")
            instances = try await bootstrap["agent_instances"].records
            channels = try await projectChannels["channels"].records
            error = nil
        } catch { self.error = String(describing: error) }
    }
    private func start() async {
        guard !starting, pendingStart != nil || draft.valid else { return }
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
