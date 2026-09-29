import Foundation

enum ConversationMetadata {
    static func author(actorType: String, actorId: String, members: [WorkspaceRecord], agents: [WorkspaceRecord], agentInstances: [WorkspaceRecord] = [],
                       currentUserId: String?, currentUserName: String?, annotateSelf: Bool = true) -> String {
        if actorType == "system" { return "Artoo" }
        if actorType == "agent" { return agentName(actorId, agents: agents, instances: agentInstances) }
        let recordedName = actorType == "user" ? displayName(members.first { $0.id == actorId }) : nil
        let isCurrentUser = actorType == "user" && actorId == currentUserId
        let ownName = isCurrentUser ? currentUserName?.trimmingCharacters(in: .whitespacesAndNewlines) : nil
        let name = [ownName, recordedName].compactMap { $0 }.first { !$0.isEmpty }
            ?? "\(actorType):\(actorId)"
        return isCurrentUser && annotateSelf ? "\(name) (you)" : name
    }

    static func agentName(_ actorId: String, agents: [WorkspaceRecord], instances: [WorkspaceRecord]) -> String {
        // Runtime replies carry an agent-instance ID; older records may carry
        // an agent ID. Resolve only within agent directories, never members.
        if let instance = instances.first(where: { $0.id == actorId }) {
            return displayName(instance) ?? displayName(agents.first { $0.id == instance["agent_id"].text }) ?? "agent:\(actorId)"
        }
        return displayName(agents.first { $0.id == actorId }) ?? "agent:\(actorId)"
    }

    private static func displayName(_ record: WorkspaceRecord?) -> String? {
        guard let value = record?["display_name"].text.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return value
    }

    static func mentionNames(_ payload: JSONValue?, members: [WorkspaceRecord], agents: [WorkspaceRecord], agentInstances: [WorkspaceRecord] = [],
                             currentUserId: String?, currentUserName: String?) -> [String] {
        var names: [String] = [], seen = Set<String>()
        for mention in payload?["mentions"].array ?? [] {
            guard case let .string(actorType) = mention["actor_type"],
                  case let .string(actorId) = mention["actor_id"], !actorId.isEmpty else { continue }
            let name = author(actorType: actorType, actorId: actorId, members: members, agents: agents, agentInstances: agentInstances,
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
