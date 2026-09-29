import SwiftUI

public struct AppConfig {
    public var useMock: Bool
    public var baseURLString: String
    public var projectId: String
    public init(useMock: Bool = false, baseURLString: String = "", projectId: String = "proj_artoo") {
        self.useMock = useMock; self.baseURLString = baseURLString; self.projectId = projectId
    }
    public static let `default` = AppConfig()
}

@MainActor
public final class AppContainer: ObservableObject {
    @Published public private(set) var client: ApiClientProtocol
    public let config: AppConfig
    @Published public private(set) var bootstrap: ViewState<Bootstrap> = .idle
    @Published public private(set) var identity: SessionIdentity?
    @Published public private(set) var isAuthenticated = false
    @Published public private(set) var isConnecting = false
    @Published public var connectionError: String?
    @Published public var selectedProjectId: String = ""
    @Published public private(set) var serverURL = ""
    @Published public private(set) var sessionGeneration = UUID()
    @Published public private(set) var unreadNotificationCount: Int?
    @Published public private(set) var notificationCountError: String?
    public let realtime = RealtimeConnection()
    private let credentials: CredentialStore
    private var restored = false

    public init(config: AppConfig = .default, credentials: CredentialStore = KeychainCredentialStore()) {
        self.config = config; self.credentials = credentials
        self.client = ApiClient(baseURL: URL(string: "https://unconfigured.invalid")!)
        #if DEBUG
        if config.useMock { self.client = MockApiClient.demo(); isAuthenticated = true; restored = true }
        #endif
    }
    public init(client: ApiClientProtocol, config: AppConfig = .default) {
        self.client = client; self.config = config; self.credentials = KeychainCredentialStore()
        isAuthenticated = true; restored = true
    }
    public var projectId: String { selectedProjectId.isEmpty ? (bootstrap.value?.projects.first?.id ?? config.projectId) : selectedProjectId }
    public var isAdministrator: Bool { identity?.isAdministrator ?? false }
    public var notificationBadge: String? {
        guard notificationCountError == nil, let count = unreadNotificationCount else { return "?" }
        return count > 0 ? String(count) : nil
    }
    public var mentionsTitle: String {
        guard let count = unreadNotificationCount else { return "Mentions (?)" }
        return notificationCountError == nil ? "Mentions (\(count))" : "Mentions (last known \(count))"
    }
    public var notificationCountSummary: String {
        if let count = unreadNotificationCount {
            return notificationCountError == nil ? "\(count) unread across all projects" : "Last known: \(count) unread. The latest count could not be retrieved."
        }
        return notificationCountError == nil ? "Checking unread mentions…" : "Unread count unavailable. Open Mentions to retry."
    }

    public func restore() async {
        guard !restored else { return }; restored = true; isConnecting = true
        defer { isConnecting = false }
        do { if let stored = try credentials.load() { try await connect(stored) } }
        catch { connectionError = "Unable to restore your connection. \(error)" }
    }
    public func pair(server: String, code: String, displayName: String, allowLocalHTTP: Bool) async {
        guard !isConnecting else { return }; isConnecting = true; connectionError = nil
        defer { isConnecting = false }
        do {
            let url = try ServerAddress.validate(server, allowLocalHTTP: allowLocalHTTP)
            let name = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty, !code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw ApiError.invalidURL("Enter the device name and the one-time pairing code")
            }
            let claim = try await ApiClient(baseURL: url).claimPairing(code: code, displayName: name)
            let stored = StoredConnection(serverURL: url.absoluteString, controlToken: claim.controlToken, deviceId: claim.device.id)
            // Persist the one-time credential before further network requests.
            try credentials.save(stored)
            try await connect(stored)
        } catch { connectionError = String(describing: error) }
    }
    public func retryConnection() async { restored = false; await restore() }
    private func connect(_ stored: StoredConnection) async throws {
        realtime.stop(); (client as? ApiClient)?.invalidate()
        sessionGeneration = UUID(); isAuthenticated = false
        unreadNotificationCount = nil; notificationCountError = nil
        let generation = sessionGeneration
        let url = try ServerAddress.validate(stored.serverURL, allowLocalHTTP: true)
        let live = ApiClient(baseURL: url, authToken: stored.controlToken)
        let authenticated = try await live.currentSession()
        let initial = try await live.bootstrap()
        guard generation == sessionGeneration else { live.invalidate(); throw CancellationError() }
        client = live; identity = authenticated; serverURL = stored.serverURL
        bootstrap = .loaded(initial); isAuthenticated = true; connectionError = nil
        if !initial.projects.contains(where: { $0.id == selectedProjectId }) { selectedProjectId = initial.projects.first?.id ?? "" }
        try realtime.configure(origin: url, controlToken: stored.controlToken, sessionID: live.sessionID,
            topics: initial.projects.map { "project:\($0.id)" } + ["inbox:\(authenticated.user.id)"])
    }
    public func loadBootstrap() async {
        let generation = sessionGeneration
        if bootstrap.value == nil { bootstrap = .loading }
        do {
            let value = try await client.bootstrap()
            guard generation == sessionGeneration else { return }
            bootstrap = .loaded(value)
            if !value.projects.contains(where: { $0.id == selectedProjectId }) { selectedProjectId = value.projects.first?.id ?? "" }
            if let user = identity?.user.id { realtime.updateTopics(value.projects.map { "project:\($0.id)" } + ["inbox:\(user)"]) }
        } catch { if generation == sessionGeneration { bootstrap = .failed(String(describing: error)) } }
    }
    public func validateConnection() async {
        guard isAuthenticated, let live = client as? ApiClient else { return }
        let generation = sessionGeneration
        do {
            let current = try await live.currentSession()
            guard generation == sessionGeneration else { return }
            guard current.user.id == identity?.user.id else { authenticationExpired(session: live.sessionID); return }
            identity = current; connectionError = nil
        } catch { if generation == sessionGeneration { connectionError = String(describing: error) } }
    }
    public func refreshNotificationCount() async {
        guard isAuthenticated, let live = client as? ApiClient else { return }
        do {
            let value = try await live.resource(path: "/api/v1/notifications?limit=1")
            let page = try ArtooJSON.decoder().decode(NativeNotificationPage.self, from: JSONEncoder().encode(value))
            acceptNotificationCount(page.unreadCount, session: live.sessionID)
        } catch {
            if live.sessionID == (client as? ApiClient)?.sessionID { notificationCountError = String(describing: error) }
        }
    }
    public func acceptNotificationCount(_ count: Int, session: String?) {
        guard isAuthenticated, let session, session == (client as? ApiClient)?.sessionID else { return }
        unreadNotificationCount = count; notificationCountError = nil
    }
    public func authenticationExpired(session: String?) {
        guard session == (client as? ApiClient)?.sessionID else { return }
        realtime.stop(); (client as? ApiClient)?.invalidate(); sessionGeneration = UUID()
        isAuthenticated = false; identity = nil; bootstrap = .idle
        unreadNotificationCount = nil; notificationCountError = nil
        connectionError = "Your device connection expired or was revoked. Pair this device again."
        do { try credentials.clear() } catch { connectionError = String(describing: error) }
    }
    public func logout() async {
        guard !isConnecting else { return }; isConnecting = true
        defer { isConnecting = false }
        let live = client as? ApiClient
        realtime.stop(); sessionGeneration = UUID()
        isAuthenticated = false; identity = nil; bootstrap = .idle; connectionError = nil
        unreadNotificationCount = nil; notificationCountError = nil
        selectedProjectId = ""; serverURL = ""
        do { try credentials.clear() } catch { connectionError = String(describing: error) }
        do { try await live?.revokeAndInvalidate() }
        catch { connectionError = "Signed out on this phone. Server revocation could not be confirmed; revoke this device from Web if needed. \(error)" }
    }
}

@main
struct ArtooApp: App {
    @StateObject private var container = AppContainer()
    var body: some Scene { WindowGroup { RootView().environmentObject(container) } }
}

private enum RootTab: Hashable { case inbox, tasks, channels, team, more }

public struct RootView: View {
    @EnvironmentObject private var container: AppContainer
    @Environment(\.scenePhase) private var scenePhase
    @State private var selectedTab = RootTab.inbox
    public init() {}
    public var body: some View {
        Group {
            if container.isAuthenticated {
                TabView(selection: $selectedTab) {
                    InboxView(client: container.client).tabItem { Label("Inbox", systemImage: "tray.full") }.badge(container.notificationBadge).tag(RootTab.inbox)
                    TasksView(client: container.client, projectId: container.projectId)
                        .id("tasks.\(container.projectId)").tabItem { Label("Tasks", systemImage: "checklist") }.tag(RootTab.tasks)
                    ChannelsView(client: container.client, projectId: container.projectId)
                        .id("channels.\(container.projectId)").tabItem { Label("Channels", systemImage: "number") }.tag(RootTab.channels)
                    TeamView(client: container.client).tabItem { Label("Team", systemImage: "desktopcomputer") }.tag(RootTab.team)
                    WorkspaceSettingsView().tabItem { Label("More", systemImage: "ellipsis.circle") }.tag(RootTab.more)
                }.id(container.sessionGeneration).liveRefresh(interval: 30, realtime: false) { await container.validateConnection() }
                    .liveRefresh { await container.refreshNotificationCount() }
            } else { PairDeviceView() }
        }
        .task { await container.restore() }
        .onChange(of: container.sessionGeneration) { _, _ in selectedTab = .inbox }
        .onChange(of: scenePhase) { _, phase in container.realtime.setActive(phase == .active) }
        .onReceive(NotificationCenter.default.publisher(for: .artooAuthenticationExpired).receive(on: RunLoop.main)) { notification in
            container.authenticationExpired(session: notification.object as? String)
        }
    }
}

private struct PairDeviceView: View {
    @EnvironmentObject private var container: AppContainer
    @State private var server = ""
    @State private var code = ""
    @State private var deviceName = "My iPhone"
    @State private var localHTTP = false
    var body: some View {
        NavigationStack {
            Form {
                Section("Connect to your team") {
                    Text("Sign in to your team's Web app. Ask an owner or admin to create an iOS pairing code in Settings, then enter it here.")
                    TextField("https://artoo.example.com", text: $server).keyboardType(.URL)
                        .textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("serverURL")
                    TextField("Device name", text: $deviceName).accessibilityIdentifier("pairingDeviceName")
                    TextField("One-time pairing code", text: $code).textInputAutocapitalization(.characters)
                        .autocorrectionDisabled().accessibilityIdentifier("pairingCode")
                    Button("Connect") { Task { await container.pair(server: server, code: code, displayName: deviceName, allowLocalHTTP: localHTTP); code = "" } }
                        .disabled(container.isConnecting || server.isEmpty || code.isEmpty)
                        .accessibilityIdentifier("pairDevice")
                    if container.isConnecting { ProgressView("Connecting…") }
                }
                if let error = container.connectionError {
                    Section { Text(error).foregroundStyle(.red); Button("Retry saved connection") { Task { await container.retryConnection() } } }
                }
                Section("Local development") {
                    Toggle("Allow localhost or .local HTTP", isOn: $localHTTP).accessibilityIdentifier("allowLocalHTTP")
                    Text("Use HTTPS for a shared team server. On a phone, localhost refers to the phone itself.").font(.caption)
                }
            }.navigationTitle("Welcome to Artoo")
        }
    }
}

private struct WorkspaceSettingsView: View {
    @EnvironmentObject private var container: AppContainer
    var body: some View {
        NavigationStack {
            List {
                Section("Workspace") {
                    Text(container.identity?.user.name ?? "Connected")
                    Text(container.serverURL).font(.caption).textSelection(.enabled)
                    if let projects = container.bootstrap.value?.projects {
                        Picker("Project", selection: $container.selectedProjectId) {
                            ForEach(projects) { project in Text(project.name).tag(project.id) }
                        }
                    }
                    Button("Refresh workspace") { Task { await container.loadBootstrap() } }
                    if container.isAdministrator { NavigationLink("Manage projects") { ProjectsView() } }
                }
                Section("Work") {
                    NavigationLink("Goals") { WorkspaceListView(kind: .goals, client: container.client, projectId: container.projectId, embedded: true) }
                    NavigationLink { MentionsView(client: container.client) } label: {
                        VStack(alignment: .leading) {
                            Text(container.mentionsTitle)
                            Text(container.notificationCountSummary).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    NavigationLink("Run history") { RunsOverviewView(client: container.client, projectId: container.projectId) }
                    NavigationLink("Memory") { WorkspaceListView(kind: .memories, client: container.client, projectId: container.projectId, embedded: true) }
                    NavigationLink("Skills") { WorkspaceListView(kind: .skills, client: container.client, projectId: container.projectId, embedded: true) }
                    NavigationLink("Devices") { DevicesView(client: container.client) }
                }
                if let error = container.connectionError { Section { Text(error).foregroundStyle(.red) } }
                Section { Button("Sign out", role: .destructive) { Task { await container.logout() } }.disabled(container.isConnecting).accessibilityIdentifier("signOut") }
            }.navigationTitle("More")
        }
    }
}

private struct RunsOverviewView: View {
    @StateObject private var model: RunsOverviewViewModel
    let client: ApiClientProtocol
    init(client: ApiClientProtocol, projectId: String) { self.client = client; _model = StateObject(wrappedValue: RunsOverviewViewModel(client: client, projectId: projectId)) }
    var body: some View {
        StateView(state: model.state, retry: { Task { await model.load() } }) { items in
            List(items) { item in NavigationLink { RunSummaryView(run: item.run, client: client) } label: {
                VStack(alignment: .leading) { Text(item.task.title); RunStatusBadge(item.run.status); Text(item.run.id).font(.caption) }
            } }
        }.navigationTitle("Runs").refreshable { await model.load() }.liveRefresh { await model.load() }
    }
}

@MainActor
private final class RefreshCoordinator: ObservableObject {
    private var running = false
    private var pending = false
    func perform(_ action: @MainActor () async -> Void) async {
        if running { pending = true; return }
        running = true
        repeat { pending = false; await action() } while pending && !Task.isCancelled
        running = false
    }
}

private struct LiveRefresh: ViewModifier {
    @Environment(\.scenePhase) private var scenePhase
    @EnvironmentObject private var container: AppContainer
    @StateObject private var coordinator = RefreshCoordinator()
    @State private var visible = false
    let interval: Double
    let realtime: Bool
    let action: @MainActor () async -> Void
    func body(content: Content) -> some View {
        content.task(id: scenePhase) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                await coordinator.perform(action)
                let delay = container.realtime.connected ? interval : min(interval, 15)
                do { try await Task.sleep(for: .seconds(delay)) } catch { return }
            }
        }
        .onAppear { visible = true }
        .onDisappear { visible = false }
        .onReceive(NotificationCenter.default.publisher(for: .artooRealtimeChanged).receive(on: RunLoop.main)) { notification in
            guard realtime, visible, scenePhase == .active, notification.object as? String == (container.client as? ApiClient)?.sessionID else { return }
            Task { await coordinator.perform(action) }
        }
    }
}
extension View {
    func liveRefresh(interval: Double = 60, realtime: Bool = true, _ action: @escaping @MainActor () async -> Void) -> some View {
        modifier(LiveRefresh(interval: interval, realtime: realtime, action: action))
    }
}
