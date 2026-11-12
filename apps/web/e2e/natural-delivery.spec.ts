import { expect, test } from "@playwright/test";

test("a conversation becomes an editable goal, then keeps its context through work and delivery", async ({ page, request }) => {
  const marker = `natural-${Date.now()}`;
  const channelResponse = await request.post("/api/v1/channels", { data: { project_id: "proj_artoo", name: marker } });
  expect(channelResponse.ok()).toBe(true);
  const { channel } = await channelResponse.json();
  const objective = `Build a running journal ${marker}`;
  const messageResponse = await request.post(`/api/v1/rooms/${channel.id}/messages`, { data: { kind: "text", body: objective } });
  expect(messageResponse.ok()).toBe(true);
  const { message } = await messageResponse.json();
  await page.goto(`/channels?room=${channel.id}`);
  const row = page.getByRole("article", { name: "text message" }).filter({ hasText: objective });
  await row.hover();
  let submissions = 0;
  page.on("request", item => { if (item.method() === "POST" && /\/goals(?:\/autonomous)?$/.test(new URL(item.url()).pathname)) submissions++; });
  await row.getByRole("button", { name: "Plan this", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New goal", exact: true });
  await expect(dialog.getByLabel("Objective", { exact: true })).toHaveValue(objective);
  await expect(dialog).toContainText("Draft from a conversation");
  expect(submissions).toBe(0);
  await dialog.getByLabel("Goal acceptance criteria").fill("Running entries remain available after reload");
  await dialog.getByRole("button", { name: "Create goal", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(submissions).toBe(1);
  const goalId = new URL(page.url()).searchParams.get("goal")!;
  const proposal = await request.post(`/api/v1/goals/${goalId}/plans`, { data: { rationale: "Implement, then validate persistence.", task_specs: [
    { title: `Implement entries ${marker}`, acceptance_criteria: ["Entries persist"] },
    { title: `Validate entries ${marker}`, acceptance_criteria: ["Reload preserves entries"], dependencies: [{ ref: "0", type: "blocks" }] },
  ] } });
  expect(proposal.ok()).toBe(true);
  const { plan } = await proposal.json();
  const accepted = await request.post(`/api/v1/plans/${plan.id}/accept`);
  expect(accepted.ok()).toBe(true);
  await page.reload();
  await expect(page.getByRole("region", { name: "Current goal progress" })).toContainText("0 / 2 done");
  const views = page.getByRole("navigation", { name: "Project views", exact: true });
  await views.getByRole("link", { name: "Board", exact: true }).click();
  await expect(page.getByLabel("Goal scope")).toHaveValue(goalId);
  await expect(page.getByRole("button", { name: new RegExp(`Implement entries ${marker}`) })).toBeVisible();
  await page.getByRole("button", { name: new RegExp(`Implement entries ${marker}`) }).click();
  await expect(page).toHaveURL(new RegExp(`/\\?goal=${goalId}$`));
  await expect(page.getByRole("complementary", { name: "Task detail" })).toContainText(`Implement entries ${marker}`);
  await views.getByRole("link", { name: "Board", exact: true }).click();
  await expect(page.getByLabel("Goal scope")).toHaveValue(goalId);
  await views.getByRole("link", { name: "Release", exact: true }).click();
  await expect(page.getByRole("region", { name: "Publication overview" })).toContainText(objective);
  await expect(page.getByText("Not configured", { exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel("Goal scope")).toHaveValue(goalId);
  await views.getByRole("link", { name: "Thread", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`goal=${goalId}`));
  // Return to the source discussion and check that only the reply composer remains.
  await page.goto(`/channels?room=${channel.id}&thread=${message.id}`);
  await expect(page.getByRole("form", { name: "Send room message", exact: true })).toHaveCount(1);
  await expect(page.getByText("Replying in this thread", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close thread", exact: true }).click();
  await expect(page.getByRole("region", { name: "Channel conversation", exact: true }).getByLabel("Message", { exact: true })).toBeVisible();
});
