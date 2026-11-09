// @vitest-environment jsdom
import type { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoalAutomationSchema, GoalSchema } from "@artoo/domain";
import { ApiClientError, type ApiClient } from "../api/client.js";
import type { ApplicationPublicationView } from "../api/types.js";
import { queryKeys } from "../app/queryKeys.js";
import { bootstrapFixture, createTestQueryClient, fakeApi, renderWithProviders } from "../test/utils.js";
import { GoalsPage } from "./GoalsPage.js";

const goal = GoalSchema.parse({ id: "goal_application", organization_id: "org_default", project_id: "proj_artoo", room_id: null,
  owner_user_id: "user_1", title: "A local application", objective: "Save and reopen a personal journal", priority: "p2", status: "completed",
  acceptance_criteria: [], stop_conditions: {}, budgets: {}, current_plan_id: null, running_since: null, elapsed_cost_usd: null,
  retry_count: 0, created_at: "2026-11-09", updated_at: "2026-11-09" });
const automation = GoalAutomationSchema.parse({ goal_id: goal.id, organization_id: "org_default", actor_user_id: "user_1",
  consent_id: null, policy_version: "local-v1", status: "completed", discussion_id: null, plan_id: null, agent_instance_id: null,
  computer_id: null, workspace_root: null, execution_mode: "agent_team", verification_profile_id: "application-verifier",
  app_publication: { version: 1, kind: "same-computer-local-application-publication", publication_profile_id: "application-publisher" },
  application_publication_authorization_event_id: "publication-consent", last_error: null, created_at: goal.created_at, updated_at: goal.updated_at });
const iso = (offset: number) => new Date(Date.now() + offset).toISOString();
const clients: QueryClient[] = [];

// Controlled display projections exercise the Web/API boundary only. They are
// deliberately not complete native publication receipts or acceptance evidence.
function snapshot(state: ApplicationPublicationView["current_state"] = "healthy"): ApplicationPublicationView {
  const pending = state === "pending", closed = state === "closed-normal" || state === "closed-aborted";
  const lease = { deadline_at: iso(600_000) };
  return {
    id: "application-publication", goal_id: goal.id, status: pending ? "queued" : "published",
    scope: "bounded-local-application-publication", created_at: iso(-10_000), updated_at: iso(-1_000), current_state: state,
    endpoint: pending ? null : "http://127.0.0.1:4173",
    request: { capabilities: { contract: { limits: { health_freshness_ms: 30_000 } } } },
    receipt: pending ? null : { outcome: "published", recorded_at: iso(-3_000), lease, deployment: { origin: "http://127.0.0.1:4173" } },
    latest_observation: pending ? null : { state, observed_at: iso(-1_000), lease, reason: null,
      health: state === "healthy" ? { checked_at: iso(-2_000) } : null,
      live: ["healthy", "live", "draining"].includes(state) ? { observed_at: iso(-1_000), counters_observed_at: iso(-1_000) } : null,
      closure: closed ? { kind: state === "closed-normal" ? "normal-drain" : "aborted" } : null },
  } as unknown as ApplicationPublicationView;
}

function renderPublication(publication: ApplicationPublicationView | null, overrides: Partial<ApiClient> = {}) {
  const query = createTestQueryClient();
  query.setDefaultOptions({ queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } });
  query.setQueryData(queryKeys.bootstrap, bootstrapFixture());
  query.setQueryData(["goals", goal.project_id], { goals: [goal] });
  query.setQueryData(["goal-automation", goal.id], { automation });
  query.setQueryData(["plans", goal.id], { plans: [] });
  query.setQueryData(["checkpoints", goal.id], { checkpoints: [] });
  clients.push(query);
  renderWithProviders(<GoalsPage />, { queryClient: query, client: fakeApi({ bootstrap: async () => bootstrapFixture(),
    listGoals: async () => ({ goals: [goal] }), getGoalAutomation: async () => ({ automation }), listPlans: async () => ({ plans: [] }),
    listCheckpoints: async () => ({ checkpoints: [] }), getGoalApplicationPublication: async () => ({ publication }), ...overrides }) });
  return query;
}
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(1); });
const publicationRegion = () => within(screen.getByRole("region", { name: "Application publication" }));

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-09T12:00:00Z")); });
afterEach(async () => {
  cleanup();
  for (const query of clients.splice(0)) { await query.cancelQueries(); query.clear(); }
  vi.useRealTimers();
});

describe("application publication history and current availability", () => {
  it("keeps an absent publication pending without claiming success or offering a stop", async () => {
    renderPublication(null); await settle();
    const region = publicationRegion();
    expect(region.getByLabelText("Publication history")).toHaveTextContent("No completed application publication has been recorded.");
    expect(region.getByLabelText("Current application availability")).toHaveTextContent("Waiting for implementation, tests and independent review.");
    expect(region.queryByRole("link")).not.toBeInTheDocument();
    expect(region.queryByRole("button", { name: "Stop application" })).not.toBeInTheDocument();
  });

  it("reports unavailable history and unknown availability when the initial GET fails", async () => {
    renderPublication(null, { getGoalApplicationPublication: async () => { throw new Error("Publication status is unavailable"); } }); await settle();
    const region = publicationRegion();
    expect(region.getByLabelText("Publication history")).toHaveTextContent("Publication history is unavailable.");
    expect(region.getByLabelText("Current application availability")).toHaveTextContent("Current availability is unconfirmed.");
    expect(region.getByRole("alert")).toHaveTextContent("Publication status is unavailable");
    expect(region.queryByRole("link")).not.toBeInTheDocument();
  });

  it("allows cancellation of a queued publication without claiming it has published", async () => {
    renderPublication(snapshot("pending")); await settle();
    const region = publicationRegion();
    expect(region.getByLabelText("Publication history")).toHaveTextContent("No completed application publication has been recorded.");
    expect(region.getByLabelText("Current application availability")).toHaveTextContent("Publishing and checking the application…");
    expect(region.getByRole("button", { name: "Stop application" })).toBeEnabled();
    expect(region.queryByRole("link")).not.toBeInTheDocument();
  });

  it.each(["unconfirmed", "not-started", "closed-confirmed"] as const)("shows a failed publication with %s cleanup honestly", async state => {
    const value = snapshot("unknown"); value.status = "failed"; value.endpoint = null; value.latest_observation = null;
    value.receipt = { outcome: "failed", recorded_at: iso(-3_000), lease: state === "not-started" ? null : value.receipt!.lease, reason: "The original startup did not complete",
      cleanup: { state } } as ApplicationPublicationView["receipt"];
    renderPublication(value); await settle();
    const region = publicationRegion();
    expect(region.getByLabelText("Publication history")).toHaveTextContent("Publication failed.");
    expect(region.getByText("The original startup did not complete")).toBeInTheDocument();
    expect(region.queryByRole("link")).not.toBeInTheDocument();
    if (state === "unconfirmed") {
      expect(region.getByLabelText("Current application availability")).toHaveTextContent("Current availability is unconfirmed.");
      expect(region.getByRole("button", { name: "Stop application" })).toBeEnabled();
    } else {
      expect(region.getByLabelText("Current application availability")).toHaveTextContent("No application is running from this attempt.");
      expect(region.queryByRole("button", { name: "Stop application" })).not.toBeInTheDocument();
    }
  });

  it("offers a current local address and a stop after the development goal has completed", async () => {
    renderPublication(snapshot()); await settle();
    const region = publicationRegion();
    expect(region.getByLabelText("Publication history")).toHaveTextContent("Published at");
    expect(region.getByLabelText("Current application availability")).toHaveTextContent("Running — the latest health check passed.");
    expect(region.getByRole("link", { name: "Open local application" })).toHaveAttribute("href", "http://127.0.0.1:4173/");
    expect(region.getByRole("button", { name: "Stop application" })).toBeEnabled();
    expect(screen.queryByText(/verified workspace is ready; it has not been automatically published/)).not.toBeInTheDocument();
    expect(region.getByText(/configured time and request limits/)).toBeInTheDocument();
  });

  it.each([
    ["live", "Running — a fresh health check is unavailable."],
    ["draining", "Stopping — waiting for the application to close."],
    ["unknown", "Current availability is unconfirmed."],
    ["expired", "The configured running time has ended."],
    ["closed-normal", "Stopped."],
    ["closed-aborted", "Stopped after an interruption."],
  ] as const)("preserves publication history without advertising a usable address for %s", async (state, label) => {
    renderPublication(snapshot(state)); await settle();
    const region = publicationRegion();
    expect(region.getByLabelText("Publication history")).toHaveTextContent("Published at");
    expect(region.getByLabelText("Current application availability")).toHaveTextContent(label);
    expect(region.queryByRole("link")).not.toBeInTheDocument();
    if (state.startsWith("closed")) expect(region.queryByRole("button", { name: "Stop application" })).not.toBeInTheDocument();
    else expect(region.getByRole("button", { name: "Stop application" })).toBeEnabled();
  });

  it.each(["observed_at", "health", "live", "counters"] as const)("withholds a healthy address when the %s evidence is old", async field => {
    const value = snapshot(), report = value.latest_observation!;
    if (field === "observed_at") report.observed_at = iso(-30_001);
    if (field === "health") report.health!.checked_at = iso(-30_001);
    if (field === "live") report.live!.observed_at = iso(-30_001);
    if (field === "counters") report.live!.counters_observed_at = iso(-30_001);
    renderPublication(value); await settle();
    expect(publicationRegion().getByLabelText("Current application availability")).toHaveTextContent("Current availability is unconfirmed.");
    expect(publicationRegion().queryByRole("link")).not.toBeInTheDocument();
  });

  it("expires an old successful observation while the next GET hangs, and recovers on fresh evidence", async () => {
    let respond!: (result: { publication: ApplicationPublicationView }) => void;
    const getGoalApplicationPublication = vi.fn<ApiClient["getGoalApplicationPublication"]>().mockResolvedValueOnce({ publication: snapshot() })
      .mockImplementation(() => new Promise(resolve => { respond = resolve; }));
    renderPublication(null, { getGoalApplicationPublication }); await settle();
    expect(publicationRegion().getByRole("link", { name: "Open local application" })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_001); });
    expect(getGoalApplicationPublication).toHaveBeenCalledTimes(2);
    expect(publicationRegion().getByLabelText("Current application availability")).toHaveTextContent("Current availability is unconfirmed.");
    expect(publicationRegion().queryByRole("link")).not.toBeInTheDocument();
    await act(async () => { respond({ publication: snapshot() }); await vi.advanceTimersByTimeAsync(1); });
    expect(publicationRegion().getByRole("link", { name: "Open local application" })).toBeInTheDocument();
  });

  it("hides a healthy address at the original lease deadline without waiting for another response", async () => {
    const value = snapshot(); value.receipt!.lease!.deadline_at = iso(2_000);
    renderPublication(value); await settle();
    expect(publicationRegion().getByRole("link", { name: "Open local application" })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_001); });
    expect(publicationRegion().queryByRole("link")).not.toBeInTheDocument();
    expect(publicationRegion().getByLabelText("Publication history")).toHaveTextContent("Published at");
  });

  it("withholds a future-dated observation instead of treating it as fresh", async () => {
    const value = snapshot(); value.latest_observation!.observed_at = iso(60_000);
    renderPublication(value); await settle();
    expect(publicationRegion().getByLabelText("Current application availability")).toHaveTextContent("Current availability is unconfirmed.");
    expect(publicationRegion().queryByRole("link")).not.toBeInTheDocument();
  });

  it("retains historical success while a failed refresh suppresses current availability", async () => {
    const getGoalApplicationPublication = vi.fn<ApiClient["getGoalApplicationPublication"]>().mockResolvedValueOnce({ publication: snapshot() })
      .mockRejectedValue(new Error("The publishing computer is unreachable"));
    const query = renderPublication(null, { getGoalApplicationPublication }); await settle();
    await act(async () => { await query.invalidateQueries({ queryKey: ["goal-application-publication", goal.id] }); await vi.advanceTimersByTimeAsync(1); });
    const region = publicationRegion();
    expect(region.getByLabelText("Publication history")).toHaveTextContent("Published at");
    expect(region.getByLabelText("Current application availability")).toHaveTextContent("Current availability is unconfirmed.");
    expect(region.getByRole("alert")).toHaveTextContent("The publishing computer is unreachable");
    expect(region.queryByRole("link")).not.toBeInTheDocument();
    expect(region.getByRole("button", { name: "Stop application" })).toBeEnabled();
  });

  it.each(["javascript:alert(1)", "http://127.0.0.1:4173/private", "http://127.0.0.1:4173/?token=private",
    "http://127.0.0.1:4173/#section", "http://user:password@127.0.0.1:4173", "https://example.com/", "not an address"])(
    "does not advertise an unsupported endpoint %s", async endpoint => {
      const value = snapshot(); value.endpoint = endpoint;
      if (value.receipt?.outcome === "published") value.receipt.deployment.origin = endpoint;
      renderPublication(value); await settle();
      expect(publicationRegion().getByLabelText("Publication history")).toHaveTextContent("Published at");
      expect(publicationRegion().queryByRole("link")).not.toBeInTheDocument();
    });

  it("rejects an address that differs from the original publication receipt", async () => {
    const value = snapshot(); value.endpoint = "http://127.0.0.1:9999";
    renderPublication(value); await settle(); expect(publicationRegion().queryByRole("link")).not.toBeInTheDocument();
  });

  it("waits for the stop response and actual closed state without changing the historical outcome", async () => {
    let current = snapshot(), respond!: () => void;
    const stopGoalApplicationPublication = vi.fn<ApiClient["stopGoalApplicationPublication"]>().mockImplementation(() => new Promise(resolve => {
      respond = () => { current = snapshot("closed-normal"); resolve({ publication: current }); };
    }));
    renderPublication(null, { getGoalApplicationPublication: async () => ({ publication: current }), stopGoalApplicationPublication }); await settle();
    fireEvent.click(publicationRegion().getByRole("button", { name: "Stop application" })); await settle();
    expect(stopGoalApplicationPublication).toHaveBeenCalledExactlyOnceWith(goal.id, expect.any(String));
    expect(publicationRegion().getByRole("button", { name: "Stop application" })).toBeDisabled();
    expect(publicationRegion().getByLabelText("Current application availability")).toHaveTextContent("Stopping — waiting for the application to close.");
    expect(publicationRegion().queryByRole("link")).not.toBeInTheDocument();
    expect(publicationRegion().getByLabelText("Publication history")).toHaveTextContent("Published at");
    fireEvent.click(publicationRegion().getByRole("button", { name: "Stop application" }));
    expect(stopGoalApplicationPublication).toHaveBeenCalledOnce();
    await act(async () => { respond(); await vi.advanceTimersByTimeAsync(1); });
    expect(publicationRegion().getByLabelText("Current application availability")).toHaveTextContent("Stopped.");
    expect(publicationRegion().getByLabelText("Publication history")).toHaveTextContent("Published at");
    expect(publicationRegion().queryByRole("button", { name: "Stop application" })).not.toBeInTheDocument();
    expect(publicationRegion().queryByRole("link")).not.toBeInTheDocument();
  });

  it("preserves a rejected stop and allows retry without reporting the application stopped", async () => {
    let current = snapshot();
    const stopGoalApplicationPublication = vi.fn<ApiClient["stopGoalApplicationPublication"]>().mockImplementation(async () => {
      current = snapshot("unknown"); throw new ApiClientError("conflict", "Original service closure remains unconfirmed", 409);
    });
    renderPublication(null, { getGoalApplicationPublication: async () => ({ publication: current }), stopGoalApplicationPublication }); await settle();
    fireEvent.click(publicationRegion().getByRole("button", { name: "Stop application" })); await settle();
    const region = publicationRegion();
    expect(region.getByRole("alert")).toHaveTextContent("Original service closure remains unconfirmed");
    expect(region.getByLabelText("Current application availability")).toHaveTextContent("Current availability is unconfirmed.");
    expect(region.getByRole("button", { name: "Stop application" })).toBeEnabled();
    expect(region.getByLabelText("Publication history")).toHaveTextContent("Published at");
    expect(region.queryByRole("link")).not.toBeInTheDocument();
    fireEvent.click(region.getByRole("button", { name: "Stop application" })); await settle();
    expect(stopGoalApplicationPublication).toHaveBeenCalledTimes(2);
  });

  it.each(["confirmed", "rejected"] as const)("settles a %s stop even while the following status GET hangs", async outcome => {
    const getGoalApplicationPublication = vi.fn<ApiClient["getGoalApplicationPublication"]>().mockResolvedValueOnce({ publication: snapshot() })
      .mockImplementation(() => new Promise(() => {}));
    const stopGoalApplicationPublication = vi.fn<ApiClient["stopGoalApplicationPublication"]>().mockImplementation(async () => {
      if (outcome === "rejected") throw new ApiClientError("conflict", "Original service closure remains unconfirmed", 409);
      return { publication: snapshot("closed-normal") };
    });
    const query = renderPublication(null, { getGoalApplicationPublication, stopGoalApplicationPublication }); await settle();
    fireEvent.click(publicationRegion().getByRole("button", { name: "Stop application" })); await settle();
    expect(query.getQueryState(["goal-application-publication", goal.id])?.fetchStatus).toBe("fetching");
    const region = publicationRegion();
    expect(region.getByLabelText("Publication history")).toHaveTextContent("Published at");
    expect(region.queryByRole("link")).not.toBeInTheDocument();
    if (outcome === "confirmed") {
      expect(region.getByLabelText("Current application availability")).toHaveTextContent("Stopped.");
      expect(region.queryByRole("button", { name: "Stop application" })).not.toBeInTheDocument();
    } else {
      expect(region.getByRole("alert")).toHaveTextContent("Original service closure remains unconfirmed");
      expect(region.getByLabelText("Current application availability")).toHaveTextContent("Current availability is unconfirmed.");
      expect(region.getByRole("button", { name: "Stop application" })).toBeEnabled();
    }
  });

  it("requires newer observed health after a failed stop even when GET repeats the prior healthy snapshot", async () => {
    let current = snapshot();
    const stopGoalApplicationPublication = vi.fn<ApiClient["stopGoalApplicationPublication"]>().mockRejectedValue(
      new ApiClientError("conflict", "Original service closure remains unconfirmed", 409));
    const query = renderPublication(null, { getGoalApplicationPublication: async () => ({ publication: current }), stopGoalApplicationPublication }); await settle();
    fireEvent.click(publicationRegion().getByRole("button", { name: "Stop application" })); await settle();
    expect(publicationRegion().queryByRole("link")).not.toBeInTheDocument();
    expect(publicationRegion().getByLabelText("Current application availability")).toHaveTextContent("Current availability is unconfirmed.");
    await act(async () => { await vi.advanceTimersByTimeAsync(2_501); });
    current = snapshot();
    await act(async () => { await query.invalidateQueries({ queryKey: ["goal-application-publication", goal.id] }); await vi.advanceTimersByTimeAsync(1); });
    expect(publicationRegion().getByRole("link", { name: "Open local application" })).toBeInTheDocument();
    expect(publicationRegion().getByLabelText("Current application availability")).toHaveTextContent("Running — the latest health check passed.");
  });
});
