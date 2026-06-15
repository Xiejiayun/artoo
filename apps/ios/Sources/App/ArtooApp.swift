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

public struct RootView: View {
    @EnvironmentObject private var container: AppContainer

    public init() {}

    public var body: some View {
        TabView {
            InboxView(client: container.client)
                .tabItem { Label("Inbox", systemImage: "tray.full") }

            TasksView(client: container.client, projectId: container.projectId)
                .tabItem { Label("Tasks", systemImage: "checklist") }
        }
        .task { await container.loadBootstrap() }
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
