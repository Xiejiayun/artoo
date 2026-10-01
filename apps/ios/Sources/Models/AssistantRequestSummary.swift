import Foundation

/// Identifies a turn's request without changing its message or lifecycle.
struct AssistantRequestSummary: Equatable {
    let text: String
    let originalText: String?
    let isUnavailable: Bool

    init(userMessageId: String, roomId: String, threadRootId: String?, messages: [Message]) {
        let matches = messages.filter { $0.id == userMessageId && $0.roomId == roomId && $0.threadRootId == threadRootId }
        guard matches.count == 1, let message = matches.first else {
            text = "Request message unavailable"; originalText = nil; isUnavailable = true
            return
        }
        isUnavailable = false
        if let instruction = message.planningInstruction {
            // The actual message already offers its original instructions.
            // Request controls must not repeat that long internal prompt.
            text = instruction.title; originalText = nil
            return
        }
        let compact = message.body.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        let shortened = compact.count > 180
        text = compact.isEmpty ? "Empty request" : shortened ? String(compact.prefix(180)) + "…" : compact
        originalText = shortened || compact != message.body ? message.body : nil
    }
}
