import SwiftUI

struct TeamView: View {
    @EnvironmentObject private var container: AppContainer
    @StateObject private var model: WorkspaceViewModel
    @StateObject private var daemons: DaemonStatusViewModel
    init(client: ApiClientProtocol) {
        _model = StateObject(wrappedValue: WorkspaceViewModel(client: client, path: "/api/v1/bootstrap"))
        _daemons = StateObject(wrappedValue: DaemonStatusViewModel(client: client))
    }
    var body: some View {
        NavigationStack {
            StateView(state: model.state, retry: { Task { await refresh() } }) { data in
                List {
                    Section("Execution computers") {
                        if data["computers"].records.isEmpty { Text("Pair an execution computer from Devices, then start its daemon.") }
                        ForEach(data["computers"].records) { computer in
                            NavigationLink { ComputerDetailView(computer: computer, client: model.client) } label: {
                                VStack(alignment: .leading) {
                                    RecordRow(item: computer, showStatus: false)
                                    DaemonStatusRow(model: daemons, computerId: computer.id)
                                }
                            }.accessibilityIdentifier("computer.\(computer.id)")
                        }
                    }
                    Section("Agent instances") {
                        ForEach(data["agent_instances"].records) { instance in
                            VStack(alignment: .leading, spacing: 6) {
                                RecordRow(item: instance)
                                Text(instance["workspace_root"].text).font(.caption).textSelection(.enabled)
                                if container.isAdministrator {
                                    Button(instance.status == "disabled" ? "Enable" : "Disable") { Task {
                                        await model.perform(path: "/api/v1/agent-instances/\(apiPart(instance.id))", method: "PATCH", body: .object(["enabled": .bool(instance.status == "disabled")]))
                                    } }.disabled(model.busy)
                                }
                            }
                        }
                    }
                    if let message = daemons.error ?? model.actionError { Text(message).foregroundStyle(.red) }
                }
            }.navigationTitle("Team").refreshable { await refresh() }.liveRefresh { await model.load() }
                .liveRefresh(interval: 5) { await daemons.load() }
        }
    }
    private func refresh() async {
        await model.load()
        await daemons.load()
    }
}

private struct ComputerDetailView: View {
    @EnvironmentObject private var container: AppContainer
    let computer: WorkspaceRecord
    @StateObject private var model: WorkspaceViewModel
    @StateObject private var daemons: DaemonStatusViewModel
    @State private var runtime = ""
    @State private var name = ""
    @State private var workspace = ""
    @State private var success = false
    init(computer: WorkspaceRecord, client: ApiClientProtocol) {
        self.computer = computer
        _model = StateObject(wrappedValue: WorkspaceViewModel(client: client, path: "/api/v1/computers/\(apiPart(computer.id))/runtimes"))
        _daemons = StateObject(wrappedValue: DaemonStatusViewModel(client: client))
    }
    var body: some View {
        Form {
            Section("Computer") { RecordRow(item: computer, showStatus: false); Text("\(computer["os"].text) · \(computer["arch"].text)") }
            Section("Execution daemon") {
                DaemonStatusRow(model: daemons, computerId: computer.id)
                Text("Status is confirmed by the server every five seconds while this screen is visible.").font(.caption)
                if let error = daemons.error { Text(error).foregroundStyle(.red) }
            }
            Section("Advertised runtimes") {
                ForEach(model.state.value?["runtimes"].records ?? []) { runtime in RecordRow(item: runtime) }
                if model.state.isLoading { ProgressView() }
            }
            if container.isAdministrator {
                Section("Configure an agent") {
                    Picker("Runtime", selection: $runtime) {
                        Text("Choose runtime").tag("")
                        ForEach((model.state.value?["runtimes"].records ?? []).filter { $0.status == "available" }) { item in Text(item["runtime"].text).tag(item["runtime"].text) }
                    }
                    TextField("Agent name", text: $name)
                    TextField("Absolute workspace path on this computer", text: $workspace).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button("Create agent instance") { Task {
                        success = await model.perform(path: "/api/v1/computers/\(apiPart(computer.id))/instances", body: .object(["runtime": .string(runtime), "display_name": .string(name), "workspace_root": .string(workspace)]))
                    } }.disabled(model.busy || runtime.isEmpty || name.isEmpty || workspace.isEmpty)
                    if success { Label("Agent configured", systemImage: "checkmark.circle") }
                }
            }
            if let error = model.actionError ?? model.state.errorMessage { Text(error).foregroundStyle(.red) }
        }.navigationTitle(computer.title).liveRefresh { await model.load() }.liveRefresh(interval: 5) { await daemons.load() }
    }
}

private struct DaemonStatusRow: View {
    @ObservedObject var model: DaemonStatusViewModel
    let computerId: String
    var body: some View {
        TimelineView(.periodic(from: Date(), by: 1)) { context in
            let status = model.status(computerId: computerId, now: context.date)
            let value = model.daemons.first { $0.computerId == computerId }
            VStack(alignment: .leading, spacing: 4) {
                Label("Daemon: \(status.capitalized)", systemImage: status == "online" ? "checkmark.circle" : status == "unknown" ? "questionmark.circle" : "exclamationmark.circle")
                    .foregroundStyle(status == "online" ? Color.green : status == "unknown" ? Color.secondary : Color.orange)
                    .accessibilityIdentifier("daemonStatus.\(computerId)").accessibilityValue(status)
                if let value {
                    Text("\(status == "unknown" ? "Last known: " : "")\(value.activeRuns) active runs").font(.caption)
                    if let heartbeat = value.lastHeartbeatAt { Text("Last heartbeat: \(heartbeat)").font(.caption) }
                    ForEach(Array(value.runtimes.enumerated()), id: \.offset) { _, runtime in
                        Text("\(runtime["runtime"].text): \(runtime["status"].text)").font(.caption)
                    }
                }
                if status == "unknown" { Text("Unable to confirm the daemon. This does not mean the computer is offline.").font(.caption) }
            }
        }
    }
}

struct DevicesView: View {
    @EnvironmentObject private var container: AppContainer
    @StateObject private var model: WorkspaceViewModel
    @State private var revoking: WorkspaceRecord?
    @State private var enrolling: WorkspaceRecord?
    @State private var platform = "ios"
    @State private var pairing: JSONValue = .null
    @State private var error: String?
    @State private var creating = false
    init(client: ApiClientProtocol) { _model = StateObject(wrappedValue: WorkspaceViewModel(client: client, path: "/api/v1/devices")) }
    var body: some View {
        List {
            Section("Connect another device") {
                Text("Use this code only on your own device. It grants access as your account.").font(.caption)
                Picker("Platform", selection: $platform) { Text("iOS").tag("ios"); Text("Windows").tag("windows"); Text("macOS").tag("macos") }
                Button("Create one-time code") { Task { await createPairing() } }.disabled(creating)
                if !pairing["code"].text.isEmpty {
                    Text(pairing["code"].text).font(.system(.title, design: .monospaced)).textSelection(.enabled).privacySensitive()
                        .accessibilityIdentifier("device.pairing.code")
                    Text("Expires \(pairing["pairing"]["expires_at"].text)").font(.caption)
                }
            }
            Section("Devices") {
                ForEach(model.state.value?["devices"].records ?? []) { device in
                    VStack(alignment: .leading) {
                        RecordRow(item: device)
                        Text(device["platform"].text).font(.caption)
                        if !device["computer_id"].text.isEmpty {
                            Text("Computer: \(device["computer_id"].text)").font(.caption).textSelection(.enabled)
                        } else if device.status == "active" && ["macos", "windows"].contains(device["platform"].text) {
                            if container.isAdministrator {
                                Button("Enroll computer") { error = nil; enrolling = device }
                                    .disabled(model.busy)
                                    .accessibilityIdentifier("device.enroll.\(device.id)")
                            } else {
                                Text("An owner or admin must enroll this computer before its local worker can start.").font(.caption)
                                    .accessibilityIdentifier("device.enrollment.pending.\(device.id)")
                            }
                        }
                        if device.status == "active" && (container.isAdministrator || device["enrolled_by_user_id"].text == container.identity?.user.id) {
                            Button("Revoke device", role: .destructive) { revoking = device }.disabled(model.busy)
                                .accessibilityIdentifier("device.revoke.\(device.id)")
                        }
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("device.row.\(device.id)")
                }
            }
            if model.state.isLoading { ProgressView() }
            if let message = error ?? model.actionError ?? model.state.errorMessage { Text(message).foregroundStyle(.red) }
        }.navigationTitle("Devices").refreshable { await model.load() }.liveRefresh { await model.load() }
            .confirmationDialog("Enroll this execution computer?", isPresented: Binding(get: { enrolling != nil }, set: { if !$0 { enrolling = nil } }), titleVisibility: .visible, presenting: enrolling) { device in
                Button("Enroll computer") { Task {
                    if await model.perform(path: "/api/v1/devices/\(apiPart(device.id))/enroll") { await container.loadBootstrap() }
                } }
                Button("Cancel", role: .cancel) { enrolling = nil }
            } message: { device in
                Text("Enroll \(device.title) so its owner can start a worker and allow team tasks in their selected folders.")
            }
            .confirmationDialog("Revoke this device and disconnect its sessions?", isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } })) {
                Button("Revoke", role: .destructive) { if let device = revoking { Task { await model.perform(path: "/api/v1/devices/\(apiPart(device.id))/revoke"); revoking = nil } } }
            }
    }
    private func createPairing() async {
        creating = true; error = nil; defer { creating = false }
        do { pairing = try await model.client.command(path: "/api/v1/devices/pairings", method: "POST", body: .object(["intended_platform": .string(platform)])) }
        catch { self.error = String(describing: error) }
    }
}

struct ProjectsView: View {
    @EnvironmentObject private var container: AppContainer
    @State private var name = ""
    @State private var workspace = ""
    @State private var error: String?
    @State private var busy = false
    var body: some View {
        Form {
            Section("Projects") { ForEach(container.bootstrap.value?.projects ?? []) { project in
                VStack(alignment: .leading) { Text(project.name); Text(project.defaultWorkspace ?? "No default workspace").font(.caption) }
            } }
            Section("Create project") {
                TextField("Name", text: $name)
                TextField("Absolute workspace path", text: $workspace).textInputAutocapitalization(.never).autocorrectionDisabled()
                Button("Create") { Task { await create() } }.disabled(busy || name.isEmpty || workspace.isEmpty)
            }
            if let error { Text(error).foregroundStyle(.red) }
        }.navigationTitle("Projects")
    }
    private func create() async {
        busy = true; error = nil; defer { busy = false }
        do { _ = try await container.client.command(path: "/api/v1/projects", method: "POST", body: .object(["name": .string(name), "default_workspace": .string(workspace)])); await container.loadBootstrap(); name = ""; workspace = "" }
        catch { self.error = String(describing: error) }
    }
}
