import Foundation
import Combine

public func apiPart(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? value
}

public enum WorkspaceKind: String, CaseIterable {
    case goals, memories, skills
    public var title: String { self == .memories ? "Memory" : rawValue.capitalized }
}

@MainActor
public final class WorkspaceViewModel: ObservableObject {
    @Published public private(set) var state: ViewState<JSONValue> = .idle
    @Published public private(set) var actionError: String?
    @Published public private(set) var busy = false
    private var loading = false
    public let client: ApiClientProtocol
    public let path: String
    public init(client: ApiClientProtocol, path: String) { self.client = client; self.path = path }
    public func load() async {
        guard !loading else { return }; loading = true
        defer { loading = false }
        if state.value == nil { state = .loading }
        do { state = .loaded(try await client.resource(path: path)) }
        catch { if state.value == nil { state = .failed(String(describing: error)) } else { actionError = String(describing: error) } }
    }
    @discardableResult
    public func perform(path: String, method: String = "POST", body: JSONValue = .object([:])) async -> Bool {
        guard !busy else { return false }; busy = true; actionError = nil
        defer { busy = false }
        do { _ = try await client.command(path: path, method: method, body: body); await load(); return true }
        catch { actionError = String(describing: error); return false }
    }
}

public struct PlanTaskDraft: Identifiable, Equatable {
    public let id = UUID()
    public var title = ""
    public var criteria = ""
    public var capabilities = "code.modify"
    public var afterPrevious = false
    public init() {}
    public func spec(index: Int) -> JSONValue {
        .object([
            "title": .string(title.trimmingCharacters(in: .whitespacesAndNewlines)),
            "acceptance_criteria": .strings(nonemptyLines(criteria)),
            "required_capabilities": .strings(capabilities.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }),
            "dependencies": .array(afterPrevious && index > 0 ? [.object(["ref": .string(String(index - 1)), "type": .string("blocks")])] : [])
        ])
    }
    public var valid: Bool { !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !nonemptyLines(criteria).isEmpty }
}

public struct ExecutionApprovalDraft: Equatable {
    public var summary = ""
    public var risk = "medium"
    public init() {}
    public var trimmedSummary: String { summary.trimmingCharacters(in: .whitespacesAndNewlines) }
    public var valid: Bool { !trimmedSummary.isEmpty && trimmedSummary.utf16.count <= 4000 && ["low", "medium", "high"].contains(risk) }
    public var body: JSONValue { .object(["summary": .string(trimmedSummary), "risk": .string(risk)]) }
}

public func nonemptyLines(_ value: String) -> [String] {
    value.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
}
