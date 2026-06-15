import SwiftUI

// MARK: - Status & risk badges

public struct StatusBadge: View {
    public let status: TaskStatus
    public init(_ status: TaskStatus) { self.status = status }

    public var body: some View {
        Text(status.label)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.18), in: Capsule())
            .foregroundStyle(color)
            .accessibilityLabel("Status \(status.label)")
    }

    private var color: Color {
        switch status {
        case .backlog: return .gray
        case .ready: return .blue
        case .assigned, .running, .inProgress: return .indigo
        case .awaitingApproval: return .purple
        case .blocked: return .red
        case .review: return .orange
        case .done: return .teal
        case .cancelled: return .secondary
        case .other: return .gray
        }
    }
}

public struct RunStatusBadge: View {
    public let status: RunStatus
    public init(_ status: RunStatus) { self.status = status }

    public var body: some View {
        Text(status.label)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.18), in: Capsule())
            .foregroundStyle(color)
    }

    private var color: Color {
        switch status {
        case .queued, .starting: return .gray
        case .running: return .blue
        case .completed: return .green
        case .failed: return .red
        case .cancelled: return .secondary
        case .other: return .gray
        }
    }
}

public struct RiskBadge: View {
    public let risk: RiskLevel
    public init(_ risk: RiskLevel) { self.risk = risk }

    public var body: some View {
        Text(risk.label)
            .font(.caption2.weight(.bold))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.18), in: Capsule())
            .foregroundStyle(color)
            .accessibilityLabel("Risk \(risk.label)")
    }

    private var color: Color {
        switch risk {
        case .low: return .green
        case .medium: return .orange
        case .high: return .red
        case .other: return .gray
        }
    }
}

// MARK: - Generic load-state container
//
// Renders idle/loading/failed uniformly and hands `.loaded` data to `content`.
// Keeps every screen free of repetitive switch statements.

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
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case let .failed(message):
            VStack(spacing: 12) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.largeTitle)
                    .foregroundStyle(.orange)
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Button("Retry", action: retry)
                    .buttonStyle(.borderedProminent)
            }
            .padding()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case let .loaded(value):
            content(value)
        }
    }
}

// MARK: - Empty state

public struct EmptyStateView: View {
    public let systemImage: String
    public let title: String
    public let message: String

    public init(systemImage: String, title: String, message: String) {
        self.systemImage = systemImage
        self.title = title
        self.message = message
    }

    public var body: some View {
        VStack(spacing: 10) {
            Image(systemName: systemImage)
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text(title).font(.headline)
            Text(message)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
