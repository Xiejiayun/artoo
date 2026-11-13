import { selectProject } from "./navigation.js";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { goalAutomations, goals, runs } from "@artoo/db";
import type { ProductReleaseHealthReport, ProductReleaseReceipt, RunVerificationPayload } from "@artoo/domain";
import { buildTestServer } from "../../server/src/test-support.js";
import { createSession } from "../../server/src/auth/auth-service.js";
import { cancelGoal, createGoal } from "../../server/src/services/goal-service.js";
import { createGoalAutomationDispatcher } from "../../server/src/services/goal-automation-service.js";
import { acceptPlan, proposePlan } from "../../server/src/services/plan-service.js";
import { assignTask, markReady, reviewTask } from "../../server/src/services/lifecycle-service.js";
import { ingestWireRunEvent } from "../../server/src/services/run-service.js";
import { ensureGoalProductRelease, getGoalProductRelease } from "../../server/src/services/product-release-service.js";

const digest = `sha256:${"a".repeat(64)}`,
  previousDigest = `sha256:${"b".repeat(64)}`;

/** Real database, HTTP API, WebSocket receipt admission and rendered SPA, with
 * explicitly controlled node evidence. This does not execute a production
 * health monitor, coding model or external deployment. Their gates are separate. */
async function fixture(withPrevious = false) {
  const workspace = join(tmpdir(), "artoo-controlled-health-ui-workspace");
  const server = await buildTestServer({
    workspaceRoot: workspace,
    webDistDir: fileURLToPath(new URL("../dist", import.meta.url)),
    authConfig: { enforceApiAuth: true },
  });
  let node: WebSocket | undefined;
  try {
    const origin = await server.app.listen({ host: "127.0.0.1", port: 0 });
    // Match production's committed-event publisher; an open control socket alone
    // cannot deliver health updates, and online polling intentionally backs off.
    await server.publisher.start();
    const session = await createSession(
      server.ctx,
      { ttlMs: server.ctx.authConfig.sessionTtlMs },
      { userId: "user_owner" },
    );
    async function prepared(subjectDigest: string, title = "Controlled publication health") {
      const goal = await createGoal(server.ctx, {
        project_id: "proj_artoo",
        title,
        objective: "Display measured product health and recovery accurately",
      });
      const plan = await proposePlan(server.ctx, goal.id, {
        task_specs: [
          {
            title: "Controlled acceptance boundary",
            acceptance_criteria: ["Controlled verifier evidence for UI coverage"],
          },
        ],
      });
      const materialized = await acceptPlan(server.ctx, plan.id),
        taskId = materialized.task_ids[0]!;
      await markReady(server.ctx, taskId);
      const assigned = await assignTask(server.ctx, taskId, { mode: "auto" });
      const requirement = {
        version: 1 as const,
        request_id: `verify-controlled-ui-${assigned.run.id}`,
        profile_id: "default",
      };
      await server.db.db.update(runs).set({ verificationRequirement: requirement }).where(eq(runs.id, assigned.run.id));
      const [run] = await server.db.db.select().from(runs).where(eq(runs.id, assigned.run.id));
      const verification: RunVerificationPayload = {
        ...requirement,
        profile_digest: digest,
        subject_digest: subjectDigest,
        outcome: "passed",
        checks: [{ id: "controlled-ui-fixture", exit_code: 0, duration_ms: 1, output_digest: digest }],
        required_files: [],
      };
      for (const [sequence, event] of [
        { type: "run.lifecycle", payload: { phase: "started" } },
        { type: "run.verification", payload: verification },
        { type: "run.lifecycle", payload: { phase: "completed" } },
      ].entries())
        await ingestWireRunEvent(server.ctx, {
          kind: "run.event",
          node_id: run!.computerId,
          run_id: run!.id,
          sequence,
          event,
        });
      await reviewTask(server.ctx, taskId, {
        outcome: "accepted",
        comment: "Controlled fixture boundary, not live model acceptance",
      });
      await server.db.db.update(goals).set({ status: "running" }).where(eq(goals.id, goal.id));
      await server.db.db.insert(goalAutomations).values({
        goalId: goal.id,
        organizationId: server.ctx.organizationId,
        actorUserId: server.ctx.actorUserId,
        policyVersion: "controlled-ui-fixture",
        status: "executing",
        planId: plan.id,
        agentInstanceId: run!.agentInstanceId,
        computerId: run!.computerId,
        workspaceRoot: workspace,
        verificationProfileId: "default",
        releaseProfileId: "site",
        createdAt: server.ctx.clock.nowIso(),
        updatedAt: server.ctx.clock.nowIso(),
      });
      const [automation] = await server.db.db.select().from(goalAutomations).where(eq(goalAutomations.goalId, goal.id));
      return { goal, taskId, run: run!, automation: automation! };
    }
    const initial = withPrevious
      ? await prepared(previousDigest, "Earlier controlled publication")
      : await prepared(digest);

    node = new WebSocket(`${origin.replace("http:", "ws:")}/api/v1/node?token=dev`);
    await new Promise<void>((resolve, reject) => {
      node!.addEventListener("open", () => resolve(), { once: true });
      node!.addEventListener("error", () => reject(new Error("Controlled health node could not connect")), {
        once: true,
      });
    });
    node.send(
      JSON.stringify({
        kind: "node.hello",
        node_id: initial.run.computerId,
        protocol_version: "2026-06-11",
        artood_version: "controlled-health-ui-fixture",
        machine: { hostname: "playwright-controlled-health", os: process.platform, arch: process.arch },
        execution_features: ["run-verification.v1", "product-release.static.v1", "product-release.health.v1"],
        verification_profiles: [{ profile_id: "default", project_id: "proj_artoo", workspace_root: workspace }],
        release_profiles: [
          {
            profile_id: "site",
            project_id: "proj_artoo",
            workspace_root: workspace,
            verification_profile_id: "default",
            target_kind: "static_site",
          },
        ],
      }),
    );
    await expect
      .poll(() =>
        server.nodeRegistry
          .get(initial.run.computerId)
          ?.supportsReleaseProfile?.("site", "proj_artoo", workspace, "default"),
      )
      .toBe(true);
    const socket = node;
    const queue = (item: Awaited<ReturnType<typeof prepared>>) =>
      server.db.transaction((tx) => ensureGoalProductRelease(server.ctx, tx, item.automation));
    async function publish(item: Awaited<ReturnType<typeof prepared>>, previousReleaseId: string | null = null) {
      await expect(queue(item)).resolves.toMatchObject({ status: "pending" });
      const release = (await getGoalProductRelease(server.ctx, item.goal.id))!;
      expect(release).toMatchObject({ status: "queued", receipt: null });
      const published: ProductReleaseReceipt = {
        request: release.request,
        release_profile_digest: digest,
        artifact_digest: release.request.subject_digest,
        outcome: "published",
        endpoint: "https://controlled-product.example",
        previous_release_id: previousReleaseId,
        health_checks: [
          {
            path: "/",
            status_code: 200,
            body_digest: release.request.subject_digest,
            passed: true,
            checked_at: "2026-11-04T00:00:00Z",
          },
        ],
      };
      socket.send(
        JSON.stringify({ kind: "product.release.receipt", node_id: item.run.computerId, payload: published }),
      );
      await expect.poll(async () => (await getGoalProductRelease(server.ctx, item.goal.id))?.status).toBe("published");
      return { release, published };
    }
    let current = initial,
      previousReleaseId: string | null = null;
    if (withPrevious) {
      const prior = await publish(initial);
      await expect(queue(initial)).resolves.toMatchObject({ status: "succeeded" });
      // Publication preserves the reservation. Settle the prior goal before assigning
      // this same workspace to the next version, retaining its exact published receipt.
      await expect(cancelGoal(server.ctx, initial.goal.id)).resolves.toMatchObject({ status: "cancelled" });
      const errors: unknown[] = [],
        dispatcher = createGoalAutomationDispatcher(
          server.ctx,
          async () => {
            throw Error("The settled prior publication must not need a process stop");
          },
          (error) => errors.push(error),
        );
      try {
        await dispatcher.pump();
      } finally {
        await dispatcher.stop();
      }
      expect(errors).toEqual([]);
      expect(
        (await server.db.db.select().from(goalAutomations).where(eq(goalAutomations.goalId, initial.goal.id)))[0]!
          .status,
      ).toBe("cancelled");
      expect(await getGoalProductRelease(server.ctx, initial.goal.id)).toMatchObject({
        status: "published",
        receipt: prior.published,
      });
      previousReleaseId = prior.release.id;
      current = await prepared(digest);
      expect(current.run.computerId).toBe(initial.run.computerId);
      expect(current.goal.id).not.toBe(initial.goal.id);
      expect(current.taskId).not.toBe(initial.taskId);
      expect(current.run.id).not.toBe(initial.run.id);
    }
    const { goal, run } = current;
    const { release, published } = await publish(current, previousReleaseId);
    await server.db.db.update(goals).set({ status: "completed" }).where(eq(goals.id, goal.id));
    await server.db.db.update(goalAutomations).set({ status: "completed" }).where(eq(goalAutomations.goalId, goal.id));
    return {
      origin,
      goal,
      published,
      async authenticate(page: Page) {
        // The preview build enables AuthGate; retain it and resolve a real test session.
        await page.context().addCookies([
          {
            name: server.ctx.authConfig.sessionCookieName,
            value: session.raw,
            url: origin,
            httpOnly: true,
            sameSite: "Lax",
            secure: server.ctx.authConfig.secureCookies,
          },
        ]);
        const response = await page.request.get(`${origin}/auth/session`);
        expect(response.status()).toBe(200);
        expect((await response.json()).user.id).toBe("user_owner");
      },
      async sendHealth(sequence: number, state: ProductReleaseHealthReport["state"]) {
        const report: ProductReleaseHealthReport = {
          version: 1,
          event_id: `controlled_health_${sequence}`,
          sequence,
          request: published.request,
          release_profile_digest: digest,
          artifact_digest: digest,
          state,
          active_release_id:
            state === "unavailable" ? null : state === "rolled_back" ? published.previous_release_id : release.id,
          active_artifact_digest: state === "unavailable" ? null : state === "rolled_back" ? previousDigest : digest,
          consecutive_failures: state === "healthy" ? 0 : sequence,
          health_checks: published.health_checks.map((check) => ({
            ...check,
            passed: state === "healthy",
            status_code: state === "healthy" ? 200 : 503,
          })),
          recovery_checks:
            state === "rolled_back"
              ? published.health_checks.map((check) => ({ ...check, body_digest: previousDigest }))
              : [],
          checked_at: `2026-11-04T00:0${sequence}:00Z`,
          reason:
            state === "healthy"
              ? "Controlled health measurement recovered."
              : "Controlled health evidence for browser regression coverage; no production monitor was executed.",
        };
        const acknowledgement = new Promise<Record<string, unknown>>((resolve, reject) => {
          const timer = setTimeout(() => {
            socket.removeEventListener("message", receive);
            reject(new Error("Controlled health report commit acknowledgement timed out"));
          }, 15000);
          function receive(event: MessageEvent) {
            const command = JSON.parse(String(event.data));
            if (command.type !== "product.release.health.ack" || command.payload.event_id !== report.event_id) return;
            clearTimeout(timer);
            socket.removeEventListener("message", receive);
            resolve(command.payload);
          }
          socket.addEventListener("message", receive);
        });
        socket.send(JSON.stringify({ kind: "product.release.health", node_id: run!.computerId, payload: report }));
        expect(await acknowledgement).toEqual({
          event_id: report.event_id,
          release_id: release.id,
          sequence,
          status: "accepted",
        });
        return report;
      },
      async close() {
        socket.close();
        await server.close();
      },
    };
  } catch (error) {
    node?.close();
    await server.close();
    throw error;
  }
}

async function openPublication(page: Page, item: Awaited<ReturnType<typeof fixture>>) {
  await item.authenticate(page);
  await page.goto(`${item.origin}/goals`);
  await selectProject(page, "plan");
  await page
    .getByRole("navigation", { name: "Goal list" })
    .getByRole("button", { name: /Controlled publication health/ })
    .click();
  await page.getByText("Publication details", { exact: false }).click();
  const publication = page.getByLabel("Product publication", { exact: true });
  await expect(publication.getByRole("link", { name: "Open published product" })).toBeVisible();
  return publication;
}

async function mobileEvidence(page: Page, name: string, testInfo: TestInfo) {
  await page.setViewportSize({ width: 390, height: 844 });
  const progress = page.getByRole("region", { name: "Autonomous progress" });
  await progress.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await progress.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(
    await page.locator(".pane").evaluateAll((panes) => panes.every((pane) => pane.scrollWidth <= pane.clientWidth + 1)),
  ).toBe(true);
  const screenshot = testInfo.outputPath(`controlled-health-${name}-mobile.png`);
  await progress.screenshot({ path: screenshot });
  await testInfo.attach(`Controlled health UI · ${name} · mobile`, { path: screenshot, contentType: "image/png" });
}

test("controlled health evidence updates published to degraded and recovered through the real API", async ({
  page,
}, testInfo) => {
  const item = await fixture();
  try {
    const publication = await openPublication(page, item);
    await expect(publication.getByText("Published", { exact: true })).toBeVisible();
    await expect(publication.locator("time")).toHaveCount(0);
    const degraded = await item.sendHealth(1, "degraded");
    await expect(publication).toContainText("The latest health check failed.");
    await expect(publication.getByRole("link", { name: "Open published product" })).toHaveCount(0);
    await expect(publication.locator("time")).toHaveAttribute("datetime", degraded.checked_at);
    await expect(publication).toContainText("latest received observation");
    await mobileEvidence(page, "degraded", testInfo);
    const recovered = await item.sendHealth(2, "healthy");
    await expect(publication).toContainText("the latest health check passed.");
    await expect(publication.getByRole("link", { name: "Open published product" })).toHaveAttribute(
      "href",
      `${item.published.endpoint}/`,
    );
    await expect(publication.locator("time")).toHaveAttribute("datetime", recovered.checked_at);
    await mobileEvidence(page, "recovered", testInfo);
    const stored = await (await page.request.get(`${item.origin}/api/v1/goals/${item.goal.id}/release`)).json();
    expect(stored.release).toMatchObject({ status: "published", receipt: item.published, health: recovered });
  } finally {
    await item.close();
  }
});

for (const state of ["rolled_back", "unavailable"] as const) {
  test(`controlled ${state} evidence hides the original product link and survives reload`, async ({
    page,
  }, testInfo) => {
    const item = await fixture(state === "rolled_back");
    try {
      const publication = await openPublication(page, item),
        report = await item.sendHealth(1, state);
      await expect(publication).toContainText(
        state === "rolled_back" ? "the previous release was restored and checked" : "taken offline",
      );
      await expect(publication.getByRole("link", { name: "Open published product" })).toHaveCount(0);
      await expect(publication.locator("time")).toHaveAttribute("datetime", report.checked_at);
      await mobileEvidence(page, state, testInfo);
      await page.reload();
      await page
        .getByRole("navigation", { name: "Goal list" })
        .getByRole("button", { name: /Controlled publication health/ })
        .click();
      await expect(publication).toContainText(
        state === "rolled_back" ? "the previous release was restored and checked" : "taken offline",
      );
      await expect(publication.getByRole("link", { name: "Open published product" })).toHaveCount(0);
      await expect(publication.locator("time")).toHaveAttribute("datetime", report.checked_at);
      const stored = await (await page.request.get(`${item.origin}/api/v1/goals/${item.goal.id}/release`)).json();
      expect(stored.release).toMatchObject({ status: "published", receipt: item.published, health: report });
    } finally {
      await item.close();
    }
  });
}
