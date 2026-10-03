import XCTest
import UIKit

/// The separate successful-work scenario uses actual native product actions.
/// Authenticated API reads and fixture checkpoints only verify retained evidence.
final class SuccessfulWorkspaceRetentionUITests: XCTestCase {
    private let app = XCUIApplication()
    private var fixture: RetentionFixture!
    private var retentionViews: [[String: Any]] = []

    override func setUpWithError() throws {
        continueAfterFailure = false
        fixture = try RetentionFixture(ProcessInfo.processInfo.environment)
        retentionViews = []
    }

    override func tearDownWithError() throws { app.terminate() }

    @MainActor
    func testSuccessfulWorkspaceRetainsFilesWithoutArtifactsAfterRelaunch() async throws {
        do { try await retentionFlow() }
        catch { captureFailure(); throw error }
    }

    @MainActor
    private func retentionFlow() async throws {
        try await pair()
        let before = try await observations()
        try require(before.snapshot == nil && before.receipts.isEmpty && before.livePids.isEmpty,
                    "The fixture must not precreate the native task or launch its zero-artifact execution")
        let taskId = try await createTask()
        try tapTaskButton("task.action.markReady.\(taskId)", label: "Mark Ready")
        let ready = try await waitForTask(taskId) { $0.task.status == "ready" }
        try require(ready.runs.isEmpty && ready.approvals.isEmpty && ready.artifacts.isEmpty && ready.reviews.isEmpty,
                    "Ready must not launch work, create approval, upload a report or submit a review")
        try assertStatus(taskId, "ready")
        try screenshot("Native retention task ready before approval")
        try await approveAndAssign(taskId: taskId, slot: 1)
        let completed = try await checkpoint("completed"), completedSnapshot = try snapshot(completed)
        try require(completedSnapshot.task.id == taskId && completedSnapshot.task.status == "review"
                    && completedSnapshot.runs.count == 1 && completedSnapshot.approvals.count == 1
                    && completedSnapshot.artifacts.isEmpty && completedSnapshot.reviews.isEmpty
                    && completed.receipts.count == 1 && completed.livePids.isEmpty,
                    "One successful real execution must reach Review with one approval, zero artifacts/reviews and no live owned process")
        let run = completedSnapshot.runs[0]
        let report = try workspaceRetention(run, slot: 1, outcome: "completed")
        try require(completed.receipts[0].runId == run.id && completed.workspace?.root == report.workspaceRoot
                    && completed.workspace?.branch == report.workspaceBranch,
                    "The actual receipt and retained workspace must belong to this exact completed run")
        try assertStatus(taskId, "review")
        try showRun(run)
        try screenshot("Native retention completed execution")
        try showNoArtifacts(taskId, caption: "Native retention no uploaded artifacts")
        try await showRetainedWorkspace(run, slot: 1, outcome: "completed", verifyCopy: true,
                                       caption: "Native retention exact workspace path and branch", captureDetails: true)

        app.terminate()
        try require(app.wait(for: .notRunning, timeout: 10), "Cold relaunch must start after the prior native app process has ended")
        app.launch()
        try require(app.tabBars.buttons["Tasks"].waitForExistence(timeout: 20), "Cold relaunch must restore the paired native session")
        try openTask(taskId)
        try assertStatus(taskId, "review")
        try await showRetainedWorkspace(run, slot: 1, outcome: "completed", verifyCopy: true,
                                       caption: "Native retention recovery after cold relaunch")
        try showNoArtifacts(taskId, caption: "Native retention no artifacts after relaunch")
        let restored = try await checkpoint("relaunched"), restoredSnapshot = try snapshot(restored)
        try require(restoredSnapshot == completedSnapshot && restored.workspace == completed.workspace
                    && restored.receipts == completed.receipts && restored.livePids.isEmpty,
                    "Cold historical recovery must keep the same task/run/approval/retention/file identities without another launch, review or artifact")
        let record: [String: Any] = ["task_id": taskId, "run_id": run.id, "retention_event_id": report.eventId,
                                  "workspace_root": report.workspaceRoot, "workspace_branch": report.workspaceBranch,
                                  "runs": 1, "approvals": 1, "reviews": 0, "artifacts": 0,
                                  "cold_relaunch_completed": true, "workspace_retention_views": retentionViews,
                                  "runtime_scope": "Deterministic real CLI over production authenticated node; no provider or physical-device claim"]
        let attachment = XCTAttachment(data: try JSONSerialization.data(withJSONObject: record, options: .sortedKeys), uniformTypeIdentifier: "public.json")
        attachment.name = "Native retention exact identities and historical recovery"; attachment.lifetime = .keepAlways; add(attachment)
    }

    @MainActor
    private func showNoArtifacts(_ taskId: String, caption: String) throws {
        let identifier = "task.artifacts.empty.\(taskId)", emptyState = app.staticTexts[identifier]
        try revealText(emptyState, identifier: identifier)
        try require(emptyState.label == "No artifacts uploaded.", "The exact task must visibly distinguish successful local work from uploaded artifacts")
        try screenshot(caption)
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
        let code: RetentionPairing = try await request(fixture.serverURL.appendingPathComponent("api/v1/devices/pairings"), token: fixture.peerToken,
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
            let page: RetentionTasks = try await get("api/v1/tasks?project_id=\(fixture.projectId)")
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
        throw retentionError("The task submitted by the native UI was not persisted")
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
        let before: RetentionSnapshot = try await get("api/v1/tasks/\(taskId)")
        try require(before.runs.count == slot - 1 && before.approvals.count == slot - 1, "The one approved assignment must begin with no prior runs or approvals")
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
    private func tapTaskButton(_ identifier: String, label: String) throws {
        let allowed: [(String, [String])] = [
            ("task.action.markReady.", ["Mark Ready"]),
            ("task.action.assign.", ["Assign"]),
            ("task.approval.request.", ["Request approval"]),
            ("task.approval.disclosure.", ["Request execution review", "Submit an updated review request"]),
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
        // Read-only resampling after scrolling: retain exact geometry equality
        // and full containment without touching or scrolling an unsettled row.
        let deadline = ProcessInfo.processInfo.systemUptime + 20
        var previous: (area: CGRect, frame: CGRect)?
        var stable: (area: CGRect, frame: CGRect)?
        var samples: [String] = []
        while samples.count < 8 && ProcessInfo.processInfo.systemUptime < deadline {
            let observedArea = try viewport(), observedFrame = button.frame
            let complete = finiteNonempty(observedArea) && finiteNonempty(observedFrame)
                && observedArea.contains(observedFrame)
            samples.append("sample \(samples.count + 1): viewport=\(observedArea), frame=\(observedFrame), complete=\(complete)")
            if ProcessInfo.processInfo.systemUptime < deadline, complete,
               let prior = previous, prior.area == observedArea, prior.frame == observedFrame {
                stable = (observedArea, observedFrame)
                break
            }
            previous = complete ? (observedArea, observedFrame) : nil
        }
        let geometry = XCTAttachment(string: "identifier: \(identifier)\nlabel: \(label)\n" + samples.joined(separator: "\n"))
        geometry.name = "Native retention \(label) geometry observations"; geometry.lifetime = .keepAlways; add(geometry)
        try require(stable != nil,
                    "The exact inline Task button must retain a finite, stable frame fully inside the content viewport after bounded observation")
        let (area, frame) = stable!
        try require(matches.count == 1 && button.label == label && button.isEnabled,
                    "The observed exact Task action must remain unique, correctly labeled and enabled before its one touch")
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
        attachment.name = "Native retention \(label) verified touch"; attachment.lifetime = .keepAlways; add(attachment)
        app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: center.x - bounds.minX, dy: center.y - bounds.minY)).tap()
    }

    @MainActor
    private func showRun(_ run: RetentionRun) throws {
        let row = app.buttons["task.run.\(run.id)"]
        try revealText(row, identifier: "task.run.\(run.id)")
        try require(row.isHittable && row.label.contains(run.id) && row.label.localizedCaseInsensitiveContains(run.status), "The fully visible, hittable run row must identify this exact execution and state")
    }

    private func workspaceRetention(_ run: RetentionRun, slot: Int, outcome: String) throws -> RetentionWorkspaceRetention {
        guard let report = run.workspaceRetention else { throw retentionError("This terminal run must expose a typed workspace retention report") }
        try require(run.status == outcome && report.version == 1 && report.outcome == outcome
                    && report.reporterComputerId == fixture.computerId && run.computerId == fixture.computerId
                    && report.workspaceRoot.utf8.elementsEqual(fixture.instances[slot - 1].root.utf8)
                    && report.workspaceRoot.utf8.elementsEqual(run.workspaceRoot.utf8)
                    && report.workspaceBranch == "artoo/run-\(run.id)" && report.workspaceBranch == run.workspaceBranch
                    && !report.eventId.isEmpty && report.position > 0 && report.sequence >= 0 && !report.reportedAt.isEmpty,
                    "Typed retention must match the actual terminal outcome, reporter, run, root, branch and durable event")
        return report
    }

    @MainActor
    private func showRetainedWorkspace(_ run: RetentionRun, slot: Int, outcome: String, verifyCopy: Bool, caption: String, captureDetails: Bool = false) async throws {
        let report = try workspaceRetention(run, slot: slot, outcome: outcome)
        let historical: RetentionRunResponse = try await get("api/v1/runs/\(run.id)")
        try require(historical.run == run, "The independent historical run read must retain the exact task-snapshot identity and typed report")
        try showRun(run)
        let rows = app.buttons.matching(identifier: "task.run.\(run.id)")
        try require(rows.count == 1 && rows.firstMatch.isEnabled && rows.firstMatch.isHittable,
                    "Only the exact fully visible run row may open retention history")
        rows.firstMatch.tap()
        let navigation = app.navigationBars["Run Summary"]
        try require(navigation.waitForExistence(timeout: 15), "The actual run must open its native summary")
        let headingId = "run.workspace.retention.\(run.id)", heading = app.staticTexts[headingId]
        try revealText(heading, identifier: headingId)
        try require(heading.label == "Work retention reported", "The native summary must distinguish a durable report from an unconfirmed planned workspace")
        let outcomeLabel = ["completed": "Execution completed", "failed": "Execution failed", "cancelled": "Execution cancelled"][outcome]!
        // LabeledContent exposes its title and value as one accessibility label.
        for value in ["Reported outcome, \(outcomeLabel)", "Computer name (current), \(fixture.computerName)",
                      "Computer ID, \(report.reporterComputerId)", "Server recorded, \(report.reportedAt)",
                      "This is the worker's report at that time. Current file availability has not been checked."] {
            let text = app.staticTexts.matching(NSPredicate(format: "label == %@", value)).firstMatch
            try revealText(text, identifier: value)
            try require(text.label == value, "The summary must disclose the recorded outcome/time and historical-report limitation")
        }
        if captureDetails {
            let warningText = "This is the worker's report at that time. Current file availability has not been checked."
            let warning = app.staticTexts.matching(NSPredicate(format: "label == %@", warningText)).firstMatch
            try revealTogether(heading, warning, identifiers: (headingId, warningText))
            try screenshot("Native retention reported recovery details")
        }
        let pathId = "run.workspace.path.\(run.id)", branchId = "run.workspace.branch.\(run.id)"
        let path = app.staticTexts[pathId], branch = app.staticTexts[branchId]
        for (element, identifier, value) in [(path, pathId, report.workspaceRoot), (branch, branchId, report.workspaceBranch)] {
            try revealText(element, identifier: identifier)
            try require(element.label.utf8.elementsEqual(value.utf8), "The entire recovery value must match the typed report without truncation or rewriting")
        }
        if verifyCopy {
            try await copyWorkspaceValue(runId: run.id, field: "path", label: "Copy workspace path", expected: report.workspaceRoot)
            try await copyWorkspaceValue(runId: run.id, field: "branch", label: "Copy branch", expected: report.workspaceBranch)
        }
        let branchCopyId = "run.workspace.copy.branch.\(run.id)", branchCopy = app.buttons[branchCopyId]
        try revealTogether(path, branchCopy, identifiers: (pathId, branchCopyId))
        try require(branch.label.utf8.elementsEqual(report.workspaceBranch.utf8), "The capture must retain the complete branch beside the workspace path")
        try screenshot(caption)
        retentionViews.append(["caption": caption, "run_id": run.id, "task_id": run.taskId, "slot": slot,
                               "retention_event_id": report.eventId, "outcome": report.outcome,
                               "reporter_computer_id": report.reporterComputerId, "reported_at": report.reportedAt,
                               "workspace_root": report.workspaceRoot, "workspace_branch": report.workspaceBranch,
                               "path_and_branch_copied_through_ui": verifyCopy])
        let back = navigation.buttons.matching(NSPredicate(format: "label == %@", "Task"))
        try require(back.count == 1 && back.firstMatch.isEnabled && back.firstMatch.isHittable,
                    "The run summary must offer its exact Task back navigation")
        back.firstMatch.tap()
        try require(app.navigationBars["Task"].waitForExistence(timeout: 10), "Back must return to the same correction task")
    }

    @MainActor
    private func copyWorkspaceValue(runId: String, field: String, label: String, expected: String) async throws {
        let identifier = "run.workspace.copy.\(field).\(runId)", buttons = app.buttons.matching(identifier: identifier)
        try revealText(buttons.firstMatch, identifier: identifier)
        try require(buttons.count == 1 && buttons.firstMatch.label == label && buttons.firstMatch.isEnabled && buttons.firstMatch.isHittable,
                    "The exact recovery value must offer one visible Copy action")
        try await NativeClipboardProbe.verify(expected: expected, simulatorUDID: fixture.simulatorUDID,
                                               controlURL: fixture.controlURL, token: fixture.controlToken) {
            buttons.firstMatch.tap()
        }
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
            if identifier == "pairingDeviceName" {
                try require(input.identifier == identifier && input.elementType == .textField,
                            "Only the exact single-line pairing device name may use bounded native Delete")
                let current = input.value as? String ?? ""
                try require(!current.isEmpty && current != input.placeholderValue && current.count <= 128
                            && !current.contains("\n") && !current.contains("\r"),
                            "The existing device name must be a readable, bounded single-line value")
                try require(app.keyboards.firstMatch.exists && input.isEnabled && input.isHittable,
                            "The identified device name must remain editable with the native keyboard present")
                try NativePairingInput.positionDeviceNameCaret(input, in: app, expected: current)
                input.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
            } else {
                input.press(forDuration: 1.0)
                let item = app.menuItems["Select All"].firstMatch, button = app.buttons["Select All"].firstMatch
                let selectAll = item.waitForExistence(timeout: 2) ? item : button
                try require(selectAll.waitForExistence(timeout: 5) && selectAll.isHittable, "The native edit menu must select the entire existing value")
                selectAll.tap(); input.typeText(XCUIKeyboardKey.delete.rawValue)
            }
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
        for attempt in 0...14 {
            let area = try viewport(), frame = element.exists ? element.frame : .zero
            let known = !frame.isEmpty && !frame.isNull && !frame.isInfinite
            if known {
                try require(frame.height <= area.height && frame.width <= area.width,
                            "Complete text \(identifier) cannot fit the content viewport (text \(frame.size), viewport \(area.size))")
                if area.contains(frame) { return }
            }
            // Observe the final gesture's result without adding another gesture.
            guard attempt < 14 else { break }
            if known {
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
        status.name = "Native retention failure application state"; status.lifetime = .keepAlways; add(status)
        guard state == .runningForeground && !credentialsVisible else { return }
        try? screenshot("Native retention guarded failure diagnostics")
        guard app.state == .runningForeground else { return }
        let tree = XCTAttachment(string: app.debugDescription)
        tree.name = "Native retention failure accessibility hierarchy"; tree.lifetime = .keepAlways; add(tree)
    }

    private func require(_ condition: Bool, _ message: String) throws { if !condition { throw retentionError(message) } }

    private func snapshot(_ observation: RetentionObservation) throws -> RetentionSnapshot {
        guard let value = observation.snapshot else { throw retentionError("The UI-created correction task must exist") }
        return value
    }

    private func observations() async throws -> RetentionObservation {
        try await request(fixture.controlURL.appendingPathComponent("observations"), token: fixture.controlToken)
    }

    private func checkpoint(_ name: String) async throws -> RetentionObservation {
        let result: RetentionCheckpoint = try await request(fixture.controlURL.appendingPathComponent("checkpoints/\(name)"), token: fixture.controlToken,
                                                            method: "POST", body: [:], timeout: 90)
        try require(result.name == name, "The observer must attest only the requested read-only checkpoint")
        return result.observation
    }

    private func waitForTask(_ taskId: String, _ predicate: (RetentionSnapshot) -> Bool) async throws -> RetentionSnapshot {
        let deadline = Date().addingTimeInterval(30)
        repeat {
            let snapshot: RetentionSnapshot = try await get("api/v1/tasks/\(taskId)")
            if predicate(snapshot) { return snapshot }
            try await Task.sleep(nanoseconds: 200_000_000)
        } while Date() < deadline
        throw retentionError("The exact task did not reach its expected state after the native action")
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        guard let url = URL(string: path, relativeTo: fixture.serverURL) else { throw retentionError("Invalid observer read path") }
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
            throw retentionError("Read-only observation or fixture setup failed at \(url.path), HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)")
        }
        let decoder = JSONDecoder(); decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(T.self, from: data)
    }

}

private func retentionError(_ message: String) -> NSError {
    NSError(domain: "ArtooSuccessfulWorkspaceRetentionUITest", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}

private struct RetentionFixture {
    let serverURL: URL; let peerToken: String; let controlURL: URL; let controlToken: String
    let simulatorUDID: String
    let deviceName: String; let projectId: String; let taskTitle: String; let criteria: [String]
    let approvalSummaries: [String]; let instances: [RetentionInstance]; let computerId: String; let computerName: String; let runtimeId: String

    init(_ environment: [String: String]) throws {
        func value(_ name: String) throws -> String {
            guard let value = environment["ARTOO_UI_\(name)"], !value.isEmpty else { throw retentionError("Missing retention fixture field \(name)") }
            return value
        }
        func loopback(_ name: String) throws -> URL {
            guard let url = URL(string: try value(name)), let scheme = url.scheme, let host = url.host,
                  ["http", "https"].contains(scheme), ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host),
                  url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else {
                throw retentionError("Retention fixtures must use isolated loopback origins")
            }
            return url
        }
        serverURL = try loopback("SERVER_URL"); controlURL = try loopback("FIXTURE_CONTROL_URL")
        peerToken = try value("PEER_CONTROL_TOKEN"); controlToken = try value("FIXTURE_CONTROL_TOKEN")
        simulatorUDID = try value("SIMULATOR_UDID")
        deviceName = try value("NATIVE_DEVICE_NAME"); projectId = try value("PROJECT_ID"); taskTitle = try value("TASK_TITLE")
        criteria = try [value("CRITERION_1"), value("CRITERION_2")]
        approvalSummaries = try [value("APPROVAL_SUMMARY")]
        instances = try [RetentionInstance(id: value("INSTANCE_ID"), name: value("INSTANCE_NAME"), root: value("WORKSPACE_ROOT"))]
        computerId = try value("COMPUTER_ID"); computerName = try value("COMPUTER_NAME"); runtimeId = try value("RUNTIME_ID")
    }
}

private struct RetentionInstance { let id: String; let name: String; let root: String }
private struct RetentionPairing: Decodable { let code: String }
private struct RetentionTasks: Decodable { let tasks: [RetentionTask] }
private struct RetentionTask: Decodable, Equatable { let id: String; let projectId: String; let title: String; let status: String; let acceptanceCriteria: [String]?; let requiredCapabilities: [String]? }
private struct RetentionSnapshot: Decodable, Equatable { let task: RetentionTask; let runs: [RetentionRun]; let approvals: [RetentionApproval]; let artifacts: [RetentionArtifact]; let reviews: [RetentionReview] }
private struct RetentionRun: Decodable, Equatable {
    let id: String; let taskId: String; let status: String; let agentInstanceId: String; let computerId: String; let runtimeId: String
    let workspaceRoot: String; let workspaceBranch: String; let workspaceRetention: RetentionWorkspaceRetention?
}
private struct RetentionRunResponse: Decodable { let run: RetentionRun }
private struct RetentionWorkspaceRetention: Decodable, Equatable {
    let version: Int; let workspaceRoot: String; let workspaceBranch: String; let outcome: String
    let reporterComputerId: String; let eventId: String; let position: Int; let sequence: Int; let reportedAt: String
}
private struct RetentionApproval: Decodable, Equatable { let id: String; let summary: String?; let status: String; let payloadRef: String?; let runId: String? }
private struct RetentionArtifact: Decodable, Equatable { let id: String }
private struct RetentionReview: Decodable, Equatable { let eventId: String }
private struct RetentionReceipt: Decodable, Equatable { let runId: String; let pid: Int }
private struct RetentionFile: Decodable, Equatable { let sha256: String; let size: Int }
private struct RetentionWorkspace: Decodable, Equatable { let root: String; let branch: String; let files: [String: RetentionFile] }
private struct RetentionObservation: Decodable { let snapshot: RetentionSnapshot?; let receipts: [RetentionReceipt]; let livePids: [Int]; let workspace: RetentionWorkspace? }
private struct RetentionCheckpoint: Decodable { let name: String; let observation: RetentionObservation }
