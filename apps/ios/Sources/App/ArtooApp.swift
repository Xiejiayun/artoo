import SwiftUI

// MARK: - App configuration

/// Where the app gets its data. Defaults to the in-memory mock so the app is
/// immediately runnable in the iOS Simulator without a server. Flip `useMock`
/// to false (and set `baseURLString`) to talk to a live artoo server.
///
/// Verification boundary: Mac/Xcode no-assets build-for-testing has passed, but
/// full asset-catalog build, simulator/device runtime, and live-server flows
/// remain blocked/unverified. See apps/ios/README.md.
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

            RunsOverviewView(client: container.client, projectId: container.projectId)
                .tabItem { Label("Runs", systemImage: "play.rectangle.stack") }
                .tag(RootTab.runsApprovals)

            SettingsDevicesOverviewView(container: container)
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .tag(RootTab.settingsDevices)
        }
        .task { await container.loadBootstrap() }
    }
}

private struct RunsOverviewView: View {
    @StateObject private var model: RunsOverviewViewModel

    init(client: ApiClientProtocol, projectId: String) {
        _model = StateObject(wrappedValue: RunsOverviewViewModel(client: client, projectId: projectId))
    }

    var body: some View {
        NavigationStack {
            StateView(state: model.state, retry: { Task { await model.load() } }) { items in
                if items.isEmpty {
                    EmptyStateView(
                        systemImage: "play.rectangle.stack",
                        title: "No runs yet",
                        message: "Assigned tasks will show run progress, blockers, and completed attempts here."
                    )
                } else {
                    List {
                        Section("Recent runs") {
                            ForEach(items) { item in
                                NavigationLink(value: item.run) {
                                    RunFeedRow(item: item)
                                }
                            }
                        }
                    }
                    .listStyle(.insetGrouped)
                }
            }
            .navigationTitle("Runs")
            .navigationDestination(for: Run.self) { run in
                RunSummaryView(run: run)
            }
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        Task { await model.load() }
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                }
            }
            .refreshable { await model.load() }
            .task { await model.load() }
        }
    }
}

private struct RunFeedRow: View {
    let item: RunFeedItem

    var body: some View {
        VStack(alignment: .leading, spacing: ArtooTokens.Spacing.xs) {
            HStack(alignment: .firstTextBaseline, spacing: ArtooTokens.Spacing.xs) {
                Text(item.task.title)
                    .font(ArtooTokens.Typography.subheadline.weight(.semibold))
                    .foregroundStyle(ArtooTokens.ColorToken.text)
                    .lineLimit(2)
                Spacer()
                RunStatusBadge(item.run.status)
            }
            ArtooMetadataGrid([
                ("Run", item.run.id),
                ("Runtime", item.run.runtimeId),
                ("Agent", item.run.agentInstanceId),
                ("Started", item.run.startedAt ?? item.run.createdAt)
            ])
            if let failure = item.run.failureReason, !failure.isEmpty {
                Text(failure)
                    .font(ArtooTokens.Typography.caption)
                    .foregroundStyle(ArtooTokens.ColorToken.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, ArtooTokens.Spacing.xxs)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(item.task.title), run \(item.run.status.label)")
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
