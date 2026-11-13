import Foundation
import Combine

@MainActor
public final class NotificationInboxViewModel: ObservableObject {
    @Published public private(set) var notifications: [WorkspaceRecord] = []
    @Published public private(set) var unreadCount: Int?
    @Published public private(set) var hasMore = false
    @Published public private(set) var loading = false
    @Published public private(set) var error: String?
    public let client: ApiClientProtocol
    private var before: String?
    private var loadedPages = 1
    private var refreshPending = false

    public init(client: ApiClientProtocol) { self.client = client }

    public func refresh() async {
        guard !loading else { refreshPending = true; return }
        loading = true
        do {
            var page = try await fetch()
            var records = page.notifications.compactMap(WorkspaceRecord.init)
            var pagesRead = 1
            // Refresh the loaded window, including old rows marked read on
            // another device. New bursts may move older rows outside this
            // window; the tail cursor still makes all of them reachable.
            while pagesRead < loadedPages, page.hasMore, let cursor = page.nextBefore {
                page = try await fetch(before: cursor)
                records += page.notifications.compactMap(WorkspaceRecord.init)
                pagesRead += 1
            }
            notifications = []; loadedPages = pagesRead
            before = page.nextBefore; hasMore = page.hasMore
            merge(records); unreadCount = page.unreadCount; error = nil
        } catch { self.error = String(describing: error) }
        loading = false
        if refreshPending { refreshPending = false; await refresh() }
    }

    public func loadEarlier() async {
        guard !loading, hasMore, let before else { return }
        loading = true
        do {
            let page = try await fetch(before: before)
            merge(page.notifications.compactMap(WorkspaceRecord.init)); self.before = page.nextBefore; hasMore = page.hasMore
            loadedPages += 1
            unreadCount = page.unreadCount; error = nil
        } catch { self.error = String(describing: error) }
        loading = false
        if refreshPending { refreshPending = false; await refresh() }
    }

    public func recordRead(_ notification: WorkspaceRecord, unreadCount: Int) {
        merge([notification]); self.unreadCount = unreadCount
    }

    private func fetch(before: String? = nil) async throws -> NativeNotificationPage {
        try await client.notificationPage(before: before, limit: 50)
    }

    private func merge(_ records: [WorkspaceRecord]) {
        var rows = Dictionary(uniqueKeysWithValues: notifications.map { ($0.id, $0) })
        for record in records { rows[record.id] = record }
        notifications = rows.values.sorted {
            if $0["created_at"].text != $1["created_at"].text { return $0["created_at"].text > $1["created_at"].text }
            return $0.id > $1.id
        }
    }
}
