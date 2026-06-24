import SwiftUI

// MARK: - App configuration

/// Where the app gets its data. Defaults to the in-memory mock so the app is
/// immediately runnable in the iOS Simulator without a server. Flip `useMock`
/// to false (and set `baseURLString`) to talk to a live artoo server.
///
/// NOTE (unverified): this client has never been compiled or run — it is
/// authored on Windows without an iOS SDK. See apps/ios/README.md.
public struct AppConfig {
    public var useMock: Bool
    public var baseURLString: String
    public var projectId: String

    public init(useMock: Bool = true, baseURLString: String = "http://localhost:4000", projectId: String = "proj_artoo") {
        self.useMock = useMock
        self.baseURLString = baseURLString
        self.projectId = projectId
    }

    public static let `default` = AppConfig()
}

// MARK: - Dependency container

@MainActor
public final class AppContainer: ObservableObject {
    public let client: ApiClientProtocol
    public let config: AppConfig
    @Published public private(set) var bootstrap: ViewState<Bootstrap> = .idle

    public init(config: AppConfig = .default) {
        self.config = config
        if config.useMock {
            self.client = MockApiClient.demo()
        } else if let live = ApiClient(baseURLString: config.baseURLString) {
            self.client = live
        } else {
            self.client = MockApiClient.demo()
        }
    }

    /// Test/preview seam: inject any client directly.
    public init(client: ApiClientProtocol, config: AppConfig = .default) {
        self.client = client
        self.config = config
    }

    public func loadBootstrap() async {
        if bootstrap.value == nil { bootstrap = .loading }
        do {
            bootstrap = .loaded(try await client.bootstrap())
        } catch {
            let message = (error as? ApiError)?.description ?? error.localizedDescription
            bootstrap = .failed(message)
        }
    }

    public var projectId: String {
        bootstrap.value?.projects.first?.id ?? config.projectId
    }
}

// MARK: - App entry

@main
struct ArtooApp: App {
    @StateObject private var container = AppContainer()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(container)
        }
    }
}

// MARK: - Root tab surface

private enum RootTab: String, Hashable {
    case today
    case tasks
    case runsApprovals
    case settingsDevices
}

public struct RootView: View {
    @EnvironmentObject private var container: AppContainer
    @SceneStorage("RootView.selectedTab") private var selectedTab = RootTab.today

    public init() {}

    public var body: some View {
        TabView(selection: $selectedTab) {
            InboxView(client: container.client)
                .tabItem { Label("Today", systemImage: "tray.full") }
                .tag(RootTab.today)

            TasksView(client: container.client, projectId: container.projectId)
                .tabItem { Label("Tasks", systemImage: "checklist") }
                .tag(RootTab.tasks)

            RunsApprovalsOverviewView()
                .tabItem { Label("Runs", systemImage: "play.rectangle.stack") }
                .tag(RootTab.runsApprovals)

            SettingsDevicesOverviewView(container: container)
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .tag(RootTab.settingsDevices)
        }
        .task { await container.loadBootstrap() }
    }
}

private struct RunsApprovalsOverviewView: View {
    var body: some View {
        NavigationStack {
            List {
                Section {
                    ArtooSectionCard {
                        VStack(alignment: .leading, spacing: ArtooTokens.Spacing.sm) {
                            Label("Run and approval overview", systemImage: "play.rectangle.stack")
                                .font(.headline)
                                .foregroundStyle(ArtooTokens.ColorToken.text)
                            Text("Foundation shell placeholder for run summaries and approval history. Pending approvals remain in Today until the work surface slice starts.")
                                .font(.subheadline)
                                .foregroundStyle(ArtooTokens.ColorToken.textMuted)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .listRowInsets(EdgeInsets(
                        top: ArtooTokens.Spacing.sm,
                        leading: ArtooTokens.Spacing.md,
                        bottom: ArtooTokens.Spacing.sm,
                        trailing: ArtooTokens.Spacing.md
                    ))
                    .listRowBackground(Color.clear)
                }

                Section("Included in this foundation") {
                    Label("Native NavigationStack drill-down model", systemImage: "point.3.connected.trianglepath.dotted")
                    Label("Shared run status vocabulary", systemImage: "tag")
                    Label("Semantic loading, empty, error, and offline components", systemImage: "rectangle.3.group")
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Runs")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                    .disabled(true)
                    .accessibilityHint("Run refresh becomes available when the Runs work surface is implemented")
                }
            }
        }
    }
}

private struct SettingsDevicesOverviewView: View {
    @ObservedObject var container: AppContainer

    var body: some View {
        NavigationStack {
            StateView(state: container.bootstrap, retry: { Task { await container.loadBootstrap() } }) { bootstrap in
                List {
                    Section("Workspace") {
                        LabeledContent("Organization", value: bootstrap.organization.name)
                        if let project = bootstrap.projects.first {
                            LabeledContent("Project", value: project.name)
                        }
                        LabeledContent("Signed in as", value: bootstrap.user.displayName)
                        LabeledContent("Role", value: bootstrap.user.role.capitalized)
                    }

                    Section("Connection") {
                        OfflineNoticeView()
                    }

                    Section("Devices") {
                        ArtooSectionCard {
                            VStack(alignment: .leading, spacing: ArtooTokens.Spacing.sm) {
                                Label("Device inventory foundation", systemImage: "iphone.and.arrow.forward")
                                    .font(.headline)
                                Text("Device, computer, agent, and skill detail rows will use this tab after the Devices slice begins.")
                                    .font(.subheadline)
                                    .foregroundStyle(ArtooTokens.ColorToken.textMuted)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        .listRowInsets(EdgeInsets(
                            top: ArtooTokens.Spacing.sm,
                            leading: ArtooTokens.Spacing.md,
                            bottom: ArtooTokens.Spacing.sm,
                            trailing: ArtooTokens.Spacing.md
                        ))
                        .listRowBackground(Color.clear)
                    }
                }
                .listStyle(.insetGrouped)
            }
            .navigationTitle("Settings")
        }
    }
}

#if DEBUG
struct RootView_Previews: PreviewProvider {
    static var previews: some View {
        RootView()
            .environmentObject(AppContainer(client: MockApiClient.demo()))
    }
}
#endif
