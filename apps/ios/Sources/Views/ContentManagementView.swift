import SwiftUI

struct ContentManagementView: View {
    let client: ApiClientProtocol
    var body: some View {
        List {
            NavigationLink("Reports awaiting review") { ContentReportQueueView(client: client) }
            NavigationLink("Posting rules") { PostingRulesView(client: client) }
            NavigationLink("Member access") { MemberAccessView(client: client) }
            Section { Text("Review incoming reports regularly and respond through your team's support channel. Reports and their original content are private to team administrators.") }
        }.navigationTitle("Content management")
    }
}

private struct ContentReportQueueView: View {
    let client: ApiClientProtocol
    @State private var reports: [WorkspaceRecord] = []
    @State private var before: String?
    @State private var nextBefore: String?
    @State private var busy = false
    @State private var error: String?
    @State private var loaded = false
    var body: some View {
        List {
            if !loaded && error == nil { ProgressView("Loading reports…") }
            if loaded && reports.isEmpty { Text("No reports on this page.") }
            ForEach(reports) { report in
                NavigationLink {
                    ContentReportReviewView(client: client, report: report)
                } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(report["status"].text == "open" ? "Awaiting review" : report["status"].text.capitalized).font(.headline)
                        Text(report["reason"].text).lineLimit(3)
                        Text(report["actor_email"].text.isEmpty ? report["actor_id"].text : report["actor_email"].text).font(.caption).foregroundStyle(.secondary)
                    }.padding(.vertical, 4)
                }.accessibilityIdentifier("moderation.staff-report.\(report.id)")
            }
            if let nextBefore { Button("Earlier reports") { before = nextBefore; Task { await load() } }.disabled(busy) }
            if before != nil { Button("Latest reports") { before = nil; Task { await load() } }.disabled(busy) }
            if let error { Section { Text(error).foregroundStyle(.red); Button("Retry") { Task { await load() } } } }
        }.navigationTitle("Reports").refreshable { await load() }.liveRefresh(interval: 30) { await load() }
    }
    private func load() async {
        guard !busy else { return }; busy = true
        defer { busy = false }
        do {
            let response = try await client.resource(path: "/api/v1/moderation/reports" + (before.map { "?before=\(apiPart($0))" } ?? ""))
            try Task.checkCancellation(); reports = response["reports"].records
            nextBefore = response["next_before"].text.isEmpty ? nil : response["next_before"].text
            loaded = true; error = nil
        } catch { if !Task.isCancelled { self.error = String(describing: error) } }
    }
}

private struct ContentReportReviewView: View {
    let client: ApiClientProtocol
    let report: WorkspaceRecord
    @Environment(\.dismiss) private var dismiss
    @State private var note = ""
    @State private var showsOriginal = false
    @State private var action = "remove"
    @State private var confirming = false
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        Form {
            Section("Report") {
                Text(report["reason"].text)
                Text("From \(report["actor_name"].text.isEmpty ? report["actor_id"].text : report["actor_name"].text)")
                if !report["actor_email"].text.isEmpty { Text(report["actor_email"].text).foregroundStyle(.secondary) }
                Button(showsOriginal ? "Hide reported content" : "View reported content") { showsOriginal.toggle() }
                    .accessibilityIdentifier("moderation.reportedContent")
                if showsOriginal { Text(report["body_snapshot"].text).textSelection(.enabled) }
            }
            if report["status"].text == "open" {
                Section("Resolution") {
                    Picker("Action", selection: $action) { Text("Remove message").tag("remove"); Text("Dismiss report").tag("dismiss") }
                    TextField("Private staff note", text: $note, axis: .vertical).lineLimit(3...8).accessibilityIdentifier("moderation.staffNote")
                    Text("Removal replaces the message and its mention preview. Staff evidence, historical execution records and previously exported copies may retain the original. Stop related runs separately if needed.").font(.footnote)
                    Button("Review resolution…") { confirming = true }.disabled(busy || note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier("moderation.reviewResolution")
                }
            } else { Section("Completed review") { Text(report["status"].text.capitalized); Text(report["resolution_note"].text) } }
            if let error { Section { Text(error).foregroundStyle(.red) } }
        }.navigationTitle("Review report")
            .confirmationDialog(action == "remove" ? "Remove this message?" : "Dismiss this report?", isPresented: $confirming, titleVisibility: .visible) {
                Button(action == "remove" ? "Confirm removal" : "Confirm dismissal", role: action == "remove" ? .destructive : nil) { Task { await save() } }
            }
    }
    private func save() async {
        guard !busy else { return }; busy = true; error = nil
        defer { busy = false }
        do {
            _ = try await client.command(path: "/api/v1/moderation/reports/\(apiPart(report.id))/resolve", method: "POST",
                body: .object(["action": .string(action), "note": .string(note.trimmingCharacters(in: .whitespacesAndNewlines))]))
            try Task.checkCancellation(); dismiss()
        } catch { self.error = String(describing: error) }
    }
}

private struct PostingRulesView: View {
    let client: ApiClientProtocol
    @State private var text = ""
    @State private var version = ""
    @State private var savedPhrases: [String] = []
    @State private var busy = false
    @State private var error: String?
    @State private var saved = false
    @State private var confirmDisable = false
    @FocusState private var editingRules: Bool
    private var phrases: [String] { text.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty } }
    var body: some View {
        Form {
            Section {
                Text("These literal phrases block new team messages and agent requests. Matching ignores case, normalizes whitespace and also matches within words.")
                Text("This is a phrase filter, not a complete automated content classifier.").font(.footnote)
            }
            Section("Blocked phrases, one per line") {
                TextEditor(text: $text).frame(minHeight: 200).focused($editingRules).accessibilityIdentifier("moderation.blockedPhrases")
                Text("Up to 128 phrases, each 3–200 characters. Existing reports require separate review.").font(.footnote)
                if savedPhrases.isEmpty { Text("Phrase filtering is currently off.") }
                Button("Save posting rules") {
                    if !savedPhrases.isEmpty && phrases.isEmpty { confirmDisable = true }
                    else { Task { await save() } }
                }.disabled(busy || version.isEmpty).accessibilityIdentifier("moderation.saveRules")
                Button("Reload saved rules") { Task { await load() } }.disabled(busy)
            }
            if saved { Text("Posting rules saved.").accessibilityIdentifier("moderation.rulesSaved") }
            if let error { Text(error).foregroundStyle(.red) }
        }.navigationTitle("Posting rules").navigationBarTitleDisplayMode(.inline)
            .scrollDismissesKeyboard(.interactively)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if editingRules {
                    HStack {
                        Spacer()
                        Button("Done") { editingRules = false }.frame(minWidth: 44, minHeight: 44)
                            .accessibilityIdentifier("moderation.rules.keyboard.done")
                    }.padding(.horizontal, 16).background(.regularMaterial)
                }
            }
            .task { await load() }
            .confirmationDialog("Turn off phrase filtering?", isPresented: $confirmDisable, titleVisibility: .visible) {
                Button("Turn off filtering", role: .destructive) { Task { await save() } }
            } message: { Text("New posts will no longer be checked against blocked phrases.") }
    }
    private func accept(_ response: JSONValue) {
        savedPhrases = response["blocked_phrases"].array.map(\.text); text = savedPhrases.joined(separator: "\n"); version = response["version"].text
    }
    private func load() async {
        guard !busy else { return }; busy = true; error = nil; saved = false
        defer { busy = false }
        do { let response = try await client.resource(path: "/api/v1/moderation/rules"); try Task.checkCancellation(); accept(response) }
        catch { if !Task.isCancelled { self.error = String(describing: error) } }
    }
    private func save() async {
        guard !busy else { return }; busy = true; error = nil; saved = false
        defer { busy = false }
        do {
            let response = try await client.command(path: "/api/v1/moderation/rules", method: "PUT", body: .object(["blocked_phrases": .strings(phrases), "version": .string(version)]))
            try Task.checkCancellation(); accept(response); saved = true
        } catch { self.error = String(describing: error) }
    }
}

private struct MemberAccessView: View {
    let client: ApiClientProtocol
    @EnvironmentObject private var container: AppContainer
    @State private var members: [WorkspaceRecord] = []
    @State private var error: String?
    var body: some View {
        List {
            ForEach(members) { member in
                let suspended = !member["suspended_at"].text.isEmpty && member["reinstated_at"].text.isEmpty
                let allowed = member.id != container.identity?.user.id && (member["role"].text == "member" || container.identity?.user.role == "owner")
                if allowed {
                    NavigationLink { ChangeMemberAccessView(client: client, member: member, suspended: suspended) } label: { row(member, suspended: suspended) }
                        .accessibilityIdentifier("moderation.member.\(member.id)")
                } else { row(member, suspended: suspended) }
            }
            if let error { Text(error).foregroundStyle(.red) }
        }.navigationTitle("Member access").refreshable { await load() }.liveRefresh(interval: 30) { await load() }
    }
    private func row(_ member: WorkspaceRecord, suspended: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) { Text(member["name"].text).font(.headline); Text(member["email"].text); Text("\(member["role"].text) · \(suspended ? "Suspended" : "Active")").font(.caption) }
    }
    private func load() async {
        do { let response = try await client.resource(path: "/api/v1/moderation/members"); try Task.checkCancellation(); members = response["members"].records; error = nil }
        catch { if !Task.isCancelled { self.error = String(describing: error) } }
    }
}

private struct ChangeMemberAccessView: View {
    let client: ApiClientProtocol
    let member: WorkspaceRecord
    let suspended: Bool
    @Environment(\.dismiss) private var dismiss
    @State private var reason = ""
    @State private var confirming = false
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        Form {
            Section { Text(member["name"].text).font(.headline); Text(member["email"].text) }
            Section {
                Text(suspended ? "The member can sign in and pair new devices. Old credentials remain revoked." : "Block sign-in, expire pairing codes and revoke the member's device sessions. Existing agent processes may still run; check Runs and stop any that must be stopped.")
                TextField("Access change reason", text: $reason, axis: .vertical).lineLimit(3...8).accessibilityIdentifier("moderation.accessReason")
                Button(suspended ? "Reinstate member…" : "Suspend member…") { confirming = true }
                    .disabled(busy || reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty).accessibilityIdentifier("moderation.changeAccess")
            }
            if let error { Text(error).foregroundStyle(.red) }
        }.navigationTitle(suspended ? "Reinstate member" : "Suspend member")
            .confirmationDialog(suspended ? "Reinstate this member?" : "Suspend this member?", isPresented: $confirming, titleVisibility: .visible) {
                Button(suspended ? "Confirm reinstatement" : "Confirm suspension", role: suspended ? nil : .destructive) { Task { await save() } }
            }
    }
    private func save() async {
        guard !busy else { return }; busy = true; error = nil
        defer { busy = false }
        do {
            _ = try await client.command(path: "/api/v1/moderation/members/\(apiPart(member.id))/suspension", method: "POST",
                body: .object(["suspended": .bool(!suspended), "reason": .string(reason.trimmingCharacters(in: .whitespacesAndNewlines))]))
            try Task.checkCancellation(); dismiss()
        } catch { self.error = String(describing: error) }
    }
}
