import Foundation

enum ReleasePresentation {
    static func date(_ value: JSONValue) -> Date? {
        guard case let .string(text) = value else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: text) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: text)
    }

    static func staticEndpoint(_ release: JSONValue, syncFailed: Bool) -> URL? {
        guard !syncFailed, release["status"] == .string("published"), release["receipt"]["outcome"] == .string("published"),
              release["health"] == .null || release["health"]["state"] == .string("healthy"),
              let url = URL(string: release["receipt"]["endpoint"].text),
              ["https", "http"].contains(url.scheme?.lowercased() ?? ""), url.host?.isEmpty == false,
              !["localhost", "127.0.0.1", "::1", "[::1]"].contains(url.host?.lowercased() ?? ""),
              url.user == nil, url.password == nil else { return nil }
        return url
    }

    static func isClosed(_ publication: JSONValue) -> Bool {
        if case .object = publication["latest_observation"]["closure"] { return true }
        return publication["receipt"]["outcome"] == .string("failed") &&
            ["not-started", "closed-confirmed"].contains(publication["receipt"]["cleanup"]["state"].text)
    }

    /// Keep publication history separate from a fresh availability observation.
    /// A phone cannot open the publishing computer's loopback endpoint.
    static func applicationState(_ publication: JSONValue, now: Date, syncFailed: Bool, stoppedAt: Date?) -> String {
        guard !syncFailed else { return "unknown" }
        let state = publication["current_state"].text
        guard ["pending", "healthy", "live", "draining", "closed-normal", "closed-aborted", "expired", "unknown"].contains(state) else { return "unknown" }
        guard ["healthy", "live", "draining"].contains(state) else { return state }
        let receipt = publication["receipt"], observation = publication["latest_observation"]
        let deadlineValue = receipt["lease"]["deadline_at"] == .null ? observation["lease"]["deadline_at"] : receipt["lease"]["deadline_at"]
        guard let deadline = date(deadlineValue) else { return "unknown" }
        if now >= deadline { return "expired" }
        guard case let .number(freshness) = publication["request"]["capabilities"]["contract"]["limits"]["health_freshness_ms"],
              freshness.isFinite, freshness > 0, date(observation["observed_at"]) != nil else { return "unknown" }
        let samples = [observation["observed_at"], observation["health"]["checked_at"],
                       observation["live"]["observed_at"], observation["live"]["counters_observed_at"]].filter { $0 != .null }
        guard samples.allSatisfy({ value in
            guard let time = date(value), time <= now, now.timeIntervalSince(time) * 1000 < freshness else { return false }
            return stoppedAt.map { time > $0 } ?? true
        }) else { return "unknown" }
        return state
    }
}
