import XCTest
import CryptoKit

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
    func testTaskExecutionApprovalArtifactPreviewAndAcceptance() async throws {
        try await controlNode("start")
        try await pairNative(name: "Native task execution CI")
        let beforeCreation = try await peerExecutionTasks()
        try require(!beforeCreation.contains { $0.title == fixture.executionTaskTitle }, "The fixture must not precreate the native execution task")
        app.tabBars.buttons["Tasks"].tap()
        let create = app.buttons["task.create.open"]
        try require(create.waitForExistence(timeout: 15), "Tasks must expose native creation")
        create.tap()
        try replace(editableField("task.create.title"), with: fixture.executionTaskTitle)
        try dismissKeyboard(using: "task.create.keyboard.done")
        try replace(editableField("task.create.criteria"), with: "\(fixture.executionCriterion1)\n\(fixture.executionCriterion2)")
        try dismissKeyboard(using: "task.create.keyboard.done")
        try replace(editableField("task.create.capabilities"), with: "code.modify")
        let submit = app.buttons["task.create.submit"]
        try reveal(submit); try require(submit.isEnabled, "The completed native form must enable creation"); submit.tap()
        let created = try await waitForCreatedExecutionTask()
        XCTAssertEqual(created.status, "backlog")
        XCTAssertEqual(created.projectId, fixture.projectId)
        XCTAssertEqual(created.acceptanceCriteria, [fixture.executionCriterion1, fixture.executionCriterion2])
        XCTAssertEqual(created.requiredCapabilities, ["code.modify"])
        let taskId = created.id
        let taskRow = app.buttons["task.row.\(taskId)"]
        try require(taskRow.waitForExistence(timeout: 15), "The task created by the phone must appear in Tasks")
        try reveal(taskRow); taskRow.tap()
        let status = app.descendants(matching: .any).matching(identifier: "task.status.\(taskId)").firstMatch
        try require(status.waitForExistence(timeout: 15), "Task detail must expose its real status")
        try waitForValue(status, "backlog", message: "The newly created task must remain in Backlog")
        let ready = app.buttons["task.action.markReady.\(taskId)"]
        try reveal(ready); ready.tap()
        let readySnapshot = try await waitForExecutionTask(taskId) { $0.task.status == "ready" }
        XCTAssertTrue(readySnapshot.runs.isEmpty)
        XCTAssertTrue(readySnapshot.approvals.isEmpty, "The fixture must not precreate execution approval")
        try reveal(app.staticTexts[fixture.executionTaskTitle])
        try waitForValue(status, "ready", message: "Mark Ready must update the native task")
        let identifiedDisclosure = app.buttons["task.approval.disclosure.\(taskId)"]
        let disclosure = identifiedDisclosure.waitForExistence(timeout: 2) ? identifiedDisclosure : app.buttons["Request execution review"]
        try reveal(disclosure); disclosure.tap()
        try replace(editableField("task.approval.summary.\(taskId)"), with: fixture.executionApprovalSummary)
        try dismissKeyboard(using: "task.detail.keyboard.done")
        let risk = app.segmentedControls["task.approval.risk.\(taskId)"].buttons["High"]
        try reveal(risk); risk.tap()
        let requestApproval = app.buttons["task.approval.request.\(taskId)"]
        try reveal(requestApproval); requestApproval.tap()
        let pending = try await waitForExecutionTask(taskId) {
            $0.approvals.contains { $0.action == "execution.start" && $0.payloadRef == "execution-gate/current" && $0.status == "pending" }
        }
        try require(pending.approvals.count == 1, "One native review request must create one approval")
        let approval = try XCTUnwrap(pending.approvals.first)
        XCTAssertEqual(approval.summary, fixture.executionApprovalSummary)
        XCTAssertEqual(approval.risk, "high")
        XCTAssertNil(approval.runId)
        XCTAssertEqual(pending.task.status, "ready")
        XCTAssertTrue(pending.runs.isEmpty, "Requesting review must not execute the task")
        let assign = app.buttons["task.action.assign.\(taskId)"]
        let blocked = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: assign)
        try require(XCTWaiter.wait(for: [blocked], timeout: 10) == .completed, "The native task must block assignment while approval is pending")
        let keyboardDismissed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.keyboards.firstMatch)
        try require(XCTWaiter.wait(for: [keyboardDismissed], timeout: 10) == .completed, "Submitting execution approval must dismiss the keyboard so root navigation is reachable")
        let summaryInput = app.descendants(matching: .any).matching(identifier: "task.approval.summary.\(taskId)").firstMatch
        let requestCollapsed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: summaryInput)
        try require(XCTWaiter.wait(for: [requestCollapsed], timeout: 10) == .completed, "A successful approval request must collapse its cleared input form")
        attachScreenshot("Native task awaiting execution approval")

        let inbox = app.tabBars.buttons["Inbox"]
        try require(inbox.isHittable, "Inbox must be reachable after submitting execution approval")
        inbox.tap()
        try require(app.navigationBars["Today"].waitForExistence(timeout: 10), "Selecting Inbox must leave Task detail and show Today")
        let approvalRow = app.buttons["inbox.approval.\(approval.id)"]
        try require(approvalRow.waitForExistence(timeout: 15), "Inbox must receive the task's real execution approval")
        try reveal(approvalRow); approvalRow.tap()
        let summary = app.staticTexts["approval.summary.\(approval.id)"]
        try require(summary.waitForExistence(timeout: 10), "Approval detail must show the submitted summary")
        XCTAssertEqual(summary.label, fixture.executionApprovalSummary)
        let approve = app.buttons["approval.decision.approved.\(approval.id)"]
        try reveal(approve); approve.tap()
        let approved = try await waitForExecutionTask(taskId) { $0.approvals.first { $0.id == approval.id }?.status == "approved" }
        XCTAssertEqual(approved.task.status, "ready")
        XCTAssertTrue(approved.runs.isEmpty, "Approval must authorize one future execution, not start it automatically")
        XCTAssertNil(approved.approvals.first?.runId)
        try require(app.navigationBars["Today"].waitForExistence(timeout: 15), "Approving execution must finish and return to Inbox")
        app.tabBars.buttons["Tasks"].tap()
        try require(assign.waitForExistence(timeout: 15), "The approved task must offer assignment")
        try reveal(assign); assign.tap()
        try require(app.navigationBars["Assign Task"].waitForExistence(timeout: 10), "Assign must open the real assignment form")
        let manual = app.segmentedControls["task.assignment.mode"].buttons["Manual"]
        try reveal(manual); manual.tap()
        let picker = app.descendants(matching: .any).matching(identifier: "task.assignment.instance").firstMatch
        try reveal(picker); picker.tap()
        try require(fixture.executorInstanceId != fixture.executorCollisionInstanceId, "The same-name fixture must contain two distinct execution instances")
        let option = try assignmentOption(instanceId: fixture.executorInstanceId)
        let collision = try assignmentOption(instanceId: fixture.executorCollisionInstanceId)
        for (candidate, id, otherId) in [(option, fixture.executorInstanceId, fixture.executorCollisionInstanceId),
                                         (collision, fixture.executorCollisionInstanceId, fixture.executorInstanceId)] {
            try require(candidate.label.contains(fixture.executorName) && candidate.label.contains(fixture.computerName)
                        && candidate.label.contains(fixture.executorRuntime) && candidate.label.contains("Instance: \(id)")
                        && !candidate.label.contains(otherId),
                        "Same-name executor options must expose their full unique instance ID alongside readable details")
        }
        try revealAssignmentPair(option, collision)
        try attachConnectedScreenshot("Native executor options with readable details")
        // Never select a same-name candidate by its display name. This remains
        // the original executor's stable ID (or a complete-ID fallback).
        option.tap()
        let confirm = app.buttons["task.assignment.confirm"]
        do {
            // Keep the selected executor in the open form, then remove its
            // real authenticated node connection before submitting through UI.
            try await controlNode("stop")
            _ = try await waitForDaemon("offline")
            try reveal(confirm); try require(confirm.isEnabled, "The selected executor must remain submittable so the server decides eligibility"); confirm.tap()
            let assignmentError = app.staticTexts["task.assignment.error"]
            try require(assignmentError.waitForExistence(timeout: 15), "A rejected assignment must display the server error in the same sheet")
            try require(app.navigationBars["Assign Task"].exists, "Server rejection must keep the assignment sheet open")
            try require(manual.isSelected, "Server rejection must preserve Manual mode")
            let selection = picker.value as? String ?? picker.label
            try require(selection.contains(fixture.executorName) && selection.contains("Instance: \(fixture.executorInstanceId)")
                        && !selection.contains(fixture.executorCollisionInstanceId),
                        "Server rejection must preserve the original executor's readable name and full instance ID")
            // The scheduler distinguishes an entirely offline fleet from an
            // unavailable pinned instance when another computer is online.
            let schedulerErrors = ["HTTP 409: no online computer is available",
                                   "HTTP 409: no eligible idle agent instance for the required capabilities"]
            try require(schedulerErrors.contains(assignmentError.label), "The native form must retain the actual scheduler rejection, received: \(assignmentError.label)")
            try require(confirm.isEnabled && app.buttons["task.assignment.cancel"].isEnabled, "A completed rejection must leave the form available for retry or cancellation")
            let rejected: ExecutionTaskSnapshot = try await peerGet("api/v1/tasks/\(taskId)")
            try require(rejected.task.status == "ready" && rejected.runs.isEmpty, "Rejected assignment must not create a run or advance the task")
            let unusedApproval = try XCTUnwrap(rejected.approvals.first { $0.id == approval.id })
            try require(unusedApproval.status == "approved" && unusedApproval.runId == nil, "Rejected assignment must not consume the execution approval")
            attachScreenshot("Native assignment rejected with selection preserved")
            try attachRecord(["task_id": taskId, "approval_id": approval.id, "agent_instance_id": fixture.executorInstanceId,
                              "unselected_collision_instance_id": fixture.executorCollisionInstanceId,
                              "server_error": assignmentError.label, "task_status": rejected.task.status,
                              "run_count": String(rejected.runs.count), "selection_preserved": "true"],
                             name: "Native assignment rejection before explicit retry")
            try await controlNode("start")
            _ = try await waitForDaemon("online")
        } catch {
            try? await controlNode("start")
            throw error
        }
        try require(app.navigationBars["Assign Task"].exists && manual.isSelected, "Reconnecting the node must retain the same form for explicit retry")
        let retrySelection = picker.value as? String ?? picker.label
        try require(retrySelection.contains(fixture.executorName) && retrySelection.contains("Instance: \(fixture.executorInstanceId)")
                    && !retrySelection.contains(fixture.executorCollisionInstanceId),
                    "Retry must retain the original executor's full identity, not its same-name counterpart")
        try reveal(confirm); try require(confirm.isEnabled, "Selecting the executor must enable assignment"); confirm.tap()
        let assigned = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.navigationBars["Assign Task"])
        try require(XCTWaiter.wait(for: [assigned], timeout: 15) == .completed, "An accepted assignment must close the sheet")
        let completed = try await waitForExecutionTask(taskId, timeout: 90) { $0.task.status == "review" && !$0.artifacts.isEmpty }
        try require(completed.runs.count == 1 && completed.artifacts.count == 1, "One assignment must produce one real run and one uploaded report")
        let run = try XCTUnwrap(completed.runs.first)
        XCTAssertEqual(run.status, "completed")
        XCTAssertEqual(run.taskId, taskId)
        XCTAssertEqual(run.runtimeId, fixture.executorRuntime)
        XCTAssertEqual(run.agentInstanceId, fixture.executorInstanceId)
        XCTAssertEqual(run.computerId, fixture.computerId)
        XCTAssertEqual(completed.approvals.first { $0.id == approval.id }?.runId, run.id)
        let artifact = try XCTUnwrap(completed.artifacts.first)
        XCTAssertEqual(artifact.taskId, taskId); XCTAssertEqual(artifact.runId, run.id)
        XCTAssertEqual(artifact.type, "report")
        XCTAssertEqual(artifact.uri, "/api/v1/artifacts/\(artifact.id)/content")
        XCTAssertEqual(artifact.metadata.filename, fixture.executionArtifactFilename)
        let bytes = try await peerArtifact(artifact)
        XCTAssertEqual(bytes.count, artifact.metadata.size)
        let checksum = "sha256:" + SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(checksum, artifact.checksum)
        let text = try XCTUnwrap(String(data: bytes, encoding: .utf8))
        for expected in [fixture.executionArtifactMarker, taskId, run.id, fixture.executionCriterion1, fixture.executionCriterion2] {
            XCTAssertTrue(text.contains(expected), "The actual uploaded bytes must retain \(expected)")
        }
        try reveal(app.staticTexts[fixture.executionTaskTitle])
        try waitForValue(status, "review", message: "The completed execution must be ready for human review")
        let preview = app.buttons["artifact.preview.\(artifact.id)"]
        try reveal(preview)
        attachScreenshot("Native execution completed with uploaded artifact")
        preview.tap()
        let marker = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", fixture.executionArtifactMarker, fixture.executionArtifactMarker)).firstMatch
        try require(marker.waitForExistence(timeout: 20), "Quick Look must render the actual report body, not only open a preview shell")
        let basename = (fixture.executionArtifactFilename as NSString).deletingPathExtension
        let previewBar = app.navigationBars.matching(NSPredicate(format: "identifier == %@ OR identifier == %@ OR label == %@ OR label == %@",
            fixture.executionArtifactFilename, basename, fixture.executionArtifactFilename, basename)).firstMatch
        try require(previewBar.waitForExistence(timeout: 10), "Quick Look must identify the uploaded filename")
        attachScreenshot("Native uploaded execution report in Quick Look")
        let identified = previewBar.buttons.matching(identifier: "QLOverlayDoneButtonAccessibilityIdentifier")
        let done = previewBar.buttons.matching(NSPredicate(format: "label == %@", "Done"))
        let controls: XCUIElementQuery
        if identified.firstMatch.waitForExistence(timeout: 2) {
            controls = identified
        } else {
            controls = done.firstMatch.waitForExistence(timeout: 2) ? done : app.buttons.matching(NSPredicate(format: "label == %@", "Close"))
        }
        let close = controls.firstMatch
        try require(close.waitForExistence(timeout: 10) && controls.count == 1
                    && ["Done", "Close", "close"].contains(close.label) && close.isEnabled && close.isHittable,
                    "The system preview must offer one enabled, hittable close control with its expected label")
        close.tap()
        try require(app.navigationBars["Task"].waitForExistence(timeout: 15), "Closing Quick Look must return to the task")
        // Quick Look returns to the artifact's scroll position. SwiftUI List
        // creates the review field only after that row is scrolled into view.
        let reviewInput = app.descendants(matching: .any).matching(identifier: "task.review.comment.\(taskId)").firstMatch
        try reveal(reviewInput)
        try replace(editableField("task.review.comment.\(taskId)"), with: fixture.executionReviewComment)
        try dismissKeyboard(using: "task.detail.keyboard.done")
        let accept = app.buttons["task.action.accept.\(taskId)"]
        try reveal(accept); accept.tap()
        let accepted = try await waitForExecutionTask(taskId) { $0.task.status == "done" }
        XCTAssertEqual(accepted.runs.map(\.id), [run.id])
        XCTAssertEqual(accepted.artifacts.map(\.id), [artifact.id])
        XCTAssertEqual(accepted.artifacts.first?.checksum, checksum)
        try reveal(app.staticTexts[fixture.executionTaskTitle])
        try waitForValue(status, "done", message: "Accepting the reviewed artifact must finish the native task")
        attachScreenshot("Native task accepted after artifact review")
        try attachRecord(["task_id": taskId, "approval_id": approval.id, "run_id": run.id,
                          "agent_instance_id": run.agentInstanceId, "artifact_id": artifact.id,
                          "artifact_checksum": checksum, "downloaded_bytes": String(bytes.count),
                          "final_status": accepted.task.status, "runtime_validation": "deterministic subprocess; no live model inference"],
                         name: "Real native execution approval and artifact acceptance")
    }

    @MainActor
    func testApprovalNeedsMoreInfoSurvivesRelaunchAndCanBeApproved() async throws {
        try await pairNative(name: "Native approval recovery CI")
        let initial = try await waitForApproval("pending")
        XCTAssertEqual(initial.taskId, fixture.approvalTaskId)
        XCTAssertEqual(initial.summary, fixture.approvalSummary)
        let inbox = app.tabBars.buttons["Inbox"]
        inbox.tap()
        let row = app.buttons["inbox.approval.\(fixture.approvalId)"]
        try require(row.waitForExistence(timeout: 15), "The pending approval must be reachable from Inbox")
        try reveal(row); row.tap()
        let summary = app.staticTexts["approval.summary.\(fixture.approvalId)"]
        try require(summary.waitForExistence(timeout: 10), "Approval detail must show the real request summary")
        XCTAssertEqual(summary.label, fixture.approvalSummary)
        let needsInfo = app.buttons["approval.decision.needs_more_info.\(fixture.approvalId)"]
        try reveal(needsInfo); needsInfo.tap()
        let waiting = try await waitForApproval("needs_more_info")
        XCTAssertEqual(waiting.id, initial.id, "Requesting information must retain the same approval")
        try require(app.navigationBars["Today"].waitForExistence(timeout: 15), "Requesting information must return to Inbox")
        try require(row.waitForExistence(timeout: 15), "Need Info must not remove the request from Inbox")
        XCTAssertTrue(row.label.contains("Needs More Info"))

        app.terminate(); app.launch()
        try require(inbox.waitForExistence(timeout: 20), "Relaunch must restore the authenticated Inbox")
        inbox.tap()
        try require(app.navigationBars["Today"].waitForExistence(timeout: 15), "The restored client must open Inbox")
        try require(row.waitForExistence(timeout: 15), "The needs-information request must still be reachable after relaunch")
        try reveal(row)
        XCTAssertTrue(row.label.contains("Needs More Info"))
        attachScreenshot("Native needs-information approval restored after relaunch")
        row.tap()
        try require(summary.waitForExistence(timeout: 10), "Reopening must retain the approval's exact summary")
        XCTAssertEqual(summary.label, fixture.approvalSummary)
        XCTAssertFalse(needsInfo.exists, "An existing information request must offer a final decision rather than repeating Need Info")
        let approve = app.buttons["approval.decision.approved.\(fixture.approvalId)"]
        try reveal(approve); approve.tap()
        let approved = try await waitForApproval("approved")
        XCTAssertEqual(approved.id, initial.id)
        XCTAssertEqual(approved.taskId, fixture.approvalTaskId)
        XCTAssertEqual(approved.summary, fixture.approvalSummary)
        XCTAssertNotNil(approved.resolvedBy)
        try require(app.navigationBars["Today"].waitForExistence(timeout: 15), "Approving must return to Inbox")
        let removed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: row)
        try require(XCTWaiter.wait(for: [removed], timeout: 15) == .completed, "A completed approval must leave the actionable Inbox")
        for status in ["pending", "needs_more_info"] {
            let approvals = try await peerApprovals(status: status)
            XCTAssertFalse(approvals.contains { $0.id == fixture.approvalId }, "The server must remove the approved request from \(status)")
        }
        attachScreenshot("Native approval completed and removed from Inbox")
        try attachRecord(["approval_id": approved.id, "task_id": approved.taskId,
                          "initial_status": initial.status, "after_need_info": waiting.status,
                          "final_status": approved.status, "resolved_by": approved.resolvedBy ?? ""],
                         name: "Real approval recovery and final decision")
    }

    @MainActor
    func testGoalCancellationRequiresConfirmationAndKeepGoalDoesNotMutateServer() async throws {
        try await pairNative(name: "Native goal cancellation CI")
        try require(fixture.cancellationGoalId != fixture.goalId, "Cancellation must use an independent fixture goal")
        let initial = try await peerGoalBundle(goalId: fixture.cancellationGoalId)
        XCTAssertEqual(initial.goal.id, fixture.cancellationGoalId)
        XCTAssertEqual(initial.goal.title, fixture.cancellationGoalTitle)
        try require(initial.goal.status == "draft" && initial.tasks.isEmpty, "Cancellation must start with an isolated draft goal without child work")
        app.tabBars.buttons["More"].tap()
        let goals = app.buttons["Goals"]
        try reveal(goals); goals.tap()
        let goal = app.buttons["workspace.goals.\(fixture.cancellationGoalId)"]
        try require(goal.waitForExistence(timeout: 15), "The independent cancellation goal must appear in Goals")
        XCTAssertTrue(goal.label.contains(fixture.cancellationGoalTitle))
        try reveal(goal); goal.tap()
        let visibleStatus = app.descendants(matching: .any).matching(identifier: "goal.status.\(fixture.cancellationGoalId)").firstMatch
        try require(visibleStatus.waitForExistence(timeout: 15), "Goal detail must expose its current server status")
        try waitForValue(visibleStatus, initial.goal.status, message: "The independent goal must display its initial server status")
        let request = app.buttons["goal.cancel.request.\(fixture.cancellationGoalId)"]
        try reveal(request); request.tap()
        let keep = try cancellationDialogButton("dismiss", label: "Keep goal")
        try require(keep.waitForExistence(timeout: 10), "Cancelling a goal must first expose a Keep goal choice")
        let beforeDecision = try await peerGoalBundle(goalId: fixture.cancellationGoalId)
        XCTAssertEqual(beforeDecision.goal.status, initial.goal.status)
        XCTAssertEqual(beforeDecision.events.map(\.id), initial.events.map(\.id), "Opening confirmation must not issue a goal mutation")
        attachScreenshot("Native goal cancellation requires confirmation")
        keep.tap()
        let dismissed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: keep)
        try require(XCTWaiter.wait(for: [dismissed], timeout: 10) == .completed, "Keep goal must dismiss the confirmation")
        let kept = try await peerGoalBundle(goalId: fixture.cancellationGoalId)
        XCTAssertEqual(kept.goal.status, initial.goal.status)
        XCTAssertEqual(kept.goal.updatedAt, initial.goal.updatedAt)
        XCTAssertEqual(kept.events.map(\.id), initial.events.map(\.id), "Keep goal must leave the real server audit stream unchanged")
        try waitForValue(visibleStatus, kept.goal.status, message: "Keep goal must preserve the displayed server status")
        try reveal(request)
        attachScreenshot("Native goal preserved after dismissing cancellation")
        request.tap()
        let confirm = try cancellationDialogButton("confirm", label: "Cancel goal")
        try require(confirm.waitForExistence(timeout: 10), "The destructive confirmation must be available on the second attempt")
        confirm.tap()
        let cancelled = try await waitForCancelledGoal()
        XCTAssertEqual(cancelled.goal.id, fixture.cancellationGoalId)
        XCTAssertEqual(cancelled.events.filter { $0.type == "goal.cancelled" }.count,
                       initial.events.filter { $0.type == "goal.cancelled" }.count + 1,
                       "One explicit confirmation must persist exactly one cancellation event")
        try waitForValue(visibleStatus, "cancelled", message: "Goal detail must display the server-confirmed cancelled state")
        let actionRemoved = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: request)
        try require(XCTWaiter.wait(for: [actionRemoved], timeout: 10) == .completed, "The cancelled goal must no longer offer cancellation")
        attachScreenshot("Native goal cancelled after explicit confirmation")
        try attachRecord(["goal_id": cancelled.goal.id, "initial_status": initial.goal.status,
                          "after_keep_goal": kept.goal.status, "final_status": cancelled.goal.status,
                          "events_before_confirmation": String(kept.events.count),
                          "cancellation_event_id": cancelled.events.first { $0.type == "goal.cancelled" }?.id ?? ""],
                         name: "Real goal cancellation confirmation boundary")
    }

    @MainActor
    func testMemberDeviceRevocationRequiresFreshPairingAfterRelaunch() async throws {
        try await pairNative(name: fixture.memberNativeDeviceName, pairingToken: fixture.memberPeerToken)
        let original = try await memberPhone(named: fixture.memberNativeDeviceName)
        try require(original.trust == "active", "The member's UI pairing must create an active phone")
        try openMemberDevices(phoneId: original.id)
        try attachConnectedScreenshot("Native member device permissions without pairing inputs")

        try openFixtureChannel()
        try waitForLiveConnection()
        // The owner browser waits for this UI-authored message before touching
        // Settings. It can revoke promptly, so do not wait on a disappearing
        // native message row after submitting the readiness message.
        try send(fixture.memberRevocationReadyMessage, waitForRenderedMessage: false)
        let ready = try await waitForMemberMessage(fixture.memberRevocationReadyMessage)
        let expired = app.staticTexts["pairing.connection.error"]
        try require(expired.waitForExistence(timeout: 45), "Owner revocation must return the native app to pairing")
        try require(expired.label.contains("expired or was revoked"), "The pairing page must explain why the member connection ended")
        try await waitForPairingState(allowAuthenticated: false)
        try require(!app.tabBars.buttons["Channels"].exists && !app.tabBars.buttons["More"].exists, "A revoked member must lose workspace navigation")
        let revoked = try await memberPhone(named: fixture.memberNativeDeviceName)
        try require(revoked.id == original.id && revoked.trust == "revoked" && revoked.revokedAt != nil, "The owner must revoke the same phone that paired through native UI")
        let retry = app.buttons["pairing.retrySavedConnection"]
        try reveal(retry); retry.tap()
        try await waitForPairingState(allowAuthenticated: false)
        try require(!app.tabBars.buttons["Channels"].exists, "Retry saved connection must not restore a revoked credential")

        // No onboarding screenshot is exported: the raw failure diagnostics
        // remain separate from the public HTML's approved workflow images.
        app.terminate(); app.launch()
        try await waitForPairingState(allowAuthenticated: false)
        try require(app.navigationBars["Welcome to Artoo"].exists && !app.tabBars.buttons["More"].exists, "Relaunch must remain disconnected after server revocation")
        try require(app.textFields["pairingCode"].value as? String == app.textFields["pairingCode"].placeholderValue
                    || (app.textFields["pairingCode"].value as? String ?? "").isEmpty, "Relaunch must not restore a pairing code")

        try await pairNative(name: fixture.memberRecoveryDeviceName, pairingToken: fixture.memberPeerToken)
        let recovered = try await memberPhone(named: fixture.memberRecoveryDeviceName)
        try require(recovered.id != original.id && recovered.trust == "active", "Fresh member pairing must create a different active phone")
        try openMemberDevices(phoneId: recovered.id)
        let oldRevoke = app.buttons["device.revoke.\(original.id)"]
        try require(!oldRevoke.exists, "The revoked phone must not retain an active revoke action")
        try openFixtureChannel()
        try waitForLiveConnection()
        try require(app.staticTexts[fixture.memberRevocationReadyMessage].waitForExistence(timeout: 15), "Member history must survive revocation and fresh pairing")
        try send(fixture.memberRecoveryMessage)
        let recovery = try await waitForMemberMessage(fixture.memberRecoveryMessage)
        try attachConnectedScreenshot("Native member restored after fresh pairing without pairing inputs")
        let finalOld = try await memberPhone(named: fixture.memberNativeDeviceName)
        try require(finalOld.trust == "revoked", "Fresh pairing must not reactivate the old device")
        try attachRecord(["member_user_id": fixture.memberUserId, "revoked_device_id": original.id,
                          "recovered_device_id": recovered.id, "readiness_message_id": ready.id,
                          "recovery_message_id": recovery.id, "old_device_status": finalOld.trust,
                          "recovered_device_status": recovered.trust, "relaunch_state": "disconnected"],
                         name: "Real member device revocation and fresh pairing recovery")
    }

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

        try await enterBackground()
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
        let instructions = replies.filter { $0.actorType == "system" && $0.actorId == "discussion-coordinator" }
            .sorted { ($0.payload?.discussionStep ?? -1) < ($1.payload?.discussionStep ?? -1) }
        try require(instructions.count == 3 && instructions.compactMap { $0.payload?.discussionStep } == [0, 1, 2],
                    "The real coordinator must persist exactly three ordered planning instructions")
        try require(instructions.allSatisfy { $0.kind == "text" && $0.threadRootId == discussion.threadRootId
            && $0.payload?.discussionId == discussion.id && $0.payload?.intent == "discussion"
            && !($0.payload?.assistantTurnId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "").isEmpty },
                    "Planning summaries must be tied to real coordinator messages in this discussion")
        try require(Set(instructions.compactMap { $0.payload?.assistantTurnId }).count == 3,
                    "Each coordinator instruction must identify a distinct real agent turn")
        let finalInstruction = try XCTUnwrap(instructions.last)
        let instructionHash = "sha256:" + SHA256.hash(data: Data(finalInstruction.body.utf8)).map { String(format: "%02x", $0) }.joined()
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
        // Visit each instruction with its actual reply in conversation order;
        // avoid a second full traversal of this long compact-screen thread.
        for instruction in instructions {
            let step = try XCTUnwrap(instruction.payload?.discussionStep)
            let title = app.staticTexts["message.planning.title.\(instruction.id)"]
            try reveal(title)
            try require(title.label == "Planning instruction · Step \(step + 1)", "Each real coordinator step must display its readable summary title")
            let brief = app.staticTexts["message.planning.summary.\(instruction.id)"]
            try reveal(brief)
            try require(brief.label == "The agents use the goal and earlier replies to prepare a plan. You review a proposal before accepting it.",
                        "Coordinator instructions must show the human-readable planning brief")
            let toggle = app.buttons["message.planning.original.\(instruction.id)"]
            try require(toggle.exists && toggle.value as? String == "Collapsed", "Agent instructions must start collapsed")
            let originalInstruction = app.staticTexts["message.\(instruction.id)"]
            try require(!originalInstruction.exists, "The raw coordinator prompt must not be displayed by default")
            let matchingReplies = agentReplies.filter { $0.payload?.assistantTurnId == instruction.payload?.assistantTurnId }
            try require(matchingReplies.count == 1, "Each summarized instruction must have exactly one real agent reply")
            let reply = try XCTUnwrap(matchingReplies.first)
            if instruction.id == finalInstruction.id {
                try require(reply.id == synthesis.id, "The final instruction must belong to the validated plan synthesis")
                // Move the entire disclosure above the fixed composer before
                // asking XCTest for its activation point.
                try revealText(toggle)
                try require(toggle.isEnabled && toggle.isHittable, "Show agent instructions must be reachable")
                try attachConnectedScreenshot("Native planning instructions summarized before proposal")
                toggle.tap()
                try waitForValue(toggle, "Expanded", message: "Show agent instructions must expand the actual coordinator prompt")
                // Only the expanded original is selectable text. Summary labels
                // and buttons retain strict hittability checks above.
                try revealText(originalInstruction)
                try require(Array(originalInstruction.label.utf8) == Array(instruction.body.utf8),
                            "Expanded coordinator instructions must match the exact persisted server body")
                let displayedHash = "sha256:" + SHA256.hash(data: Data(originalInstruction.label.utf8)).map { String(format: "%02x", $0) }.joined()
                try require(displayedHash == instructionHash, "The full displayed instruction must retain its server-body hash")
                try attachConnectedScreenshot("Native original coordinator instruction expanded")
                try revealText(toggle, preferTop: true)
                try require(toggle.isEnabled && toggle.isHittable, "Hide agent instructions must be reachable")
                try require(toggle.value as? String == "Expanded", "The coordinator prompt must remain expanded before testing Hide")
                toggle.tap()
                try waitForValue(toggle, "Collapsed", message: "Hide agent instructions must collapse the prompt again")
                let hidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: originalInstruction)
                try require(XCTWaiter.wait(for: [hidden], timeout: 5) == .completed, "Collapsing coordinator instructions must remove the original text")
            }
            if reply.id != synthesis.id {
                let body = app.staticTexts["message.\(reply.id)"]
                try revealText(body)
                XCTAssertEqual(body.label, reply.body)
            }
            let author = app.staticTexts["messageAuthor.\(reply.id)"]
            try reveal(author)
            let name = reply.actorId == fixture.plannerInstanceId ? fixture.plannerName : fixture.reviewerName
            let named = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label BEGINSWITH %@", "\(name) · "), object: author)
            try require(XCTWaiter.wait(for: [named], timeout: 15) == .completed, "Real agent replies must show their display name and timestamp, not an instance ID")
        }
        let draftTitle = app.staticTexts["message.plan.title.\(synthesis.id)"]
        try revealText(draftTitle); XCTAssertEqual(draftTitle.label, "Suggested plan")
        let originalBody = app.staticTexts["message.\(synthesis.id)"]
        XCTAssertFalse(originalBody.exists, "The original JSON must be collapsed when the suggested plan first appears")
        let rationale = app.staticTexts["message.plan.rationale.\(synthesis.id)"]
        try revealText(rationale); XCTAssertEqual(rationale.label, draft.rationale)
        for (index, task) in draft.taskSpecs.enumerated() {
            let title = app.staticTexts["message.plan.task.title.\(synthesis.id).\(index)"]
            try revealText(title); XCTAssertEqual(title.label, "\(index + 1). \(task.title)")
            let description = app.staticTexts["message.plan.task.description.\(synthesis.id).\(index)"]
            try revealText(description); XCTAssertEqual(description.label, task.description)
            for (criterionIndex, criterion) in task.acceptanceCriteria.enumerated() {
                let label = app.staticTexts["message.plan.task.criterion.\(synthesis.id).\(index).\(criterionIndex)"]
                try revealText(label); XCTAssertEqual(label.label, criterion)
            }
            if !task.requiredCapabilities.isEmpty {
                let capabilities = app.staticTexts["message.plan.task.capabilities.\(synthesis.id).\(index)"]
                try revealText(capabilities); XCTAssertEqual(capabilities.label, "Capabilities: \(task.requiredCapabilities.joined(separator: ", "))")
            }
            for (artifactIndex, artifact) in task.expectedArtifacts.enumerated() {
                let label = app.staticTexts["message.plan.task.artifact.\(synthesis.id).\(index).\(artifactIndex)"]
                try revealText(label)
                XCTAssertEqual(label.label, artifact.description.isEmpty ? artifact.type : "\(artifact.type): \(artifact.description)")
            }
        }
        let draftDependency = app.staticTexts["message.plan.task.dependency.\(synthesis.id).1.0"]
        try revealText(draftDependency)
        XCTAssertEqual(draftDependency.label, "Depends on: 1. \(fixture.task1Title)", "The draft must resolve its standard dependency to the numbered task name")
        attachScreenshot("Native suggested plan card before proposal")
        let planHierarchy = XCTAttachment(string: app.debugDescription)
        planHierarchy.name = "Native suggested plan accessibility before original reply"
        planHierarchy.lifetime = .keepAlways; add(planHierarchy)
        let originalToggle = app.buttons["message.plan.original.\(synthesis.id)"]
        try revealText(originalToggle)
        try require(originalToggle.isEnabled && originalToggle.isHittable, "Show original reply must be reachable")
        try waitForValue(originalToggle, "Collapsed", message: "The original-reply button must expose its collapsed state")
        originalToggle.tap()
        try waitForValue(originalToggle, "Expanded", message: "Tapping the original-reply button must expand the exact reply")
        try revealText(originalBody); XCTAssertEqual(originalBody.label, synthesis.body, "Expanding the original must preserve the exact server reply")
        attachScreenshot("Native suggested plan with original reply expanded")
        try revealText(originalToggle, preferTop: true)
        try require(originalToggle.isEnabled && originalToggle.isHittable, "Hide original reply must be reachable")
        try require(originalToggle.value as? String == "Expanded", "The original reply must remain expanded before testing Hide")
        originalToggle.tap()
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
                          "coordinator_message_ids": instructions.map(\.id).joined(separator: ","),
                          "final_instruction_body_sha256": instructionHash,
                          "runtime_validation": "deterministic process fixtures over authenticated node WebSocket; not live provider validation"],
                         name: "Real discussion and materialized task identities")
    }

    @MainActor
    private func assignmentOption(instanceId: String) throws -> XCUIElement {
        let identified = app.descendants(matching: .any).matching(identifier: "task.assignment.option.\(instanceId)").firstMatch
        if identified.waitForExistence(timeout: 2) { return identified }
        let fullIdentity = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Instance: \(instanceId)"))
        try require(fullIdentity.firstMatch.waitForExistence(timeout: 5) && fullIdentity.count == 1,
                    "An assignment fallback must identify exactly one option by its complete instance ID")
        return fullIdentity.firstMatch
    }

    @MainActor
    private func revealAssignmentPair(_ original: XCUIElement, _ collision: XCUIElement) throws {
        try require(!app.keyboards.firstMatch.exists, "Executor identity evidence must not be covered by a keyboard")
        for attempt in 0..<6 {
            let navigation = app.navigationBars.firstMatch
            let tabs = app.tabBars.firstMatch
            let top = navigation.exists ? max(app.frame.minY, navigation.frame.maxY) : app.frame.minY
            let bottom = tabs.exists ? min(app.frame.maxY, tabs.frame.minY) : app.frame.maxY
            let viewport = CGRect(x: app.frame.minX, y: top + 2, width: app.frame.width, height: max(0, bottom - top - 4))
            try require(!viewport.isEmpty && !viewport.isNull && !viewport.isInfinite, "Assignment options require an unobscured viewport")
            let frames = [original.frame, collision.frame]
            var scrollUp = attempt < 3
            if frames.allSatisfy({ !$0.isEmpty && !$0.isNull && !$0.isInfinite }) {
                if frames.allSatisfy({ viewport.contains($0) }) && original.isHittable && collision.isHittable { return }
                scrollUp = frames[0].union(frames[1]).midY > viewport.midY
            }
            let startY = viewport.minY + viewport.height * (scrollUp ? 0.65 : 0.35)
            let endY = viewport.minY + viewport.height * (scrollUp ? 0.35 : 0.65)
            let origin = app.coordinate(withNormalizedOffset: .zero)
            origin.withOffset(CGVector(dx: viewport.midX, dy: startY))
                .press(forDuration: 0.05, thenDragTo: origin.withOffset(CGVector(dx: viewport.midX, dy: endY)))
        }
        try require(false, "Both executor options and their full IDs must be visible together before taking the screenshot")
    }

    @MainActor
    private func enterBackground() async throws {
        func stateName(_ state: XCUIApplication.State) -> String {
            switch state {
            case .unknown: return "unknown"
            case .notRunning: return "not_running"
            case .runningForeground: return "foreground"
            case .runningBackground: return "background"
            case .runningBackgroundSuspended: return "background_suspended"
            @unknown default: return "unrecognized_\(state.rawValue)"
            }
        }
        var transitions: [String] = []
        var homePresses = 0
        for attempt in 1...3 {
            var pressed = false
            var lastState: XCUIApplication.State?
            let deadline = Date().addingTimeInterval(10)
            repeat {
                let state = app.state
                if state != lastState {
                    let observation = "attempt \(attempt): \(stateName(state))"
                    transitions.append(observation)
                    print("[native-ui] Background transition \(observation)")
                    lastState = state
                }
                if state == .runningBackground || state == .runningBackgroundSuspended {
                    try attachRecord(["home_presses": String(homePresses), "confirmed_state": stateName(state),
                                      "observed_states": transitions.joined(separator: " -> ")], name: "Native background transition states")
                    return
                }
                try require(state != .notRunning, "The app exited instead of entering the background: \(transitions.joined(separator: " -> "))")
                // Retry only an observed foreground app. Both legitimate
                // background states are checked throughout each bounded wait.
                if state == .runningForeground && !pressed {
                    XCUIDevice.shared.press(.home)
                    homePresses += 1
                    pressed = true
                }
                try await Task.sleep(nanoseconds: 250_000_000)
            } while Date() < deadline
        }
        try require(false, "The app must enter the background after at most three Home presses: \(transitions.joined(separator: " -> "))")
    }

    @MainActor
    private func editableField(_ identifier: String) -> XCUIElement {
        let field = app.textFields.matching(identifier: identifier).firstMatch
        if field.waitForExistence(timeout: 2) { return field }
        return app.textViews.matching(identifier: identifier).firstMatch
    }

    @MainActor
    private func cancellationDialogButton(_ action: String, label: String) throws -> XCUIElement {
        let title = "Cancel this goal?"
        let alerts = app.alerts.containing(.staticText, identifier: title), sheets = app.sheets.containing(.staticText, identifier: title)
        try require(alerts.firstMatch.waitForExistence(timeout: 10) || sheets.firstMatch.waitForExistence(timeout: 2),
                    "The native goal cancellation confirmation must be presented")
        let dialogs = alerts.allElementsBoundByIndex + sheets.allElementsBoundByIndex
        try require(dialogs.count == 1, "Exactly one titled goal cancellation confirmation must be active")
        let dialog = dialogs[0]
        try require(dialog.staticTexts.matching(NSPredicate(format: "label == %@", title)).count == 1,
                    "The goal confirmation must expose its exact title once")
        let warning = "This cancels the goal and its unfinished tasks. Active runs must stop before cancellation completes. A cancelled goal cannot be resumed."
        let messages = dialog.staticTexts.matching(NSPredicate(format: "label == %@", warning))
        try require(messages.firstMatch.waitForExistence(timeout: 10) && messages.count == 1,
                    "The active goal confirmation must expose its exact cancellation warning")
        try require(dialog.frame.contains(messages.element(boundBy: 0).frame), "The goal cancellation warning must be fully contained in its confirmation")
        let identifier = "goal.cancel.\(action).\(fixture.cancellationGoalId)", expectedLabel = NSPredicate(format: "label == %@", label)
        let identified = dialog.buttons.matching(identifier: identifier)
        let hasIdentifier = identified.firstMatch.waitForExistence(timeout: 2)
        let matches = hasIdentifier ? identified.matching(expectedLabel) : dialog.buttons.matching(expectedLabel)
        try require(matches.firstMatch.waitForExistence(timeout: 5), "The goal confirmation must expose its exact \(label) action")
        let candidates = matches.allElementsBoundByIndex
        let leaves = candidates.filter { $0.descendants(matching: .button).count == 0 }
        try require(leaves.count == 1, "The goal confirmation must expose exactly one leaf \(label) button")
        let button = leaves[0]
        try require(candidates.allSatisfy { candidate in
            if candidate === button { return true }
            let descendants = candidate.descendants(matching: .button).allElementsBoundByIndex
            return candidate.frame.contains(button.frame) && !descendants.isEmpty
                && descendants.allSatisfy { $0.label == label && (!hasIdentifier || $0.identifier == identifier) }
        }, "Only nested wrappers of the exact goal action may share its identity")
        try require(button.label == label && button.isEnabled && button.isHittable,
                    "The goal confirmation's unique \(label) button must be actionable")
        return button
    }

    @MainActor
    private func pairNative(name: String, pairingToken: String? = nil) async throws {
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
        let code: PairingCode = try await peerPost("api/v1/devices/pairings", body: ["intended_platform": "ios"], token: pairingToken)
        let origin = app.textFields["serverURL"]
        let localHTTP = app.switches["allowLocalHTTP"]
        if fixture.serverURL.scheme == "http" {
            try setSwitchOn(localHTTP, message: "Local HTTP must be enabled through the onboarding switch")
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
    private func openMemberDevices(phoneId: String) throws {
        app.tabBars.buttons["More"].tap()
        let account = app.staticTexts["workspace.account.name"]
        try require(account.waitForExistence(timeout: 10) && account.label == fixture.memberName, "The native workspace must display the member account")
        try require(!app.buttons["Manage projects"].exists, "A member must not have administrator project management")
        let devices = app.buttons["Devices"]
        try reveal(devices); devices.tap()
        try require(app.navigationBars["Devices"].waitForExistence(timeout: 10), "More must open the member Devices page")
        let own = app.descendants(matching: .any).matching(identifier: "device.row.\(phoneId)").firstMatch
        try require(own.waitForExistence(timeout: 15), "The phone paired by this member must appear in Devices")
        try reveal(own)
        let ownRevoke = app.buttons["device.revoke.\(phoneId)"]
        try require(ownRevoke.exists && ownRevoke.isEnabled, "A member must be allowed to revoke their own phone")
        let other = app.descendants(matching: .any).matching(identifier: "device.row.\(fixture.ownerDeviceId)").firstMatch
        try reveal(other)
        try require(!app.buttons["device.revoke.\(fixture.ownerDeviceId)"].exists, "A member must not be offered revocation of the owner's device")
        let pending = app.descendants(matching: .any).matching(identifier: "device.row.\(fixture.memberPendingMacId)").firstMatch
        try reveal(pending)
        try require(app.staticTexts[fixture.memberPendingMacName].exists, "The member's pending Mac must be visible")
        try require(app.staticTexts["device.enrollment.pending.\(fixture.memberPendingMacId)"].exists, "A member must see that computer enrollment needs an owner or admin")
        try require(!app.buttons["device.enroll.\(fixture.memberPendingMacId)"].exists, "Pairing as a member must not grant computer enrollment")
    }

    @MainActor
    private func openFixtureChannel() throws {
        app.tabBars.buttons["Channels"].tap()
        try require(app.navigationBars["Channels"].waitForExistence(timeout: 10), "Channels must open the channel list")
        let channel = app.buttons["channel.\(fixture.channelId)"]
        try require(channel.waitForExistence(timeout: 15), "The shared fixture channel must be available to the member")
        try reveal(channel); channel.tap()
    }

    @MainActor
    private func attachConnectedScreenshot(_ name: String) throws {
        // Deliberate workflow images admitted to public HTML must never contain
        // an onboarding field or a generated pairing code.
        for identifier in ["serverURL", "pairingDeviceName", "pairingCode", "device.pairing.code"] {
            try require(!app.descendants(matching: .any).matching(identifier: identifier).firstMatch.exists, "Workflow report screenshots must exclude pairing inputs and generated codes")
        }
        attachScreenshot(name)
    }

    @MainActor
    private func memberPhone(named name: String) async throws -> ServerDevice {
        let page: DevicePage = try await peerGet("api/v1/devices")
        let matches = page.devices.filter { $0.displayName == name }
        try require(matches.count == 1, "Native pairing must create exactly one device with its unique name")
        let phone = try XCTUnwrap(matches.first)
        try require(phone.enrolledByUserId == fixture.memberUserId && phone.platform == "ios" && phone.computerId == nil, "The native phone must retain the member identity without compute authority")
        return phone
    }

    @MainActor
    private func waitForMemberMessage(_ body: String) async throws -> ServerMessage {
        let deadline = Date().addingTimeInterval(20)
        repeat {
            let matches = try await peerMessages().filter { $0.body == body }
            if !matches.isEmpty {
                try require(matches.count == 1, "The member message must persist once")
                let message = try XCTUnwrap(matches.first)
                try require(message.actorType == "user" && message.actorId == fixture.memberUserId && message.threadRootId == nil, "Native messages must be attributed to the member before and after recovery")
                return message
            }
            try await Task.sleep(nanoseconds: 250_000_000)
        } while Date() < deadline
        throw NSError(domain: "ArtooUITestMember", code: 1, userInfo: [NSLocalizedDescriptionKey: "The native member message was not persisted"])
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
        // iOS 18 exposes the Stepper as a value container whose own hit test
        // is false even when both real adjustment buttons are on screen.
        try reveal(stepper.buttons.firstMatch)
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
    private func setSwitchOn(_ element: XCUIElement, message: String) throws {
        for _ in 0..<3 {
            let nested = element.switches.firstMatch
            let control = nested.exists ? nested : element
            try reveal(control)
            try require(control.isEnabled, "The onboarding switch must be enabled before tapping")
            // A first tap can be dropped while a fresh simulator is busy.
            // Re-read state before retrying, so a delayed success is never
            // toggled back off. All changes still use the actual native UI.
            if element.value as? String == "1" { return }
            try require(element.value as? String == "0", "The onboarding switch must expose a known off/on state")
            control.tap()
            let changed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "1"), object: element)
            if XCTWaiter.wait(for: [changed], timeout: 3) == .completed { return }
        }
        try waitForValue(element, "1", message: message)
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
    private func send(_ body: String, waitForRenderedMessage: Bool = true) throws {
        let composer = app.descendants(matching: .any).matching(identifier: "messageComposer").firstMatch
        try reveal(composer)
        try replace(composer, with: body)
        try dismissKeyboard(using: "conversation.keyboard.done")
        let button = app.buttons["sendMessage"]
        try reveal(button)
        try require(button.isEnabled, "The message send control must be enabled")
        button.tap()
        if waitForRenderedMessage { try require(app.staticTexts[body].waitForExistence(timeout: 15), "The native send must complete against the real server") }
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
        let enteredInput = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", text), object: field)
        try require(XCTWaiter.wait(for: [enteredInput], timeout: 45) == .completed, "The original native typing operation must finish with the exact intended text")
        try require(field.value as? String == text, "The native input must exactly match the replacement text")
    }

    @MainActor
    private func dismissKeyboard(using identifier: String) throws {
        let done = app.buttons[identifier]
        try require(done.waitForExistence(timeout: 10) && done.isHittable,
                    "Multiline input must expose a reachable keyboard Done action")
        done.tap()
        let dismissed = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"), object: app.keyboards.firstMatch)
        try require(XCTWaiter.wait(for: [dismissed], timeout: 10) == .completed,
                    "Done must dismiss the keyboard before continuing the workflow")
    }

    @MainActor
    private func revealText(_ element: XCUIElement, preferTop: Bool = false) throws {
        // Selectable SwiftUI text can be visibly rendered yet make XCTest's
        // activation-point lookup throw. Read-only checks need visible content.
        // Disclosure callers also require enabled/hittable controls before taps.
        let list = app.collectionViews.firstMatch
        try require(list.exists, "The displayed text must belong to a visible list")
        try require(!app.keyboards.firstMatch.exists, "Read-only content must not be covered by the keyboard")
        for attempt in 0..<24 {
            var viewport = list.frame.intersection(app.frame)
            let navigation = app.navigationBars.firstMatch
            let tabs = app.tabBars.firstMatch
            var top = navigation.exists ? max(viewport.minY, navigation.frame.maxY) : viewport.minY
            var bottom = tabs.exists ? min(viewport.maxY, tabs.frame.minY) : viewport.maxY
            let connection = app.descendants(matching: .any).matching(identifier: "realtimeStatus").firstMatch
            let composer = app.descendants(matching: .any).matching(identifier: "conversation.composer").firstMatch
            if connection.exists && !connection.frame.isEmpty { top = max(top, connection.frame.maxY + 4) }
            if composer.exists && !composer.frame.isEmpty { bottom = min(bottom, composer.frame.minY - 4) }
            viewport = CGRect(x: viewport.minX, y: top, width: viewport.width, height: max(0, bottom - top)).insetBy(dx: 2, dy: 2)
            try require(!viewport.isEmpty && !viewport.isNull && !viewport.isInfinite,
                        "The list must have an unobscured content viewport")
            var scrollUp = preferTop ? attempt >= 12 : attempt < 12
            if element.exists {
                let frame = element.frame
                if !frame.isEmpty && !frame.isNull && !frame.isInfinite {
                    let visible = frame.intersection(viewport)
                    // Text that fits must be completely visible. Text taller
                    // than the viewport must show at least half of it. Exact content
                    // is independently asserted by the caller against the server.
                    let requiredHeight = frame.height <= viewport.height ? frame.height : viewport.height / 2
                    if !visible.isNull && visible.width >= frame.width - 1
                        && visible.height >= requiredHeight - 1 { return }
                    // Move only the distance needed to reveal the required
                    // height. A fixed swipe can fling an expanded reply past
                    // the opposite edge and oscillate without showing it all.
                    let above = max(0, viewport.minY + requiredHeight - frame.maxY)
                    let below = max(0, frame.minY + requiredHeight - viewport.maxY)
                    try require(above > 0 || below > 0,
                                "Vertical scrolling cannot resolve horizontal text clipping")
                    scrollUp = below > 0
                    let gap = scrollUp ? below : above
                    var distance = min(viewport.height * 0.3, max(24, gap + 12))
                    if frame.height <= viewport.height {
                        // Near-screen-height text has too little spare room
                        // for the normal minimum drag or interior margin.
                        distance = min(distance, gap + max(0, viewport.height - frame.height))
                    }
                    let start = CGPoint(x: viewport.midX, y: viewport.midY + (scrollUp ? distance : -distance) / 2)
                    let end = CGPoint(x: viewport.midX, y: viewport.midY - (scrollUp ? distance : -distance) / 2)
                    try require(distance.isFinite && distance > 0 && viewport.contains(start) && viewport.contains(end),
                                "Text alignment must stay inside the unobscured viewport")
                    let origin = app.coordinate(withNormalizedOffset: .zero)
                    origin.withOffset(CGVector(dx: start.x, dy: start.y))
                        .press(forDuration: 0.05, thenDragTo: origin.withOffset(CGVector(dx: end.x, dy: end.y)),
                               withVelocity: .slow, thenHoldForDuration: 0.2)
                    continue
                }
            }
            // Short drags start inside the actual content, avoiding tab bars and
            // skipping over a short label inside a plan taller than the screen.
            let startY = viewport.minY + viewport.height * (scrollUp ? 0.7 : 0.3)
            let endY = viewport.minY + viewport.height * (scrollUp ? 0.3 : 0.7)
            let origin = app.coordinate(withNormalizedOffset: .zero)
            origin.withOffset(CGVector(dx: viewport.midX, dy: startY))
                .press(forDuration: 0.05, thenDragTo: origin.withOffset(CGVector(dx: viewport.midX, dy: endY)))
        }
        try require(false, "Required text must be visibly rendered in the unobscured list")
    }

    @MainActor
    private func reveal(_ element: XCUIElement) throws {
        for attempt in 0..<10 {
            if element.exists && element.isHittable { return }
            // App-wide swipes can begin on the keyboard after a form grows.
            // Keep both drag points in the visible native content instead.
            let bounds = app.frame
            let list = app.collectionViews.firstMatch
            let rect = list.exists ? list.frame.intersection(bounds) : bounds
            let navigation = app.navigationBars.firstMatch
            let tabs = app.tabBars.firstMatch
            let keyboard = app.keyboards.firstMatch
            let top = navigation.exists ? max(rect.minY, navigation.frame.maxY) : rect.minY
            var bottom = tabs.exists ? min(rect.maxY, tabs.frame.minY) : rect.maxY
            if keyboard.exists { bottom = min(bottom, keyboard.frame.minY) }
            let viewport = CGRect(x: rect.minX + 6, y: top + 8,
                                  width: rect.width - 12, height: bottom - top - 16)
            try require([viewport.minX, viewport.minY, viewport.width, viewport.height].allSatisfy { $0.isFinite }
                        && !viewport.isEmpty && bounds.contains(viewport),
                        "Control scrolling must stay inside finite content bounds above the keyboard")
            let frame = element.exists ? element.frame : .zero
            let known = !frame.isEmpty && [frame.minX, frame.minY, frame.width, frame.height].allSatisfy { $0.isFinite }
            let upward = known ? frame.midY > viewport.midY : attempt < 5
            let origin = app.coordinate(withNormalizedOffset: .zero)
            origin.withOffset(CGVector(dx: viewport.midX, dy: viewport.minY + viewport.height * (upward ? 0.7 : 0.3)))
                .press(forDuration: 0.05, thenDragTo: origin.withOffset(CGVector(dx: viewport.midX, dy: viewport.minY + viewport.height * (upward ? 0.3 : 0.7))))
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

    private func peerApprovals(status: String) async throws -> [ServerApproval] {
        var components = URLComponents(url: fixture.serverURL.appendingPathComponent("api/v1/approvals"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "status", value: status)]
        let response: ApprovalPage = try await peerRequest(URLRequest(url: components.url!))
        return response.approvals
    }

    private func peerExecutionTasks() async throws -> [ExecutionTask] {
        var components = URLComponents(url: fixture.serverURL.appendingPathComponent("api/v1/tasks"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "project_id", value: fixture.projectId)]
        let page: ExecutionTaskPage = try await peerRequest(URLRequest(url: components.url!))
        return page.tasks
    }

    private func waitForCreatedExecutionTask() async throws -> ExecutionTask {
        let deadline = Date().addingTimeInterval(30)
        repeat {
            let tasks = try await peerExecutionTasks().filter { $0.title == fixture.executionTaskTitle }
            if tasks.count == 1 { return tasks[0] }
            if tasks.count > 1 { break }
            try await Task.sleep(nanoseconds: 250_000_000)
        } while Date() < deadline
        throw NSError(domain: "ArtooUITestExecution", code: 1, userInfo: [NSLocalizedDescriptionKey: "Native creation must persist exactly one uniquely titled execution task"])
    }

    private func waitForExecutionTask(_ id: String, timeout: TimeInterval = 30, _ predicate: (ExecutionTaskSnapshot) -> Bool) async throws -> ExecutionTaskSnapshot {
        let deadline = Date().addingTimeInterval(timeout)
        repeat {
            let snapshot: ExecutionTaskSnapshot = try await peerGet("api/v1/tasks/\(id)")
            if predicate(snapshot) { return snapshot }
            if let failed = snapshot.runs.first(where: { ["failed", "cancelled"].contains($0.status) }) {
                throw NSError(domain: "ArtooUITestExecution", code: 2, userInfo: [NSLocalizedDescriptionKey: "The real execution ended with \(failed.status): \(failed.failureReason ?? "no reported reason")"])
            }
            try await Task.sleep(nanoseconds: 250_000_000)
        } while Date() < deadline
        throw NSError(domain: "ArtooUITestExecution", code: 3, userInfo: [NSLocalizedDescriptionKey: "The real task did not reach its required state within \(timeout) seconds"])
    }

    private func peerArtifact(_ artifact: ExecutionArtifact) async throws -> Data {
        var request = URLRequest(url: fixture.serverURL.appendingPathComponent("api/v1/artifacts/\(artifact.id)/content"))
        request.setValue("Bearer \(fixture.peerToken)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 20
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: request)
        let http = try XCTUnwrap(response as? HTTPURLResponse)
        guard http.statusCode == 200 else {
            throw NSError(domain: "ArtooUITestExecution", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: "Authenticated artifact download failed"])
        }
        XCTAssertEqual(http.suggestedFilename, fixture.executionArtifactFilename)
        return data
    }

    private func waitForApproval(_ status: String) async throws -> ServerApproval {
        let deadline = Date().addingTimeInterval(20)
        repeat {
            let snapshot: ApprovalTaskSnapshot = try await peerGet("api/v1/tasks/\(fixture.approvalTaskId)")
            if let approval = snapshot.approvals.first(where: { $0.id == fixture.approvalId && $0.status == status }) { return approval }
            try await Task.sleep(nanoseconds: 250_000_000)
        } while Date() < deadline
        throw NSError(domain: "ArtooUITestApproval", code: 1, userInfo: [NSLocalizedDescriptionKey: "The real server did not confirm approval \(status) within 20 seconds"])
    }

    private func peerPost<Response: Decodable>(_ path: String, body: [String: String], token: String? = nil) async throws -> Response {
        var request = URLRequest(url: fixture.serverURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(UUID().uuidString, forHTTPHeaderField: "Idempotency-Key")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await peerRequest(request, token: token)
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

    private func peerGoalBundle(goalId: String? = nil) async throws -> GoalBundle {
        let response: GoalAuditResponse = try await peerGet("api/v1/goals/\(goalId ?? fixture.goalId)/audit-bundle")
        return response.bundle
    }

    private func waitForCancelledGoal() async throws -> GoalBundle {
        let deadline = Date().addingTimeInterval(30)
        repeat {
            let bundle = try await peerGoalBundle(goalId: fixture.cancellationGoalId)
            if bundle.goal.status == "cancelled" { return bundle }
            try await Task.sleep(nanoseconds: 250_000_000)
        } while Date() < deadline
        throw NSError(domain: "ArtooUITestGoal", code: 2, userInfo: [NSLocalizedDescriptionKey: "The real server did not confirm goal cancellation within 30 seconds"])
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
    let kind: String?
    let payload: ServerMessagePayload?
}
private struct ServerMessagePayload: Decodable {
    let discussionPlan: ServerPlanDraft?
    let discussionId: String?
    let discussionStep: Int?
    let assistantTurnId: String?
    let intent: String?
}
private struct ServerPlanDraft: Decodable {
    let version: Int; let discussionId: String; let goalId: String; let rationale: String; let taskSpecs: [ServerPlanTaskSpec]
}
private struct ServerPlanTaskSpec: Decodable {
    let title: String; let description: String; let acceptanceCriteria: [String]; let requiredCapabilities: [String]
    let expectedArtifacts: [ServerExpectedArtifact]
}
private struct ServerExpectedArtifact: Decodable { let type: String; let description: String }
private struct PairingCode: Decodable { let code: String }
private struct DevicePage: Decodable { let devices: [ServerDevice] }
private struct ServerDevice: Decodable {
    let id: String; let displayName: String; let enrolledByUserId: String; let platform: String
    let trust: String; let computerId: String?; let revokedAt: String?
}
private struct ApprovalPage: Decodable { let approvals: [ServerApproval] }
private struct ApprovalTaskSnapshot: Decodable { let approvals: [ServerApproval] }
private struct ServerApproval: Decodable {
    let id: String; let taskId: String; let summary: String; let status: String; let resolvedBy: String?
}
private struct ExecutionTaskPage: Decodable { let tasks: [ExecutionTask] }
private struct ExecutionTaskSnapshot: Decodable {
    let task: ExecutionTask; let runs: [ExecutionRun]; let approvals: [ExecutionApproval]; let artifacts: [ExecutionArtifact]
}
private struct ExecutionTask: Decodable {
    let id: String; let projectId: String; let title: String; let status: String
    let acceptanceCriteria: [String]; let requiredCapabilities: [String]
}
private struct ExecutionRun: Decodable {
    let id: String; let taskId: String; let status: String; let runtimeId: String
    let agentInstanceId: String; let computerId: String; let failureReason: String?
}
private struct ExecutionApproval: Decodable {
    let id: String; let action: String; let summary: String; let risk: String; let status: String
    let payloadRef: String?; let runId: String?
}
private struct ExecutionArtifact: Decodable {
    let id: String; let taskId: String; let runId: String; let type: String; let uri: String; let checksum: String
    let metadata: ExecutionArtifactMetadata
}
private struct ExecutionArtifactMetadata: Decodable { let filename: String; let size: Int }
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
private struct GoalBundle: Decodable { let goal: ServerGoal; let plans: [ServerPlan]; let tasks: [GoalTaskEnvelope]; let events: [ServerGoalEvent] }
private struct ServerGoal: Decodable { let id: String; let title: String; let status: String; let updatedAt: String }
private struct ServerGoalEvent: Decodable { let id: String; let type: String }
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
    let memberUserId: String
    let memberName: String
    let memberPeerToken: String
    let memberNativeDeviceName: String
    let memberRecoveryDeviceName: String
    let memberPendingMacId: String
    let memberPendingMacName: String
    let ownerDeviceId: String
    let memberRevocationReadyMessage: String
    let memberRecoveryMessage: String
    let computerId: String
    let computerName: String
    let goalId: String
    let goalTitle: String
    let approvalId: String
    let approvalSummary: String
    let approvalTaskId: String
    let cancellationGoalId: String
    let cancellationGoalTitle: String
    let executorInstanceId: String
    let executorCollisionInstanceId: String
    let executorName: String
    let executorRuntime: String
    let executionTaskTitle: String
    let executionCriterion1: String
    let executionCriterion2: String
    let executionApprovalSummary: String
    let executionArtifactFilename: String
    let executionArtifactMarker: String
    let executionReviewComment: String
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
        memberUserId = try require("ARTOO_UI_MEMBER_USER_ID")
        memberName = try require("ARTOO_UI_MEMBER_NAME")
        memberPeerToken = try require("ARTOO_UI_MEMBER_PEER_CONTROL_TOKEN")
        memberNativeDeviceName = try require("ARTOO_UI_MEMBER_NATIVE_DEVICE_NAME")
        memberRecoveryDeviceName = try require("ARTOO_UI_MEMBER_RECOVERY_DEVICE_NAME")
        memberPendingMacId = try require("ARTOO_UI_MEMBER_PENDING_MAC_ID")
        memberPendingMacName = try require("ARTOO_UI_MEMBER_PENDING_MAC_NAME")
        ownerDeviceId = try require("ARTOO_UI_OWNER_DEVICE_ID")
        memberRevocationReadyMessage = try require("ARTOO_UI_MEMBER_REVOCATION_READY_MESSAGE")
        memberRecoveryMessage = try require("ARTOO_UI_MEMBER_RECOVERY_MESSAGE")
        computerId = try require("ARTOO_UI_COMPUTER_ID")
        computerName = try require("ARTOO_UI_COMPUTER_NAME")
        goalId = try require("ARTOO_UI_GOAL_ID")
        goalTitle = try require("ARTOO_UI_GOAL_TITLE")
        approvalId = try require("ARTOO_UI_APPROVAL_ID")
        approvalSummary = try require("ARTOO_UI_APPROVAL_SUMMARY")
        approvalTaskId = try require("ARTOO_UI_APPROVAL_TASK_ID")
        cancellationGoalId = try require("ARTOO_UI_CANCELLATION_GOAL_ID")
        cancellationGoalTitle = try require("ARTOO_UI_CANCELLATION_GOAL_TITLE")
        executorInstanceId = try require("ARTOO_UI_EXECUTOR_INSTANCE_ID")
        executorCollisionInstanceId = try require("ARTOO_UI_EXECUTOR_COLLISION_INSTANCE_ID")
        executorName = try require("ARTOO_UI_EXECUTOR_NAME")
        executorRuntime = try require("ARTOO_UI_EXECUTOR_RUNTIME")
        executionTaskTitle = try require("ARTOO_UI_EXECUTION_TASK_TITLE")
        executionCriterion1 = try require("ARTOO_UI_EXECUTION_CRITERION_1")
        executionCriterion2 = try require("ARTOO_UI_EXECUTION_CRITERION_2")
        executionApprovalSummary = try require("ARTOO_UI_EXECUTION_APPROVAL_SUMMARY")
        executionArtifactFilename = try require("ARTOO_UI_EXECUTION_ARTIFACT_FILENAME")
        executionArtifactMarker = try require("ARTOO_UI_EXECUTION_ARTIFACT_MARKER")
        executionReviewComment = try require("ARTOO_UI_EXECUTION_REVIEW_COMMENT")
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
