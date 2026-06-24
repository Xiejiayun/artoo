import SwiftUI

/// Tasks board: status-grouped list of the project's tasks with a create flow.
public struct TasksView: View {
    @StateObject private var model: TasksViewModel
    private let client: ApiClientProtocol
    @State private var showingCreate = false
    @State private var searchText = ""
    @State private var selectedStatusRaw = "all"

    private let statusFilters: [TaskStatus] = [.backlog, .ready, .assigned, .running, .awaitingApproval, .blocked, .review, .done, .cancelled]

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
                        message: "Create the first task to kick off the create → ready → assign → review loop."
                    )
                } else {
                    List {
                        ForEach(columns, id: \.status) { column in
                            Section {
                                ForEach(column.tasks) { task in
                                    NavigationLink(value: task) {
                                        TaskRow(task: task)
                                    }
                                }
                            } header: {
                                HStack {
                                    Text(column.status.label)
                                    Spacer()
                                    Text("\(column.tasks.count)")
                                        .font(ArtooTokens.Typography.caption)
                                        .foregroundStyle(ArtooTokens.ColorToken.textMuted)
                                }
                            }
                        }
                    }
                    .listStyle(.insetGrouped)
                }
            }
            .navigationTitle("Tasks")
            .searchable(text: $searchText, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Search title, assignee, priority")
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
                }
            }
            .sheet(isPresented: $showingCreate) {
                CreateTaskView(model: model)
            }
            .refreshable { await model.load() }
            .task { await model.load() }
        }
    }

    private var statusFilterTitle: String {
        selectedStatusRaw == "all" ? "All" : TaskStatus(rawValue: selectedStatusRaw).label
    }

    private func clearFilters() {
        searchText = ""
        selectedStatusRaw = "all"
    }
}

private struct TaskRow: View {
    let task: TaskItem

    var body: some View {
        VStack(alignment: .leading, spacing: ArtooTokens.Spacing.xs) {
            HStack(alignment: .firstTextBaseline, spacing: ArtooTokens.Spacing.xs) {
                Text(task.title)
                    .font(ArtooTokens.Typography.subheadline.weight(.semibold))
                    .foregroundStyle(ArtooTokens.ColorToken.text)
                    .lineLimit(2)
                Spacer()
                StatusBadge(task.status)
            }
            HStack(spacing: ArtooTokens.Spacing.xs) {
                if let priority = task.priority {
                    PriorityBadge(priority)
                }
                if let assignee = task.assigneeId, !assignee.isEmpty {
                    Label(assignee, systemImage: "person.crop.circle")
                        .font(ArtooTokens.Typography.caption)
                        .foregroundStyle(ArtooTokens.ColorToken.textMuted)
                        .lineLimit(1)
                }
                if let updated = task.updatedAt ?? task.createdAt {
                    Label(updated, systemImage: "clock")
                        .font(ArtooTokens.Typography.caption)
                        .foregroundStyle(ArtooTokens.ColorToken.textMuted)
                        .lineLimit(1)
                }
            }
            if let description = task.description, !description.isEmpty {
                Text(description)
                    .font(ArtooTokens.Typography.caption)
                    .foregroundStyle(ArtooTokens.ColorToken.textMuted)
                    .lineLimit(2)
            }
        }
        .padding(.vertical, ArtooTokens.Spacing.xxs)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(task.title), \(task.status.label), \(task.priority?.uppercased() ?? "No priority")")
    }
}

public struct CreateTaskView: View {
    @ObservedObject var model: TasksViewModel
    @Environment(\.dismiss) private var dismiss

    @State private var title = ""
    @State private var description = ""
    @State private var priority = "p2"
    @State private var criteriaText = ""

    private let priorities = ["p0", "p1", "p2", "p3"]

    public var body: some View {
        NavigationStack {
            Form {
                Section("Task") {
                    TextField("Title", text: $title)
                    TextField("Description", text: $description, axis: .vertical)
                        .lineLimit(2...5)
                }
                Section("Priority") {
                    Picker("Priority", selection: $priority) {
                        ForEach(priorities, id: \.self) { Text($0.uppercased()).tag($0) }
                    }
                    .pickerStyle(.segmented)
                }
                Section("Acceptance criteria") {
                    TextField("One per line", text: $criteriaText, axis: .vertical)
                        .lineLimit(3...6)
                }
                if let error = model.state.errorMessage {
                    Section {
                        Text(error).foregroundStyle(.red).font(.callout)
                    }
                }
            }
            .navigationTitle("New Task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        Task {
                            let ok = await model.create(
                                title: title,
                                description: description,
                                priority: priority,
                                acceptanceCriteria: parsedCriteria
                            )
                            if ok { dismiss() }
                        }
                    }
                    .disabled(model.creating || title.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
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
