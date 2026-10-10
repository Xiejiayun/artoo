import SwiftUI
import UIKit

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
    let aiConsent = AIConsentPresenter()
    private let credentials: CredentialStore
    private var bootstrapOperationSequence = 0
    private var bootstrapPublicationSequence = 0
    @Published fileprivate private(set) var restored = false

    public init(config: AppConfig = .default, credentials: CredentialStore = KeychainCredentialStore()) {
        self.config = config; self.credentials = credentials
        self.client = ApiClient(baseURL: URL(string: "https://unconfigured.invalid")!)
        #if DEBUG
        if config.useMock { self.client = MockApiClient.demo(); isAuthenticated = true; restored = true }
        #endif
    }
    public init(client: ApiClientProtocol, config: AppConfig = .default, credentials: CredentialStore = KeychainCredentialStore()) {
        self.client = client; self.config = config; self.credentials = credentials
        isAuthenticated = true; restored = true
        configureAIConsent()
    }
    private func configureAIConsent() {
        guard let live = client as? ApiClient else { return }
        live.setAIConsentHandler { [weak self, weak live] in
            guard let self, let live else { return false }
            return await self.aiConsent.request(client: live)
        }
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
        aiConsent.finish(false)
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
        configureAIConsent()
        bootstrap = .loaded(initial); isAuthenticated = true; connectionError = nil
        if !initial.projects.contains(where: { $0.id == selectedProjectId }) { selectedProjectId = initial.projects.first?.id ?? "" }
        try realtime.configure(origin: url, controlToken: stored.controlToken, sessionID: live.sessionID,
            topics: initial.projects.map { "project:\($0.id)" } + ["inbox:\(authenticated.user.id)"])
    }
    private func nextBootstrapOperation() -> Int {
        bootstrapOperationSequence += 1
        return bootstrapOperationSequence
    }
    private func acceptBootstrapPublication(_ operation: Int, session: UUID) -> Bool {
        guard isAuthenticated, session == sessionGeneration, !Task.isCancelled,
              operation > bootstrapPublicationSequence else { return false }
        // Only an accepted outcome advances the barrier. A cancelled mention
        // must not discard a still-useful workspace refresh that is in flight.
        bootstrapPublicationSequence = operation
        return true
    }
    public func loadBootstrap() async {
        guard isAuthenticated, !Task.isCancelled else { return }
        let generation = sessionGeneration
        let operation = nextBootstrapOperation()
        if bootstrap.value == nil { bootstrap = .loading }
        do {
            let value = try await client.bootstrap()
            guard acceptBootstrapPublication(operation, session: generation) else { return }
            bootstrap = .loaded(value)
            if !value.projects.contains(where: { $0.id == selectedProjectId }) { selectedProjectId = value.projects.first?.id ?? "" }
            if let user = identity?.user.id { realtime.updateTopics(value.projects.map { "project:\($0.id)" } + ["inbox:\(user)"]) }
        } catch { if acceptBootstrapPublication(operation, session: generation) { bootstrap = .failed(String(describing: error)) } }
    }
    private struct SupersededMentionProjectError: Error, CustomStringConvertible {
        var description: String { "The workspace changed while opening this mention. Try opening it again." }
    }
    func makeMentionDestinationModel(client: ApiClientProtocol, session: UUID) -> MentionDestinationViewModel {
        return MentionDestinationViewModel(client: client, resolveProject: { [weak self] projectId, isCurrent in
            guard let self else { throw CancellationError() }
            try await self.resolveMentionProject(projectId, session: session, isCurrent: isCurrent)
        }, isSessionCurrent: { [weak self] in
            self?.isAuthenticated == true && self?.sessionGeneration == session
        })
    }
    func resolveMentionProject(_ projectId: String, session: UUID, isCurrent: @escaping @MainActor () -> Bool) async throws {
        func requireCurrent() throws {
            guard isAuthenticated, session == sessionGeneration, isCurrent(), !Task.isCancelled else { throw CancellationError() }
        }
        try requireCurrent()
        guard !projectId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ApiError.decoding("The mention has no project destination.")
        }
        let operation = nextBootstrapOperation()
        var refreshed: Bootstrap?
        if bootstrap.value?.projects.contains(where: { $0.id == projectId }) != true {
            // The global inbox can receive mentions from projects added after pairing.
            // Keep the current workspace usable when this authorized refresh fails.
            let value = try await client.bootstrap()
            try requireCurrent()
            guard value.projects.contains(where: { $0.id == projectId }) else {
                throw ApiError.http(status: 403, body: "This mention's project is unavailable or you no longer have access. Refresh and try again.")
            }
            refreshed = value
        }
        try requireCurrent()
        // A cache-hit selection is also newer workspace state: older refresh
        // success or failure must not undo the resolved destination.
        guard acceptBootstrapPublication(operation, session: session) else { throw SupersededMentionProjectError() }
        if let value = refreshed {
            bootstrap = .loaded(value)
            if let user = identity?.user.id { realtime.updateTopics(value.projects.map { "project:\($0.id)" } + ["inbox:\(user)"]) }
        }
        selectedProjectId = projectId
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
        aiConsent.finish(false)
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
        aiConsent.finish(false)
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
    @State private var selectedTab = RootTab.channels
    public init() {}
    public var body: some View {
        Group {
            if container.isAuthenticated {
                TabView(selection: $selectedTab) {
                    ChannelsView(client: container.client, projectId: container.projectId)
                        .id("channels.\(container.projectId)").tabItem { Label("Channels", systemImage: "bubble.left.and.bubble.right") }.tag(RootTab.channels)
                    InboxView(client: container.client).tabItem { Label("Inbox", systemImage: "tray.full") }.badge(container.notificationBadge).tag(RootTab.inbox)
                    TasksView(client: container.client, projectId: container.projectId)
                        .id("tasks.\(container.projectId)").tabItem { Label("Tasks", systemImage: "checklist") }.tag(RootTab.tasks)
                    TeamView(client: container.client).tabItem { Label("Team", systemImage: "desktopcomputer") }.tag(RootTab.team)
                    WorkspaceSettingsView().tabItem { Label("More", systemImage: "ellipsis.circle") }.tag(RootTab.more)
                }.id(container.sessionGeneration).liveRefresh(interval: 30, realtime: false) { await container.validateConnection() }
                    .liveRefresh { await container.refreshNotificationCount() }
            } else { PairDeviceView() }
        }
        .task { await container.restore() }
        .background(AIConsentAnchor(presenter: container.aiConsent).frame(width: 0, height: 0))
        .onChange(of: container.sessionGeneration) { _, _ in selectedTab = .channels }
        .onChange(of: scenePhase) { _, phase in container.realtime.setActive(phase == .active) }
        .onReceive(NotificationCenter.default.publisher(for: .artooAuthenticationExpired).receive(on: RunLoop.main)) { notification in
            container.authenticationExpired(session: notification.object as? String)
        }
    }
}

@MainActor
private struct PairDeviceView: View {
    private enum InputField: Hashable { case server, name, code }
    @EnvironmentObject private var container: AppContainer
    @State private var server = ""
    @State private var code = ""
    @State private var deviceName = "My iPhone"
    @State private var localHTTP = false
    @State private var isVisible = false
    @State private var focusReveal = FocusRevealController()
    @FocusState private var focusedField: InputField?
    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                Form {
                    Section {
                        ArtooPageIntro(title: "Your team, on the go", message: "Chat, review work, and keep projects moving.", systemImage: "bubble.left.and.bubble.right.fill")
                    }
                    Section {
                        Text("In Web Settings, choose Connect a device → iOS to get your pairing code.")
                            .font(.subheadline).foregroundStyle(.secondary)
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Team server").font(.caption).foregroundStyle(.secondary)
                            TextField("https://artoo.example.com", text: $server,
                                      onEditingChanged: { focusReveal.editingChanged($0, field: .server) }).keyboardType(.URL)
                                .textInputAutocapitalization(.never).autocorrectionDisabled().accessibilityIdentifier("serverURL")
                                .focused($focusedField, equals: .server).submitLabel(.next)
                                .onSubmit { focusedField = .name }
                        }.id(InputField.server)
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Device name").font(.caption).foregroundStyle(.secondary)
                            TextField("Device name", text: $deviceName,
                                      onEditingChanged: { focusReveal.editingChanged($0, field: .name) }).accessibilityIdentifier("pairingDeviceName")
                                .focused($focusedField, equals: .name).submitLabel(.next)
                                .onSubmit { focusedField = .code }
                        }.id(InputField.name)
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Pairing code").font(.caption).foregroundStyle(.secondary)
                            TextField("One-time pairing code", text: $code,
                                      onEditingChanged: { focusReveal.editingChanged($0, field: .code) }).textInputAutocapitalization(.characters)
                                .textContentType(.oneTimeCode).privacySensitive()
                                .autocorrectionDisabled().accessibilityIdentifier("pairingCode")
                                .focused($focusedField, equals: .code).submitLabel(.done)
                                .onSubmit { focusedField = nil }
                        }.id(InputField.code)
                        Button("Connect") {
                            focusedField = nil
                            Task { await container.pair(server: server, code: code, displayName: deviceName, allowLocalHTTP: localHTTP); code = "" }
                        }
                            .frame(minHeight: 44)
                            .disabled(container.isConnecting || server.isEmpty || code.isEmpty)
                            .accessibilityIdentifier("pairDevice")
                        if container.isConnecting { ProgressView("Connecting…") }
                    } header: {
                        Text("Connect to your team")
                    } footer: {
                        Text("Your phone will use your Web account's permissions. Keep this one-time code private.")
                    }
                    if let error = container.connectionError {
                        Section {
                            Text(error).foregroundStyle(.red).accessibilityIdentifier("pairing.connection.error")
                            Button("Retry saved connection") { Task { await container.retryConnection() } }
                                .accessibilityIdentifier("pairing.retrySavedConnection")
                        }
                    }
                    Section("Local development") {
                        Toggle("Allow localhost or .local HTTP", isOn: $localHTTP).accessibilityIdentifier("allowLocalHTTP")
                        Text("Use HTTPS for a shared team server. On a phone, localhost refers to the phone itself.").font(.caption)
                    }
                    Section { NavigationLink("Privacy and data") { PrivacyView() } }
                }
                .navigationTitle("Welcome to Artoo").scrollDismissesKeyboard(.interactively)
                .disabled(!container.restored || container.isConnecting)
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    if focusedField != nil {
                        HStack {
                            Spacer()
                            Button { focusedField = nil } label: {
                                Text("Done")
                                    .frame(minWidth: 44, minHeight: 44)
                                    .contentShape(Rectangle())
                            }
                            .accessibilityIdentifier("pairing.keyboard.done")
                        }
                        .padding(.horizontal, 16)
                        .background(ArtooTokens.ColorToken.surfaceRaised)
                        .overlay(alignment: .top) { Divider() }
                        .accessibilityElement(children: .contain)
                        .accessibilityIdentifier("pairing.keyboard.controls")
                    }
                }
                .background {
                    FocusRevealReader(controller: focusReveal, focusedField: isVisible ? focusedField : nil) { field in
                        guard isVisible, focusedField == field else { return }
                        proxy.scrollTo(field, anchor: .center)
                    }
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                }
                .onAppear { isVisible = true }
                .onDisappear { isVisible = false; focusedField = nil; focusReveal.disappear() }
            }
        }
    }

    // Public editing callbacks provide field identity independently of the
    // order in which FocusState and keyboard notifications arrive.
    @MainActor
    private struct FocusRevealReader: UIViewRepresentable {
        let controller: FocusRevealController
        let focusedField: InputField?
        let reveal: (InputField) -> Void

        func makeUIView(context: Context) -> FocusRevealScopeView {
            let view = FocusRevealScopeView()
            view.isUserInteractionEnabled = false
            view.isAccessibilityElement = false
            view.accessibilityElementsHidden = true
            view.controller = controller
            controller.attach(view)
            controller.configure(focusedField: focusedField, reveal: reveal)
            return view
        }

        func updateUIView(_ view: FocusRevealScopeView, context: Context) {
            controller.configure(focusedField: focusedField, reveal: reveal)
        }

        static func dismantleUIView(_ view: FocusRevealScopeView, coordinator: Void) { view.controller?.detach(view) }
    }

    @MainActor
    private final class FocusRevealScopeView: UIView {
        weak var controller: FocusRevealController?
        override func didMoveToWindow() { super.didMoveToWindow(); controller?.windowChanged() }
    }

    private final class ObserverTokens {
        var values: [NSObjectProtocol] = []
        func removeAll() {
            for token in values { NotificationCenter.default.removeObserver(token) }
            values.removeAll()
        }
        deinit { removeAll() }
    }

    @MainActor
    private final class FocusRevealController: NSObject {
        private enum Phase { case active, environmentSuspended, userSuppressed, keyboardHidden, ended }
        private final class Activation {
            let field: InputField
            var token = UUID()
            weak var window: UIWindow?
            weak var responder: UIView?
            var phase = Phase.active
            var initialSent = false
            var completionSent = false

            init(field: InputField) { self.field = field }
        }

        private final class KeyboardCompletion {
            weak var window: UIWindow?
            weak var responder: UIView?

            init(window: UIWindow, responder: UIView) {
                self.window = window; self.responder = responder
            }
        }

        private let observers = ObserverTokens()
        private weak var scope: FocusRevealScopeView?
        private var focusedField: InputField?
        private var reveal: ((InputField) -> Void)?
        private var activation: Activation?
        private weak var observedPan: UIPanGestureRecognizer?
        private var keyboardCompletion: KeyboardCompletion?
        private var request: DispatchWorkItem?

        func editingChanged(_ editing: Bool, field: InputField) {
            if !editing {
                // An old field can finish after the next field began editing.
                guard let activation, activation.field == field else { return }
                activation.phase = .ended
                cancelRequest()
                if keyboardCompletion?.responder === activation.responder { keyboardCompletion = nil }
                stopObservingPan()
                return
            }
            let previous = activation
            cancelRequest()
            stopObservingPan()
            if previous?.field == field { keyboardCompletion = nil }
            activation = Activation(field: field)
            // Bind the native responder on the next main turn, once the fixed
            // editing identity and FocusState agree, not inside the callback.
            scheduleReveal()
        }

        func configure(focusedField next: InputField?, reveal: @escaping (InputField) -> Void) {
            self.reveal = reveal
            if next != focusedField { cancelRequest(); focusedField = next }
            resumeEnvironment()
            scheduleReveal()
        }

        func attach(_ view: FocusRevealScopeView) {
            scope = view
            guard observers.values.isEmpty else { return }
            for name in [UIResponder.keyboardDidShowNotification, UIResponder.keyboardDidChangeFrameNotification,
                         UIResponder.keyboardWillHideNotification, UIResponder.keyboardDidHideNotification,
                         UITextField.textDidBeginEditingNotification, UIWindow.didBecomeKeyNotification,
                         UIWindow.didResignKeyNotification, UIScene.didActivateNotification, UIScene.willDeactivateNotification] {
                observers.values.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] notification in
                    MainActor.assumeIsolated { self?.receive(notification) }
                })
            }
        }

        func windowChanged() {
            if let activation, let previousWindow = activation.window, previousWindow !== scope?.window {
                suspendEnvironment()
            }
            resumeEnvironment()
            scheduleReveal()
        }

        private var activeWindow: UIWindow? {
            guard let window = scope?.window, window.isKeyWindow,
                  window.windowScene?.activationState == .foregroundActive else { return nil }
            return window
        }

        private func firstResponder(in view: UIView) -> UIView? {
            if view.isFirstResponder { return view }
            for child in view.subviews { if let responder = firstResponder(in: child) { return responder } }
            return nil
        }

        private func scheduleReveal() {
            guard request == nil, let activation, activation.phase == .active,
                  focusedField == activation.field,
                  !activation.initialSent || (!activation.completionSent && completedKeyboard(for: activation)) else { return }
            let token = activation.token
            let work = DispatchWorkItem { [weak self, weak activation] in
                MainActor.assumeIsolated {
                    guard let self, let activation, self.activation === activation, activation.token == token else { return }
                    self.request = nil
                    guard activation.phase == .active, self.focusedField == activation.field,
                          let window = self.activeWindow, let responder = self.firstResponder(in: window) else { return }
                    if let bound = activation.responder {
                        guard bound === responder, activation.window === window else { return }
                    } else {
                        activation.responder = responder; activation.window = window
                        self.observePan(above: responder)
                    }
                    guard activation.phase == .active else { return }
                    if !activation.initialSent {
                        activation.initialSent = true
                        self.reveal?(activation.field)
                        // A keyboard may already have finished before the
                        // editing callback and FocusState agreed.
                        if self.completedKeyboard(for: activation) { self.scheduleReveal() }
                    } else if !activation.completionSent, self.completedKeyboard(for: activation) {
                        activation.completionSent = true
                        self.reveal?(activation.field)
                    }
                }
            }
            request = work
            DispatchQueue.main.async(execute: work)
        }

        private func completedKeyboard(for activation: Activation) -> Bool {
            guard let completion = keyboardCompletion else { return false }
            return completion.window === activation.window && completion.responder === activation.responder
        }

        private func receive(_ notification: Notification) {
            guard let window = scope?.window ?? activation?.window else { return }
            if notification.name == UIWindow.didBecomeKeyNotification || notification.name == UIWindow.didResignKeyNotification {
                guard let eventWindow = notification.object as? UIWindow, eventWindow === window else { return }
                if notification.name == UIWindow.didResignKeyNotification { suspendEnvironment() }
                else { resumeEnvironment(); scheduleReveal() }
                return
            }
            if notification.name == UIScene.didActivateNotification || notification.name == UIScene.willDeactivateNotification {
                guard let scene = notification.object as? UIWindowScene, scene === window.windowScene else { return }
                if notification.name == UIScene.willDeactivateNotification { suspendEnvironment() }
                else { resumeEnvironment(); scheduleReveal() }
                return
            }
            if notification.name == UITextField.textDidBeginEditingNotification {
                if let field = notification.object as? UITextField, field.window === window { scheduleReveal() }
                return
            }
            let screen = window.windowScene?.screen ?? window.screen
            if let eventScreen = notification.object as? UIScreen, eventScreen !== screen { return }
            guard (notification.userInfo?[UIResponder.keyboardIsLocalUserInfoKey] as? Bool) != false else { return }
            // Hide still invalidates queued work after the responder is gone.
            if notification.name == UIResponder.keyboardWillHideNotification || notification.name == UIResponder.keyboardDidHideNotification {
                keyboardHidden(); return
            }
            guard activeWindow === window, let responder = firstResponder(in: window),
                  let rawEnd = (notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
            let end = window.convert(rawEnd, from: screen.coordinateSpace)
            guard !end.isNull, !end.isInfinite, end.intersects(window.bounds) else { keyboardHidden(); return }
            // The keyboard belongs to the window. Its completed layout can
            // reveal the current editor regardless of which field began it.
            keyboardCompletion = KeyboardCompletion(window: window, responder: responder)
            if let activation, activation.phase == .keyboardHidden,
               focusedField == activation.field,
               activation.window == nil || activation.window === window,
               activation.responder == nil || activation.responder === responder {
                activation.phase = .active
            }
            scheduleReveal()
        }

        private func keyboardHidden() {
            cancelRequest(); keyboardCompletion = nil
            if activation?.phase == .active { activation?.phase = .keyboardHidden }
        }

        private func suspendEnvironment() {
            guard let activation, activation.phase == .active || activation.phase == .keyboardHidden else { return }
            activation.phase = .environmentSuspended
            cancelRequest(); keyboardCompletion = nil
        }

        private func resumeEnvironment() {
            guard let activation, activation.phase == .environmentSuspended,
                  focusedField == activation.field, let window = activeWindow,
                  activation.window == nil || activation.window === window,
                  let responder = firstResponder(in: window),
                  activation.responder == nil || activation.responder === responder else { return }
            // A resumed editing environment gets a fresh bounded reveal. A
            // user's pan is a separate phase and can never enter this path.
            cancelRequest(); stopObservingPan()
            self.activation = Activation(field: activation.field)
        }

        private func observePan(above responder: UIView) {
            var ancestor: UIView? = responder
            while let view = ancestor {
                if let scroll = view as? UIScrollView {
                    let pan = scroll.panGestureRecognizer
                    if pan.state == .began || pan.state == .changed { suppressForPan(); return }
                    observedPan = pan
                    pan.addTarget(self, action: #selector(didPan(_:)))
                    return
                }
                ancestor = view.superview
            }
        }

        @objc private func didPan(_ pan: UIPanGestureRecognizer) {
            if pan.state == .began || pan.state == .changed { suppressForPan() }
        }

        private func suppressForPan() {
            activation?.phase = .userSuppressed
            cancelRequest(); keyboardCompletion = nil
        }

        private func stopObservingPan() {
            observedPan?.removeTarget(self, action: #selector(didPan(_:)))
            observedPan = nil
        }

        private func cancelRequest() {
            activation?.token = UUID()
            request?.cancel(); request = nil
        }

        func disappear() {
            cancelRequest(); stopObservingPan()
            activation = nil; keyboardCompletion = nil; focusedField = nil
        }

        func detach(_ view: FocusRevealScopeView) {
            guard scope === view else { return }
            disappear(); observers.removeAll(); scope = nil; reveal = nil
        }
    }
}

private struct WorkspaceSettingsView: View {
    @EnvironmentObject private var container: AppContainer
    var body: some View {
        NavigationStack {
            List {
                Section("Workspace") {
                    HStack(spacing: 12) {
                        ArtooAvatar(name: container.identity?.user.name ?? "Connected", size: 48)
                        VStack(alignment: .leading, spacing: 5) {
                            Text(container.identity?.user.name ?? "Connected").font(.headline)
                                .accessibilityIdentifier("workspace.account.name")
                            Text(container.serverURL).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                        }
                    }.padding(.vertical, 8)
                    if let projects = container.bootstrap.value?.projects {
                        Picker("Project", selection: $container.selectedProjectId) {
                            ForEach(projects) { project in Text(project.name).tag(project.id).accessibilityIdentifier("workspace.project.option.\(project.id)") }
                        }.accessibilityIdentifier("workspace.project")
                    }
                    Button { Task { await container.loadBootstrap() } } label: { Label("Refresh workspace", systemImage: "arrow.clockwise") }
                    if container.isAdministrator { NavigationLink("Manage projects") { ProjectsView() } }
                }
                Section("Work") {
                    NavigationLink { WorkspaceListView(kind: .goals, client: container.client, projectId: container.projectId, embedded: true) } label: { Label("Goals", systemImage: "target") }
                    NavigationLink { MentionsView(client: container.client) } label: {
                        VStack(alignment: .leading) {
                            Text(container.mentionsTitle)
                            Text(container.notificationCountSummary).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    NavigationLink { RunsOverviewView(client: container.client, projectId: container.projectId) } label: { Label("Run history", systemImage: "clock.arrow.circlepath") }
                    NavigationLink { WorkspaceListView(kind: .memories, client: container.client, projectId: container.projectId, embedded: true) } label: { Label("Memory", systemImage: "brain.head.profile") }
                    NavigationLink { WorkspaceListView(kind: .skills, client: container.client, projectId: container.projectId, embedded: true) } label: { Label("Skills", systemImage: "square.stack.3d.up") }
                    NavigationLink { DevicesView(client: container.client) } label: { Label("Devices", systemImage: "laptopcomputer.and.iphone") }
                }
                if let error = container.connectionError { Section { Text(error).foregroundStyle(.red) } }
                Section {
                    NavigationLink("AI data sharing") { AIDataSharingView(client: container.client) }.accessibilityIdentifier("aiSharing.settings")
                    NavigationLink("Privacy and data") { PrivacyView() }
                }
                Section { Button("Sign out", role: .destructive) { Task { await container.logout() } }.disabled(container.isConnecting).accessibilityIdentifier("signOut") }
            }.navigationTitle("More")
        }
    }
}

private struct RunsOverviewView: View {
    @StateObject private var model: RunsOverviewViewModel
    @State private var searchText = ""
    let client: ApiClientProtocol
    init(client: ApiClientProtocol, projectId: String) { self.client = client; _model = StateObject(wrappedValue: RunsOverviewViewModel(client: client, projectId: projectId)) }
    var body: some View {
        StateView(state: model.state, retry: { Task { await model.load() } }) { items in
            let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
            let matches = items.filter { query.isEmpty || ($0.task.title + " " + $0.run.id + " " + $0.run.status.label).localizedCaseInsensitiveContains(query) }
            List {
                if items.isEmpty {
                    EmptyStateView(systemImage: "clock.arrow.circlepath", title: "No executions yet", message: "Assign a ready task to an agent to start its first execution. Progress and outcomes will appear here.")
                } else if matches.isEmpty {
                    EmptyStateView(systemImage: "magnifyingglass", title: "No matching executions", message: "Search by task, status, or run identifier.", actionTitle: "Clear search", action: { searchText = "" })
                }
                ForEach(matches) { item in
                    NavigationLink { RunSummaryView(run: item.run, client: client) } label: {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(item.task.title).font(.headline).lineLimit(3)
                            RunStatusBadge(item.run.status)
                            Text("\(item.run.displayTitle) · \(ConversationMetadata.timestamp(item.run.startedAt ?? item.run.createdAt))")
                                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                            if let reason = item.run.failureReason, !reason.isEmpty {
                                Text(reason).font(.subheadline).foregroundStyle(ArtooTokens.ColorToken.danger).lineLimit(2)
                            }
                        }.padding(.vertical, 6)
                    }
                    .accessibilityIdentifier("run.history.\(item.run.id)")
                    .accessibilityHint("Opens execution details for run \(item.run.id)")
                }
            }.listStyle(.insetGrouped)
        }.navigationTitle("Runs").searchable(text: $searchText, prompt: "Search tasks or executions")
            .refreshable { await model.load() }.liveRefresh { await model.load() }
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
