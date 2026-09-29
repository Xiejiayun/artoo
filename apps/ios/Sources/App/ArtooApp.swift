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
        let url = try ServerAddress.validate(stored.serverURL, allowLocalHTTP: true)
        let live = ApiClient(baseURL: url, authToken: stored.controlToken)
        let authenticated = try await live.currentSession()
        let initial = try await live.bootstrap()
        client = live; identity = authenticated; serverURL = stored.serverURL
        bootstrap = .loaded(initial); isAuthenticated = true; connectionError = nil
        if !initial.projects.contains(where: { $0.id == selectedProjectId }) { selectedProjectId = initial.projects.first?.id ?? "" }
    }
    public func loadBootstrap() async {
        if bootstrap.value == nil { bootstrap = .loading }
        do {
            let value = try await client.bootstrap(); bootstrap = .loaded(value)
            if !value.projects.contains(where: { $0.id == selectedProjectId }) { selectedProjectId = value.projects.first?.id ?? "" }
        } catch { bootstrap = .failed(String(describing: error)) }
    }
    public func validateConnection() async {
        guard isAuthenticated, let live = client as? ApiClient else { return }
        do { identity = try await live.currentSession(); connectionError = nil }
        catch { connectionError = String(describing: error) }
    }
    public func authenticationExpired(server: String?) {
        guard server == serverURL || serverURL.isEmpty else { return }
        isAuthenticated = false; identity = nil; bootstrap = .idle
        connectionError = "Your device connection expired or was revoked. Pair this device again."
        do { try credentials.clear() } catch { connectionError = String(describing: error) }
    }
    public func logout() async {
        guard !isConnecting else { return }; isConnecting = true
        defer { isConnecting = false }
        do {
            if let live = client as? ApiClient { try await live.logout() }
            try credentials.clear()
            isAuthenticated = false; identity = nil; bootstrap = .idle; connectionError = nil
            selectedProjectId = ""; serverURL = ""
        } catch { connectionError = "Sign out could not be confirmed. Reconnect and try again. \(error)" }
    }
}

@main
struct ArtooApp: App {
    @StateObject private var container = AppContainer()
    var body: some Scene { WindowGroup { RootView().environmentObject(container) } }
}

public struct RootView: View {
    @EnvironmentObject private var container: AppContainer
    public init() {}
    public var body: some View {
        Group {
            if container.isAuthenticated {
                TabView {
                    InboxView(client: container.client).tabItem { Label("Inbox", systemImage: "tray.full") }
                    TasksView(client: container.client, projectId: container.projectId)
                        .id(container.projectId).tabItem { Label("Tasks", systemImage: "checklist") }
                    WorkspaceListView(kind: .goals, client: container.client, projectId: container.projectId)
                        .id(container.projectId).tabItem { Label("Goals", systemImage: "target") }
                    TeamView(client: container.client).tabItem { Label("Team", systemImage: "desktopcomputer") }
                    WorkspaceSettingsView().tabItem { Label("More", systemImage: "ellipsis.circle") }
                }.liveRefresh(interval: 30) { await container.validateConnection() }
            } else { PairDeviceView() }
        }
        .task { await container.restore() }
        .onReceive(NotificationCenter.default.publisher(for: .artooAuthenticationExpired).receive(on: RunLoop.main)) { notification in
            container.authenticationExpired(server: notification.object as? String)
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
                    TextField("Device name", text: $deviceName)
                    TextField("One-time pairing code", text: $code).textInputAutocapitalization(.characters)
                        .autocorrectionDisabled().accessibilityIdentifier("pairingCode")
                    Button("Connect") { Task { await container.pair(server: server, code: code, displayName: deviceName, allowLocalHTTP: localHTTP); code = "" } }
                        .disabled(container.isConnecting || server.isEmpty || code.isEmpty)
                    if container.isConnecting { ProgressView("Connecting…") }
                }
                if let error = container.connectionError {
                    Section { Text(error).foregroundStyle(.red); Button("Retry saved connection") { Task { await container.retryConnection() } } }
                }
                Section("Local development") {
                    Toggle("Allow localhost or .local HTTP", isOn: $localHTTP)
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
                    NavigationLink("Run history") { RunsOverviewView(client: container.client, projectId: container.projectId) }
                    NavigationLink("Memory") { WorkspaceListView(kind: .memories, client: container.client, projectId: container.projectId, embedded: true) }
                    NavigationLink("Skills") { WorkspaceListView(kind: .skills, client: container.client, projectId: container.projectId, embedded: true) }
                    NavigationLink("Devices") { DevicesView(client: container.client) }
                }
                if let error = container.connectionError { Section { Text(error).foregroundStyle(.red) } }
                Section { Button("Sign out", role: .destructive) { Task { await container.logout() } }.disabled(container.isConnecting) }
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

private struct LiveRefresh: ViewModifier {
    @Environment(\.scenePhase) private var scenePhase
    let interval: Double
    let action: @MainActor () async -> Void
    func body(content: Content) -> some View {
        content.task(id: scenePhase) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                await action()
                do { try await Task.sleep(for: .seconds(interval)) } catch { return }
            }
        }
    }
}
extension View {
    func liveRefresh(interval: Double = 8, _ action: @escaping @MainActor () async -> Void) -> some View {
        modifier(LiveRefresh(interval: interval, action: action))
    }
}
