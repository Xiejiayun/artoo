import SwiftUI

struct AgentHistoryView: View {
    @StateObject private var model: AgentHistoryViewModel
    init(client: ApiClientProtocol, agentId: String, projectId: String) {
        _model = StateObject(wrappedValue: AgentHistoryViewModel(client: client, agentId: agentId, mode: .executions(projectId: projectId)))
    }
    var body: some View {
        List {
            Section {
                Text("Executions across this agent's instances in the selected project. Open an execution to load its original request, tool activity and results.").font(.subheadline)
            }
            if model.document != nil && model.rows.isEmpty { Text("No executions recorded in this project.") }
            ForEach(model.rows) { entry in
                let value = entry.value
                NavigationLink { AgentExecutionHistoryView(client: model.client, agentId: model.agentId, runId: entry.id) } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(value["task_title"].text).font(.headline)
                        Text(value["run"]["status"].text)
                        Text(ConversationMetadata.timestamp(value["run"]["created_at"].text)).font(.caption)
                        Text(value["run"]["agent_instance_id"].text).font(.caption).textSelection(.enabled)
                    }.fixedSize(horizontal: false, vertical: true)
                }.accessibilityIdentifier("agent.history.run.\(entry.id)")
            }
            historyControls(model)
        }.navigationTitle("Agent history").navigationBarTitleDisplayMode(.inline)
            .task { if model.document == nil { await model.refresh() } }.refreshable { await model.refresh() }
    }
}

private struct AgentExecutionHistoryView: View {
    @StateObject private var model: AgentHistoryViewModel
    init(client: ApiClientProtocol, agentId: String, runId: String) {
        _model = StateObject(wrappedValue: AgentHistoryViewModel(client: client, agentId: agentId, mode: .events(runId: runId)))
    }
    var body: some View {
        List {
            if let data = model.document {
                Section("Execution") {
                    Text(data["execution"]["task_title"].text).font(.headline)
                    Text(data["execution"]["run"]["status"].text)
                    Text(data["execution"]["run"]["id"].text).font(.caption).textSelection(.enabled)
                    if !data["execution"]["run"]["failure_reason"].text.isEmpty { Text(data["execution"]["run"]["failure_reason"].text).foregroundStyle(.red) }
                }
                Section("Original request") {
                    if data["request"] == .null { Text("The original request is unavailable for this execution.") }
                    else {
                        Text(data["request"]["title"].text).font(.headline)
                            .accessibilityIdentifier("agent.history.request.title")
                        Text(data["request"]["description"].text).textSelection(.enabled)
                        ForEach(Array(data["request"]["acceptance_criteria"].array.enumerated()), id: \.offset) { _, criterion in Text(criterion.text) }
                    }
                }
            }
            Section("Recorded activity · newest first") {
                Text("Tool details appear when reported by the runtime. Older executions may only contain plain output.").font(.footnote)
                if model.document != nil && model.rows.isEmpty { Text("No events recorded yet.") }
                ForEach(model.rows) { entry in
                    HistoryEventRow(event: entry.value).accessibilityIdentifier("agent.history.event.\(entry.id)")
                }
            }
            historyControls(model)
        }.navigationTitle("Execution history").navigationBarTitleDisplayMode(.inline)
            .task { if model.document == nil { await model.refresh() } }.refreshable { await model.refresh() }
    }
}

private struct HistoryEventRow: View {
    let event: JSONValue
    var body: some View {
        DisclosureGroup {
            if event["response_text"] != .null { Text(event["response_text"].text).textSelection(.enabled) }
            ForEach(Array(event["payload"]["activity"]["operations"].array.enumerated()), id: \.offset) { _, operation in
                VStack(alignment: .leading, spacing: 8) {
                    Text("\(operation["name"].text) · \(operation["phase"].text)").font(.headline)
                    Text("Call: \(operation["call_id"].text)").font(.caption)
                    if operation["exit_code"] != .null { Text("Exit code: \(operation["exit_code"].text)") }
                    ForEach(["request", "response"], id: \.self) { key in
                        if operation[key] != .null {
                            Text(key.capitalized + (operation["\(key)_truncated"] == .bool(true) ? " (truncated)" : "")).font(.subheadline.bold())
                            Text(operation[key].text).font(.caption.monospaced()).textSelection(.enabled)
                        }
                    }
                }.fixedSize(horizontal: false, vertical: true)
            }
            if event["payload"]["activity"]["omitted_operations"] != .null {
                Text("Additional operations omitted: \(event["payload"]["activity"]["omitted_operations"].text)")
            }
            DisclosureGroup("Recorded event") { Text(event.pretty).font(.caption.monospaced()).textSelection(.enabled) }
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text(event["response_text"] != .null ? "Final answer" : event["type"].text).font(.headline)
                Text(ConversationMetadata.timestamp(event["occurred_at"].text)).font(.caption)
                Text("#\(event["position"].text) · \(event["actor"]["type"].text): \(event["actor"]["id"].text)").font(.caption)
            }
        }
    }
}

@MainActor @ViewBuilder private func historyControls(_ model: AgentHistoryViewModel) -> some View {
    if model.loading { ProgressView("Loading history…") }
    if let error = model.error { Text(error).foregroundStyle(.red) }
    if model.hasMore { Button("Load older history") { Task { await model.loadEarlier() } }.disabled(model.loading) }
    Button("Refresh latest history") { Task { await model.refresh() } }.disabled(model.loading)
    Text("Refreshing returns to the newest page; older history remains available through Load older history.").font(.footnote).foregroundStyle(.secondary)
}
