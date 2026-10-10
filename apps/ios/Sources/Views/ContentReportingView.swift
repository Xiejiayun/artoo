import SwiftUI

struct MessageReportButton: View {
    let message: Message
    let client: ApiClientProtocol
    @State private var showingReport = false

    var body: some View {
        Button { showingReport = true } label: {
            Image(systemName: "flag").frame(minWidth: 44, minHeight: 44)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .accessibilityLabel("Report message")
        .accessibilityIdentifier("message.report.\(message.id)")
        .sheet(isPresented: $showingReport) {
            NavigationStack { MessageReportForm(message: message, client: client) }
        }
    }
}

private struct MessageReportForm: View {
    let message: Message
    let client: ApiClientProtocol
    @Environment(\.dismiss) private var dismiss
    @State private var reason = ""
    @State private var busy = false
    @State private var sent = false
    @State private var error: String?
    @FocusState private var editing: Bool

    var body: some View {
        Form {
            if sent {
                Section {
                    Label("Report received", systemImage: "checkmark.circle").accessibilityIdentifier("moderation.report.sent")
                    Text("Your team administrators can now review it. Track its status in More → My reports.")
                    Button("Done") { dismiss() }
                }
            } else {
                Section("Selected message") { Text(String(message.body.prefix(240))).lineLimit(6) }
                Section {
                    TextEditor(text: $reason).frame(minHeight: 140).focused($editing)
                        .accessibilityLabel("Report reason").accessibilityIdentifier("moderation.report.reason")
                        .onChange(of: reason) { _, value in if value.count > 1000 { reason = String(value.prefix(1000)) } }
                } header: { Text("Report reason") } footer: {
                    Text("The selected message and your reason will be visible to your team's administrators.")
                }
            }
            if let error { Section { Text(error).foregroundStyle(.red) } }
        }
        .navigationTitle("Report message")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) }
            if !sent {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send report") { editing = false; Task { await send() } }
                        .disabled(busy || reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier("moderation.report.submit")
                }
            }
            ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("Done") { editing = false } }
        }
        .interactiveDismissDisabled(busy)
    }
    private func send() async {
        guard !busy else { return }; busy = true; error = nil
        defer { busy = false }
        do {
            _ = try await client.command(path: "/api/v1/messages/\(apiPart(message.id))/report", method: "POST",
                body: .object(["reason": .string(reason.trimmingCharacters(in: .whitespacesAndNewlines))]))
            try Task.checkCancellation(); sent = true
        } catch { self.error = String(describing: error) }
    }
}

struct MyContentReportsView: View {
    let client: ApiClientProtocol
    @State private var reports: [WorkspaceRecord] = []
    @State private var before: String?
    @State private var nextBefore: String?
    @State private var loaded = false
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        List {
            if !loaded && error == nil { ProgressView("Loading reports…") }
            if loaded && reports.isEmpty { Text("You have not reported any messages.") }
            ForEach(reports) { report in
                VStack(alignment: .leading, spacing: 8) {
                    Text(status(report["status"].text)).font(.headline)
                    Text(report["reason"].text)
                    Text("Reported \(ConversationMetadata.timestamp(report["created_at"].text))").font(.caption).foregroundStyle(.secondary)
                }.padding(.vertical, 6).accessibilityElement(children: .combine).accessibilityIdentifier("moderation.my-report.\(report.id)")
            }
            if let nextBefore { Button("Earlier reports") { before = nextBefore; Task { await load() } }.disabled(busy) }
            if before != nil { Button("Latest reports") { before = nil; Task { await load() } }.disabled(busy) }
            if let error { Section { Text(error).foregroundStyle(.red); Button("Retry") { Task { await load() } } } }
        }
        .navigationTitle("My reports")
        .refreshable { await load() }
        .liveRefresh(interval: 30) { await load() }
    }
    private func status(_ value: String) -> String {
        switch value {
        case "open": return "Awaiting review"
        case "resolved": return "Message removed"
        case "dismissed": return "Review complete — no removal"
        default: return value.capitalized
        }
    }
    private func load() async {
        guard !busy else { return }; busy = true
        defer { busy = false }
        do {
            let response = try await client.resource(path: "/api/v1/moderation/my-reports" + (before.map { "?before=\(apiPart($0))" } ?? ""))
            try Task.checkCancellation(); reports = response["reports"].records; loaded = true; error = nil
            nextBefore = response["next_before"].text.isEmpty ? nil : response["next_before"].text
        } catch { self.error = String(describing: error) }
    }
}
