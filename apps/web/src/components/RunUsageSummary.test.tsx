// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fakeApi, renderWithProviders, runFixture } from "../test/utils.js";
import { RunUsageSummary } from "./RunUsageSummary.js";

const run = runFixture({ id: "run_1", status: "completed" });

describe("RunUsageSummary", () => {
  it("shows unavailable measurements when the provider has not reported usage", async () => {
    renderWithProviders(<RunUsageSummary run={run} />, { client: fakeApi({ getRunUsage: async () => ({ usage: null }) }) });
    const summary = await screen.findByLabelText("Run usage");
    expect(within(summary).getAllByText("unavailable")).toHaveLength(4);
    expect(within(summary).queryByText(/\$0/)).not.toBeInTheDocument();
  });

  it("distinguishes measured zero tokens from missing provider cost", async () => {
    renderWithProviders(<RunUsageSummary run={run} />, { client: fakeApi({ getRunUsage: async () => ({ usage: { run_id: run.id, input_tokens: 1234, output_tokens: 0, cached_input_tokens: 400, cost_usd: null, currency: null, provider_session_id: "session", updated_at: "2026-09-29" } }) }) });
    const summary = await screen.findByLabelText("Run usage");
    expect(within(summary).getByText((1234).toLocaleString())).toBeInTheDocument();
    expect(within(summary).getByText("0")).toBeInTheDocument();
    expect(within(summary).getAllByText("unavailable")).toHaveLength(1);
  });

  it("renders measured USD cost and reports sync failures explicitly", async () => {
    const first = renderWithProviders(<RunUsageSummary run={run} />, { client: fakeApi({ getRunUsage: async () => ({ usage: { run_id: run.id, input_tokens: 120, output_tokens: 30, cached_input_tokens: 0, cost_usd: 0.012345, currency: "USD", provider_session_id: null, updated_at: "2026-09-29" } }) }) });
    expect(await screen.findByText("$0.012345")).toBeInTheDocument();
    first.unmount();
    renderWithProviders(<RunUsageSummary run={run} />, { client: fakeApi({ getRunUsage: async () => { throw new Error("offline"); } }) });
    expect(await screen.findByText(/Usage unavailable: could not sync/)).toBeInTheDocument();
  });
});
