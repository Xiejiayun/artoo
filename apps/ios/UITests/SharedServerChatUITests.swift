import XCTest

/// Black-box tests of the Release app. The companion client uses the same
/// authenticated REST routes as every other paired client; no API is mocked.
final class SharedServerChatUITests: XCTestCase {
    private let app = XCUIApplication()
    private var fixture: Fixture!

    override func setUpWithError() throws {
        continueAfterFailure = false
        fixture = try Fixture(environment: ProcessInfo.processInfo.environment)
    }

    override func tearDownWithError() throws { app.terminate() }

    @MainActor
    func testPairSendThreadAndCatchUpWithAnotherClient() async throws {
        let suffix = UUID().uuidString.prefix(8)
        let rootBody = fixture.nativeMessage
        let replyBody = fixture.nativeReply
        let liveBody = fixture.browserReply
        let catchUpBody = "Peer background reply \(suffix)"
        try await pairNative(name: "Native chat CI \(suffix)")
        let channelsTab = app.tabBars.buttons["Channels"]
        channelsTab.tap()
        try require(app.navigationBars["Channels"].waitForExistence(timeout: 10), "Selecting Channels must show the channel page")
        let channel = app.buttons["channel.\(fixture.channelId)"]
        try require(channel.waitForExistence(timeout: 15), "The server fixture channel must appear in the selected project")
        channel.tap()
        try waitForLiveConnection()

        try send(rootBody)
        let roots = try await peerMessages()
        let root = try XCTUnwrap(roots.first { $0.body == rootBody }, "Native root must be persisted on the real server")
        XCTAssertEqual(roots.filter { $0.body == rootBody }.count, 1)
        XCTAssertNil(root.threadRootId)
        let thread = app.buttons["thread.\(root.id)"]
        try reveal(thread)
        thread.tap()
        try send(replyBody)
        let nativeReplies = try await peerMessages(root: root.id)
        let reply = try XCTUnwrap(nativeReplies.first { $0.body == replyBody })
        XCTAssertEqual(reply.threadRootId, root.id)
        XCTAssertEqual(nativeReplies.filter { $0.body == replyBody }.count, 1)
        try waitForLiveConnection()

        // The real browser waits for nativeReply, then sends browserReply through
        // its own composer. This test never substitutes an API write for it.
        // The reply must appear promptly without a manual refresh while the
        // authenticated socket is connected. A send-triggered REST refresh may
        // overlap this exchange, so this alone does not isolate the WS path.
        try require(app.staticTexts[liveBody].waitForExistence(timeout: 12), "Web UI reply must appear without a manual refresh")
        let repliesAfterBrowser = try await peerMessages(root: root.id)
        let live = try XCTUnwrap(repliesAfterBrowser.first { $0.body == liveBody })
        XCTAssertEqual(live.threadRootId, root.id)
        try waitForLiveConnection()

        XCUIDevice.shared.press(.home)
        try require(app.wait(for: .runningBackground, timeout: 10) || app.state == .runningBackgroundSuspended, "The app must enter the background")
        let background = try await peerSend(catchUpBody, root: root.id)
        app.activate()
        try require(app.staticTexts[catchUpBody].waitForExistence(timeout: 15), "Foreground must reconcile the message written while backgrounded")
        XCTAssertEqual(background.threadRootId, root.id)
        try waitForLiveConnection()
        let finalReplies = try await peerMessages(root: root.id)
        for body in [replyBody, liveBody, catchUpBody] {
            XCTAssertEqual(finalReplies.filter { $0.body == body }.count, 1, "A logical send must be persisted once")
        }
        XCTAssertTrue(finalReplies.allSatisfy { $0.threadRootId == root.id })
        app.terminate()
        app.launch()
        try require(channelsTab.waitForExistence(timeout: 20), "Relaunch must restore the saved Keychain connection")
        channelsTab.tap()
        try require(app.navigationBars["Channels"].waitForExistence(timeout: 10), "Selecting Channels after relaunch must show the channel page")
        try require(channel.waitForExistence(timeout: 15), "The saved channel must be available after relaunch")
        channel.tap()
        try require(app.staticTexts[rootBody].waitForExistence(timeout: 15), "Channel history must survive app relaunch")
        try reveal(thread); thread.tap()
        try require(app.staticTexts[catchUpBody].waitForExistence(timeout: 15), "Thread history must survive app relaunch")
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Native real-server thread after foreground catch-up"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        let evidence = ["project_id": fixture.projectId, "channel_id": fixture.channelId, "root_message_id": root.id,
                        "native_reply_id": reply.id, "peer_live_reply_id": live.id, "peer_background_reply_id": background.id]
        let record = XCTAttachment(data: try JSONSerialization.data(withJSONObject: evidence, options: .sortedKeys), uniformTypeIdentifier: "public.json")
        record.name = "Real server message identities"; record.lifetime = .keepAlways; add(record)
    }

    @MainActor
    func testDaemonPresenceFollowsRealNodeConnection() async throws {
        // The fixture controls an authenticated artood process connection. All
        // native status reads still go to the production server's /daemons API.
        try await controlNode("start")
        try await pairNative(name: "Native daemon CI")
        app.tabBars.buttons["Team"].tap()
        let computer = app.buttons["computer.\(fixture.computerId)"]
        try require(computer.waitForExistence(timeout: 15), "The enrolled execution computer must appear in Team")
        try reveal(computer); computer.tap()
        try require(app.navigationBars[fixture.computerName].waitForExistence(timeout: 10), "Team must open the selected computer")
        let status = app.descendants(matching: .any).matching(identifier: "daemonStatus.\(fixture.computerId)").firstMatch
        let firstOnline = try await waitForDaemon("online")
        try waitForValue(status, "online", message: "The computer must show a freshly confirmed online daemon")
        XCTAssertFalse(app.staticTexts["offline"].exists, "Computer metadata must not contradict the live daemon with an old status")
        do {
            try await controlNode("stop")
            // Production allows 30 seconds to reconnect. Do not shorten its
            // policy or require an instantaneous offline transition for CI.
            let offline = try await waitForDaemon("offline", timeout: 60)
            XCTAssertFalse(offline.connected)
            try waitForValue(status, "offline", message: "A stopped execution daemon must become offline while the server remains reachable")
            XCTAssertFalse(app.staticTexts["online"].exists, "Computer metadata must not retain an old online label after confirmed disconnection")
            attachScreenshot("Native daemon offline after real disconnect grace")
            try await controlNode("start")
            let recovered = try await waitForDaemon("online")
            XCTAssertTrue(recovered.connected)
            XCTAssertNotEqual(firstOnline.lastHeartbeatAt, recovered.lastHeartbeatAt, "Recovery must have a new heartbeat")
            try waitForValue(status, "online", message: "The resumed daemon must be confirmed online by a new server snapshot")
            XCTAssertFalse(app.staticTexts["offline"].exists, "Recovery must not leave a stale offline label beside the confirmed online daemon")

            // Recreate the detail view to exercise a fresh status reader.
            let back = app.navigationBars[fixture.computerName].buttons.firstMatch
            try require(back.exists, "The computer detail must provide back navigation")
            back.tap(); try reveal(computer); computer.tap()
            try waitForValue(status, "online", message: "Reopening the computer must reconfirm the live daemon")
            attachScreenshot("Native daemon online after real reconnect")
            try attachRecord(["computer_id": fixture.computerId, "initial_status": firstOnline.status,
                              "disconnected_status": offline.status, "recovered_status": recovered.status,
                              "recovered_heartbeat": recovered.lastHeartbeatAt ?? ""], name: "Real daemon presence transitions")
        } catch {
            // Independent tests may run in any order; always restore the node.
            try? await controlNode("start")
            throw error
        }
    }

    @MainActor
    func testGoalDiscussionRequiresHumanAcceptanceToCreateDependentTasks() async throws {
        // These are real process-adapter fixture runtimes, not a live model
        // provider. The fixture never writes completed turns or plans for us.
        try await controlNode("start")
        try await pairNative(name: "Native planning CI")
        let initial = try await peerGoalBundle()
        try require(initial.tasks.isEmpty && initial.plans.isEmpty, "The isolated goal must start without plans or child tasks")
        app.tabBars.buttons["More"].tap()
        let goals = app.buttons["Goals"]
        try reveal(goals); goals.tap()
        let goal = app.buttons["workspace.goals.\(fixture.goalId)"]
        try require(goal.waitForExistence(timeout: 15), "The fixture goal must be present in the selected project")
        XCTAssertTrue(goal.label.contains(fixture.goalTitle))
        try reveal(goal); goal.tap()
        let discuss = app.buttons["goal.discuss.\(fixture.goalId)"]
        try reveal(discuss); discuss.tap()
        try selectAgent(index: 0, id: fixture.plannerInstanceId, name: fixture.plannerName)
        try selectAgent(index: 1, id: fixture.reviewerInstanceId, name: fixture.reviewerName)
        try setStepper("discussion.rounds", from: 2, to: 1)
        try setStepper("discussion.minutes", from: 15, to: 5)
        let start = app.buttons["discussion.start"]
        try reveal(start)
        try require(start.isEnabled, "Two distinct selected agents must enable discussion")
        start.tap()

        let discussion = try await waitForDiscussion { $0.status == "ready" }
        XCTAssertEqual(discussion.rounds, 1)
        XCTAssertEqual(discussion.maxMinutes, 5)
        XCTAssertEqual(discussion.currentStep, 3)
        XCTAssertEqual(discussion.totalSteps, 3)
        XCTAssertEqual(Set(discussion.participants.map(\.agentInstanceId)), Set([fixture.plannerInstanceId, fixture.reviewerInstanceId]))
        let progress = app.descendants(matching: .any).matching(identifier: "discussion.progress.\(discussion.id)").firstMatch
        try reveal(progress)
        try waitForValue(progress, "3 / 3", message: "Native discussion progress must show two contributions and the final synthesis")
        let beforeProposal = try await peerGoalBundle()
        try require(beforeProposal.tasks.isEmpty && beforeProposal.plans.isEmpty, "Finishing agent discussion must not create a plan or execution tasks automatically")

        let replies = try await peerMessages(roomId: discussion.roomId, root: discussion.threadRootId)
        let agentReplies = replies.filter { $0.actorType == "agent" }
        try require(agentReplies.count == 3, "The real dispatcher and processes must persist exactly three agent replies")
        XCTAssertEqual(agentReplies.filter { $0.actorId == fixture.plannerInstanceId }.count, 2)
        XCTAssertEqual(agentReplies.filter { $0.actorId == fixture.reviewerInstanceId }.count, 1)
        XCTAssertTrue(agentReplies.allSatisfy { $0.threadRootId == discussion.threadRootId })
        let planReplies = agentReplies.filter { $0.payload?.discussionPlan != nil }
        try require(planReplies.count == 1, "Only the validated final synthesis may carry suggested-plan metadata")
        let synthesis = try XCTUnwrap(planReplies.first)
        let draft = try XCTUnwrap(synthesis.payload?.discussionPlan)
        XCTAssertEqual(draft.version, 1)
        XCTAssertEqual(draft.discussionId, discussion.id)
        XCTAssertEqual(draft.goalId, fixture.goalId)
        XCTAssertEqual(draft.taskSpecs.map(\.title), [fixture.task1Title, fixture.task2Title])
        XCTAssertEqual(draft.taskSpecs.map(\.acceptanceCriteria), [[fixture.task1Criterion], [fixture.task2Criterion]])
        XCTAssertEqual(draft.taskSpecs.map(\.requiredCapabilities), [["code.read"], ["code.read"]])
        XCTAssertEqual(draft.taskSpecs.flatMap(\.expectedArtifacts).map(\.type), ["patch", "test_report"])
        let thread = app.buttons["discussion.thread.\(discussion.id)"]
        try reveal(thread); thread.tap()
        try require(app.navigationBars["Thread"].waitForExistence(timeout: 15), "The discussion must open its real conversation thread")
        for reply in agentReplies {
            if reply.id != synthesis.id {
                let body = app.staticTexts["message.\(reply.id)"]
                try reveal(body)
                XCTAssertEqual(body.label, reply.body)
            }
            let author = app.staticTexts["messageAuthor.\(reply.id)"]
            try reveal(author)
            let name = reply.actorId == fixture.plannerInstanceId ? fixture.plannerName : fixture.reviewerName
            let named = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label BEGINSWITH %@", "\(name) · "), object: author)
            try require(XCTWaiter.wait(for: [named], timeout: 15) == .completed, "Real agent replies must show their display name and timestamp, not an instance ID")
        }
        let draftTitle = app.staticTexts["message.plan.title.\(synthesis.id)"]
        try reveal(draftTitle); XCTAssertEqual(draftTitle.label, "Suggested plan")
        let originalBody = app.staticTexts["message.\(synthesis.id)"]
        XCTAssertFalse(originalBody.exists, "The original JSON must be collapsed when the suggested plan first appears")
        let rationale = app.staticTexts["message.plan.rationale.\(synthesis.id)"]
        try reveal(rationale); XCTAssertEqual(rationale.label, draft.rationale)
        for (index, task) in draft.taskSpecs.enumerated() {
            let title = app.staticTexts["message.plan.task.title.\(synthesis.id).\(index)"]
            try reveal(title); XCTAssertEqual(title.label, "\(index + 1). \(task.title)")
            let description = app.staticTexts["message.plan.task.description.\(synthesis.id).\(index)"]
            try reveal(description); XCTAssertEqual(description.label, task.description)
            for (criterionIndex, criterion) in task.acceptanceCriteria.enumerated() {
                let label = app.staticTexts["message.plan.task.criterion.\(synthesis.id).\(index).\(criterionIndex)"]
                try reveal(label); XCTAssertEqual(label.label, criterion)
            }
            if !task.requiredCapabilities.isEmpty {
                let capabilities = app.staticTexts["message.plan.task.capabilities.\(synthesis.id).\(index)"]
                try reveal(capabilities); XCTAssertEqual(capabilities.label, "Capabilities: \(task.requiredCapabilities.joined(separator: ", "))")
            }
            for (artifactIndex, artifact) in task.expectedArtifacts.enumerated() {
                let label = app.staticTexts["message.plan.task.artifact.\(synthesis.id).\(index).\(artifactIndex)"]
                try reveal(label)
                XCTAssertEqual(label.label, artifact.description.isEmpty ? artifact.type : "\(artifact.type): \(artifact.description)")
            }
        }
        let draftDependency = app.staticTexts["message.plan.task.dependency.\(synthesis.id).1.0"]
        try reveal(draftDependency)
        XCTAssertEqual(draftDependency.label, "Depends on: 1. \(fixture.task1Title)", "The draft must resolve its standard dependency to the numbered task name")
        attachScreenshot("Native suggested plan card before proposal")
        let planHierarchy = XCTAttachment(string: app.debugDescription)
        planHierarchy.name = "Native suggested plan accessibility before original reply"
        planHierarchy.lifetime = .keepAlways; add(planHierarchy)
        let originalToggle = app.buttons["message.plan.original.\(synthesis.id)"]
        try reveal(originalToggle)
        try waitForValue(originalToggle, "Collapsed", message: "The original-reply button must expose its collapsed state")
        originalToggle.tap()
        try waitForValue(originalToggle, "Expanded", message: "Tapping the original-reply button must expand the exact reply")
        try reveal(originalBody); XCTAssertEqual(originalBody.label, synthesis.body, "Expanding the original must preserve the exact server reply")
        attachScreenshot("Native suggested plan with original reply expanded")
        try reveal(originalToggle); originalToggle.tap()
        try waitForValue(originalToggle, "Collapsed", message: "Tapping the original-reply button again must collapse the reply")
        let collapsed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: originalBody)
        try require(XCTWaiter.wait(for: [collapsed], timeout: 5) == .completed, "The original reply must collapse without changing the suggested plan")
        let afterPresentation = try await peerGoalBundle()
        try require(afterPresentation.tasks.isEmpty && afterPresentation.plans.isEmpty, "Viewing the plan card or original reply must never propose a plan or create execution tasks")
        app.navigationBars["Thread"].buttons.firstMatch.tap()

        let propose = app.buttons["discussion.propose.\(discussion.id)"]
        try reveal(propose); propose.tap()
        let proposedDiscussion = try await waitForDiscussion { $0.id == discussion.id && $0.planId != nil }
        let planId = try XCTUnwrap(proposedDiscussion.planId)
        let beforeAcceptance = try await peerGoalBundle()
        try require(beforeAcceptance.tasks.isEmpty, "Creating a proposal must leave execution tasks empty until a human accepts")
        XCTAssertEqual(beforeAcceptance.plans.count, 1)
        XCTAssertEqual(beforeAcceptance.plans.first?.status, "proposed")
        let review = app.buttons["discussion.review.\(discussion.id)"]
        try reveal(review); review.tap()
        for (index, expected) in [(fixture.task1Title, fixture.task1Criterion), (fixture.task2Title, fixture.task2Criterion)].enumerated() {
            let title = app.staticTexts["plan.task.title.\(planId).\(index)"]
            let criteria = app.staticTexts["plan.task.criteria.\(planId).\(index)"]
            try reveal(title); XCTAssertEqual(title.label, "\(index + 1). \(expected.0)")
            try reveal(criteria); XCTAssertEqual(criteria.label, expected.1)
        }
        let dependencyPreview = app.staticTexts["plan.task.dependencies.\(planId).1"]
        try reveal(dependencyPreview)
        XCTAssertEqual(dependencyPreview.label, "Depends on: \(fixture.task1Title)", "The human must see the prerequisite task by name before accepting")
        attachScreenshot("Native proposed plan before human acceptance")
        let accept = app.buttons["plan.accept.\(planId)"]
        try reveal(accept); accept.tap()
        let accepted = try await waitForGoalTasks(count: 2)
        XCTAssertEqual(accepted.plans.first { $0.id == planId }?.status, "accepted")
        let first = try XCTUnwrap(accepted.tasks.first { $0.task.title == fixture.task1Title }?.task)
        let second = try XCTUnwrap(accepted.tasks.first { $0.task.title == fixture.task2Title }?.task)
        XCTAssertEqual(first.acceptanceCriteria, [fixture.task1Criterion])
        XCTAssertEqual(second.acceptanceCriteria, [fixture.task2Criterion])
        let dependencies: DependencyPage = try await peerGet("api/v1/tasks/\(second.id)/dependencies")
        XCTAssertEqual(dependencies.dependencies.count, 1)
        XCTAssertEqual(dependencies.dependencies.first?.fromTaskId, first.id)
        XCTAssertEqual(dependencies.dependencies.first?.toTaskId, second.id)
        XCTAssertEqual(dependencies.dependencies.first?.type, "blocks")
        for task in [first, second] {
            let row = app.buttons["goal.task.\(task.id)"]
            try reveal(row)
            try require(row.label.contains(task.title), "Native goal must show each materialized task")
        }
        attachScreenshot("Native accepted plan with dependent tasks")
        try attachRecord(["goal_id": fixture.goalId, "discussion_id": discussion.id, "thread_root_id": discussion.threadRootId,
                          "plan_id": planId, "first_task_id": first.id, "dependent_task_id": second.id,
                          "runtime_validation": "deterministic process fixtures over authenticated node WebSocket; not live provider validation"],
                         name: "Real discussion and materialized task identities")
    }

    @MainActor
    private func pairNative(name: String) async throws {
        // Codes are minted after Xcode has built the app and independently for
        // every method, so ordering and one-use/expiry semantics stay real.
        app.launch()
        try await waitForPairingState(allowAuthenticated: true)
        if app.tabBars.buttons["More"].exists {
            app.tabBars.buttons["More"].tap()
            let signOut = app.buttons["signOut"]
            try reveal(signOut); signOut.tap()
        }
        try await waitForPairingState(allowAuthenticated: false)
        let code: PairingCode = try await peerPost("api/v1/devices/pairings", body: ["intended_platform": "ios"])
        let origin = app.textFields["serverURL"]
        let localHTTP = app.switches["allowLocalHTTP"]
        if fixture.serverURL.scheme == "http" {
            try reveal(localHTTP)
            if localHTTP.value as? String != "1" {
                let control = localHTTP.switches.firstMatch
                (control.exists ? control : localHTTP).tap()
            }
            try waitForValue(localHTTP, "1", message: "Local HTTP must be enabled through the onboarding switch")
        }
        try replace(origin, with: fixture.serverURL.absoluteString)
        try replace(app.textFields["pairingDeviceName"], with: name)
        try replace(app.textFields["pairingCode"], with: code.code)
        let pair = app.buttons["pairDevice"]
        try reveal(pair)
        try require(pair.isEnabled, "Pairing must be enabled after completing the form")
        pair.tap()
        try require(app.tabBars.buttons["Channels"].waitForExistence(timeout: 20), "The app must authenticate and load the real server bootstrap")
    }

    @MainActor
    private func waitForPairingState(allowAuthenticated: Bool) async throws {
        // Onboarding is visible but disabled while Keychain restoration or
        // logout is pending. Its mere existence does not mean it is ready.
        let deadline = Date().addingTimeInterval(30)
        // Restoration can replace onboarding between separate exists and
        // isEnabled reads. Match XCTest's enabled snapshot attribute inside
        // the query, so a disappearing field is simply not a ready match.
        let readyOrigin = app.textFields.matching(identifier: "serverURL")
            .matching(NSPredicate(format: "enabled == true")).firstMatch
        while Date() < deadline {
            if allowAuthenticated && app.tabBars.buttons["More"].exists { return }
            if readyOrigin.exists { return }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        try require(false, "Saved connection restoration or sign-out must settle before pairing")
    }

    @MainActor
    private func selectAgent(index: Int, id: String, name: String) throws {
        let picker = app.descendants(matching: .any).matching(identifier: "discussion.participant.\(index).instance").firstMatch
        try reveal(picker); picker.tap()
        let identified = app.descendants(matching: .any).matching(identifier: "discussion.agentOption.\(id)").firstMatch
        // Menu options expose their SwiftUI Text as a button on some iOS
        // versions; the exact display-name suffix also identifies that option.
        let option = identified.waitForExistence(timeout: 2) ? identified : app.buttons.matching(NSPredicate(format: "label ENDSWITH %@", "· \(name)")).firstMatch
        try require(option.waitForExistence(timeout: 10), "The enrolled agent instance must be a selectable option")
        option.tap()
    }

    @MainActor
    private func setStepper(_ id: String, from initial: Int, to target: Int) throws {
        let stepper = app.steppers[id]
        try reveal(stepper)
        try waitForValue(stepper, "\(initial)", message: "The discussion limit must begin at its displayed default")
        let hierarchy = XCTAttachment(string: stepper.debugDescription)
        hierarchy.name = "\(id) accessibility hierarchy"; hierarchy.lifetime = .keepAlways; add(hierarchy)
        let direction = target < initial ? -1 : 1
        var expected = initial
        for _ in 0..<abs(target - initial) {
            // This English/LTR UI shows the native minus and plus segments
            // from left to right. Scope to this stepper's actual buttons
            // instead of relying on OS-provided accessibility names.
            let controls = stepper.buttons.allElementsBoundByIndex.sorted { $0.frame.midX < $1.frame.midX }
            try require(controls.count == 2, "The native stepper must expose exactly two adjustment buttons; found \(controls.count)")
            try require(!controls[0].frame.isEmpty && !controls[1].frame.isEmpty && controls[0].frame.midX < controls[1].frame.midX,
                        "The stepper's minus and plus buttons must have distinct visible frames")
            let control = controls[direction < 0 ? 0 : 1]
            try require(control.isEnabled && control.isHittable, "The requested stepper adjustment must be available")
            control.tap()
            expected += direction
            try waitForValue(stepper, "\(expected)", message: "Each real stepper tap must update the displayed discussion limit")
        }
    }

    @MainActor
    private func waitForValue(_ element: XCUIElement, _ value: String, message: String) throws {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", value), object: element)
        try require(XCTWaiter.wait(for: [expectation], timeout: 15) == .completed, message)
    }

    @MainActor
    private func attachScreenshot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }

    private func attachRecord(_ record: [String: String], name: String) throws {
        let attachment = XCTAttachment(data: try JSONSerialization.data(withJSONObject: record, options: .sortedKeys), uniformTypeIdentifier: "public.json")
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }

    @MainActor
    private func send(_ body: String) throws {
        let composer = app.descendants(matching: .any).matching(identifier: "messageComposer").firstMatch
        try reveal(composer)
        try replace(composer, with: body)
        let button = app.buttons["sendMessage"]
        try reveal(button)
        try require(button.isEnabled, "The message send control must be enabled")
        button.tap()
        try require(app.staticTexts[body].waitForExistence(timeout: 15), "The native send must complete against the real server")
    }

    @MainActor
    private func replace(_ field: XCUIElement, with text: String) throws {
        try require(field.waitForExistence(timeout: 10), "Required text field must exist")
        try reveal(field)
        field.tap()
        if let current = field.value as? String, !current.isEmpty, current != field.placeholderValue {
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
        }
        field.typeText(text)
    }

    @MainActor
    private func reveal(_ element: XCUIElement) throws {
        for _ in 0..<5 {
            if element.exists && element.isHittable { return }
            app.swipeUp()
        }
        for _ in 0..<5 {
            if element.exists && element.isHittable { return }
            app.swipeDown()
        }
        try require(element.exists && element.isHittable, "Required control must be reachable")
    }

    @MainActor
    private func waitForLiveConnection() throws {
        // Connection status is read-only. Its decorative image need not be
        // hittable, and scrolling here could trigger the list's manual refresh.
        let connected = app.descendants(matching: .any).matching(identifier: "realtimeStatus")
            .matching(NSPredicate(format: "value == %@", "connected")).firstMatch
        try require(connected.waitForExistence(timeout: 15), "The native client must establish an authenticated WebSocket")
    }

    @MainActor
    private func require(_ condition: Bool, _ message: String) throws {
        guard condition else {
            let screenshot = XCTAttachment(screenshot: app.screenshot())
            screenshot.name = "Native UI failure"; screenshot.lifetime = .keepAlways; add(screenshot)
            let hierarchy = XCTAttachment(string: app.debugDescription)
            hierarchy.name = "Native UI failure accessibility hierarchy"; hierarchy.lifetime = .keepAlways; add(hierarchy)
            // XCTest assertions in async tests can continue despite
            // continueAfterFailure=false. Throw to stop dependent UI actions.
            throw NSError(domain: "ArtooUITestAssertion", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
        }
    }

    private func peerMessages(roomId: String? = nil, root: String? = nil) async throws -> [ServerMessage] {
        var components = URLComponents(url: fixture.serverURL.appendingPathComponent("api/v1/rooms/\(roomId ?? fixture.channelId)/messages"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "limit", value: "50")]
        if let root { components.queryItems?.append(URLQueryItem(name: "thread_root_id", value: root)) }
        let response: MessagePage = try await peerRequest(URLRequest(url: components.url!))
        return response.messages
    }

    private func peerSend(_ body: String, root: String) async throws -> ServerMessage {
        var request = URLRequest(url: fixture.serverURL.appendingPathComponent("api/v1/rooms/\(fixture.channelId)/messages"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let key = UUID().uuidString
        request.setValue(key, forHTTPHeaderField: "Idempotency-Key")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["kind": "text", "body": body, "thread_root_id": root, "client_request_id": key])
        let response: MessageEnvelope = try await peerRequest(request)
        return response.message
    }

    private func peerGet<Response: Decodable>(_ path: String) async throws -> Response {
        try await peerRequest(URLRequest(url: fixture.serverURL.appendingPathComponent(path)))
    }

    private func peerPost<Response: Decodable>(_ path: String, body: [String: String]) async throws -> Response {
        var request = URLRequest(url: fixture.serverURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(UUID().uuidString, forHTTPHeaderField: "Idempotency-Key")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await peerRequest(request)
    }

    private func controlNode(_ action: String) async throws {
        var request = URLRequest(url: fixture.controlURL.appendingPathComponent("node/\(action)"))
        request.httpMethod = "POST"
        let _: NodeControlResponse = try await peerRequest(request, token: fixture.controlToken, timeout: 75)
    }

    private func waitForDaemon(_ status: String, timeout: TimeInterval = 30) async throws -> ServerDaemon {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            let page: DaemonPage = try await peerGet("api/v1/daemons")
            if let daemon = page.daemons.first(where: { $0.computerId == fixture.computerId && $0.status == status }) { return daemon }
            try await Task.sleep(nanoseconds: 500_000_000)
        } while Date() < deadline
        throw NSError(domain: "ArtooUITestDaemon", code: 1, userInfo: [NSLocalizedDescriptionKey: "The real server did not confirm daemon \(status) within \(timeout) seconds"])
    }

    private func peerGoalBundle() async throws -> GoalBundle {
        let response: GoalAuditResponse = try await peerGet("api/v1/goals/\(fixture.goalId)/audit-bundle")
        return response.bundle
    }

    private func waitForGoalTasks(count: Int) async throws -> GoalBundle {
        let deadline = Date().addingTimeInterval(30)
        repeat {
            let bundle = try await peerGoalBundle()
            if bundle.tasks.count == count { return bundle }
            if bundle.tasks.count > count { break }
            try await Task.sleep(nanoseconds: 500_000_000)
        } while Date() < deadline
        throw NSError(domain: "ArtooUITestGoal", code: 1, userInfo: [NSLocalizedDescriptionKey: "The real goal must materialize exactly \(count) child tasks after native acceptance"])
    }

    private func waitForDiscussion(_ predicate: (ServerDiscussion) -> Bool) async throws -> ServerDiscussion {
        let deadline = Date().addingTimeInterval(120)
        repeat {
            let page: DiscussionPage = try await peerGet("api/v1/goals/\(fixture.goalId)/discussions")
            if let discussion = page.discussions.first(where: predicate) { return discussion }
            if let failed = page.discussions.first(where: { ["failed", "cancelled", "expired"].contains($0.status) }) {
                throw NSError(domain: "ArtooUITestDiscussion", code: 1, userInfo: [NSLocalizedDescriptionKey: "The real discussion ended with \(failed.status)"])
            }
            try await Task.sleep(nanoseconds: 500_000_000)
        } while Date() < deadline
        throw NSError(domain: "ArtooUITestDiscussion", code: 2, userInfo: [NSLocalizedDescriptionKey: "The real discussion did not reach the required state within 120 seconds"])
    }

    private func peerRequest<Response: Decodable>(_ input: URLRequest, token: String? = nil, timeout: TimeInterval = 20) async throws -> Response {
        var request = input
        request.setValue("Bearer \(token ?? fixture.peerToken)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = timeout
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: request)
        let http = try XCTUnwrap(response as? HTTPURLResponse)
        guard (200..<300).contains(http.statusCode) else {
            throw NSError(domain: "ArtooUITestPeer", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: "Authenticated peer request failed with HTTP \(http.statusCode)"])
        }
        let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(Response.self, from: data)
    }
}

private struct MessagePage: Decodable { let messages: [ServerMessage] }
private struct MessageEnvelope: Decodable { let message: ServerMessage }
private struct ServerMessage: Decodable {
    let id: String; let body: String; let threadRootId: String?; let actorType: String; let actorId: String
    let payload: ServerMessagePayload?
}
private struct ServerMessagePayload: Decodable { let discussionPlan: ServerPlanDraft? }
private struct ServerPlanDraft: Decodable {
    let version: Int; let discussionId: String; let goalId: String; let rationale: String; let taskSpecs: [ServerPlanTaskSpec]
}
private struct ServerPlanTaskSpec: Decodable {
    let title: String; let description: String; let acceptanceCriteria: [String]; let requiredCapabilities: [String]
    let expectedArtifacts: [ServerExpectedArtifact]
}
private struct ServerExpectedArtifact: Decodable { let type: String; let description: String }
private struct PairingCode: Decodable { let code: String }
private struct DaemonPage: Decodable { let daemons: [ServerDaemon] }
private struct ServerDaemon: Decodable { let computerId: String; let status: String; let connected: Bool; let lastHeartbeatAt: String? }
private struct NodeControlResponse: Decodable { let daemon: ServerDaemon? }
private struct DiscussionPage: Decodable { let discussions: [ServerDiscussion] }
private struct ServerDiscussion: Decodable {
    let id: String; let roomId: String; let threadRootId: String; let status: String; let planId: String?
    let rounds: Int; let maxMinutes: Int; let currentStep: Int; let totalSteps: Int; let participants: [DiscussionParticipant]
}
private struct DiscussionParticipant: Decodable { let agentInstanceId: String }
private struct GoalAuditResponse: Decodable { let bundle: GoalBundle }
private struct GoalBundle: Decodable { let plans: [ServerPlan]; let tasks: [GoalTaskEnvelope] }
private struct ServerPlan: Decodable { let id: String; let status: String }
private struct GoalTaskEnvelope: Decodable { let task: ServerTask }
private struct ServerTask: Decodable { let id: String; let title: String; let acceptanceCriteria: [String] }
private struct DependencyPage: Decodable { let dependencies: [ServerDependency] }
private struct ServerDependency: Decodable { let fromTaskId: String; let toTaskId: String; let type: String }

private struct Fixture {
    let serverURL: URL
    let projectId: String
    let channelId: String
    let peerToken: String
    let nativeMessage: String
    let nativeReply: String
    let browserReply: String
    let computerId: String
    let computerName: String
    let goalId: String
    let goalTitle: String
    let plannerInstanceId: String
    let plannerName: String
    let reviewerInstanceId: String
    let reviewerName: String
    let task1Title: String
    let task2Title: String
    let task1Criterion: String
    let task2Criterion: String
    let controlURL: URL
    let controlToken: String
    init(environment: [String: String]) throws {
        func require(_ key: String) throws -> String {
            guard let value = environment[key], !value.isEmpty else {
                throw NSError(domain: "ArtooUITestFixture", code: 1, userInfo: [NSLocalizedDescriptionKey: "Missing required UI fixture field \(key). Start the real server fixture first."])
            }
            return value
        }
        let origin = try require("ARTOO_UI_SERVER_URL")
        guard let url = URL(string: origin), let host = url.host, let scheme = url.scheme,
              ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host), ["http", "https"].contains(scheme), url.user == nil, url.password == nil else {
            throw NSError(domain: "ArtooUITestFixture", code: 2, userInfo: [NSLocalizedDescriptionKey: "UI fixtures must target an isolated loopback server"])
        }
        serverURL = url
        projectId = try require("ARTOO_UI_PROJECT_ID")
        channelId = try require("ARTOO_UI_CHANNEL_ID")
        peerToken = try require("ARTOO_UI_PEER_CONTROL_TOKEN")
        nativeMessage = try require("ARTOO_UI_NATIVE_MESSAGE")
        nativeReply = try require("ARTOO_UI_NATIVE_REPLY")
        browserReply = try require("ARTOO_UI_BROWSER_REPLY")
        computerId = try require("ARTOO_UI_COMPUTER_ID")
        computerName = try require("ARTOO_UI_COMPUTER_NAME")
        goalId = try require("ARTOO_UI_GOAL_ID")
        goalTitle = try require("ARTOO_UI_GOAL_TITLE")
        plannerInstanceId = try require("ARTOO_UI_PLANNER_INSTANCE_ID")
        plannerName = try require("ARTOO_UI_PLANNER_NAME")
        reviewerInstanceId = try require("ARTOO_UI_REVIEWER_INSTANCE_ID")
        reviewerName = try require("ARTOO_UI_REVIEWER_NAME")
        task1Title = try require("ARTOO_UI_TASK_1_TITLE")
        task2Title = try require("ARTOO_UI_TASK_2_TITLE")
        task1Criterion = try require("ARTOO_UI_TASK_1_CRITERION")
        task2Criterion = try require("ARTOO_UI_TASK_2_CRITERION")
        let controlOrigin = try require("ARTOO_UI_FIXTURE_CONTROL_URL")
        guard let control = URL(string: controlOrigin), let controlHost = control.host,
              ["localhost", "127.0.0.1", "::1", "[::1]"].contains(controlHost), ["http", "https"].contains(control.scheme ?? ""),
              control.user == nil, control.password == nil else {
            throw NSError(domain: "ArtooUITestFixture", code: 3, userInfo: [NSLocalizedDescriptionKey: "Node fixture controls must target an isolated loopback server"])
        }
        controlURL = control
        controlToken = try require("ARTOO_UI_FIXTURE_CONTROL_TOKEN")
    }
}
