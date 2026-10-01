import Foundation

extension Run {
    // The wire sequence is not an attempt ordinal (real runs currently start
    // at zero). The visible full run ID and timestamp establish its identity.
    var displayTitle: String { "Execution" }

    var canStop: Bool {
        [.queued, .starting, .running, .awaitingInput, .paused].contains(status)
    }
}

extension Artifact {
    /// Storage URIs are opaque and cannot establish a user-facing filename.
    var displayName: String {
        if case let .string(filename) = metadata?["filename"],
           !filename.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return filename
        }
        let label = type.replacingOccurrences(of: "_", with: " ").capitalized
        return label.isEmpty ? "Artifact" : label
    }

    func originatingRun(in runs: [Run]) -> Run? {
        guard let runId else { return nil }
        return runs.first { $0.id == runId }
    }
}

extension TaskReview {
    var outcomeLabel: String { outcome == "accepted" ? "Accepted" : "Changes requested" }

    var reviewerLabel: String {
        if let actorName, !actorName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return actorName }
        return "\(actor.type.capitalized) · \(actor.id)"
    }
}
