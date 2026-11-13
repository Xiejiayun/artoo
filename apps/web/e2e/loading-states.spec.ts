import { expect, test, type Locator, type Page, type Route } from "@playwright/test";

/** Hold the actual local server response; no successful API payload is synthesized. */
async function holdResponse(page: Page, pattern: RegExp) {
  let release!: () => void;
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const finished = new Promise<void>(resolve => { finish = resolve; });
  let intercepted = false;
  const handler = async (route: Route) => {
    intercepted = true;
    try {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await gate;
      await route.fulfill({ response });
    } finally { finish(); }
  };
  await page.route(pattern, handler);
  let completion: Promise<void> | undefined;
  return () => completion ??= (async () => { release(); if (intercepted) await finished; await page.unroute(pattern, handler); })();
}

async function columns(layout: Locator) {
  return layout.locator(":scope > *").evaluateAll(elements => elements.map(element => {
    const { x, width } = element.getBoundingClientRect();
    return { x, width };
  }));
}

test("Plan placeholders use the real responsive columns in both themes and settle into actual goals", async ({ page, request }, testInfo) => {
  const title = `Loading outcome ${Date.now()}`;
  const response = await request.post("/api/v1/goals", { headers: { "Idempotency-Key": title }, data: {
    project_id: "proj_artoo", title, objective: "Controlled loading-state browser check", priority: "p2", acceptance_criteria: ["Preserve actual content"],
  } });
  expect(response.ok()).toBe(true);
  const { goal } = await response.json();
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const theme of ["dark", "light"]) {
    for (const width of [1440, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(value => localStorage.setItem("artoo.theme", value), theme);
      const release = await holdResponse(page, /\/api\/v1\/goals\?/);
      try {
        await page.goto(`/goals?goal=${encodeURIComponent(goal.id)}`);
        const loading = page.locator(".loading-view--goals");
        await expect(loading).toContainText("Loading goals…");
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expect(loading.locator("button, input, a, [tabindex]")).toHaveCount(0);
        expect(await loading.evaluate(element => getComputedStyle(element).padding)).toBe("0px");
        expect(await loading.locator(".ui-skeleton").first().evaluate(element => getComputedStyle(element).animationName)).toBe("none");
        await expect(page.locator(".delivery-new-outcome")).not.toHaveAttribute("open");
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        const before = await columns(loading.locator(".insights-goal-layout"));
        await page.screenshot({ path: testInfo.outputPath(`goals-loading-${theme}-${width}.png`) });
        await release();
        await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
        await expect(loading).toHaveCount(0);
        const after = await columns(page.locator(".insights-goal-layout"));
        expect(before).toHaveLength(2);
        expect(after).toHaveLength(2);
        for (let i = 0; i < before.length; i++) {
          expect(Math.abs(before[i]!.x - after[i]!.x)).toBeLessThan(1);
          expect(Math.abs(before[i]!.width - after[i]!.width)).toBeLessThan(1);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`goals-loaded-${theme}-${width}.png`) });
      } finally { await release(); }
    }
  }
});

test("Release waits for actual evidence before rendering conclusions", async ({ page, request }, testInfo) => {
  const title = `Pending evidence ${Date.now()}`;
  const response = await request.post("/api/v1/goals", { headers: { "Idempotency-Key": title }, data: {
    project_id: "proj_artoo", title, objective: "Wait for the recorded evidence", priority: "p2", acceptance_criteria: [],
  } });
  expect(response.ok()).toBe(true);
  const { goal } = await response.json();
  const release = await holdResponse(page, new RegExp(`/api/v1/goals/${goal.id}/release$`));
  try {
    await page.goto(`/release?goal=${encodeURIComponent(goal.id)}`);
    await expect(page.getByText("Loading publication evidence…", { exact: true })).toBeVisible();
    await expect(page.getByText("Not published", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Release checks" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Open published product" })).toHaveCount(0);
    await page.setViewportSize({ width: 320, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("release-evidence-loading-320.png") });
    await release();
    await expect(page.getByRole("region", { name: "Publication overview" })).toContainText("Not published");
    await expect(page.getByRole("region", { name: "Release checks" })).toContainText("Not configured");
    await expect(page.getByText("Loading publication evidence…", { exact: true })).toHaveCount(0);
  } finally { await release(); }
});

test("a delayed route and devices retain navigation and the usable project form", async ({ page }, testInfo) => {
  const resumeRoute = await holdResponse(page, /\/src\/components\/SettingsPage\.tsx(?:\?|$)/);
  const resumeDevices = await holdResponse(page, /\/api\/v1\/devices$/);
  try {
    await page.goto("/settings");
    await expect(page.locator(".loading-view--page")).toContainText("Loading…");
    await expect(page.getByRole("navigation", { name: "Primary", exact: true }).getByRole("link", { name: "ARTOO home", exact: true })).toBeVisible();
    await expect(page.locator(".os-header .os-breadcrumb")).toContainText("Settings");
    await resumeRoute();
    await expect(page.getByRole("form", { name: "Edit project", exact: true })).toBeVisible();
    const devices = page.getByRole("region", { name: "Devices", exact: true });
    await expect(devices).toContainText("Loading devices…");
    await page.setViewportSize({ width: 320, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await devices.scrollIntoViewIfNeeded();
    await expect(devices.getByText("Loading devices…", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("settings-devices-loading-320.png") });
    await resumeDevices();
    await expect(devices.getByText("Loading devices…", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("form", { name: "Edit project", exact: true }).getByRole("button", { name: "Save project", exact: true })).toBeEnabled();
  } finally { await resumeRoute(); await resumeDevices(); }
});
