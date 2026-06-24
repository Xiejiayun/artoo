import SwiftUI

// MARK: - Production UI tokens
//
// Mirrors docs/production-ui-gate.md sections #61-#64 and
// docs/ui-system-spec.md sections 3-7 for the native iOS client.

public enum ArtooTokens {
    public enum ColorToken {
        public static let background = Color(uiColor: .systemGroupedBackground)
        public static let surface = Color(uiColor: .secondarySystemGroupedBackground)
        public static let surfaceRaised = Color(uiColor: .systemBackground)
        public static let border = Color(uiColor: .separator)

        public static let text = Color.primary
        public static let textMuted = Color.secondary
        public static let textSubtle = Color(uiColor: .tertiaryLabel)

        public static let accent = Color(hex: 0x4F46E5)
        public static let accentSoft = Color(hex: 0xEEF0FE)
        public static let success = Color(hex: 0x15803D)
        public static let successSoft = Color(hex: 0xE7F6EC)
        public static let warning = Color(hex: 0xB45309)
        public static let warningSoft = Color(hex: 0xFDF1E0)
        public static let danger = Color(hex: 0xB42318)
        public static let dangerSoft = Color(hex: 0xFDECEB)
        public static let info = Color(hex: 0x1D6FD1)
        public static let infoSoft = Color(hex: 0xE8F1FC)
        public static let neutral = Color(hex: 0x475467)
        public static let neutralSoft = Color(hex: 0xEEF1F4)
    }

    public enum Spacing {
        public static let xxs: CGFloat = 4
        public static let xs: CGFloat = 8
        public static let sm: CGFloat = 12
        public static let md: CGFloat = 16
        public static let lg: CGFloat = 24
        public static let xl: CGFloat = 32
    }

    public enum Typography {
        public static let title = Font.title3.weight(.semibold)
        public static let headline = Font.headline
        public static let body = Font.body
        public static let subheadline = Font.subheadline
        public static let caption = Font.caption
        public static let badge = Font.caption2.weight(.semibold)
    }

    public enum Radius {
        public static let sm: CGFloat = 6
        public static let md: CGFloat = 8
        public static let lg: CGFloat = 12
        public static let pill: CGFloat = 999
    }

    public enum Layout {
        public static let minTouchTarget: CGFloat = 44
    }
}

public struct ArtooSectionCard<Content: View>: View {
    private let content: Content

    public init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    public var body: some View {
        content
            .padding(ArtooTokens.Spacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(ArtooTokens.ColorToken.surfaceRaised, in: RoundedRectangle(cornerRadius: ArtooTokens.Radius.lg))
            .overlay(
                RoundedRectangle(cornerRadius: ArtooTokens.Radius.lg)
                    .stroke(ArtooTokens.ColorToken.border.opacity(0.45), lineWidth: 1)
            )
    }
}

public struct ArtooMetadataGrid: View {
    private let rows: [(String, String)]

    public init(_ rows: [(String, String?)]) {
        self.rows = rows.compactMap { label, value in
            guard let value, !value.isEmpty else { return nil }
            return (label, value)
        }
    }

    public var body: some View {
        VStack(spacing: ArtooTokens.Spacing.xs) {
            ForEach(Array(rows.enumerated()), id: \.offset) { item in
                HStack(alignment: .firstTextBaseline, spacing: ArtooTokens.Spacing.sm) {
                    Text(item.element.0)
                        .font(ArtooTokens.Typography.caption)
                        .foregroundStyle(ArtooTokens.ColorToken.textMuted)
                        .frame(width: 86, alignment: .leading)
                    Text(item.element.1)
                        .font(ArtooTokens.Typography.caption)
                        .foregroundStyle(ArtooTokens.ColorToken.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
            }
        }
        .accessibilityElement(children: .contain)
    }
}

// MARK: - Semantic badges

private struct SemanticBadgeStyle {
    let label: String
    let systemImage: String
    let foreground: Color
    let background: Color
}

public struct StatusBadge: View {
    public let status: TaskStatus
    public init(_ status: TaskStatus) { self.status = status }

    public var body: some View {
        ProductionBadge(style: status.badgeStyle, accessibilityPrefix: "Task status")
    }
}

public struct RunStatusBadge: View {
    public let status: RunStatus
    public init(_ status: RunStatus) { self.status = status }

    public var body: some View {
        ProductionBadge(style: status.badgeStyle, accessibilityPrefix: "Run status")
    }
}

public struct ApprovalStatusBadge: View {
    public let status: ApprovalStatus
    public init(_ status: ApprovalStatus) { self.status = status }

    public var body: some View {
        ProductionBadge(style: status.badgeStyle, accessibilityPrefix: "Approval status")
    }
}

public struct RiskBadge: View {
    public let risk: RiskLevel
    public init(_ risk: RiskLevel) { self.risk = risk }

    public var body: some View {
        ProductionBadge(style: risk.badgeStyle, accessibilityPrefix: "Risk")
    }
}

public struct PriorityBadge: View {
    public let priority: String
    public init(_ priority: String) { self.priority = priority }

    public var body: some View {
        ProductionBadge(style: priorityBadgeStyle(priority), accessibilityPrefix: "Priority")
    }
}

private struct ProductionBadge: View {
    let style: SemanticBadgeStyle
    let accessibilityPrefix: String

    var body: some View {
        Label(style.label, systemImage: style.systemImage)
            .font(ArtooTokens.Typography.badge)
            .lineLimit(1)
            .padding(.horizontal, ArtooTokens.Spacing.xs)
            .padding(.vertical, ArtooTokens.Spacing.xxs)
            .foregroundStyle(style.foreground)
            .background(style.background, in: Capsule())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(accessibilityPrefix) \(style.label)")
    }
}

// MARK: - Generic load-state container
//
// Renders idle/loading/failed uniformly and hands `.loaded` data to `content`.
// Loading and error states mirror the accepted gate's #63 state rules.

public struct StateView<Value: Equatable, Content: View>: View {
    public let state: ViewState<Value>
    public let retry: () -> Void
    public let content: (Value) -> Content

    public init(
        state: ViewState<Value>,
        retry: @escaping () -> Void,
        @ViewBuilder content: @escaping (Value) -> Content
    ) {
        self.state = state
        self.retry = retry
        self.content = content
    }

    public var body: some View {
        switch state {
        case .idle, .loading:
            LoadingStateView()
        case let .failed(message):
            ErrorStateView(message: message, retry: retry)
        case let .loaded(value):
            content(value)
        }
    }
}

public struct LoadingStateView: View {
    public init() {}

    public var body: some View {
        VStack(alignment: .leading, spacing: ArtooTokens.Spacing.sm) {
            ForEach(0..<5, id: \.self) { index in
                SkeletonRow(isPrimary: index == 0)
            }
        }
        .padding(ArtooTokens.Spacing.md)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(ArtooTokens.ColorToken.background)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading content")
    }
}

public struct EmptyStateView: View {
    public let systemImage: String
    public let title: String
    public let message: String
    public let actionTitle: String?
    public let action: (() -> Void)?

    public init(systemImage: String, title: String, message: String, actionTitle: String? = nil, action: (() -> Void)? = nil) {
        self.systemImage = systemImage
        self.title = title
        self.message = message
        self.actionTitle = actionTitle
        self.action = action
    }

    public var body: some View {
        VStack(spacing: ArtooTokens.Spacing.sm) {
            Image(systemName: systemImage)
                .font(.title2.weight(.semibold))
                .foregroundStyle(ArtooTokens.ColorToken.accent)
                .frame(width: ArtooTokens.Layout.minTouchTarget, height: ArtooTokens.Layout.minTouchTarget)
                .background(ArtooTokens.ColorToken.accentSoft, in: Circle())
                .accessibilityHidden(true)

            Text(title)
                .font(ArtooTokens.Typography.headline)
                .foregroundStyle(ArtooTokens.ColorToken.text)
                .multilineTextAlignment(.center)

            Text(message)
                .font(ArtooTokens.Typography.subheadline)
                .foregroundStyle(ArtooTokens.ColorToken.textMuted)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(.borderedProminent)
                    .controlSize(.regular)
                    .padding(.top, ArtooTokens.Spacing.xxs)
                    .accessibilityHint("Starts the recommended recovery action")
            }
        }
        .padding(ArtooTokens.Spacing.lg)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

public struct ErrorStateView: View {
    public let message: String
    public let retry: () -> Void

    public init(message: String, retry: @escaping () -> Void) {
        self.message = message
        self.retry = retry
    }

    public var body: some View {
        EmptyStateView(
            systemImage: "exclamationmark.triangle.fill",
            title: "Could not load this view",
            message: message,
            actionTitle: "Retry",
            action: retry
        )
        .accessibilityElement(children: .contain)
    }
}

public struct OfflineNoticeView: View {
    public let queuedCount: Int?
    public init(queuedCount: Int? = nil) { self.queuedCount = queuedCount }

    public var body: some View {
        HStack(alignment: .top, spacing: ArtooTokens.Spacing.xs) {
            Image(systemName: "wifi.slash")
                .foregroundStyle(ArtooTokens.ColorToken.warning)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: ArtooTokens.Spacing.xxs) {
                Text("Offline or reconnecting")
                    .font(ArtooTokens.Typography.subheadline.weight(.semibold))
                Text(message)
                    .font(ArtooTokens.Typography.caption)
                    .foregroundStyle(ArtooTokens.ColorToken.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(ArtooTokens.Spacing.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ArtooTokens.ColorToken.warningSoft, in: RoundedRectangle(cornerRadius: ArtooTokens.Radius.md))
        .foregroundStyle(ArtooTokens.ColorToken.warning)
        .accessibilityElement(children: .combine)
    }

    private var message: String {
        if let queuedCount, queuedCount > 0 {
            return "\(queuedCount) command\(queuedCount == 1 ? "" : "s") will replay when the server reconnects."
        }
        return "Changes may be delayed until the server connection is restored."
    }
}

private struct SkeletonRow: View {
    let isPrimary: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: ArtooTokens.Spacing.xs) {
            RoundedRectangle(cornerRadius: ArtooTokens.Radius.sm)
                .fill(ArtooTokens.ColorToken.neutralSoft)
                .frame(height: isPrimary ? 18 : 14)
                .frame(maxWidth: isPrimary ? .infinity : 260, alignment: .leading)
            RoundedRectangle(cornerRadius: ArtooTokens.Radius.sm)
                .fill(ArtooTokens.ColorToken.neutralSoft.opacity(0.75))
                .frame(width: isPrimary ? 220 : 160, height: 12)
        }
        .padding(ArtooTokens.Spacing.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(ArtooTokens.ColorToken.surfaceRaised, in: RoundedRectangle(cornerRadius: ArtooTokens.Radius.lg))
    }
}

// MARK: - Semantic mappings

private extension TaskStatus {
    var badgeStyle: SemanticBadgeStyle {
        switch self {
        case .backlog:
            return .neutral(label, "circle")
        case .ready:
            return .info(label, "checkmark.circle")
        case .assigned:
            return .neutral(label, "person.crop.circle")
        case .running, .inProgress:
            return .info(label, "play.circle")
        case .awaitingApproval:
            return .warning(label, "hand.raised")
        case .blocked:
            return .danger(label, "exclamationmark.octagon")
        case .review:
            return .warning(label, "magnifyingglass.circle")
        case .done:
            return .success(label, "checkmark.seal")
        case .cancelled:
            return .danger(label, "xmark.circle")
        case .other:
            return .neutral(label, "questionmark.circle")
        }
    }
}

private extension RunStatus {
    var badgeStyle: SemanticBadgeStyle {
        switch self {
        case .queued:
            return .neutral(label, "clock")
        case .starting:
            return .info(label, "arrow.triangle.2.circlepath")
        case .running:
            return .info(label, "play.circle")
        case .awaitingInput, .paused:
            return .warning(label, "pause.circle")
        case .completed:
            return .success(label, "checkmark.seal")
        case .failed:
            return .danger(label, "exclamationmark.octagon")
        case .cancelled:
            return .danger(label, "xmark.circle")
        case .other:
            return .neutral(label, "questionmark.circle")
        }
    }
}

private extension ApprovalStatus {
    var badgeStyle: SemanticBadgeStyle {
        switch self {
        case .pending:
            return .warning(label, "clock.badge.exclamationmark")
        case .approved:
            return .success(label, "checkmark.seal")
        case .rejected:
            return .danger(label, "xmark.octagon")
        case .needsMoreInfo:
            return .warning(label, "questionmark.circle")
        case .expired:
            return .neutral(label, "clock.badge.xmark")
        case .other:
            return .neutral(label, "questionmark.circle")
        }
    }
}

private extension RiskLevel {
    var badgeStyle: SemanticBadgeStyle {
        switch self {
        case .low:
            return .neutral(label, "shield")
        case .medium:
            return .warning(label, "shield.lefthalf.filled")
        case .high:
            return .danger(label, "exclamationmark.shield")
        case .other:
            return .neutral(label, "shield")
        }
    }
}

private func priorityBadgeStyle(_ priority: String) -> SemanticBadgeStyle {
    switch priority.lowercased() {
    case "p0":
        return .danger("P0", "flame")
    case "p1":
        return .warning("P1", "flag")
    case "p2":
        return .accent("P2", "flag")
    case "p3":
        return .neutral("P3", "flag")
    default:
        return .neutral(priority.uppercased(), "flag")
    }
}

private extension SemanticBadgeStyle {
    static func accent(_ label: String, _ systemImage: String) -> SemanticBadgeStyle {
        SemanticBadgeStyle(label: label, systemImage: systemImage, foreground: ArtooTokens.ColorToken.accent, background: ArtooTokens.ColorToken.accentSoft)
    }

    static func success(_ label: String, _ systemImage: String) -> SemanticBadgeStyle {
        SemanticBadgeStyle(label: label, systemImage: systemImage, foreground: ArtooTokens.ColorToken.success, background: ArtooTokens.ColorToken.successSoft)
    }

    static func warning(_ label: String, _ systemImage: String) -> SemanticBadgeStyle {
        SemanticBadgeStyle(label: label, systemImage: systemImage, foreground: ArtooTokens.ColorToken.warning, background: ArtooTokens.ColorToken.warningSoft)
    }

    static func danger(_ label: String, _ systemImage: String) -> SemanticBadgeStyle {
        SemanticBadgeStyle(label: label, systemImage: systemImage, foreground: ArtooTokens.ColorToken.danger, background: ArtooTokens.ColorToken.dangerSoft)
    }

    static func info(_ label: String, _ systemImage: String) -> SemanticBadgeStyle {
        SemanticBadgeStyle(label: label, systemImage: systemImage, foreground: ArtooTokens.ColorToken.info, background: ArtooTokens.ColorToken.infoSoft)
    }

    static func neutral(_ label: String, _ systemImage: String) -> SemanticBadgeStyle {
        SemanticBadgeStyle(label: label, systemImage: systemImage, foreground: ArtooTokens.ColorToken.neutral, background: ArtooTokens.ColorToken.neutralSoft)
    }
}

private extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255.0,
            green: Double((hex >> 8) & 0xFF) / 255.0,
            blue: Double(hex & 0xFF) / 255.0,
            opacity: 1
        )
    }
}
