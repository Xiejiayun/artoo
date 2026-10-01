import XCTest
import CryptoKit

/// Product mutations use the phone UI. API reads and fixture checkpoints only
/// observe the real task, production executions and disposable Git workspaces.
final class ExecutionCorrectionUITests: XCTestCase {
    private let app = XCUIApplication()
    private var fixture: CorrectionFixture!

    override func setUpWithError() throws {
        continueAfterFailure = false
        fixture = try CorrectionFixture(ProcessInfo.processInfo.environment)
    }

    override func tearDownWithError() throws { app.terminate() }

    @MainActor
    func testTaskCorrectionRetainsWorkAndConfirmsExactStop() async throws {
        do { try await correctionFlow() }
        catch {
            captureFailure()
            throw error
        }
    }

    @MainActor
    private func correctionFlow() async throws {
        try await pair()
        let before = try await observations()
        try require(before.snapshot == nil && before.receipts.isEmpty, "The fixture must not precreate this task or any execution")
        let taskId = try await createTask()
        try tapTaskButton("task.action.markReady.\(taskId)", label: "Mark Ready")
        let ready = try await waitForTask(taskId) { $0.task.status == "ready" }
        try require(ready.runs.isEmpty && ready.approvals.isEmpty && ready.artifacts.isEmpty, "Ready must not launch work or fabricate approval or artifacts")

        try await approveAndAssign(taskId: taskId, slot: 1)
        let initial = try await checkpoint("initial")
        let initialSnapshot = try snapshot(initial)
        let firstRun = try run(slot: 1, in: initial)
        let firstArtifact = try artifact(runId: firstRun.id, in: initialSnapshot)
        try await verifyDownloadedArtifact(firstArtifact, observation: initial)
        try assertStatus(taskId, "review")
        try showArtifact(firstArtifact)
        try screenshot("Native correction initial artifact details")
        try preview(firstArtifact, run: firstRun, stage: "initial", reviewEventId: nil, caption: "Native correction initial patch in Quick Look")

        try await requestChanges(taskId: taskId, comment: fixture.reviewComments[0])
        let changed = try await checkpoint("changes_requested")
        let firstReview = try review(comment: fixture.reviewComments[0], in: snapshot(changed))
        try require(firstReview.artifactIds == [firstArtifact.id], "The first review must record only the actual initial report")
        app.terminate(); app.launch()
        try require(app.tabBars.buttons["Tasks"].waitForExistence(timeout: 20), "Relaunch must restore the paired native session")
        try openTask(taskId)
        try assertStatus(taskId, "ready")
        try showReview(firstReview)
        try screenshot("Native correction feedback after relaunch")
        let reopened: CorrectionSnapshot = try await get("api/v1/tasks/\(taskId)")
        try require(reopened.reviews == snapshot(changed).reviews && reopened.runs.map(\.id).sorted() == [firstRun.id], "Relaunch must preserve the review and run identities without resubmitting work")

        try await approveAndAssign(taskId: taskId, slot: 2)
        let failed = try await checkpoint("failed")
        let failedSnapshot = try snapshot(failed), failedRun = try run(slot: 2, in: failed)
        try assertStatus(taskId, "blocked")
        try showRun(failedRun)
        try screenshot("Native correction failed run")
        try showArtifact(firstArtifact)
        try screenshot("Native correction retained initial artifact after failure")
        try require(failedSnapshot.artifacts == [firstArtifact], "Failed execution must leave the original report immutable and add no report")
        try tapTaskButton("task.action.retry.\(taskId)", label: "Retry")
        let retried = try await checkpoint("retried")
        try require(snapshot(retried).runs.map(\.id).sorted() == failedSnapshot.runs.map(\.id).sorted(), "Retry must only return the task to Ready, without starting another execution")
        try assertStatus(taskId, "ready")
        try screenshot("Native correction ready after explicit Retry")

        try await approveAndAssign(taskId: taskId, slot: 3)
        let corrected = try await checkpoint("corrected")
        let correctedSnapshot = try snapshot(corrected), thirdRun = try run(slot: 3, in: corrected)
        let correctedArtifact = try artifact(runId: thirdRun.id, in: correctedSnapshot)
        try require(correctedArtifact.id != firstArtifact.id && correctedArtifact.checksum != firstArtifact.checksum, "The corrected report must have its own immutable identity and different bytes")
        try await verifyDownloadedArtifact(firstArtifact, observation: corrected)
        try await verifyDownloadedArtifact(correctedArtifact, observation: corrected)
        try assertStatus(taskId, "review")
        try showBothArtifacts(firstArtifact, correctedArtifact)
        try screenshot("Native correction original and corrected artifacts")
        try preview(correctedArtifact, run: thirdRun, stage: "corrected", reviewEventId: firstReview.eventId, caption: "Native correction corrected patch in Quick Look")
        let draft = field("task.review.comment.\(taskId)")
        try reveal(draft, identifier: "task.review.comment.\(taskId)", preferTop: true)
        try require(empty(draft), "Successfully submitted feedback must not reappear as the new review draft")
        try await requestChanges(taskId: taskId, comment: fixture.reviewComments[1])
        let changedAgain = try await checkpoint("changes_requested_again")
        let secondReview = try review(comment: fixture.reviewComments[1], in: snapshot(changedAgain))
        try require(Set(secondReview.artifactIds ?? []) == Set([firstArtifact.id, correctedArtifact.id]), "The second task review must identify both reports that existed at its decision")
        try showReview(secondReview)
        try screenshot("Native correction second feedback")

        try await approveAndAssign(taskId: taskId, slot: 4)
        let held = try await checkpoint("holding"), fourthRun = try run(slot: 4, in: held)
        try require(held.livePids.count == 1 && held.cancellation.attempts.isEmpty, "The fourth actual process must be alive before any Stop decision")
        try assertStatus(taskId, "running")
        try showRun(fourthRun)
        try openStop(fourthRun)
        try screenshot("Native correction exact Stop confirmation")
        _ = try await checkpoint("keep_running_before")
        let keep = try stopDialogButton(runId: fourthRun.id, confirming: false)
        try require(keep.exists && keep.isHittable, "The exact confirmation must offer Keep running")
        keep.tap()
        try await Task.sleep(nanoseconds: 3_200_000_000)
        let kept = try await checkpoint("keep_running_after")
        try require(kept.cancellation.attempts.isEmpty && kept.livePids == held.livePids, "Dismissing Stop must issue no cancel command and preserve the same live process")
        try assertStatus(taskId, "running")
        try showRun(fourthRun)
        try screenshot("Native correction kept running")

        try openStop(fourthRun)
        let confirm = try stopDialogButton(runId: fourthRun.id, confirming: true)
        try require(confirm.exists && confirm.isHittable, "Confirmation must remain bound to the captured fourth run")
        confirm.tap()
        let stopped = try await checkpoint("stopped")
        try require(stopped.cancellation.attempts.count == 1 && stopped.cancellation.attempts[0].runId == fourthRun.id && stopped.livePids.isEmpty, "Exactly one native cancel must stop the captured process")
        try await Task.sleep(nanoseconds: 3_200_000_000)
        let stable = try await checkpoint("stopped_stable")
        let final = try snapshot(stable)
        try require(final.task.id == taskId && final.runs.count == 4 && final.reviews == snapshot(changedAgain).reviews
                    && final.artifacts.sorted { $0.id < $1.id } == correctedSnapshot.artifacts.sorted { $0.id < $1.id }, "Cancelled state must retain the same four executions, both reviews and both immutable reports")
        try assertStatus(taskId, "cancelled")
        try screenshot("Native correction cancelled task")
        try showReview(firstReview)
        try screenshot("Native correction retained first review after Stop")
        try showReview(secondReview)
        try screenshot("Native correction retained second review after Stop")
        try showBothArtifacts(firstArtifact, correctedArtifact)
        try screenshot("Native correction retained artifacts after Stop")
        try await verifyDownloadedArtifact(firstArtifact, observation: stable)
        try await verifyDownloadedArtifact(correctedArtifact, observation: stable)
        let record: [String: Any] = ["task_id": taskId, "run_ids": [firstRun.id, failedRun.id, thirdRun.id, fourthRun.id],
                                  "review_event_ids": [firstReview.eventId, secondReview.eventId],
                                  "artifact_ids": [firstArtifact.id, correctedArtifact.id], "cancelled_run_id": fourthRun.id,
                                  "cancellation_requests": stable.cancellation.attempts.count,
                                  "runtime_scope": "Deterministic real CLI over the production authenticated node; no live provider inference"]
        let attachment = XCTAttachment(data: try JSONSerialization.data(withJSONObject: record, options: .sortedKeys), uniformTypeIdentifier: "public.json")
        attachment.name = "Native correction exact identities and lifecycle boundaries"; attachment.lifetime = .keepAlways; add(attachment)
    }

    @MainActor
    private func pair() async throws {
        app.launch()
        let origin = app.textFields.matching(identifier: "serverURL").matching(NSPredicate(format: "enabled == true")).firstMatch
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline && !origin.exists && !app.tabBars.buttons["More"].exists { try await Task.sleep(nanoseconds: 100_000_000) }
        if app.tabBars.buttons["More"].exists {
            app.tabBars.buttons["More"].tap(); try tap("signOut")
        }
        try require(origin.waitForExistence(timeout: 30), "The disposable phone must reach native pairing")
        // Minting a disposable pairing code is infrastructure setup, never a
        // replacement for any task, approval, review, assignment or Stop action.
        let code: CorrectionPairing = try await request(fixture.serverURL.appendingPathComponent("api/v1/devices/pairings"), token: fixture.peerToken,
                                                       method: "POST", body: ["intended_platform": "ios"])
        if fixture.serverURL.scheme == "http" { try setSwitch("allowLocalHTTP", enabled: true) }
        try replace(origin, fixture.serverURL.absoluteString, identifier: "serverURL")
        try replace(field("pairingDeviceName"), fixture.deviceName, identifier: "pairingDeviceName")
        try replace(field("pairingCode"), code.code, identifier: "pairingCode")
        try tap("pairDevice")
        try require(app.tabBars.buttons["Tasks"].waitForExistence(timeout: 20), "Native pairing must authenticate before task creation")
    }

    @MainActor
    private func createTask() async throws -> String {
        app.tabBars.buttons["Tasks"].tap(); try tap("task.create.open")
        try replace(field("task.create.title"), fixture.taskTitle, identifier: "task.create.title")
        try dismissKeyboard("task.create.keyboard.done")
        try replace(field("task.create.criteria"), fixture.criteria.joined(separator: "\n"), identifier: "task.create.criteria")
        try dismissKeyboard("task.create.keyboard.done")
        try replace(field("task.create.capabilities"), "code.modify", identifier: "task.create.capabilities")
        try dismissKeyboard("task.create.keyboard.done")
        try tap("task.create.submit")
        let deadline = Date().addingTimeInterval(20)
        repeat {
            let page: CorrectionTasks = try await get("api/v1/tasks?project_id=\(fixture.projectId)")
            let matches = page.tasks.filter { $0.title == fixture.taskTitle }
            try require(matches.count <= 1, "One UI submission must create exactly one task")
            if let task = matches.first {
                try require(task.status == "backlog" && task.projectId == fixture.projectId && task.acceptanceCriteria == fixture.criteria && task.requiredCapabilities == ["code.modify"], "The native form must persist its exact project, criteria and capability")
                let closed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.navigationBars["New Task"])
                try require(XCTWaiter.wait(for: [closed], timeout: 15) == .completed, "Successful task creation must dismiss its native form")
                try openTask(task.id); return task.id
            }
            try await Task.sleep(nanoseconds: 200_000_000)
        } while Date() < deadline
        throw correctionError("The task submitted by the native UI was not persisted")
    }

    @MainActor
    private func openTask(_ taskId: String) throws {
        app.tabBars.buttons["Tasks"].tap()
        let route = app.navigationBars.matching(NSPredicate(format: "identifier IN %@", ["Task", "Tasks"] as NSArray)).firstMatch
        try require(route.waitForExistence(timeout: 15), "Tasks must restore its detail or list navigation")
        // A tab preserves its detail and scroll position. Offscreen List rows
        // such as task.status may not exist in the accessibility tree yet.
        if app.navigationBars["Task"].exists { return }
        try require(app.navigationBars["Tasks"].exists, "Only the Tasks list can contain task.row.\(taskId)")
        try tap("task.row.\(taskId)")
        try require(app.navigationBars["Task"].waitForExistence(timeout: 15), "The exact created task must open")
    }

    @MainActor
    private func approveAndAssign(taskId: String, slot: Int) async throws {
        let instance = fixture.instances[slot - 1], summary = fixture.approvalSummaries[slot - 1]
        try assertStatus(taskId, "ready")
        let before: CorrectionSnapshot = try await get("api/v1/tasks/\(taskId)")
        try require(before.runs.count == slot - 1 && before.approvals.count == slot - 1, "Each new attempt must start after exactly the preceding executions")
        try tapTaskButton("task.approval.disclosure.\(taskId)", label: slot == 1 ? "Request execution review" : "Submit an updated review request")
        try replace(field("task.approval.summary.\(taskId)"), summary, identifier: "task.approval.summary.\(taskId)")
        try dismissKeyboard("task.detail.keyboard.done")
        let risk = app.segmentedControls["task.approval.risk.\(taskId)"].buttons["High"]
        try reveal(risk, identifier: "task.approval.risk.\(taskId).High"); risk.tap()
        try tapTaskButton("task.approval.request.\(taskId)", label: "Request approval")
        let pending = try await waitForTask(taskId) { value in
            value.approvals.contains { $0.summary == summary && $0.status == "pending" && $0.payloadRef == "execution-gate/current" }
        }
        let matching = pending.approvals.filter { $0.summary == summary && $0.payloadRef == "execution-gate/current" }
        try require(matching.count == 1, "This request must create one distinct current execution approval")
        let approval = matching[0]
        try require(pending.runs.map(\.id).sorted() == before.runs.map(\.id).sorted() && approval.runId == nil, "Requesting approval must not execute work")
        let blocked = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.buttons["task.action.assign.\(taskId)"])
        try require(XCTWaiter.wait(for: [blocked], timeout: 10) == .completed, "A pending fresh approval must block native assignment")
        app.tabBars.buttons["Inbox"].tap(); try tap("inbox.approval.\(approval.id)")
        let shown = app.staticTexts["approval.summary.\(approval.id)"]
        try revealText(shown, identifier: "approval.summary.\(approval.id)"); try require(shown.label == summary, "The phone must approve the exact new attempt summary")
        try tap("approval.decision.approved.\(approval.id)")
        let approved = try await waitForTask(taskId) { $0.approvals.first { $0.id == approval.id }?.status == "approved" }
        try require(approved.approvals.first { $0.id == approval.id }?.runId == nil && approved.runs.map(\.id).sorted() == before.runs.map(\.id).sorted(), "Approval alone must not launch or consume an execution")
        try require(app.navigationBars["Today"].waitForExistence(timeout: 15), "Approving must return to Inbox")
        try openTask(taskId); try tapTaskButton("task.action.assign.\(taskId)", label: "Assign")
        try require(app.navigationBars["Assign Task"].waitForExistence(timeout: 10), "Assignment must use the real native sheet")
        let worktree = app.switches["task.assignment.worktree"]
        try reveal(worktree, identifier: "task.assignment.worktree"); try require(worktree.value as? String == "0", "Git worktrees must remain an explicit opt-in for every new sheet")
        try setSwitch("task.assignment.worktree", enabled: true)
        let manual = app.segmentedControls["task.assignment.mode"].buttons["Manual"]
        try reveal(manual, identifier: "task.assignment.mode.Manual"); manual.tap(); try tap("task.assignment.instance")
        let option = field("task.assignment.option.\(instance.id)")
        try reveal(option, identifier: "task.assignment.option.\(instance.id)")
        try require(option.label.contains(instance.name) && option.label.contains(instance.root) && option.label.contains(fixture.runtimeId), "The chosen exact instance must show its readable name, own workspace and runtime")
        option.tap()
        let selected = field("task.assignment.instance")
        try require((selected.value as? String ?? selected.label).contains(instance.root), "The sheet must retain this attempt's independent workspace selection")
        try tap("task.assignment.confirm")
        let closed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.navigationBars["Assign Task"])
        try require(XCTWaiter.wait(for: [closed], timeout: 20) == .completed, "Server-accepted assignment must close the native sheet")
        let assigned = try await waitForTask(taskId) { $0.runs.contains { $0.agentInstanceId == instance.id } }
        let runs = assigned.runs.filter { $0.agentInstanceId == instance.id }
        try require(runs.count == 1 && assigned.runs.count == slot, "A single manual assignment must create only its intended new run")
        let run = runs[0]
        try require(run.workspaceRoot == instance.root && run.workspaceBranch == "artoo/run-\(run.id)" && run.computerId == fixture.computerId && run.runtimeId == fixture.runtimeId, "The actual server run must use the opt-in Git worktree and exact selected computer/runtime")
        try require(assigned.approvals.first { $0.id == approval.id }?.runId == run.id, "Only the newly approved gate may authorize this exact run")
    }

    @MainActor
    private func requestChanges(taskId: String, comment: String) async throws {
        try assertStatus(taskId, "review")
        let input = field("task.review.comment.\(taskId)")
        try replace(input, comment, identifier: "task.review.comment.\(taskId)", preferTop: true); try dismissKeyboard("task.detail.keyboard.done")
        try require(input.value as? String == comment, "Review must submit the original multiline feedback without alteration")
        try tapTaskButton("task.action.requestChanges.\(taskId)", label: "Request Changes")
        _ = try await waitForTask(taskId) { $0.task.status == "ready" && $0.reviews.contains { $0.comment == comment } }
    }

    @MainActor
    private func tapTaskButton(_ identifier: String, label: String) throws {
        let allowed: [(String, [String])] = [
            ("task.action.markReady.", ["Mark Ready"]),
            ("task.action.retry.", ["Retry"]),
            ("task.action.assign.", ["Assign"]),
            ("task.action.requestChanges.", ["Request Changes"]),
            ("task.approval.request.", ["Request approval"]),
            ("task.approval.disclosure.", ["Request execution review", "Submit an updated review request"]),
            ("task.run.stop.request.", ["Stop execution"]),
        ]
        try require(allowed.contains { identifier.hasPrefix($0.0) && identifier.count > $0.0.count && $0.1.contains(label) },
                    "Only explicitly identified inline Task actions may use a verified center touch")
        try requireForeground("revealing an inline Task action")
        try require(app.navigationBars["Task"].exists && !app.keyboards.firstMatch.exists
                    && !app.alerts.firstMatch.exists && !app.sheets.firstMatch.exists,
                    "The inline action must belong to the unobscured task detail")
        let matches = app.buttons.matching(identifier: identifier), button = matches.firstMatch
        try revealText(button, identifier: identifier)
        try require(matches.count == 1 && button.label == label && button.isEnabled,
                    "The exact task action must expose one enabled button labeled \(label)")
        let firstArea = try viewport(), firstFrame = button.frame
        let area = try viewport(), frame = button.frame
        let finite = [firstArea, firstFrame, area, frame].allSatisfy { finiteNonempty($0) }
        try require(finite && firstArea == area && firstFrame == frame
                    && firstArea.contains(firstFrame) && area.contains(frame),
                    "The exact inline Task button must retain a finite, stable frame fully inside the content viewport")
        try requireForeground("touching an inline Task action")
        try require(app.navigationBars["Task"].exists && !app.keyboards.firstMatch.exists
                    && !app.alerts.firstMatch.exists && !app.sheets.firstMatch.exists,
                    "The verified inline Task action must remain unobscured before its one touch")
        // XCTest can reject derived activation points for enabled, visible
        // Task rows. Touch the verified center once; callers still require
        // the actual form, task, review, assignment or Stop-dialog outcome.
        let bounds = app.frame, center = CGPoint(x: frame.midX, y: frame.midY)
        try require(finiteNonempty(bounds) && bounds.contains(area) && area.contains(center),
                    "The verified Task action center must remain inside finite app bounds")
        let attachment = XCTAttachment(string: "identifier: \(identifier)\nlabel: \(button.label)\nframe: \(frame)\nviewport: \(area)\ncenter: \(center)")
        attachment.name = "Native correction \(label) verified touch"; attachment.lifetime = .keepAlways; add(attachment)
        app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: center.x - bounds.minX, dy: center.y - bounds.minY)).tap()
    }

    @MainActor
    private func showReview(_ review: CorrectionReview) throws {
        let feedback = app.staticTexts["task.review.feedback.\(review.eventId)"]
        try revealText(feedback, identifier: "task.review.feedback.\(review.eventId)"); try require(feedback.label == review.comment, "History must display the exact persisted multiline comment")
        let reviewer = app.staticTexts["task.review.reviewer.\(review.eventId)"]
        try revealText(reviewer, identifier: "task.review.reviewer.\(review.eventId)"); try require(reviewer.label == review.actorName, "History must identify the actual reviewer")
        let date = app.staticTexts["task.review.date.\(review.eventId)"]
        try revealText(date, identifier: "task.review.date.\(review.eventId)"); try require(date.value as? String == review.occurredAt, "Review date must correspond to the actual durable event")
        try revealTogether(reviewer, feedback, identifiers: ("task.review.reviewer.\(review.eventId)", "task.review.feedback.\(review.eventId)"))
    }

    @MainActor
    private func showRun(_ run: CorrectionRun) throws {
        let row = app.buttons["task.run.\(run.id)"]
        try revealText(row, identifier: "task.run.\(run.id)")
        try require(row.isHittable && row.label.contains(run.id) && row.label.localizedCaseInsensitiveContains(run.status), "The fully visible, hittable run row must identify this exact execution and state")
    }

    @MainActor
    private func showArtifact(_ artifact: CorrectionArtifact) throws {
        let name = app.staticTexts["artifact.name.\(artifact.id)"]
        try revealText(name, identifier: "artifact.name.\(artifact.id)"); try require(name.label == artifact.metadata.filename, "Each report must display its actual metadata filename")
        let details = field("artifact.details.\(artifact.id)")
        try revealText(details, identifier: "artifact.details.\(artifact.id)")
        try require(details.label.contains(artifact.runId) && details.label.contains(artifact.createdAt), "Artifact details must expose its complete originating run and real creation time")
    }

    @MainActor
    private func showBothArtifacts(_ first: CorrectionArtifact, _ second: CorrectionArtifact) throws {
        try showArtifact(first); try showArtifact(second)
        try revealTogether(field("artifact.details.\(first.id)"), field("artifact.details.\(second.id)"), identifiers: ("artifact.details.\(first.id)", "artifact.details.\(second.id)"))
    }

    @MainActor
    private func preview(_ artifact: CorrectionArtifact, run: CorrectionRun, stage: String, reviewEventId: String?, caption: String) throws {
        try tap("artifact.preview.\(artifact.id)")
        for value in ["Execution correction evidence", "run: \(run.id)", "stage: \(stage)"] + (reviewEventId.map { ["feedback event: \($0)"] } ?? []) {
            let body = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", value, value)).firstMatch
            try require(body.waitForExistence(timeout: 20), "Quick Look must render the uploaded patch's actual task/run and feedback content")
        }
        let filename = artifact.metadata.filename, basename = (filename as NSString).deletingPathExtension
        let bar = app.navigationBars.matching(NSPredicate(format: "identifier == %@ OR identifier == %@ OR label == %@ OR label == %@", filename, basename, filename, basename)).firstMatch
        try require(bar.waitForExistence(timeout: 10), "Quick Look must identify the original uploaded filename")
        try screenshot(caption)
        let identified = bar.buttons.matching(identifier: "QLOverlayDoneButtonAccessibilityIdentifier")
        let done = bar.buttons.matching(NSPredicate(format: "label == %@", "Done"))
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
        close.tap(); try require(app.navigationBars["Task"].waitForExistence(timeout: 15), "Closing the patch preview must return to the task")
    }

    @MainActor
    private func openStop(_ run: CorrectionRun) throws {
        try tapTaskButton("task.run.stop.request.\(run.id)", label: "Stop execution")
        _ = try stopDialogButton(runId: run.id, confirming: true)
        _ = try stopDialogButton(runId: run.id, confirming: false)
    }

    @MainActor
    private func stopDialogButton(runId: String, confirming: Bool) throws -> XCUIElement {
        let title = "Stop this execution?"
        let alerts = app.alerts.containing(.staticText, identifier: title), sheets = app.sheets.containing(.staticText, identifier: title)
        try require(alerts.firstMatch.waitForExistence(timeout: 10) || sheets.firstMatch.waitForExistence(timeout: 2),
                    "The native Stop confirmation must be presented")
        let dialogs = alerts.allElementsBoundByIndex + sheets.allElementsBoundByIndex
        try require(dialogs.count == 1, "Exactly one titled Stop confirmation must be active")
        let dialog = dialogs[0]
        try require(dialog.staticTexts.matching(NSPredicate(format: "label == %@", title)).count == 1,
                    "The Stop confirmation must expose its exact title once")
        let identities = dialog.staticTexts.matching(NSPredicate(format: "label CONTAINS %@ AND label CONTAINS %@", runId, "also cancels its task"))
        try require(identities.firstMatch.waitForExistence(timeout: 10) && identities.count == 1,
                    "The active Stop dialog must uniquely disclose captured run \(runId) and task cancellation before any decision")
        try require(dialog.frame.contains(identities.element(boundBy: 0).frame), "The captured-run warning must be fully contained in its Stop confirmation")
        let action = confirming ? "confirm" : "keep", label = confirming ? "Stop run and cancel task" : "Keep running"
        let identifier = "task.run.stop.\(action).\(runId)", expectedLabel = NSPredicate(format: "label == %@", label)
        let identified = dialog.buttons.matching(identifier: identifier)
        let hasIdentifier = identified.firstMatch.waitForExistence(timeout: 2)
        let matches = hasIdentifier ? identified.matching(expectedLabel) : dialog.buttons.matching(expectedLabel)
        try require(matches.firstMatch.waitForExistence(timeout: 5), "The captured-run dialog must expose its exact \(label) action")
        let candidates = matches.allElementsBoundByIndex
        let leaves = candidates.filter { $0.descendants(matching: .button).count == 0 }
        try require(leaves.count == 1, "The captured-run dialog must expose exactly one leaf \(label) button")
        let button = leaves[0]
        // Some system presentations wrap a button in another same-action
        // Button. Accept only that nesting, never independent duplicate actions.
        try require(candidates.allSatisfy { candidate in
            if candidate === button { return true }
            let descendants = candidate.descendants(matching: .button).allElementsBoundByIndex
            return candidate.frame.contains(button.frame) && !descendants.isEmpty
                && descendants.allSatisfy { $0.label == label && (!hasIdentifier || $0.identifier == identifier) }
        }, "Only nested wrappers of the exact Stop action may share its identity")
        try require(button.label == label && button.isEnabled && button.isHittable,
                    "The captured-run dialog's unique \(label) button must be actionable")
        return button
    }

    @MainActor
    private func assertStatus(_ taskId: String, _ status: String) throws {
        let element = field("task.status.\(taskId)")
        try revealText(element, identifier: "task.status.\(taskId)", preferTop: true)
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", status), object: element)
        try require(XCTWaiter.wait(for: [expectation], timeout: 15) == .completed, "The native task must visibly reach \(status)")
    }

    @MainActor private func field(_ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }
    @MainActor private func empty(_ field: XCUIElement) -> Bool {
        let value = field.value as? String ?? ""
        return value.isEmpty || value == field.placeholderValue
    }

    @MainActor
    private func replace(_ input: XCUIElement, _ text: String, identifier: String, preferTop: Bool = false) throws {
        try reveal(input, identifier: identifier, preferTop: preferTop); try require(input.isEnabled && input.isHittable, "The exact input must be editable through the native UI")
        input.tap()
        if input.value as? String == text { return }
        if !empty(input) {
            input.press(forDuration: 1.0)
            let item = app.menuItems["Select All"].firstMatch, button = app.buttons["Select All"].firstMatch
            let selectAll = item.waitForExistence(timeout: 2) ? item : button
            try require(selectAll.waitForExistence(timeout: 5) && selectAll.isHittable, "The native edit menu must select the entire existing value")
            selectAll.tap(); input.typeText(XCUIKeyboardKey.delete.rawValue)
            let clearedInput = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@ OR value == %@", "", input.placeholderValue ?? ""), object: input)
            try require(XCTWaiter.wait(for: [clearedInput], timeout: 45) == .completed, "The existing native Delete action must finish clearing the input")
            try require(empty(input), "Deleting the selection must clear the entire native input")
        }
        input.typeText(text)
        // Queued native key events can outlive typeText's return. Observe the
        // same edit finishing without issuing another tap or typing operation.
        let enteredInput = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", text), object: input)
        try require(XCTWaiter.wait(for: [enteredInput], timeout: 45) == .completed, "The original native typing operation must finish with the exact intended text")
        try require(input.value as? String == text, "The native input must exactly match the intended original text")
    }

    @MainActor
    private func dismissKeyboard(_ id: String) throws {
        try tap(id)
        let gone = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.keyboards.firstMatch)
        try require(XCTWaiter.wait(for: [gone], timeout: 10) == .completed, "Done must dismiss the keyboard before lifecycle actions")
    }

    @MainActor
    private func setSwitch(_ id: String, enabled: Bool) throws {
        let element = app.switches[id], expected = enabled ? "1" : "0"
        for _ in 0..<3 {
            let nested = element.switches.firstMatch
            let control = nested.exists ? nested : element
            try reveal(control, identifier: id)
            try require(control.isEnabled && control.isHittable, "The \(id) switch must be enabled and hittable before tapping")
            // Match the core suite's bounded retry for a dropped first tap on
            // a busy simulator. Read again before each tap so delayed success
            // cannot be toggled back off by an unconditional retry.
            let current = element.value as? String
            try require(current == "0" || current == "1", "The \(id) switch must expose a known off/on state")
            if current == expected { return }
            control.tap()
            let changed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", expected), object: element)
            if XCTWaiter.wait(for: [changed], timeout: 3) == .completed { return }
        }
        let changed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", expected), object: element)
        try require(XCTWaiter.wait(for: [changed], timeout: 5) == .completed, "The \(id) switch must reflect the explicit native selection")
    }

    @MainActor
    private func tap(_ id: String) throws {
        let element = field(id)
        try reveal(element, identifier: id); try require(element.isEnabled && element.isHittable, "The native action \(id) must be available")
        element.tap()
    }

    @MainActor
    private func requireForeground(_ operation: String) throws {
        let state = app.state
        try require(state == .runningForeground,
                    "Native app must be in the foreground before \(operation) (state \(state.rawValue))")
    }

    private func finiteNonempty(_ rect: CGRect) -> Bool {
        !rect.isEmpty && [rect.minX, rect.minY, rect.maxX, rect.maxY, rect.width, rect.height].allSatisfy { $0.isFinite }
    }

    @MainActor
    private func viewport() throws -> CGRect {
        try requireForeground("reading the content viewport")
        let bounds = app.frame
        try require(finiteNonempty(bounds), "Native app bounds must be finite and nonempty")
        var area = bounds
        if let bar = app.navigationBars.allElementsBoundByIndex.first(where: { $0.exists }) {
            let frame = bar.frame
            try require(finiteNonempty(frame), "Native navigation bar bounds must be finite and nonempty")
            if frame.maxY < area.maxY {
                area.origin.y = frame.maxY; area.size.height = bounds.maxY - frame.maxY
            }
        }
        if app.tabBars.firstMatch.exists {
            let frame = app.tabBars.firstMatch.frame
            try require(finiteNonempty(frame), "Native tab bar bounds must be finite and nonempty")
            area.size.height = min(area.maxY, frame.minY) - area.minY
        }
        if app.keyboards.firstMatch.exists {
            let frame = app.keyboards.firstMatch.frame
            try require(finiteNonempty(frame), "Native keyboard bounds must be finite and nonempty")
            area.size.height = min(area.maxY, frame.minY) - area.minY
        }
        area = area.insetBy(dx: 6, dy: 8)
        try require(finiteNonempty(area) && bounds.contains(area), "Native content viewport must be finite, nonempty and inside the app")
        try requireForeground("using the content viewport")
        return area
    }

    @MainActor
    private func drag(_ area: CGRect, upward: Bool) throws {
        try requireForeground("scrolling")
        try require(finiteNonempty(area), "Native scroll viewport must be finite and nonempty")
        let origin = app.coordinate(withNormalizedOffset: .zero)
        origin.withOffset(CGVector(dx: area.midX, dy: area.minY + area.height * (upward ? 0.76 : 0.24)))
            .press(forDuration: 0.05, thenDragTo: origin.withOffset(CGVector(dx: area.midX, dy: area.minY + area.height * (upward ? 0.24 : 0.76))))
    }

    @MainActor
    private func align(_ frame: CGRect, inside area: CGRect) throws {
        try requireForeground("aligning complete visible content")
        try require(finiteNonempty(frame) && finiteNonempty(area), "Native content alignment requires finite, nonempty bounds")
        let above = max(0, area.minY - frame.minY), below = max(0, frame.maxY - area.maxY)
        try require(above > 0 || below > 0, "Vertical scrolling cannot resolve horizontal content clipping")
        let upward = below > 0
        // A full search swipe can fling a nearly visible card past the opposite
        // edge. Move only its measured overflow and a small interior margin.
        let distance = min(area.height * 0.3, max(24, (upward ? below : above) + 12))
        let start = CGPoint(x: area.midX, y: area.midY + (upward ? distance : -distance) / 2)
        let end = CGPoint(x: area.midX, y: area.midY - (upward ? distance : -distance) / 2)
        try require(distance.isFinite && distance > 0 && area.contains(start) && area.contains(end),
                    "Native alignment gesture must remain inside the content viewport")
        let origin = app.coordinate(withNormalizedOffset: .zero)
        origin.withOffset(CGVector(dx: start.x, dy: start.y))
            .press(forDuration: 0.05, thenDragTo: origin.withOffset(CGVector(dx: end.x, dy: end.y)),
                   withVelocity: .slow, thenHoldForDuration: 0.2)
    }

    @MainActor
    private func reveal(_ element: XCUIElement, identifier: String, preferTop: Bool = false) throws {
        for attempt in 0..<14 {
            // Toolbar and sheet actions intentionally sit outside the list's
            // evidence viewport; hittability is the correct action boundary.
            let exists = element.exists
            if exists && element.isHittable { return }
            let area = try viewport()
            let frame = exists ? element.frame : .zero
            let known = !frame.isEmpty && !frame.isNull && !frame.isInfinite
            try drag(area, upward: known ? frame.midY > area.midY : (attempt < 7 ? !preferTop : preferTop))
        }
        try require(false, "Native control \(identifier) must be reachable after bounded scrolling")
    }

    @MainActor
    private func revealText(_ element: XCUIElement, identifier: String, preferTop: Bool = false) throws {
        for attempt in 0..<14 {
            let area = try viewport(), frame = element.exists ? element.frame : .zero
            let known = !frame.isEmpty && !frame.isNull && !frame.isInfinite
            if known {
                try require(frame.height <= area.height && frame.width <= area.width,
                            "Complete text \(identifier) cannot fit the content viewport (text \(frame.size), viewport \(area.size))")
                if area.contains(frame) { return }
                try align(frame, inside: area)
            } else {
                try drag(area, upward: attempt < 7 ? !preferTop : preferTop)
            }
        }
        try require(false, "Complete text \(identifier) must be visible inside the content viewport after bounded scrolling")
    }

    @MainActor
    private func revealTogether(_ first: XCUIElement, _ second: XCUIElement, identifiers: (String, String)) throws {
        for attempt in 0..<14 {
            let area = try viewport()
            if first.exists && second.exists {
                let frames = [first.frame, second.frame]
                if frames.allSatisfy({ !$0.isEmpty && !$0.isNull && !$0.isInfinite }) {
                    let union = frames[0].union(frames[1])
                    try require(union.height <= area.height && union.width <= area.width,
                                "Evidence \(identifiers.0) and \(identifiers.1) cannot fit together (combined \(union.size), viewport \(area.size))")
                    if area.contains(union) { return }
                    try align(union, inside: area); continue
                }
            }
            try drag(area, upward: attempt < 7)
        }
        try require(false, "Evidence \(identifiers.0) and \(identifiers.1) must be readable together after bounded scrolling")
    }

    @MainActor
    private var credentialsVisible: Bool {
        ["serverURL", "pairingDeviceName", "pairingCode", "device.pairing.code"].contains { field($0).exists }
    }

    @MainActor
    private func screenshot(_ caption: String) throws {
        try requireForeground("capturing \(caption)")
        try require(!credentialsVisible, "Evidence screenshots must exclude all pairing fields and generated codes")
        let image = XCTAttachment(screenshot: app.screenshot()); image.name = caption; image.lifetime = .keepAlways; add(image)
    }

    @MainActor
    private func captureFailure() {
        let state = app.state
        let status = XCTAttachment(string: "Native app state at failure: \(state.rawValue); required foreground state: \(XCUIApplication.State.runningForeground.rawValue)")
        status.name = "Native correction failure application state"; status.lifetime = .keepAlways; add(status)
        guard state == .runningForeground && !credentialsVisible else { return }
        try? screenshot("Native correction guarded failure diagnostics")
        guard app.state == .runningForeground else { return }
        let tree = XCTAttachment(string: app.debugDescription)
        tree.name = "Native correction failure accessibility hierarchy"; tree.lifetime = .keepAlways; add(tree)
    }

    private func require(_ condition: Bool, _ message: String) throws { if !condition { throw correctionError(message) } }

    private func snapshot(_ observation: CorrectionObservation) throws -> CorrectionSnapshot {
        guard let value = observation.snapshot else { throw correctionError("The UI-created correction task must exist") }
        return value
    }

    private func run(slot: Int, in observation: CorrectionObservation) throws -> CorrectionRun {
        let receipts = observation.receipts.filter { $0.slot == slot }
        try require(receipts.count == 1, "Each attempt must own exactly one real process receipt")
        let runs = try snapshot(observation).runs.filter { $0.id == receipts[0].runId }
        try require(runs.count == 1, "The actual receipt must identify one exact server run")
        return runs[0]
    }

    private func artifact(runId: String, in snapshot: CorrectionSnapshot) throws -> CorrectionArtifact {
        let matches = snapshot.artifacts.filter { $0.runId == runId }
        try require(matches.count == 1, "The selected completed execution must own exactly one report")
        return matches[0]
    }

    private func review(comment: String, in snapshot: CorrectionSnapshot) throws -> CorrectionReview {
        let matches = snapshot.reviews.filter { $0.comment == comment }
        try require(matches.count == 1, "The exact original comment must occur once in durable review history")
        return matches[0]
    }

    private func observations() async throws -> CorrectionObservation {
        try await request(fixture.controlURL.appendingPathComponent("observations"), token: fixture.controlToken)
    }

    private func checkpoint(_ name: String) async throws -> CorrectionObservation {
        let result: CorrectionCheckpoint = try await request(fixture.controlURL.appendingPathComponent("checkpoints/\(name)"), token: fixture.controlToken,
                                                            method: "POST", body: [:], timeout: 90)
        try require(result.name == name, "The observer must attest only the requested read-only checkpoint")
        return result.observation
    }

    private func waitForTask(_ taskId: String, _ predicate: (CorrectionSnapshot) -> Bool) async throws -> CorrectionSnapshot {
        let deadline = Date().addingTimeInterval(30)
        repeat {
            let snapshot: CorrectionSnapshot = try await get("api/v1/tasks/\(taskId)")
            if predicate(snapshot) { return snapshot }
            try await Task.sleep(nanoseconds: 200_000_000)
        } while Date() < deadline
        throw correctionError("The exact task did not reach its expected state after the native action")
    }

    private func verifyDownloadedArtifact(_ artifact: CorrectionArtifact, observation: CorrectionObservation) async throws {
        try require(artifact.uri == "/api/v1/artifacts/\(artifact.id)/content", "Artifact download must remain bound to its immutable server ID")
        var request = URLRequest(url: fixture.serverURL.appendingPathComponent("api/v1/artifacts/\(artifact.id)/content"))
        request.setValue("Bearer \(fixture.peerToken)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        try require((response as? HTTPURLResponse)?.statusCode == 200, "The independent authenticated report download must succeed")
        let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        let observed = observation.artifactBytes.filter { $0.artifactId == artifact.id }
        try require(observed.count == 1 && observed[0].runId == artifact.runId && observed[0].sha256 == hash && observed[0].text == String(data: data, encoding: .utf8)
                    && artifact.checksum == "sha256:\(hash)" && artifact.metadata.size == data.count, "Downloaded immutable bytes must match the originating process report and observer hash")
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        guard let url = URL(string: path, relativeTo: fixture.serverURL) else { throw correctionError("Invalid observer read path") }
        return try await request(url, token: fixture.peerToken)
    }

    private func request<T: Decodable>(_ url: URL, token: String, method: String = "GET", body: [String: String]? = nil, timeout: TimeInterval = 25) async throws -> T {
        var request = URLRequest(url: url); request.httpMethod = method; request.timeoutInterval = timeout
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(UUID().uuidString, forHTTPHeaderField: "Idempotency-Key")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
            throw correctionError("Read-only observation or fixture setup failed at \(url.path), HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)")
        }
        let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(T.self, from: data)
    }
}

private func correctionError(_ message: String) -> NSError {
    NSError(domain: "ArtooExecutionCorrectionUITest", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}

private struct CorrectionFixture {
    let serverURL: URL; let peerToken: String; let controlURL: URL; let controlToken: String
    let deviceName: String; let projectId: String; let taskTitle: String; let criteria: [String]
    let reviewComments: [String]; let approvalSummaries: [String]; let instances: [CorrectionInstance]
    let computerId: String; let runtimeId: String

    init(_ environment: [String: String]) throws {
        func value(_ name: String) throws -> String {
            guard let value = environment["ARTOO_UI_\(name)"], !value.isEmpty else { throw correctionError("Missing correction fixture field \(name)") }
            return value
        }
        func loopback(_ name: String) throws -> URL {
            guard let url = URL(string: try value(name)), let scheme = url.scheme, let host = url.host,
                  ["http", "https"].contains(scheme), ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host), url.user == nil, url.password == nil,
                  url.query == nil, url.fragment == nil else { throw correctionError("Correction fixtures must use an isolated loopback origin") }
            return url
        }
        serverURL = try loopback("SERVER_URL"); controlURL = try loopback("FIXTURE_CONTROL_URL")
        peerToken = try value("PEER_CONTROL_TOKEN"); controlToken = try value("FIXTURE_CONTROL_TOKEN")
        deviceName = try value("NATIVE_DEVICE_NAME"); projectId = try value("PROJECT_ID"); taskTitle = try value("TASK_TITLE")
        criteria = try [value("CRITERION_1"), value("CRITERION_2")]
        reviewComments = try [value("REVIEW_COMMENT_1"), value("REVIEW_COMMENT_2")]
        approvalSummaries = try JSONDecoder().decode([String].self, from: Data(value("APPROVAL_SUMMARIES").utf8))
        instances = try JSONDecoder().decode([CorrectionInstance].self, from: Data(value("INSTANCES").utf8))
        computerId = try value("COMPUTER_ID"); runtimeId = try value("RUNTIME_ID")
        guard approvalSummaries.count == 4, instances.count == 4, Set(instances.map(\.id)).count == 4, Set(instances.map(\.root)).count == 4 else {
            throw correctionError("Correction requires four distinct pre-provisioned execution instances and workspace roots")
        }
    }
}

private struct CorrectionInstance: Decodable { let id: String; let name: String; let root: String }
private struct CorrectionPairing: Decodable { let code: String }
private struct CorrectionTasks: Decodable { let tasks: [CorrectionTask] }
private struct CorrectionTask: Decodable { let id: String; let projectId: String; let title: String; let status: String; let acceptanceCriteria: [String]?; let requiredCapabilities: [String]? }
private struct CorrectionSnapshot: Decodable { let task: CorrectionTask; let runs: [CorrectionRun]; let approvals: [CorrectionApproval]; let artifacts: [CorrectionArtifact]; let reviews: [CorrectionReview] }
private struct CorrectionRun: Decodable {
    let id: String; let taskId: String; let status: String; let agentInstanceId: String; let computerId: String; let runtimeId: String
    let workspaceRoot: String; let workspaceBranch: String
}
private struct CorrectionApproval: Decodable { let id: String; let summary: String?; let status: String; let payloadRef: String?; let runId: String? }
private struct CorrectionArtifact: Decodable, Equatable {
    let id: String; let runId: String; let taskId: String; let uri: String; let checksum: String; let createdAt: String; let metadata: CorrectionArtifactMetadata
}
private struct CorrectionArtifactMetadata: Decodable, Equatable { let filename: String; let size: Int }
private struct CorrectionReview: Decodable, Equatable { let eventId: String; let comment: String?; let actorName: String?; let occurredAt: String; let artifactIds: [String]? }
private struct CorrectionReceipt: Decodable { let slot: Int; let runId: String; let pid: Int }
private struct CorrectionArtifactBytes: Decodable { let artifactId: String; let runId: String; let sha256: String; let text: String }
private struct CorrectionCancelAttempt: Decodable { let runId: String }
private struct CorrectionCancellation: Decodable { let attempts: [CorrectionCancelAttempt] }
private struct CorrectionObservation: Decodable {
    let snapshot: CorrectionSnapshot?; let receipts: [CorrectionReceipt]; let livePids: [Int]
    let artifactBytes: [CorrectionArtifactBytes]; let cancellation: CorrectionCancellation
}
private struct CorrectionCheckpoint: Decodable { let name: String; let observation: CorrectionObservation }
