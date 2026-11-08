import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductReleaseHealthReport } from "@artoo/domain";
import type { NodeToServerMessage, RuntimeAdapter } from "@artoo/protocol";
import { createNodeClient } from "./node-client.js";

const local = vi.hoisted(() => ({ reports: [] as ProductReleaseHealthReport[],
  notify: undefined as ((report: ProductReleaseHealthReport) => void | Promise<void>) | undefined }));
vi.mock("./product-release.js", async (original) => ({
  ...await original<typeof import("./product-release.js")>(),
  createProductReleaseExecutor: (_profiles: unknown, options: { onHealthReport?: typeof local.notify }) => {
    local.notify = options.onHealthReport;
    return { start: async () => {}, stop: async () => {}, requestStop() {}, getHealthReports: () => [...local.reports],
      getPublicationReceipts: () => local.reports.map((report) => ({ request: report.request,
        release_profile_digest: report.release_profile_digest, artifact_digest: report.artifact_digest,
        outcome: "published", endpoint: "http://127.0.0.1:8080", previous_release_id: null, health_checks: report.health_checks })) };
  },
}));
const adapter: RuntimeAdapter = { runtimeId: "fixture", async start() { throw new Error("No author should start"); },
  async *streamEvents() {}, async stop() {}, async collectArtifacts() { return []; } };
function report(sequence: number): ProductReleaseHealthReport {
  const digest = `sha256:${"a".repeat(64)}`, at = new Date().toISOString();
  return { version: 1, event_id: `health_${sequence}`, sequence,
    request: { version: 1, release_id: "release_1", goal_id: "goal_1", project_id: "project_1", run_id: "run_1",
      release_profile_id: "release", verification_profile_id: "verify", verification_request_id: "request_1",
      verification_profile_digest: digest, subject_digest: digest },
    release_profile_digest: digest, artifact_digest: digest, state: "healthy", active_release_id: "release_1",
    active_artifact_digest: digest, consecutive_failures: 0, health_checks: [{ path: "/", status_code: 200,
      body_digest: digest, passed: true, checked_at: at }], recovery_checks: [], checked_at: at };
}
beforeEach(() => { local.reports = []; local.notify = undefined; });
describe("node-owned publication health delivery", () => {
  it("gives another release a turn when fresh observations arrive during a slow ACK", async () => {
    const first = report(1), other = report(1);
    other.event_id = "other_event"; other.request.release_id = "release_2"; other.active_release_id = "release_2";
    local.reports = [first, other];
    const delivered: string[] = []; let complete!: () => void;
    const client = createNodeClient({ nodeId: "node_1", adapter, transport: {
      subscribe: () => () => {}, send: async (message) => {
        if (message.kind !== "product.release.health") return;
        delivered.push(`${message.payload.request.release_id}:${message.payload.sequence}`);
        if (delivered.length === 1) await new Promise<void>((resolve) => { complete = resolve; });
      },
    } });
    try {
      client.start(); await client.ready(); await vi.waitFor(() => expect(delivered).toHaveLength(1));
      local.notify!(report(2)); complete();
      await vi.waitFor(() => expect(delivered).toEqual(["release_1:1", "release_2:1", "release_1:2"]));
    } finally { await client.stop(); }
  });
  it("does not let a rejected historical report block another release", async () => {
    const first = report(1), other = report(1);
    other.event_id = "other_event"; other.request.release_id = "release_2"; other.active_release_id = "release_2";
    local.reports = [first, other];
    const accepted: string[] = [];
    const client = createNodeClient({ nodeId: "node_1", adapter, transport: {
      subscribe: () => () => {}, send: async (message) => {
        if (message.kind !== "product.release.health") return;
        if (message.payload.request.release_id === "release_1") throw new Error("historical report rejected");
        accepted.push(message.payload.request.release_id);
      },
    } });
    try { client.start(); await client.ready(); await vi.waitFor(() => expect(accepted).toEqual(["release_2"])); }
    finally { await client.stop(); }
  });
  it("retries a rejected observation without requiring another health check or reconnect", async () => {
    vi.useFakeTimers(); local.reports = [report(1)];
    const sent: NodeToServerMessage[] = []; let healthAttempts = 0;
    const client = createNodeClient({ nodeId: "node_1", adapter, transport: {
      subscribe: () => () => {}, send: async (message) => {
        sent.push(message);
        if (message.kind === "product.release.health" && ++healthAttempts === 1) throw new Error("server commit unavailable");
      },
    } });
    try {
      client.start(); await client.ready();
      await vi.waitFor(() => expect(healthAttempts).toBe(1));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(healthAttempts).toBe(2);
      const reports = sent.filter((message) => message.kind === "product.release.health");
      expect(reports[1]).toEqual(reports[0]);
    } finally { await client.stop(); vi.useRealTimers(); }
  });
  it("replays stored observations and coalesces periodic reports behind a disconnected send", async () => {
    local.reports = [report(1)];
    const sent: NodeToServerMessage[] = [], completions: Array<() => void> = [];
    const client = createNodeClient({ nodeId: "node_1", adapter, transport: {
      subscribe: () => () => {}, send: async (message) => {
        sent.push(message);
        if (message.kind === "product.release.health") await new Promise<void>((resolve) => completions.push(resolve));
      },
    } });
    client.start(); await client.ready(); await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[0]).toMatchObject({ kind: "product.release.receipt" });
    expect(sent[1]).toMatchObject({ kind: "product.release.health", node_id: "node_1", payload: { sequence: 1 } });
    local.notify!(report(2)); local.notify!(report(3));
    expect(sent).toHaveLength(2);
    completions.shift()!();
    await vi.waitFor(() => expect(sent).toHaveLength(4));
    expect(sent[3]).toMatchObject({ payload: { sequence: 3 } });
    completions.shift()!();
    await client.stop();
  });

  it("replays the journal on reconnection even after the previous send resolved locally", async () => {
    local.reports = [report(4)];
    const sent: NodeToServerMessage[] = [];
    const client = createNodeClient({ nodeId: "node_1", adapter, transport: {
      subscribe: () => () => {}, send: async (message) => { sent.push(message); },
    } });
    client.start(); await client.ready(); await vi.waitFor(() => expect(sent).toHaveLength(2));
    await client.replayReleaseHealth();
    expect(sent).toHaveLength(4); expect(sent[2]).toEqual(sent[0]); expect(sent[3]).toEqual(sent[1]);
    await client.stop();
    local.notify!(report(5)); await client.replayReleaseHealth();
    expect(sent).toHaveLength(4);
  });
});
