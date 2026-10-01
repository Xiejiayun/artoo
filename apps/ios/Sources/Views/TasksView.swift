import SwiftUI

/// Tasks board: status-grouped list of the project's tasks with a create flow.
public struct TasksView: View {
    @StateObject private var model: TasksViewModel
    private let client: ApiClientProtocol
    @State private var showingCreate = false
    @State private var searchText = ""
    @State private var selectedStatusRaw = "all"
    @State private var directory: JSONValue = .null

    private let statusFilters: [TaskStatus] = [.backlog, .ready, .assigned, .running, .inProgress, .awaitingApproval, .blocked, .review, .done, .cancelled]

    public init(client: ApiClientProtocol, projectId: String) {
        self.client = client
        _model = StateObject(wrappedValue: TasksViewModel(client: client, projectId: projectId))
    }

    public var body: some View {
        NavigationStack {
            StateView(state: model.state, retry: { Task { await model.load() } }) { _ in
                let columns = model.columns(searchText: searchText, statusRaw: selectedStatusRaw == "all" ? nil : selectedStatusRaw)
                let hasFilters = !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || selectedStatusRaw != "all"
                if columns.isEmpty && hasFilters {
                    EmptyStateView(
                        systemImage: "line.3.horizontal.decrease.circle",
                        title: "No matching tasks",
                        message: "Adjust search or status filters to widen the task list.",
                        actionTitle: "Clear Filters",
                        action: clearFilters
                    )
                } else if columns.isEmpty {
                    EmptyStateView(
                        systemImage: "tray",
                        title: "No tasks yet",
                        message: "Give your team a clear outcome, define what done means, then assign the right agent.",
                        actionTitle: "Create a task", action: { showingCreate = true }
                    )
                } else {
                    List {
                        ForEach(columns, id: \.status) { column in
                            Section {
                                ForEach(column.tasks) { task in
                                    NavigationLink(value: task) {
                                        TaskRow(task: task, assigneeName: assigneeName(task))
                                    }
                                    .accessibilityIdentifier("task.row.\(task.id)")
                                }
                            } header: {
                                ArtooSectionHeading(title: column.status.label, count: column.tasks.count)
                            }
                        }
                    }
                    .listStyle(.insetGrouped)
                }
            }
            .navigationTitle("Tasks")
            .searchable(text: $searchText, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Search title, description, priority")
            .safeAreaInset(edge: .top, spacing: 0) { quickFilters }
            .navigationDestination(for: TaskItem.self) { task in
                TaskDetailView(client: client, taskId: task.id)
            }
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Menu {
                        Button("All statuses") { selectedStatusRaw = "all" }
                        ForEach(statusFilters, id: \.rawValue) { status in
                            Button(status.label) { selectedStatusRaw = status.rawValue }
                        }
                    } label: {
                        Label(statusFilterTitle, systemImage: "line.3.horizontal.decrease.circle")
                    }
                    .accessibilityLabel("Filter tasks by status")
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        showingCreate = true
                    } label: {
                        Label("New Task", systemImage: "plus")
                    }
                    .accessibilityIdentifier("task.create.open")
                }
            }
            .sheet(isPresented: $showingCreate) {
                CreateTaskView(model: model)
            }
            .refreshable { await model.load() }
            .liveRefresh { await model.load() }
            .task { await loadDirectory() }
        }
    }

    private var statusFilterTitle: String {
        selectedStatusRaw == "all" ? "All" : TaskStatus(rawValue: selectedStatusRaw).label
    }

    private var quickFilters: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                filterPill("All tasks", raw: "all", count: model.state.value?.count ?? 0)
                ForEach([TaskStatus.ready, .review, .blocked], id: \.rawValue) { status in
                    filterPill(status.label, raw: status.rawValue, count: model.state.value?.filter { $0.status == status }.count ?? 0)
                }
            }.padding(.horizontal, 16).padding(.vertical, 8)
        }
        .background(ArtooTokens.ColorToken.background)
    }

    private func filterPill(_ title: String, raw: String, count: Int) -> some View {
        Button { selectedStatusRaw = raw } label: {
            HStack(spacing: 6) {
                Text(title).font(.subheadline.weight(.medium))
                Text(count, format: .number).font(.caption.weight(.semibold)).monospacedDigit()
            }
            .padding(.horizontal, 14).frame(minHeight: 44)
            .foregroundStyle(selectedStatusRaw == raw ? ArtooTokens.ColorToken.accent : ArtooTokens.ColorToken.textMuted)
            .background(selectedStatusRaw == raw ? ArtooTokens.ColorToken.accentSoft : ArtooTokens.ColorToken.surfaceRaised, in: Capsule())
        }.buttonStyle(.plain).accessibilityValue(selectedStatusRaw == raw ? "Selected" : "")
    }

    private func assigneeName(_ task: TaskItem) -> String? {
        guard let id = task.assigneeId, !id.isEmpty else { return nil }
        if task.assigneeType == "agent" {
            return ConversationMetadata.agentName(id, agents: directory["agents"].records, instances: directory["agent_instances"].records)
        }
        return id
    }

    private func loadDirectory() async {
        do { directory = try await client.resource(path: "/api/v1/bootstrap") }
        catch { /* Task loading remains available; unresolved assignees keep their actual IDs. */ }
    }

    private func clearFilters() {
        searchText = ""
        selectedStatusRaw = "all"
    }
}

private struct TaskRow: View {
    let task: TaskItem
    let assigneeName: String?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: task.status == .done ? "checkmark.circle.fill" : "circle")
                .font(.title3).foregroundStyle(task.status == .done ? ArtooTokens.ColorToken.success : ArtooTokens.ColorToken.textSubtle)
                .padding(.top, 2).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: ArtooTokens.Spacing.xs) {
                Text(task.title)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(ArtooTokens.ColorToken.text)
                    .lineLimit(2)
                if let description = task.description, !description.isEmpty {
                    Text(description).font(.subheadline).foregroundStyle(ArtooTokens.ColorToken.textMuted).lineLimit(2)
                }
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) { taskMetadata }
                    VStack(alignment: .leading, spacing: 6) { taskMetadata }
                }
                if let raw = task.updatedAt ?? task.createdAt, let date = ConversationMetadata.parseTimestamp(raw) {
                    Text("Updated \(date.formatted(.dateTime.month(.abbreviated).day()))")
                        .font(.caption).foregroundStyle(ArtooTokens.ColorToken.textMuted)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(task.title), \(task.status.label), \(task.priority?.uppercased() ?? "No priority"), \(assigneeName ?? "Unassigned")")
    }

    @ViewBuilder private var taskMetadata: some View {
        if let priority = task.priority { PriorityBadge(priority) }
        Label(assigneeName ?? "Unassigned", systemImage: assigneeName == nil ? "person.crop.circle.badge.plus" : "person.crop.circle")
            .font(.caption).foregroundStyle(ArtooTokens.ColorToken.textMuted).lineLimit(1)
    }
}

public struct CreateTaskView: View {
    @ObservedObject var model: TasksViewModel
    @Environment(\.dismiss) private var dismiss

    @State private var title = ""
    @State private var description = ""
    @State private var priority = "p2"
    @State private var criteriaText = ""
    @State private var capabilities = "code.modify"
    @FocusState private var focusedField: Field?

    private enum Field: Hashable { case title, description, criteria, capabilities }

    private let priorities = ["p0", "p1", "p2", "p3"]

    public var body: some View {
        NavigationStack {
            Form {
                Section {
                    ArtooPageIntro(title: "Make the next step clear", message: "Describe an outcome and what you will review when the work is done.", systemImage: "checklist")
                }
                Section("Task") {
                    TextField("Title", text: $title)
                        .focused($focusedField, equals: .title)
                        .accessibilityIdentifier("task.create.title")
                    TextField("Description", text: $description, axis: .vertical)
                        .lineLimit(2...5)
                        .focused($focusedField, equals: .description)
                }
                Section {
                    Picker("Priority", selection: $priority) {
                        ForEach(priorities, id: \.self) { Text($0.uppercased()).tag($0) }
                    }
                    .pickerStyle(.segmented)
                } header: { Text("Priority") } footer: { Text("P0 urgent · P1 high · P2 normal · P3 low") }
                Section("Acceptance criteria") {
                    TextField("What needs to be true when this is done? One item per line.", text: $criteriaText, axis: .vertical)
                        .lineLimit(3...6)
                        .focused($focusedField, equals: .criteria)
                        .accessibilityIdentifier("task.create.criteria")
                }
                Section("Required capabilities") {
                    TextField("Comma separated", text: $capabilities)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focusedField, equals: .capabilities)
                        .accessibilityIdentifier("task.create.capabilities")
                }
                if let error = model.state.errorMessage {
                    Section {
                        Text(error).foregroundStyle(.red).font(.callout)
                    }
                }
                if model.creating { ProgressView("Creating task…") }
            }
            .disabled(model.creating)
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("New Task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { focusedField = nil }
                        .accessibilityIdentifier("task.create.keyboard.done")
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(model.creating)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        Task {
                            let ok = await model.create(
                                title: title,
                                description: description,
                                priority: priority,
                                acceptanceCriteria: parsedCriteria,
                                requiredCapabilities: capabilities.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
                            )
                            if ok { dismiss() }
                        }
                    }
                    .disabled(model.creating || title.trimmingCharacters(in: .whitespaces).isEmpty)
                    .accessibilityIdentifier("task.create.submit")
                }
            }
        }
        .interactiveDismissDisabled(model.creating)
    }

    private var parsedCriteria: [String] {
        criteriaText
            .split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }
}

#if DEBUG
struct TasksView_Previews: PreviewProvider {
    static var previews: some View {
        TasksView(client: MockApiClient.demo(), projectId: "proj_artoo")
    }
}
#endif
