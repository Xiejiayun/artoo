import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { WebSocket } from "ws";
import { expect, it, vi } from "vitest";
import { SourceSupervisorLaunchV1Schema, SourceCleanStopIntentV1Schema, SOURCE_LIFECYCLE_ROUTE_V1 } from "@artoo/domain";
import { SourceLifecycleServerMessageV1Schema, assertSourceLifecyclePayloadReplyFitsV1,
  SOURCE_LIFECYCLE_REPLY_MAX_BYTES_V1, SOURCE_LIFECYCLE_REPLY_CACHE_MAX_BYTES_V1,
  SOURCE_LIFECYCLE_CONTROL_REPLY_RESERVE_BYTES_V1 } from "@artoo/protocol";
import { sourceRecoveryRequestFixture, recoveryFixtureSha as sha } from "../../../artood/src/test-fixtures/source-recovery-request.js";
import { buildTestServer } from "../test-support.js";
import { testDeviceAuthConfig } from "../config/device-auth.js";
import type { SourceLifecycleRegistry } from "../services/source-clean-lifecycle-service.js";
import { registerSourceLifecycleWsRoute } from "./source-lifecycle-ws.js";

/** Schema-valid wire data only. It has no accepted-origin, native-owner,
 * lifecycle-registry or database-transition authority. */
function wireFixture() {
  const old = sourceRecoveryRequestFixture(), observerId = randomUUID();
  const launch = SourceSupervisorLaunchV1Schema.parse({ version: 1, observer_id: observerId,
    supervisor: { pid: 100, creationTime: "1000", image: "C:\\controlled\\Supervisor.exe", sid: "S-1-5-21-100" },
    launch_identity_digest: sha("controlled launch"), runtime_manifest_digest: sha("controlled inventory"),
    stable: { version: 1, node_id: old.registration.binding.node_id, device_id: old.registration.binding.device_id,
      store_family_identity_digest: sha("controlled family"), genesis_store_identity_digest: old.registration.binding.store_identity_digest,
      workspace_root: old.registration.binding.workspace_root, workspace_identity_digest: old.registration.binding.workspace_identity_digest,
      stable_configuration_digest: sha("controlled configuration") } });
  const intent = SourceCleanStopIntentV1Schema.parse({ version: 1, stop_id: randomUUID(), lineage_id: randomUUID(), generation_id: randomUUID(),
    revision: 0, launch, registration: old.registration, origin: old.request.origin, goal_id: old.request.goal_id, plan_id: old.request.plan_id,
    authorization: { ...old.request.authorization, consent_id: null }, operations: old.request.operations });
  const maximumHeader = { version: 1, observer_id: observerId, request_id: randomUUID(), sequence: 2147483647,
    type: "node.source-clean-stop.prepared.v1" };
  return { observerId, launch, sizedIntent(bytes: number) {
    const payload = structuredClone(intent);
    const task = payload.origin.execution_request.run_start.context_pack.payload.task;
    // Include multibyte and escaped characters; the budget is encoded UTF-8 bytes.
    task.description = "controlled wire padding: 界\n\"\\\u0000";
    const initial = JSON.stringify(SourceLifecycleServerMessageV1Schema.parse({ ...maximumHeader, payload }));
    const padding = bytes - Buffer.byteLength(initial, "utf8");
    if (padding < 0) throw Error("Controlled wire fixture already exceeds its requested size");
    task.description += "x".repeat(padding);
    const parsed = SourceCleanStopIntentV1Schema.parse(payload);
    expect(Buffer.byteLength(JSON.stringify(SourceLifecycleServerMessageV1Schema.parse({ ...maximumHeader, payload: parsed })), "utf8")).toBe(bytes);
    return parsed;
  } };
}

async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error("Timed out waiting for " + label);
}

it("bounds real WS retained replies by bytes, replays original strings without charging again, and rejects a new control before mutation", async () => {
  // Real pairing credentials and a real socket; only registry operations are
  // controlled. This is a transport test, not DB/native clean-stop acceptance.
  const server = await buildTestServer({ deviceAuth: testDeviceAuthConfig({ devNodeToken: null }) });
  const app = Fastify({ logger: false });
  let socket: WebSocket | undefined, closeCode: number | undefined;
  const frames: string[] = [], socketErrors: Error[] = [];
  try {
    async function post(url: string, payload: object) {
      const response = await server.app.inject({ method: "POST", url, payload });
      expect(response.statusCode).toBeGreaterThanOrEqual(200); expect(response.statusCode).toBeLessThan(300);
      return response.json();
    }
    const pairing = await post("/api/v1/devices/pairings", {});
    const claimed = await post("/api/v1/devices/claim", { code: pairing.code, platform: "windows", app_version: "0.1.0", display_name: "Controlled reply-budget transport" });
    const enrolled = await post("/api/v1/devices/" + encodeURIComponent(claimed.device.id) + "/enroll", {});
    const fixture = wireFixture(), challenge = "a".repeat(64);
    let prepared = 0;
    const prepareStop = vi.fn(async (secret: string, budget: number) => {
      if (secret !== challenge) throw Error("Controlled challenge mismatch");
      const payload = fixture.sizedIntent(SOURCE_LIFECYCLE_REPLY_MAX_BYTES_V1 - (prepared === 3 ? 2048 : 0));
      assertSourceLifecyclePayloadReplyFitsV1("node.source-clean-stop.prepared.v1", payload, budget);
      prepared++; return payload;
    });
    const bindLaunch = vi.fn(async () => ({ version: 1 as const, observer_id: fixture.observerId, launch_digest: sha("controlled bound") }));
    const observer = {
      hello: { version: 1 as const, observer_id: fixture.observerId, challenge }, prepareStop, bindLaunch,
      isReadyForPlannedStop: vi.fn(async () => true),
      commitStop: vi.fn(async () => { throw Error("Unexpected controlled commit"); }),
      claimRestart: vi.fn(async () => { throw Error("Unexpected controlled claim"); }), close: vi.fn(),
    };
    const open = vi.fn((..._args: Parameters<SourceLifecycleRegistry["open"]>) => observer);
    // Deliberately replace registry authority only. Authentication, route
    // sequencing, schemas, encoding, byte accounting and WebSocket I/O are real.
    const registry = { open } as unknown as SourceLifecycleRegistry;
    await app.register(websocket);
    registerSourceLifecycleWsRoute(app, server.ctx, registry);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    socket = new WebSocket(address.replace(/^http/u, "ws") + SOURCE_LIFECYCLE_ROUTE_V1,
      { headers: { Authorization: "Bearer " + claimed.node_token } });
    socket.on("message", data => frames.push(data.toString()));
    socket.on("error", error => socketErrors.push(error));
    socket.once("close", code => { closeCode = code; });
    async function receive() {
      await until(() => frames.length > 0 || closeCode !== undefined || socketErrors.length > 0, "original WS response");
      expect(socketErrors).toEqual([]); expect(closeCode).toBeUndefined();
      const encoded = frames.shift(); expect(encoded).toBeDefined();
      return { encoded: encoded!, message: SourceLifecycleServerMessageV1Schema.parse(JSON.parse(encoded!)) };
    }
    const opened = await receive(); expect(opened.message.type).toBe("node.source-lifecycle.opened.v1");
    expect(open).toHaveBeenCalledOnce();
    expect(open.mock.calls[0]?.[0]).toMatchObject({ computerId: enrolled.computer_id, deviceId: claimed.device.id });
    const requests: string[] = [], originals: string[] = [];
    let retainedBytes = 0;
    for (let sequence = 1; sequence <= 4; sequence++) {
      const request = JSON.stringify({ version: 1, observer_id: fixture.observerId, challenge, request_id: randomUUID(), sequence,
        type: "node.source-clean-stop.prepare.v1", payload: {} });
      requests.push(request); socket.send(request);
      const reply = await receive(); expect(reply.message.type).toBe("node.source-clean-stop.prepared.v1");
      originals.push(reply.encoded); retainedBytes += Buffer.byteLength(reply.encoded, "utf8");
      expect(retainedBytes).toBeLessThanOrEqual(SOURCE_LIFECYCLE_REPLY_CACHE_MAX_BYTES_V1);
      expect(prepareStop).toHaveBeenCalledTimes(sequence);
      if (sequence === 1) {
        // A duplicate charge here would prevent the later unique replies from fitting.
        socket.send(request); expect((await receive()).encoded).toBe(reply.encoded);
        expect(prepareStop).toHaveBeenCalledTimes(1);
      }
    }
    const remaining = SOURCE_LIFECYCLE_REPLY_CACHE_MAX_BYTES_V1 - retainedBytes;
    expect(remaining).toBeGreaterThanOrEqual(0); expect(remaining).toBeLessThan(SOURCE_LIFECYCLE_CONTROL_REPLY_RESERVE_BYTES_V1);
    expect(prepareStop.mock.calls.map(call => call[1])).toEqual(Array(4).fill(SOURCE_LIFECYCLE_REPLY_MAX_BYTES_V1));
    // Replays still work when the remaining budget cannot admit a new control.
    socket.send(requests[0]!); expect((await receive()).encoded).toBe(originals[0]);
    expect(prepareStop).toHaveBeenCalledTimes(4);
    socket.send(JSON.stringify({ version: 1, observer_id: fixture.observerId, challenge, request_id: randomUUID(), sequence: 5,
      type: "node.source-lifecycle.bind.v1", payload: fixture.launch }));
    await until(() => closeCode !== undefined, "budget exhaustion close");
    expect(closeCode).toBe(1008); expect(frames).toEqual([]); expect(socketErrors).toEqual([]);
    expect(bindLaunch).not.toHaveBeenCalled(); expect(observer.commitStop).not.toHaveBeenCalled(); expect(observer.claimRestart).not.toHaveBeenCalled();
    expect(prepareStop).toHaveBeenCalledTimes(4); expect(observer.close).toHaveBeenCalled();
  } finally {
    try {
      if (socket && socket.readyState !== WebSocket.CLOSED) {
        socket.terminate(); await until(() => closeCode !== undefined, "original test socket closure");
      }
    } finally {
      try { await app.close(); } finally { await server.close(); }
    }
  }
});
