import Foundation

/// A display-only projection of a coordinator message. The stored body remains
/// the exact instruction used by the provider and available in the disclosure.
struct PlanningInstruction: Equatable {
    let stepNumber: Int
    let originalText: String

    var title: String { "Planning instruction · Step \(stepNumber)" }
    var summary: String { "The agents use the goal and earlier replies to prepare a plan. You review a proposal before accepting it." }
}

extension Message {
    // Use the same whitespace set as JavaScript trim(), so malformed IDs do
    // not receive different presentations on the two clients.
    private static let planningIdentifierWhitespace = CharacterSet(charactersIn:
        "\u{0009}\u{000A}\u{000B}\u{000C}\u{000D}\u{0020}\u{00A0}\u{1680}" +
        "\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}" +
        "\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}")

    var planningInstruction: PlanningInstruction? {
        guard actorType == "system", actorId == "discussion-coordinator", kind == "text",
              let threadRootId, !threadRootId.trimmingCharacters(in: Self.planningIdentifierWhitespace).isEmpty,
              let payload, case .object = payload,
              case .string("discussion") = payload["intent"],
              case let .string(discussionId) = payload["discussion_id"],
              !discussionId.trimmingCharacters(in: Self.planningIdentifierWhitespace).isEmpty,
              case let .string(turnId) = payload["assistant_turn_id"],
              !turnId.trimmingCharacters(in: Self.planningIdentifierWhitespace).isEmpty,
              case let .number(step) = payload["discussion_step"], step.isFinite,
              step >= 0, step.rounded(.towardZero) == step,
              // Match Web's safe integer boundary, including the displayed +1.
              step < 9_007_199_254_740_991 else { return nil }
        return PlanningInstruction(stepNumber: Int(step) + 1, originalText: body)
    }
}
