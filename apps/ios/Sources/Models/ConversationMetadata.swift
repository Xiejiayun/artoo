import Foundation

enum ConversationMetadata {
    static func author(actorType: String, actorId: String, members: [WorkspaceRecord], agents: [WorkspaceRecord],
                       currentUserId: String?, currentUserName: String?, annotateSelf: Bool = true) -> String {
        if actorType == "system" { return "Artoo" }
        let records = actorType == "user" ? members : (actorType == "agent" ? agents : [])
        let recordedName = records.first { $0.id == actorId }?["display_name"].text.trimmingCharacters(in: .whitespacesAndNewlines)
        let isCurrentUser = actorType == "user" && actorId == currentUserId
        let ownName = isCurrentUser ? currentUserName?.trimmingCharacters(in: .whitespacesAndNewlines) : nil
        let name = [ownName, recordedName].compactMap { $0 }.first { !$0.isEmpty }
            ?? "\(actorType):\(actorId)"
        return isCurrentUser && annotateSelf ? "\(name) (you)" : name
    }

    static func mentionNames(_ payload: JSONValue?, members: [WorkspaceRecord], agents: [WorkspaceRecord],
                             currentUserId: String?, currentUserName: String?) -> [String] {
        var names: [String] = [], seen = Set<String>()
        for mention in payload?["mentions"].array ?? [] {
            guard case let .string(actorType) = mention["actor_type"],
                  case let .string(actorId) = mention["actor_id"], !actorId.isEmpty else { continue }
            let name = author(actorType: actorType, actorId: actorId, members: members, agents: agents,
                              currentUserId: currentUserId, currentUserName: currentUserName, annotateSelf: false)
            if seen.insert(name).inserted { names.append(name) }
        }
        return names
    }

    static func timestamp(_ raw: String?, locale: Locale = .autoupdatingCurrent, timeZone: TimeZone = .autoupdatingCurrent) -> String {
        guard let raw, !raw.isEmpty else { return "" }
        guard let date = parseTimestamp(raw) else { return raw }
        let formatter = DateFormatter()
        formatter.locale = locale; formatter.timeZone = timeZone
        formatter.dateStyle = .medium; formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    static func parseTimestamp(_ raw: String) -> Date? {
        // PostgreSQL/PGlite returns a space separator and may shorten UTC to
        // +00. Normalize that representation before Foundation's ISO parser.
        var value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.count > 10 {
            let separator = value.index(value.startIndex, offsetBy: 10)
            if value[separator] == " " { value.replaceSubrange(separator...separator, with: "T") }
        }
        if value.contains("T") {
            if value.range(of: #"[+-]\d{2}$"#, options: .regularExpression) != nil { value += ":00" }
            else if let zone = value.range(of: #"[+-]\d{4}$"#, options: .regularExpression) {
                value.insert(":", at: value.index(zone.lowerBound, offsetBy: 3))
            }
        }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }
}
