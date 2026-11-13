import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

test("Goal links restore their authorized project across Plan, Release and Board reloads", async ({
  page,
  request,
}) => {
  const marker = randomUUID();
  const createdProject = await request.post("/api/v1/projects", { data: { name: `ZZ linked destination ${marker}` } });
  expect(createdProject.ok()).toBe(true);
  const { project } = await createdProject.json();
  const title = `Linked outcome ${marker}`;
  const createdGoal = await request.post("/api/v1/goals", {
    headers: { "Idempotency-Key": marker },
    data: {
      project_id: project.id,
      title,
      objective: "Preserve the actual goal project across reloads",
      acceptance_criteria: [],
    },
  });
  expect(createdGoal.ok()).toBe(true);
  const { goal } = await createdGoal.json();
  for (const route of ["/goals", "/release", "/board"]) {
    // The unrelated URL hint cannot select the project's Goal. The API owns its binding.
    await page.goto(`${route}?goal=${encodeURIComponent(goal.id)}&project=proj_artoo`);
    await expect(
      page
        .getByRole("navigation", { name: "Primary", exact: true })
        .getByRole("button", { name: project.name, exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    if (route === "/board") await expect(page.getByLabel("Goal scope")).toHaveValue(goal.id);
    else await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(page.getByText("This goal is unavailable in the selected project.", { exact: false })).toHaveCount(0);
  }
});
