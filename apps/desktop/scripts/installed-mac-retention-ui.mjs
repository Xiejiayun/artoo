import assert from "node:assert/strict";

/** Inspect original product content and the real Electron system clipboard.
 * Callers supply identity already bound to their passive server observation. */
export async function inspectInstalledMacRetention({ page, electronApp, api, identity, taskId, runId = identity.run.id }) {
  const { expect } = await import("@playwright/test");
  const { run, report, outcome_label } = identity;
  assert.equal(run.task_id, taskId);
  assert.equal(run.id, runId);
  const row = page.getByRole("complementary", { name: "Task detail", exact: true }).getByRole("listitem", { name: `Run ${runId}`, exact: true }), card = row.getByRole("region", { name: `Workspace for ${runId}`, exact: true });
  await expect(row).toHaveAttribute("data-status", run.status); await expect(row.locator(".run-id")).toHaveText(runId);
  await expect(card).toHaveCount(1); await expect(card.getByText("Work retention reported", { exact: true })).toBeVisible();
  await expect(card.getByText("Reported outcome", { exact: true })).toBeVisible();
  await expect(card.getByText(outcome_label, { exact: true })).toBeVisible();
  await expect(card.getByText("Reported workspace", { exact: true })).toBeVisible();
  await expect(card.getByText("This is the worker's report at that time. Current file availability has not been checked.", { exact: true })).toBeVisible();
  await expect(card.getByText("Retention not reported", { exact: true })).toHaveCount(0);
  await expect(card.locator("time")).toHaveAttribute("datetime", report.reported_at);
  const computers = (await api("/api/v1/bootstrap")).computers.filter((computer) => computer.id === report.reporter_computer_id);
  assert.equal(computers.length, 1); const computer = computers[0];
  const computerName = computer.display_name?.trim() || computer.hostname?.trim();
  assert.ok(computerName, "The fixture's reporting computer needs a readable identity");
  await expect(card.getByText(computerName, { exact: true })).toBeVisible();
  const copied = [];
  for (const [name, expected, status] of [["Copy workspace path", report.workspace_root, "Workspace path copied"],
    ["Copy branch", report.workspace_branch, "Branch copied"]]) {
    // A sentinel cannot satisfy the assertion. Do not replace the product's
    // clipboard implementation or write the expected value from the harness.
    await electronApp.evaluate(({ clipboard }, sentinel) => clipboard.writeText(sentinel), `artoo-copy-pending:${runId}:${name}`);
    await card.getByRole("button", { name, exact: true }).click();
    await expect(card.getByRole("status")).toHaveText(status);
    const actual = await electronApp.evaluate(({ clipboard }) => clipboard.readText());
    assert.equal(actual, expected, `The actual ${name} action must copy the exact selected run value`);
    copied.push({ action: name, value: actual });
  }
  await card.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
  await expect(card).toBeInViewport({ ratio: 1 });
  await expect(card.getByText(runId, { exact: true })).toBeInViewport({ ratio: 1 });
  for (const text of [runId, report.workspace_root, report.workspace_branch, report.reporter_computer_id, computerName]) {
    const value = card.getByText(text, { exact: true }); await expect(value).toHaveCount(1);
    assert.equal(await value.textContent(), text, "Recovery identity must preserve exact case, Unicode and whitespace");
    const visible = await value.evaluate((element) => {
      const range = document.createRange(); range.selectNodeContents(element);
      const bounds = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent), rect = parent.getBoundingClientRect();
        if (/auto|scroll|hidden|clip/.test(style.overflowX)) { bounds.left = Math.max(bounds.left, rect.left + parent.clientLeft); bounds.right = Math.min(bounds.right, rect.left + parent.clientLeft + parent.clientWidth); }
        if (/auto|scroll|hidden|clip/.test(style.overflowY)) { bounds.top = Math.max(bounds.top, rect.top + parent.clientTop); bounds.bottom = Math.min(bounds.bottom, rect.top + parent.clientTop + parent.clientHeight); }
      }
      const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
      return rects.length > 0 && rects.every((rect) => rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1
        && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1);
    });
    assert.equal(visible, true, "Every complete recovery value must fit the original captured viewport without clipped text");
  }
  return { card, evidence: { run_id: runId, task_id: taskId, report: structuredClone(report),
    computer_name: computerName, copied, complete_values_visible: true } };
}
