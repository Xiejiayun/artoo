import { runs } from "@artoo/db";
import type { NodeToServerMessage, NodeTransport, ServerToNodeMessage } from "@artoo/protocol";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { buildTestServer, type TestServer } from "./test-support.js";
import { attachNodeBinding, type NodeBinding } from "./node-binding.js";
import { buildAiDataSharingPolicy } from "./config/ai-data-sharing.js";
import { grantAiDataSharingConsent, revokeAiDataSharingConsent } from "./services/ai-data-sharing-service.js";

const policy = buildAiDataSharingPolicy({ mode: "external", providers: [{ id: "fixture", name: "Fixture recipient", privacy_url: "https://provider.example.com/privacy" }] });
let server: TestServer;
let binding: NodeBinding | undefined;
afterEach(async () => { binding?.close(); binding = undefined; await server?.close(); });

async function queued() {
  server = await buildTestServer({ aiDataSharingPolicy: policy });
  await grantAiDataSharingConsent(server.ctx, policy.version);
  const created = await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
    project_id: "proj_artoo", title: "Private dispatch fixture", acceptance_criteria: ["No sharing after withdrawal"], required_capabilities: ["code.modify"],
  } });
  const id = created.json().task.id as string;
  await server.app.inject({ method: "POST", url: `/api/v1/tasks/${id}/ready` });
  expect((await server.app.inject({ method: "POST", url: `/api/v1/tasks/${id}/assign`, payload: { mode: "auto" } })).statusCode).toBe(200);
  return (await server.db.db.select().from(runs))[0]!;
}
function transport(acceptStop = true) {
  const frames: ServerToNodeMessage[] = [];
  let receive: (frame: NodeToServerMessage) => void = () => {};
  const wire: NodeTransport = {
    send: async (frame) => {
      frames.push(frame);
      if (frame.kind === "command" && frame.type === "run.stop") {
        receive({ kind: "command.ack", node_id: "computer_local_mock", command_id: frame.id,
          ...(acceptStop ? { status: "accepted" as const } : { status: "rejected" as const, error_code: "permission_denied" as const, message: "Fixture stop denied" }) });
      }
    },
    close: async () => {},
    subscribe: (handler) => { receive = handler; return () => {}; },
  };
  binding = attachNodeBinding(server.ctx, wire, "computer_local_mock");
  return frames;
}

describe("AI permission at the actual node transport", () => {
  it.each(["withdrawn", "regranted", "changed", "unconfigured"] as const)("blocks queued run.start after %s, confirms stop without sending private context", async (change) => {
    const run = await queued();
    if (change === "withdrawn" || change === "regranted") await revokeAiDataSharingConsent(server.ctx);
    if (change === "regranted") await grantAiDataSharingConsent(server.ctx, policy.version);
    if (change === "changed") server.ctx.aiDataSharingPolicy = buildAiDataSharingPolicy({ mode: "external", providers: [{ id: "second", name: "Second recipient", privacy_url: "https://second.example.com/privacy" }] });
    if (change === "unconfigured") server.ctx.aiDataSharingPolicy = null;
    const frames = transport();
    await expect(binding!.dispatchRunStart(run.id)).rejects.toMatchObject({ code: change === "unconfigured" ? "ai_sharing_unconfigured" : "ai_consent_required", details: { stop_confirmed: true } });
    expect(frames.filter((frame) => frame.kind === "command").map((frame) => frame.type)).toEqual(["run.stop"]);
    expect(JSON.stringify(frames)).not.toContain("Private dispatch fixture");
    expect((await server.db.db.select().from(runs).where(eq(runs.id, run.id)))[0]?.status).toBe("cancelled");
  });
  it("refuses reconnect resume and preserves uncertain execution when the node rejects stopping", async () => {
    const run = await queued();
    await server.db.db.update(runs).set({ status: "running" }).where(eq(runs.id, run.id));
    await revokeAiDataSharingConsent(server.ctx);
    const frames = transport(false);
    await expect(binding!.dispatchRunResume(run.id)).rejects.toMatchObject({ code: "ai_consent_required", details: { stop_confirmed: false } });
    expect(frames.filter((frame) => frame.kind === "command").map((frame) => frame.type)).toEqual(["run.stop"]);
    expect((await server.db.db.select().from(runs).where(eq(runs.id, run.id)))[0]?.status).toBe("running");
  });
  it("sends a currently authorized request to the node", async () => {
    const run = await queued();
    const frames = transport();
    await binding!.dispatchRunStart(run.id);
    expect(frames.filter((frame) => frame.kind === "command").map((frame) => frame.type)).toEqual(["run.start"]);
  });
});
