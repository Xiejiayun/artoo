import SwiftUI

struct ReleaseGoalsView: View {
    @StateObject private var model: WorkspaceViewModel
    let projectId: String
    init(client: ApiClientProtocol, projectId: String) {
        self.projectId = projectId
        _model = StateObject(wrappedValue: WorkspaceViewModel(client: client, path: "/api/v1/goals?project_id=\(apiPart(projectId))"))
    }
    var body: some View {
        StateView(state: model.state, retry: { Task { await model.load() } }) { data in
            List {
                if data["goals"].records.isEmpty {
                    Text("Create a goal and configure publishing in Plan. Publication evidence appears here after verified delivery.")
                }
                ForEach(data["goals"].records) { goal in
                    NavigationLink { GoalReleaseView(client: model.client, goalId: goal.id, projectId: projectId) } label: { RecordRow(item: goal) }
                        .accessibilityIdentifier("release.goal.\(goal.id)")
                }
                if let error = model.actionError { Text(error).foregroundStyle(.red) }
            }
        }.navigationTitle("Release").refreshable { await model.load() }.liveRefresh { await model.load() }
    }
}

struct GoalReleaseView: View {
    let client: ApiClientProtocol
    let goalId: String
    let projectId: String
    var body: some View {
        List {
            Section { NavigationLink("Manage goal and plan") { GoalDetailView(client: client, goalId: goalId, projectId: projectId) } }
            NativePublicationSection(client: client, goalId: goalId, kind: .staticSite)
            NativePublicationSection(client: client, goalId: goalId, kind: .application)
        }.navigationTitle("Publication").navigationBarTitleDisplayMode(.inline)
    }
}

private struct NativePublicationSection: View {
    @StateObject private var model: ReleaseViewModel
    @State private var confirmStop = false
    let kind: ReleaseViewModel.Kind
    init(client: ApiClientProtocol, goalId: String, kind: ReleaseViewModel.Kind) {
        self.kind = kind
        _model = StateObject(wrappedValue: ReleaseViewModel(client: client, goalId: goalId, kind: kind))
    }
    var body: some View {
        Section(kind == .application ? "Local application" : "Static site") {
            if model.document == nil && model.loading { ProgressView("Loading publication evidence…") }
            if model.document != nil {
                let publication = model.publication
                if publication == .null {
                    Text("No publication recorded. Verified delivery and a configured publishing destination are required.")
                } else {
                    let receipt = publication["receipt"]
                    LabeledContent("Recorded status", value: publication["status"].text)
                    if kind == .application {
                        TimelineView(.periodic(from: Date(), by: 1)) { context in
                            let state = ReleasePresentation.applicationState(publication, now: context.date, syncFailed: model.syncError != nil, stoppedAt: model.stoppedAt)
                            LabeledContent("Current availability", value: model.stopping ? "Stopping; closure unconfirmed" : availabilityLabel(state))
                                .accessibilityIdentifier("release.application.availability")
                        }
                        Text("This application runs within its configured limits on the publishing computer. Its loopback address cannot be opened from this phone.")
                            .font(.footnote).foregroundStyle(.secondary)
                        if model.canStop {
                            Button("Stop application", role: .destructive) { confirmStop = true }
                                .accessibilityIdentifier("release.application.stop")
                        }
                        if model.stopping { ProgressView("Waiting for confirmed closure…") }
                        if ReleasePresentation.isClosed(publication) { Text("Closure was confirmed by the executor.") }
                        evidenceDate("Last observation", publication["latest_observation"]["observed_at"])
                        evidenceDate("Running time limit", receipt["lease"]["deadline_at"])
                    } else {
                        LabeledContent("Latest reported health", value: model.syncError != nil ? "Unconfirmed" : publication["health"]["state"].text.isEmpty ? "No observation" : publication["health"]["state"].text)
                        if let endpoint = ReleasePresentation.staticEndpoint(publication, syncFailed: model.syncError != nil) {
                            Link("Open published site", destination: endpoint)
                        }
                        evidenceDate("Health observed", publication["health"]["checked_at"])
                        Text("Health reflects the latest received observation. Static-site stopping is not supported by this control.").font(.footnote).foregroundStyle(.secondary)
                    }
                    let checks = publication["health"]["health_checks"] == .null ? receipt["health_checks"].array : publication["health"]["health_checks"].array
                    ForEach(Array(checks.enumerated()), id: \.offset) { _, check in
                        VStack(alignment: .leading) {
                            Text(check["path"].text).font(.headline)
                            Text(check["passed"] == .bool(true) ? "Passed" : "Not passed")
                            evidenceDate("Checked", check["checked_at"])
                        }
                    }
                    if let reason = [publication["health"]["reason"], publication["latest_observation"]["reason"], receipt["reason"]].map(\.text).first(where: { !$0.isEmpty }) {
                        Text(reason).textSelection(.enabled)
                    }
                    DisclosureGroup("Technical evidence") { Text(publication.pretty).font(.caption.monospaced()).textSelection(.enabled) }
                }
            }
            if let error = model.stopError { Text("Stop request failed: \(error)").foregroundStyle(.red) }
            if let error = model.syncError { Text("Publication sync unavailable: \(error)").foregroundStyle(.red) }
            Button("Refresh publication") { Task { await model.load() } }.disabled(model.loading || model.stopping)
        }
        .liveRefresh(interval: 5) { await model.load() }
        .confirmationDialog("Stop this local application?", isPresented: $confirmStop, titleVisibility: .visible) {
            Button("Stop application", role: .destructive) { Task { await model.stop() } }
            Button("Keep running", role: .cancel) {}
        } message: { Text("The original publishing computer must confirm closure. A failed request does not establish that the application stopped.") }
    }

    @ViewBuilder private func evidenceDate(_ label: String, _ value: JSONValue) -> some View {
        if !value.text.isEmpty { LabeledContent(label, value: ConversationMetadata.timestamp(value.text)) }
    }

    private func availabilityLabel(_ state: String) -> String {
        ["pending": "Publication pending", "healthy": "Running; latest check passed", "live": "Running; health unconfirmed",
         "draining": "Stopping; closure unconfirmed", "closed-normal": "Stopped", "closed-aborted": "Stopped after interruption",
         "expired": "Running time limit ended", "unknown": "Current availability unconfirmed"][state] ?? "Current availability unconfirmed"
    }
}
