import XCTest
@testable import Artoo

@MainActor
final class MentionProjectRecoveryTests: XCTestCase {
    func testOlderWorkspaceSuccessOrFailureCannotUndoNewMentionRecovery() async throws {
        for fails in [false, true] {
            let (container, client) = await harness()
            let older = DeferredProjectResponse<Bootstrap>()
            client.bootstrapHandler = { try await older.response() }
            let refresh = Task { await container.loadBootstrap() }
            await fulfillment(of: [older.started], timeout: 2)
            client.bootstrapHandler = { self.bootstrap(["a", "b"]) }
            let notification = try record()
            client.readHandler = { _ in self.receipt(notification) }
            let model = container.makeMentionDestinationModel(client: client, session: container.sessionGeneration)
            await model.load(notification) { _, _ in }
            XCTAssertEqual(container.selectedProjectId, "b"); XCTAssertTrue(model.projectResolved)
            if fails { older.fail(URLError(.notConnectedToInternet)) } else { older.resolve(bootstrap(["a"])) }
            await refresh.value
            XCTAssertEqual(container.bootstrap.value?.projects.map(\.id), ["a", "b"], "An older workspace response cannot replace successful mention discovery")
            XCTAssertEqual(container.selectedProjectId, "b", "An older workspace response cannot move a visible B composer back to A")
            XCTAssertEqual(model.root?.id, "root"); XCTAssertTrue(model.readConfirmed)
        }
    }

    func testCachedMentionSelectionFencesOlderWorkspaceSuccessAndFailure() async throws {
        for alreadySelected in [false, true] {
            for fails in [false, true] {
                let (container, client) = await harness(projects: ["a", "b"])
                if alreadySelected { container.selectedProjectId = "b" }
                let older = DeferredProjectResponse<Bootstrap>()
                client.bootstrapHandler = { try await older.response() }
                let refresh = Task { await container.loadBootstrap() }
                await fulfillment(of: [older.started], timeout: 2)
                let notification = try record()
                client.readHandler = { _ in self.receipt(notification) }
                let model = container.makeMentionDestinationModel(client: client, session: container.sessionGeneration)
                await model.load(notification) { _, _ in }
                XCTAssertEqual(client.bootstrapRequests, 2, "A cached mention must not need its own network refresh")
                if fails { older.fail(URLError(.timedOut)) } else { older.resolve(bootstrap(["a"])) }
                await refresh.value
                XCTAssertEqual(container.bootstrap.value?.projects.map(\.id), ["a", "b"])
                XCTAssertEqual(container.selectedProjectId, "b", "Selecting even the already-selected cached project is newer than the pending workspace response")
                XCTAssertTrue(model.projectResolved); XCTAssertTrue(model.readConfirmed)
            }
        }
    }

    func testOlderGenericRefreshCannotReplaceNewerSuccessOrAcceptedFailure() async {
        for newerFails in [false, true] {
            let (container, client) = await harness()
            let older = DeferredProjectResponse<Bootstrap>()
            client.bootstrapHandler = { try await older.response() }
            let first = Task { await container.loadBootstrap() }
            await fulfillment(of: [older.started], timeout: 2)
            client.bootstrapHandler = {
                if newerFails { throw URLError(.timedOut) }
                return self.bootstrap(["a", "c"])
            }
            await container.loadBootstrap()
            let accepted = container.bootstrap
            if newerFails { older.resolve(bootstrap(["a", "b"])) }
            else { older.fail(URLError(.notConnectedToInternet)) }
            await first.value
            XCTAssertEqual(container.bootstrap, accepted, "An accepted newer failure also prevents an older success from restoring stale data")
            XCTAssertEqual(container.selectedProjectId, "a")
        }
    }

    func testCancelledGenericRefreshDoesNotPublishSuccessOrFailure() async {
        for fails in [false, true] {
            let (container, client) = await harness()
            let pending = DeferredProjectResponse<Bootstrap>()
            client.bootstrapHandler = { try await pending.response() }
            let refresh = Task { await container.loadBootstrap() }
            await fulfillment(of: [pending.started], timeout: 2)
            refresh.cancel()
            if fails { pending.fail(URLError(.cancelled)) } else { pending.resolve(bootstrap(["c"])) }
            await refresh.value
            XCTAssertEqual(container.bootstrap.value?.projects.map(\.id), ["a"])
            XCTAssertEqual(container.selectedProjectId, "a")
        }
    }

    func testOldSessionGenericRefreshCannotRestoreWorkspaceAfterLogout() async {
        for fails in [false, true] {
            let (container, client) = await harness()
            let pending = DeferredProjectResponse<Bootstrap>()
            client.bootstrapHandler = { try await pending.response() }
            let refresh = Task { await container.loadBootstrap() }
            await fulfillment(of: [pending.started], timeout: 2)
            await container.logout()
            if fails { pending.fail(URLError(.networkConnectionLost)) } else { pending.resolve(bootstrap(["c"])) }
            await refresh.value
            XCTAssertEqual(container.bootstrap, .idle); XCTAssertEqual(container.selectedProjectId, "")
            XCTAssertFalse(container.isAuthenticated)
        }
    }

    func testCancellingNewerMentionDoesNotDiscardAnOlderUsefulWorkspaceRefresh() async throws {
        let (container, client) = await harness()
        let workspace = DeferredProjectResponse<Bootstrap>(), mention = DeferredProjectResponse<Bootstrap>()
        client.bootstrapHandler = { try await workspace.response() }
        let refresh = Task { await container.loadBootstrap() }
        await fulfillment(of: [workspace.started], timeout: 2)
        client.bootstrapHandler = { try await mention.response() }
        let model = container.makeMentionDestinationModel(client: client, session: container.sessionGeneration)
        let opening = Task { await model.load(try record()) { _, _ in XCTFail("Cancelled mention") } }
        await fulfillment(of: [mention.started], timeout: 2)
        model.cancel()
        workspace.resolve(bootstrap(["a", "c"])); await refresh.value
        mention.resolve(bootstrap(["a", "b"])); try await opening.value
        XCTAssertEqual(container.bootstrap.value?.projects.map(\.id), ["a", "c"])
        XCTAssertEqual(container.selectedProjectId, "a"); XCTAssertNil(model.root); XCTAssertFalse(model.projectResolved)
        XCTAssertNil(model.loadError); XCTAssertTrue(client.fetches.isEmpty); XCTAssertTrue(client.reads.isEmpty)
    }

    func testCancelledMentionDoesNotDiscardNewerWorkspaceRefreshOrApplyLateErrors() async throws {
        for mentionFails in [false, true] {
            let (container, client) = await harness()
            let mention = DeferredProjectResponse<Bootstrap>(), workspace = DeferredProjectResponse<Bootstrap>()
            client.bootstrapHandler = { try await mention.response() }
            let model = container.makeMentionDestinationModel(client: client, session: container.sessionGeneration)
            let opening = Task { await model.load(try record()) { _, _ in XCTFail("Cancelled mention") } }
            await fulfillment(of: [mention.started], timeout: 2)
            client.bootstrapHandler = { try await workspace.response() }
            let refresh = Task { await container.loadBootstrap() }
            await fulfillment(of: [workspace.started], timeout: 2)
            model.cancel()
            workspace.resolve(bootstrap(["a", "c"])); await refresh.value
            if mentionFails { mention.fail(URLError(.timedOut)) } else { mention.resolve(bootstrap(["a", "b"])) }
            try await opening.value
            XCTAssertEqual(container.bootstrap.value?.projects.map(\.id), ["a", "c"])
            XCTAssertEqual(container.selectedProjectId, "a"); XCTAssertNil(model.root); XCTAssertNil(model.loadError)
            XCTAssertFalse(model.projectResolved); XCTAssertTrue(client.fetches.isEmpty); XCTAssertTrue(client.reads.isEmpty)
        }
    }

    func testFailedOrMissingMentionProjectDoesNotDiscardUsefulPendingRefresh() async throws {
        for fails in [false, true] {
            let (container, client) = await harness()
            let pending = DeferredProjectResponse<Bootstrap>()
            client.bootstrapHandler = { try await pending.response() }
            let refresh = Task { await container.loadBootstrap() }
            await fulfillment(of: [pending.started], timeout: 2)
            client.bootstrapHandler = {
                if fails { throw URLError(.timedOut) }
                return self.bootstrap(["a"])
            }
            let model = container.makeMentionDestinationModel(client: client, session: container.sessionGeneration)
            await model.load(try record()) { _, _ in XCTFail("Unresolved mention") }
            XCTAssertNotNil(model.loadError); XCTAssertFalse(model.projectResolved)
            pending.resolve(bootstrap(["a", "c"])); await refresh.value
            XCTAssertEqual(container.bootstrap.value?.projects.map(\.id), ["a", "c"])
            XCTAssertEqual(container.selectedProjectId, "a"); XCTAssertTrue(client.fetches.isEmpty); XCTAssertTrue(client.reads.isEmpty)
        }
    }

    func testSupersededCurrentMentionStaysUnresolvedAndExplicitRetryUsesNewCache() async throws {
        let (container, client) = await harness()
        let pending = DeferredProjectResponse<Bootstrap>()
        client.bootstrapHandler = { try await pending.response() }
        let notification = try record()
        client.readHandler = { _ in self.receipt(notification) }
        let model = container.makeMentionDestinationModel(client: client, session: container.sessionGeneration)
        let opening = Task { await model.load(notification) { _, _ in } }
        await fulfillment(of: [pending.started], timeout: 2)
        client.bootstrapHandler = { self.bootstrap(["a", "b", "c"]) }
        await container.loadBootstrap()
        pending.resolve(bootstrap(["a", "b"])); await opening.value
        XCTAssertEqual(container.bootstrap.value?.projects.map(\.id), ["a", "b", "c"])
        XCTAssertEqual(container.selectedProjectId, "a")
        XCTAssertNil(model.root); XCTAssertNil(model.focus); XCTAssertFalse(model.projectResolved); XCTAssertFalse(model.loading)
        XCTAssertNotNil(model.loadError); XCTAssertFalse(model.loadError?.contains("CancellationError") == true)
        XCTAssertTrue(client.fetches.isEmpty); XCTAssertTrue(client.reads.isEmpty)
        await model.load(notification) { _, _ in }
        XCTAssertEqual(container.selectedProjectId, "b"); XCTAssertTrue(model.projectResolved); XCTAssertTrue(model.readConfirmed)
        XCTAssertNil(model.loadError); XCTAssertEqual(client.bootstrapRequests, 3, "Explicit retry should use the newer authorized cache")
        XCTAssertEqual(container.bootstrap.value?.projects.map(\.id), ["a", "b", "c"])
    }

    func testIndependentDestinationsCannotPublishAnOlderProjectOverANewerOne() async throws {
        let (container, client) = await harness()
        let pending = DeferredProjectResponse<Bootstrap>()
        client.bootstrapHandler = { try await pending.response() }
        let first = try record(), second = try record(id: "other", project: "c")
        client.readHandler = { path in self.receipt(path.contains("/other/") ? second : first) }
        let firstModel = container.makeMentionDestinationModel(client: client, session: container.sessionGeneration)
        let secondModel = container.makeMentionDestinationModel(client: client, session: container.sessionGeneration)
        let opening = Task { await firstModel.load(first) { _, _ in XCTFail("Superseded destination") } }
        await fulfillment(of: [pending.started], timeout: 2)
        client.bootstrapHandler = { self.bootstrap(["a", "c"]) }
        await secondModel.load(second) { _, _ in }
        pending.resolve(bootstrap(["a", "b"])); await opening.value
        XCTAssertEqual(container.bootstrap.value?.projects.map(\.id), ["a", "c"]); XCTAssertEqual(container.selectedProjectId, "c")
        XCTAssertNil(firstModel.root); XCTAssertFalse(firstModel.projectResolved); XCTAssertNotNil(firstModel.loadError)
        XCTAssertTrue(secondModel.readConfirmed); XCTAssertEqual(client.reads, ["/api/v1/notifications/other/read"])
    }

    func testNormalNewWorkspaceRefreshStillUpdatesInventoryAndFallbackSelection() async {
        let (container, client) = await harness()
        client.bootstrapHandler = { self.bootstrap(["c", "d"]) }
        await container.loadBootstrap()
        XCTAssertEqual(container.bootstrap.value?.projects.map(\.id), ["c", "d"])
        XCTAssertEqual(container.selectedProjectId, "c")
        client.bootstrapHandler = { throw URLError(.notConnectedToInternet) }
        await container.loadBootstrap()
        XCTAssertNotNil(container.bootstrap.errorMessage); XCTAssertEqual(container.selectedProjectId, "c")
        client.bootstrapHandler = { self.bootstrap(["a", "b"]) }
        await container.loadBootstrap()
        XCTAssertEqual(container.bootstrap.value?.projects.map(\.id), ["a", "b"])
        XCTAssertEqual(container.selectedProjectId, "a")
    }

    func testNewAuthorizedProjectIsSelectedBeforeMessageLookupContentOrRead() async throws {
        let (container, client) = await harness()
        let pending = DeferredProjectResponse<Bootstrap>()
        client.bootstrapHandler = { try await pending.response() }
        client.resourceHandler = { path in
            XCTAssertEqual(container.selectedProjectId, "b", "The composer must inherit the resolved project")
            return self.message(for: path)
        }
        let model = container.makeMentionDestinationModel(client: client, session: container.sessionGeneration)
        let notification = try record()
        client.readHandler = { _ in self.receipt(notification) }
        var confirmations = 0
        let opening = Task { await model.load(notification) { _, _ in confirmations += 1 } }
        await fulfillment(of: [pending.started], timeout: 2)
        XCTAssertEqual(container.selectedProjectId, "a")
        XCTAssertNil(model.root); XCTAssertNil(model.focus)
        XCTAssertTrue(model.loading); XCTAssertTrue(client.fetches.isEmpty); XCTAssertTrue(client.reads.isEmpty)
        pending.resolve(bootstrap(["a", "b"]))
        await opening.value
        XCTAssertEqual(container.selectedProjectId, "b")
        XCTAssertEqual(container.bootstrap.value?.projects.map(\.id), ["a", "b"])
        XCTAssertEqual(model.root?.id, "root"); XCTAssertEqual(model.focus?.id, "reply")
        XCTAssertEqual(client.fetches, ["/api/v1/rooms/room/messages/reply", "/api/v1/rooms/room/messages/root"])
        XCTAssertEqual(client.reads, ["/api/v1/notifications/mention/read"])
        XCTAssertEqual(confirmations, 1); XCTAssertNil(model.loadError)
    }

    func testCachedAuthorizedProjectDoesNotRequireAnotherBootstrap() async throws {
        let (container, client) = await harness(projects: ["a", "b"])
        client.bootstrapHandler = { XCTFail("A cached project should open offline without another bootstrap"); throw URLError(.notConnectedToInternet) }
        let notification = try record()
        client.readHandler = { _ in self.receipt(notification) }
        let model = container.makeMentionDestinationModel(client: client, session: container.sessionGeneration)
        await model.load(notification) { _, _ in }
        XCTAssertEqual(client.bootstrapRequests, 1)
        XCTAssertEqual(container.selectedProjectId, "b"); XCTAssertEqual(model.root?.id, "root")
        XCTAssertTrue(model.readConfirmed)
    }

    func testRefreshFailurePreservesWorkspaceAndExplicitRetryRecovers() async throws {
        let (container, client) = await harness()
        client.bootstrapHandler = { throw URLError(.notConnectedToInternet) }
        let notification = try record()
        client.readHandler = { _ in self.receipt(notification) }
        let model = container.makeMentionDestinationModel(client: client, session: container.sessionGeneration)
        await model.load(notification) { _, _ in XCTFail("Failed project resolution cannot mark read") }
        XCTAssertNotNil(model.loadError); XCTAssertNil(model.root); XCTAssertNil(model.focus)
        XCTAssertFalse(model.loading); XCTAssertTrue(client.fetches.isEmpty); XCTAssertTrue(client.reads.isEmpty)
        XCTAssertEqual(container.selectedProjectId, "a"); XCTAssertEqual(container.bootstrap.value?.projects.map(\.id), ["a"])
        await model.retryRead { _, _ in XCTFail("Retry read cannot bypass unresolved project access") }
        XCTAssertTrue(client.reads.isEmpty)
        client.bootstrapHandler = { self.bootstrap(["a", "b"]) }
        await model.load(notification) { _, _ in }
        XCTAssertNil(model.loadError); XCTAssertEqual(container.selectedProjectId, "b")
        XCTAssertEqual(model.root?.id, "root"); XCTAssertTrue(model.readConfirmed)
        XCTAssertEqual(client.bootstrapRequests, 3)
    }

    func testReopeningCachedContentResolvesItsProjectBeforeShowingTheComposer() async throws {
        let (container, client) = await harness(projects: ["a", "b"])
        let notification = try record()
        client.readHandler = { _ in throw URLError(.networkConnectionLost) }
        let model = container.makeMentionDestinationModel(client: client, session: container.sessionGeneration)
        await model.load(notification) { _, _ in }
        XCTAssertTrue(model.projectResolved); XCTAssertEqual(model.root?.id, "root")
        model.cancel()
        container.selectedProjectId = "a"
        XCTAssertFalse(model.projectResolved, "Cached content must stay hidden until its project is selected again")
        await model.retryRead { _, _ in XCTFail("Read retry cannot bypass project restoration") }
        XCTAssertEqual(client.reads.count, 1)
        client.readHandler = { _ in
            XCTAssertEqual(container.selectedProjectId, "b")
            return self.receipt(notification)
        }
        await model.load(notification) { _, _ in }
        XCTAssertEqual(container.selectedProjectId, "b"); XCTAssertTrue(model.projectResolved)
        XCTAssertEqual(model.root?.id, "root"); XCTAssertTrue(model.readConfirmed)
        XCTAssertEqual(client.fetches.count, 2, "Project restoration must preserve the loaded thread")
        XCTAssertEqual(client.bootstrapRequests, 1)
    }

    func testMissingOrInaccessibleProjectLeavesAnErrorWithoutContentOrRead() async throws {
        for inaccessible in [false, true] {
            let (container, client) = await harness()
            client.bootstrapHandler = {
                if inaccessible { throw ApiError.http(status: 403, body: "Workspace access denied") }
                return self.bootstrap(["a"])
            }
            let model = container.makeMentionDestinationModel(client: client, session: container.sessionGeneration)
            await model.load(try record()) { _, _ in XCTFail("An unavailable project cannot mark read") }
            XCTAssertTrue(model.loadError?.contains("403") == true)
            XCTAssertNil(model.root); XCTAssertNil(model.focus); XCTAssertFalse(model.loading)
            XCTAssertEqual(container.selectedProjectId, "a"); XCTAssertEqual(container.bootstrap.value?.projects.map(\.id), ["a"])
            XCTAssertTrue(client.fetches.isEmpty); XCTAssertTrue(client.reads.isEmpty)
        }
    }

    func testInvalidProjectReferencesNeverRequestMessagesOrBootstrap() async throws {
        for value in [JSONValue.null, .string(""), .string(" \n"), .number(42), .bool(true)] {
            let (container, client) = await harness()
            var fields = try XCTUnwrap(record().value.objectFields)
            fields["project_id"] = value
            let model = container.makeMentionDestinationModel(client: client, session: container.sessionGeneration)
            await model.load(try XCTUnwrap(WorkspaceRecord(.object(fields)))) { _, _ in XCTFail("Invalid project") }
            XCTAssertNotNil(model.loadError); XCTAssertNil(model.root)
            XCTAssertEqual(client.bootstrapRequests, 1); XCTAssertTrue(client.fetches.isEmpty); XCTAssertTrue(client.reads.isEmpty)
            XCTAssertEqual(container.selectedProjectId, "a")
        }
    }

    func testOldProjectRefreshCannotReplaceANewerNavigationOrWorkspace() async throws {
        let (container, client) = await harness()
        let pending = DeferredProjectResponse<Bootstrap>()
        client.bootstrapHandler = {
            if client.bootstrapRequests == 2 { return try await pending.response() }
            return self.bootstrap(["a", "c"])
        }
        let first = try record(), second = try record(id: "new", project: "c")
        client.readHandler = { _ in self.receipt(second, unread: 1) }
        let model = container.makeMentionDestinationModel(client: client, session: container.sessionGeneration)
        var confirmations: [String] = []
        let oldOpening = Task { await model.load(first) { row, _ in confirmations.append(row.id) } }
        await fulfillment(of: [pending.started], timeout: 2)
        await model.load(second) { row, _ in confirmations.append(row.id) }
        pending.resolve(bootstrap(["a", "b"]))
        await oldOpening.value
        XCTAssertEqual(container.selectedProjectId, "c")
        XCTAssertEqual(container.bootstrap.value?.projects.map(\.id), ["a", "c"])
        XCTAssertEqual(client.fetches.count, 2); XCTAssertEqual(client.reads, ["/api/v1/notifications/new/read"])
        XCTAssertEqual(confirmations, ["new"]); XCTAssertNil(model.loadError); XCTAssertTrue(model.readConfirmed)
    }

    func testDepartedDestinationCannotPublishItsProjectRefresh() async throws {
        let (container, client) = await harness()
        let pending = DeferredProjectResponse<Bootstrap>()
        client.bootstrapHandler = { try await pending.response() }
        let model = container.makeMentionDestinationModel(client: client, session: container.sessionGeneration)
        let opening = Task { await model.load(try record()) { _, _ in XCTFail("Departed destination") } }
        await fulfillment(of: [pending.started], timeout: 2)
        model.cancel(); pending.resolve(bootstrap(["a", "b"]))
        try await opening.value
        XCTAssertEqual(container.selectedProjectId, "a"); XCTAssertEqual(container.bootstrap.value?.projects.map(\.id), ["a"])
        XCTAssertNil(model.root); XCTAssertNil(model.loadError); XCTAssertFalse(model.loading)
        XCTAssertTrue(client.fetches.isEmpty); XCTAssertTrue(client.reads.isEmpty)
    }

    func testOldSessionProjectResponseCannotRestoreBootstrapOrSelectionAfterLogout() async throws {
        let (container, client) = await harness()
        let pending = DeferredProjectResponse<Bootstrap>()
        client.bootstrapHandler = { try await pending.response() }
        let model = container.makeMentionDestinationModel(client: client, session: container.sessionGeneration)
        let opening = Task { await model.load(try record()) { _, _ in XCTFail("Old session") } }
        await fulfillment(of: [pending.started], timeout: 2)
        let previousSession = container.sessionGeneration
        await container.logout()
        XCTAssertNotEqual(container.sessionGeneration, previousSession)
        pending.resolve(bootstrap(["a", "b"]))
        try await opening.value
        XCTAssertFalse(container.isAuthenticated); XCTAssertNil(container.bootstrap.value); XCTAssertEqual(container.selectedProjectId, "")
        XCTAssertNil(model.root); XCTAssertNil(model.loadError); XCTAssertFalse(model.loading)
        XCTAssertTrue(client.fetches.isEmpty); XCTAssertTrue(client.reads.isEmpty)
        await model.load(try record()) { _, _ in XCTFail("An old destination cannot restart in a new session") }
        XCTAssertEqual(client.bootstrapRequests, 2)
    }

    func testSessionChangeDuringMessageLookupNeverExposesAComposerOrMarksRead() async throws {
        let (container, client) = await harness(projects: ["a", "b"])
        let pending = DeferredProjectResponse<JSONValue>()
        client.resourceHandler = { _ in try await pending.response() }
        let model = container.makeMentionDestinationModel(client: client, session: container.sessionGeneration)
        let opening = Task { await model.load(try record()) { _, _ in XCTFail("Old message response") } }
        await fulfillment(of: [pending.started], timeout: 2)
        await container.logout()
        pending.resolve(message(for: "/reply"))
        try await opening.value
        XCTAssertNil(model.root); XCTAssertNil(model.focus); XCTAssertFalse(model.loading)
        XCTAssertEqual(client.fetches.count, 1); XCTAssertTrue(client.reads.isEmpty)
    }

    func testSessionChangeDuringReadCannotUpdateInboxOrRetryOldCommand() async throws {
        let (container, client) = await harness(projects: ["a", "b"])
        let pending = DeferredProjectResponse<JSONValue>()
        client.readHandler = { _ in try await pending.response() }
        let model = container.makeMentionDestinationModel(client: client, session: container.sessionGeneration)
        let notification = try record()
        let opening = Task { await model.load(notification) { _, _ in XCTFail("Old read response") } }
        await fulfillment(of: [pending.started], timeout: 2)
        XCTAssertEqual(model.root?.id, "root")
        await container.logout()
        pending.resolve(receipt(notification))
        await opening.value
        XCTAssertFalse(model.readConfirmed); XCTAssertFalse(model.markingRead)
        await model.retryRead { _, _ in XCTFail("Old read retry") }
        XCTAssertEqual(client.reads.count, 1)
    }

    func testProjectIsPartOfDestinationAndReadReceiptIdentity() async throws {
        let (container, client) = await harness(projects: ["a", "b", "c"])
        let first = try record(), second = try record(project: "c")
        let model = container.makeMentionDestinationModel(client: client, session: container.sessionGeneration)
        client.readHandler = { _ in self.receipt(first) }
        await model.load(first) { _, _ in }
        await model.load(second) { _, _ in XCTFail("Receipt from another project must be rejected") }
        XCTAssertEqual(container.selectedProjectId, "c")
        XCTAssertEqual(client.fetches.count, 4, "A changed project requires destination validation again")
        XCTAssertFalse(model.readConfirmed); XCTAssertNotNil(model.readError)
        client.readHandler = { _ in self.receipt(second) }
        await model.retryRead { _, _ in }
        XCTAssertTrue(model.readConfirmed); XCTAssertNil(model.readError)
    }

    private func harness(projects: [String] = ["a"]) async -> (AppContainer, MentionProjectClient) {
        let client = MentionProjectClient()
        client.bootstrapHandler = { self.bootstrap(projects) }
        client.resourceHandler = { self.message(for: $0) }
        let container = AppContainer(client: client, credentials: MentionMemoryCredentials())
        await container.loadBootstrap()
        return (container, client)
    }
    private func bootstrap(_ projects: [String]) -> Bootstrap {
        Bootstrap(organization: Organization(id: "org", name: "Team"),
                  user: UserAccount(id: "user", email: "user@example.com", displayName: "User", role: "member"),
                  projects: projects.map { ProjectRef(id: $0, name: "Project \($0)") }, actor: ActorRef(type: "user", id: "user"))
    }
    private func record(id: String = "mention", project: String = "b") throws -> WorkspaceRecord {
        try XCTUnwrap(WorkspaceRecord(.object(["id": .string(id), "project_id": .string(project), "room_id": .string("room"),
                                             "message_id": .string("reply"), "thread_root_id": .string("root"), "read_at": .null])))
    }
    private func message(for path: String) -> JSONValue {
        let reply = path.hasSuffix("/reply")
        return .object(["message": .object(["id": .string(reply ? "reply" : "root"), "room_id": .string("room"),
                                            "actor_type": .string("user"), "actor_id": .string("user"), "body": .string("body"),
                                            "thread_root_id": reply ? .string("root") : .null])])
    }
    private func receipt(_ notification: WorkspaceRecord, unread: Int = 0) -> JSONValue {
        guard var fields = notification.value.objectFields else { return .null }
        fields["read_at"] = .string("2026-10-01T00:00:00Z")
        return .object(["notification": .object(fields), "unread_count": .number(Double(unread))])
    }
}

private extension JSONValue {
    var objectFields: [String: JSONValue]? { if case let .object(fields) = self { return fields }; return nil }
}

@MainActor
private final class DeferredProjectResponse<Value> {
    let started = XCTestExpectation(description: "Request is in flight")
    private var continuation: CheckedContinuation<Value, Error>?
    func response() async throws -> Value {
        try await withCheckedThrowingContinuation { continuation in self.continuation = continuation; started.fulfill() }
    }
    func resolve(_ value: Value) { continuation?.resume(returning: value); continuation = nil }
    func fail(_ error: Error) { continuation?.resume(throwing: error); continuation = nil }
}

private struct MentionMemoryCredentials: CredentialStore {
    func load() throws -> StoredConnection? { nil }
    func save(_ connection: StoredConnection) throws {}
    func clear() throws {}
}

@MainActor
private final class MentionProjectClient: ApiClientProtocol {
    var bootstrapHandler: () async throws -> Bootstrap = { throw ApiError.notImplemented("Test bootstrap") }
    var resourceHandler: (String) async throws -> JSONValue = { _ in throw ApiError.notImplemented("Test resource") }
    var readHandler: (String) async throws -> JSONValue = { _ in throw ApiError.notImplemented("Test read") }
    var bootstrapRequests = 0
    var fetches: [String] = []
    var reads: [String] = []
    func bootstrap() async throws -> Bootstrap { bootstrapRequests += 1; return try await bootstrapHandler() }
    func resource(path: String) async throws -> JSONValue { fetches.append(path); return try await resourceHandler(path) }
    func command(path: String, method: String, body: JSONValue) async throws -> JSONValue {
        XCTAssertEqual(method, "POST"); XCTAssertEqual(body, .object([:]))
        reads.append(path); return try await readHandler(path)
    }
    func listTasks(projectId: String) async throws -> [TaskItem] { throw ApiError.notImplemented("Unused") }
    func createTask(projectId: String, request: CreateTaskRequest) async throws -> TaskResponse { throw ApiError.notImplemented("Unused") }
    func getTask(taskId: String) async throws -> TaskSnapshot { throw ApiError.notImplemented("Unused") }
    func markReady(taskId: String) async throws -> TaskResponse { throw ApiError.notImplemented("Unused") }
    func assign(taskId: String, request: AssignRequest) async throws -> AssignResponse { throw ApiError.notImplemented("Unused") }
    func retry(taskId: String) async throws -> TaskResponse { throw ApiError.notImplemented("Unused") }
    func review(taskId: String, request: ReviewRequest) async throws -> TaskResponse { throw ApiError.notImplemented("Unused") }
    func listRuns(taskId: String) async throws -> [Run] { throw ApiError.notImplemented("Unused") }
    func getRun(runId: String) async throws -> Run { throw ApiError.notImplemented("Unused") }
    func listApprovals(status: String?) async throws -> [Approval] { throw ApiError.notImplemented("Unused") }
    func resolveApproval(approvalId: String, request: ResolveApprovalRequest) async throws -> Approval { throw ApiError.notImplemented("Unused") }
    func listMessages(roomId: String) async throws -> [Message] { throw ApiError.notImplemented("Unused") }
}
