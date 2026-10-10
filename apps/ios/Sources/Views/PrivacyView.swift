import SwiftUI

/// Available before pairing as well as from the connected workspace.
struct PrivacyView: View {
    private let publisher = PublisherInformation.bundled

    var body: some View {
        List {
            if let publisher {
                Section("Publisher") {
                    Text(publisher.name)
                    Link("Privacy policy", destination: publisher.privacyPolicyURL)
                        .accessibilityIdentifier("privacy.publisher.policy")
                    Link("Support", destination: publisher.supportURL)
                        .accessibilityIdentifier("privacy.publisher.support")
                }
            }
            Section {
                Text("Artoo connects to the team server you choose. Your team's server operator manages access to your workspace and provides the privacy policy that applies to that service.")
            }

            Section("On this device") {
                Text("Your server address, device identifier and sign-in credential are kept in this device's Keychain. The credential is available while the device is unlocked and does not sync through iCloud Keychain.")
                Text("Unsent messages and pending sends are saved in the app's local settings, separately for each server, account and conversation. Drafts can remain after sign-out. Pending sends are retried only when you choose to retry them.")
                Text("Files you preview and audit records you export are saved temporarily on this device with file protection. Sharing a file gives a copy to the app or destination you select.")
            }

            Section("Your team server") {
                Text("Pairing sends your one-time code, device name, iOS platform and app version to the server. Authenticated requests identify your account and device. Your name, email and role come from your team's account records.")
                Text("Messages, mentions, task details, goals, approval decisions and other changes you submit are sent to your team server and can be available to other members of that team.")
                Text("The server also stores execution history, audit records and files produced by agents. Previewing an artifact downloads it from the server; it does not remove the server's copy.")
            }

            Section("Agents and AI providers") {
                Text("When you request an agent response or start work, the team's execution computer may send your request, conversation and task context, and relevant workspace files to its configured AI provider.")
                Text("Your team lists its configured providers in More → AI data sharing. Review their privacy policies and give explicit permission before starting external AI work. You can withdraw permission there at any time; information already sent cannot be recalled.")
            }

            Section("Tracking") {
                Text("This iOS client does not include advertising or cross-app tracking SDKs. Your team server and its AI providers may maintain their own operational logs under their policies.")
            }

            Section("Sign-out and deletion") {
                Text("Signing out removes the local sign-in credential and asks the server to revoke that session. If the server cannot be reached, an administrator can revoke the device from the team's Devices page.")
                Text("Signing out does not delete local drafts, temporary files, shared copies or records already stored by the team server and its providers.")
                Text("Contact your team administrator for the server operator's privacy policy, retention periods, backup practices, and account or content deletion requests. Those details depend on the service your team operates.")
            }

            Section {
                Text("This page explains the app's data flow. It does not replace your server operator's privacy policy.")
                    .foregroundStyle(.secondary)
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Privacy and data")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("privacyAndData")
    }
}
