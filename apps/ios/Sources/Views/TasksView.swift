import SwiftUI

/// Tasks board: status-grouped list of the project's tasks with a create flow.
public struct TasksView: View {
    @StateObject private var model: TasksViewModel
    private let client: ApiClientProtocol
    @State private var showingCreate = false

    public init(client: ApiClientProtocol, projectId: String) {
        self.client = client
        _model = StateObject(wrappedValue: TasksViewModel(client: client, projectId: projectId))
    }

    public var body: some View {
        NavigationStack {
            StateView(state: model.state, retry: { Task { await model.load() } }) { _ in
                let columns = model.columns
                if columns.isEmpty {
                    EmptyStateView(
                        systemImage: "tray",
                        title: "No tasks yet",
                        message: "Create the first task to kick off the create → ready → assign → review loop."
                    )
                } else {
                    List {
                        ForEach(columns, id: \.status) { column in
                            Section(column.status.label) {
                                ForEach(column.tasks) { task in
                                    NavigationLink(value: task) {
                                        TaskRow(task: task)
                                    }
                                }
                            }
                        }
                    }
                    .listStyle(.insetGrouped)
                }
            }
            .navigationTitle("Tasks")
            .navigationDestination(for: TaskItem.self) { task in
                TaskDetailView(client: client, taskId: task.id)
            }
            .toolbar {
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
}

private struct TaskRow: View {
    let task: TaskItem

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(task.title)
                    .font(.subheadline.weight(.semibold))
                Spacer()
                StatusBadge(task.status)
            }
            HStack(spacing: 8) {
                if let priority = task.priority {
                    Text(priority.uppercased())
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.secondary)
                }
                if let description = task.description, !description.isEmpty {
                    Text(description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .padding(.vertical, 4)
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
