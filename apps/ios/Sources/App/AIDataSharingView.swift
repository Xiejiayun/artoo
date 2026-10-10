import SwiftUI
import UIKit

/// Attached to this scene so an assignment sheet can present consent above itself.
@MainActor
final class AIConsentPresenter: NSObject, UIAdaptivePresentationControllerDelegate {
    weak var anchor: UIViewController?
    private var presented: UIViewController?
    private var waiters: [CheckedContinuation<Bool, Never>] = []

    func request(client: ApiClient) async -> Bool {
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                guard !Task.isCancelled else { continuation.resume(returning: false); return }
                if presented != nil { waiters.append(continuation); return }
                guard var top = anchor?.view.window?.rootViewController else {
                    continuation.resume(returning: false); return
                }
                while let next = top.presentedViewController { top = next }
                guard !top.isBeingDismissed else { continuation.resume(returning: false); return }
                waiters.append(continuation)
                let view = NavigationStack {
                    AIDataSharingView(client: client, onFinish: { [weak self] allowed in self?.finish(allowed) })
                }
                let host = UIHostingController(rootView: view)
                host.modalPresentationStyle = .formSheet
                presented = host
                top.present(host, animated: true)
                host.presentationController?.delegate = self
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.finish(false) }
        }
    }

    func finish(_ allowed: Bool) {
        let host = presented
        presented = nil
        let pending = waiters
        waiters.removeAll()
        // Await dismissal before replaying an action that may close its own sheet.
        if let host, host.presentingViewController != nil {
            host.dismiss(animated: true) { pending.forEach { $0.resume(returning: allowed) } }
        } else { pending.forEach { $0.resume(returning: allowed) } }
    }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { finish(false) }
}

struct AIConsentAnchor: UIViewControllerRepresentable {
    let presenter: AIConsentPresenter
    func makeUIViewController(context: Context) -> UIViewController {
        let controller = UIViewController()
        presenter.anchor = controller
        return controller
    }
    func updateUIViewController(_ controller: UIViewController, context: Context) { presenter.anchor = controller }
}

struct AIDataSharingView: View {
    let client: ApiClientProtocol
    var onFinish: ((Bool) -> Void)? = nil
    @State private var state: JSONValue?
    @State private var error: String?
    @State private var busy = false
    @State private var confirmWithdrawal = false
    @State private var withdrawalMessage: String?

    private var policy: JSONValue { state?["policy"] ?? .null }
    private var allowed: Bool { !(state?["consent"]["id"].text ?? "").isEmpty }
    private let categoryNames = [
        "prompts_and_messages": "Prompts and messages",
        "task_and_goal_context": "Task and goal context",
        "workspace_files": "Workspace files used by your agents",
        "execution_results": "Execution results",
        "account_and_workspace_identifiers": "Account and workspace identifiers",
    ]

    var body: some View {
        Form {
            if state == nil && error == nil { ProgressView("Loading AI disclosure…") }
            if let state {
                if !state["configured"].bool {
                    Section { Text("Your team has not configured its AI provider disclosure. Ask your team administrator to complete it before starting agent work. You can continue browsing your workspace.") }
                } else if policy["mode"].text == "local" {
                    Section { Text("Your team administrator has declared local-only AI processing with no external AI providers. External AI sharing permission is not required for this configuration.") }
                } else {
                    Section("What is shared") {
                        Text("When you request agent work, your execution computer may send the following information to the providers listed below.")
                        ForEach(policy["data_categories"].array.map(\.text), id: \.self) { category in
                            Text(categoryNames[category] ?? category)
                        }
                        Text(policy["purpose"].text)
                    }
                    Section("AI providers") {
                        ForEach(policy["providers"].array.indices, id: \.self) { index in
                            let provider = policy["providers"].array[index]
                            VStack(alignment: .leading, spacing: 6) {
                                Text(provider["name"].text).font(.headline)
                                if let url = URL(string: provider["privacy_url"].text), url.scheme == "https" {
                                    Link("Privacy policy for \(provider["name"].text)", destination: url)
                                }
                            }.padding(.vertical, 4)
                        }
                    }
                    Section {
                        Text("Only continue if you have permission to share this information. You can withdraw in More → AI data sharing. Withdrawal stops new sharing and requests that your agent work stop; information already sent cannot be recalled.")
                        if allowed {
                            Text("You have allowed this team's current disclosure.").accessibilityIdentifier("aiSharing.allowed")
                            if let onFinish { Button("Continue") { onFinish(true) }.disabled(busy) }
                        } else {
                            Button("Allow AI data sharing") { Task { await grant() } }
                                .disabled(busy).accessibilityIdentifier("aiSharing.allow")
                        }
                    }
                }
            }
            if state != nil && onFinish == nil {
                Section { Button("Withdraw permission…", role: .destructive) { confirmWithdrawal = true }.disabled(busy).accessibilityIdentifier("aiSharing.withdraw") }
            }
            if let withdrawalMessage { Section { Text(withdrawalMessage).accessibilityIdentifier("aiSharing.withdrawalResult") } }
            if let error { Section { Text(error).foregroundStyle(.red); Button("Reload disclosure") { Task { await load() } }.disabled(busy) } }
        }
        .navigationTitle("AI data sharing")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let onFinish { ToolbarItem(placement: .cancellationAction) { Button("Not now") { onFinish(false) }.disabled(busy).accessibilityIdentifier("aiSharing.decline") } }
        }
        .interactiveDismissDisabled(busy)
        .task { await load() }
        .confirmationDialog("Withdraw AI sharing permission?", isPresented: $confirmWithdrawal, titleVisibility: .visible) {
            Button("Withdraw and stop my agent work", role: .destructive) { Task { await withdraw() } }
        } message: { Text("This affects your queued and running agent work for this team, across your devices. Already shared information cannot be recalled. Offline computers may need to be stopped manually.") }
    }

    private func load() async {
        busy = true; error = nil
        defer { busy = false }
        do { let value = try await client.resource(path: "/api/v1/privacy/ai-sharing"); try Task.checkCancellation(); state = value }
        catch { if !Task.isCancelled { self.error = String(describing: error) } }
    }
    private func grant() async {
        busy = true; error = nil
        defer { busy = false }
        do {
            let result = try await client.command(path: "/api/v1/privacy/ai-sharing/consent", method: "POST",
                body: .object(["policy_version": .string(policy["version"].text), "expected_user_id": .string(state?["user_id"].text ?? "")]))
            try Task.checkCancellation()
            state = result
            if !result["consent"]["id"].text.isEmpty { onFinish?(true) }
        } catch { self.error = String(describing: error) }
    }
    private func withdraw() async {
        busy = true; error = nil
        defer { busy = false }
        do {
            let result = try await client.command(path: "/api/v1/privacy/ai-sharing/consent", method: "DELETE",
                body: .object(["stop_my_agent_work": .bool(true), "expected_user_id": .string(state?["user_id"].text ?? "")]))
            try Task.checkCancellation()
            state = result
            let unconfirmed = result["unconfirmed_stops"].array
            withdrawalMessage = unconfirmed.isEmpty
                ? "Permission withdrawn. No affected agent work has an unconfirmed stop."
                : "Permission withdrawn. Stopping \(unconfirmed.count) work items could not be confirmed. Stop affected agents on their execution computers; already running processes may still share information."
        } catch { self.error = "The withdrawal result could not be confirmed. Reload the disclosure and retry withdrawal if needed. \(error)" }
    }
}
