import Foundation

/// Public publisher information is embedded in the signed release bundle, so
/// privacy and support remain reachable before pairing or during an outage.
struct PublisherInformation {
    let name: String
    let privacyPolicyURL: URL
    let supportURL: URL

    init?(info: [String: Any]) {
        guard let name = info["ArtooPublisherName"] as? String,
              !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let privacy = Self.publicURL(info["ArtooPrivacyPolicyURL"]),
              let support = Self.publicURL(info["ArtooSupportURL"]) else { return nil }
        self.name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        self.privacyPolicyURL = privacy
        self.supportURL = support
    }

    static var bundled: PublisherInformation? {
        PublisherInformation(info: Bundle.main.infoDictionary ?? [:])
    }

    private static func publicURL(_ value: Any?) -> URL? {
        guard let text = value as? String, let url = URL(string: text),
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme?.lowercased() == "https", let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil,
              host.lowercased() != "localhost", !host.lowercased().hasSuffix(".local") else { return nil }
        return url
    }
}
