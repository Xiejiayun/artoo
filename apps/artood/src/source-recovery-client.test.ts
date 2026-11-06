// Controlled protocol/controller seams. No native closure, real supervisor or provider is exercised.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { productSourceRecoveryRegistrationDigestV1, canonicalProductSourceTransferValueV1 as canonical } from "@artoo/domain";
import type { NodeSideTransport, NodeToServerMessage, ServerToNodeMessage } from "@artoo/protocol";
import { sourceRecoveryRequestFixture, recoveryValidationRequestFixture, recoveryFixtureSha as sha } from "./test-fixtures/source-recovery-request.js";
const mocks = vi.hoisted(() => ({ stat: vi.fn(), bootstrap: vi.fn(), reconnect: vi.fn(), registration: vi.fn(), accept: vi.fn(),
  availability: vi.fn(), transfer: vi.fn(), local: vi.fn(), config: vi.fn(), backend: vi.fn(), runtime: vi.fn(), workspace: vi.fn(), result: vi.fn() }));
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(), lstatSync: mocks.stat }));
vi.mock("./owned/windows-runtime-guardian.js", () => ({ bootstrapWindowsGuardian: mocks.bootstrap, reconnectWindowsGuardian: mocks.reconnect,
  createWindowsGuardianRegistration: mocks.registration, acceptWindowsGuardianRegistration: mocks.accept, readWindowsGuardianAvailability: mocks.availability,
  transferWindowsGuardianEpoch: mocks.transfer, readWindowsGuardianLocalRuntime: mocks.local }));
vi.mock("./windows-source-recovery.js", () => ({ windowsGuardianConfiguration: mocks.config, recoveryConfigurationBackend: mocks.backend,
  prepareWindowsSourceRecoveryRuntime: mocks.runtime, prepareRecoveredWorkspace: mocks.workspace, readRecoveredWorkspaceResult: mocks.result }));
import { createProductSourceRecoveryClient } from "./source-recovery-client.js";
beforeEach(() => vi.resetAllMocks());
function fixture(recover = false) {
  const f = sourceRecoveryRequestFixture(), sent: NodeToServerMessage[] = [], guardian = {}, workspace = {}, runtime = {};
  const registration = { ...f.registration, registration_id: "86f89396-aed7-4897-8109-793fcefaedee",
    epoch: { ...f.registration.epoch, epoch_id: f.checkpoint.new_epoch_id, session_id: f.request.current_session_id, generation: recover ? 1 : 0 } };
  let live = true, mode = recover ? "recovery" : "registration";
  const transport: NodeSideTransport = { acknowledgesRunEvents: true, subscribe: () => () => {}, send: vi.fn(async message => { sent.push(message); }) };
  const activate = vi.fn(), suspend = vi.fn(), options = { nodeId: f.request.binding.node_id, configuration: {} as never,
    transport, isCurrent: () => live, activate, suspend };
  mocks.stat.mockImplementation(() => { if (!recover) throw Object.assign(Error("Absent"), { code: "ENOENT" }); return {}; });
  mocks.config.mockReturnValue({ storeDirectory: "C:/controlled-protected-store" }); mocks.backend.mockReturnValue({});
  mocks.bootstrap.mockResolvedValue(guardian); mocks.reconnect.mockResolvedValue(guardian); mocks.local.mockImplementation(() => ({ mode }));
  mocks.registration.mockReturnValue(registration);
  mocks.accept.mockImplementation(async (_guardian, message) => {
    if (message.payload.status !== "accepted" || message.payload.session_id !== registration.epoch.session_id
      || message.payload.registration_id !== registration.registration_id
      || message.payload.registration_digest !== productSourceRecoveryRegistrationDigestV1(registration, sha)) throw Error("Controlled wrong registration ACK");
    mode = "active";
  });
  mocks.availability.mockResolvedValue({ version: 1, state: "recoverable", registration_id: f.registration.registration_id,
    binding: f.request.binding, previous_epoch: f.request.previous_epoch, current_session_id: f.request.current_session_id,
    new_daemon_identity_digest: f.request.new_daemon_identity_digest, operations: f.request.operations });
  mocks.transfer.mockImplementation(async () => { mode = "registration"; return {}; });
  mocks.workspace.mockReturnValue(workspace); mocks.result.mockReturnValue(f.result); mocks.runtime.mockReturnValue(runtime);
  const envelope = { kind: "command" as const, id: "controlled", idempotency_key: "controlled" };
  const session: ServerToNodeMessage = { ...envelope, type: "product.source.recovery.session.v1", payload: {
    version: 1, node_id: options.nodeId, session_id: f.request.current_session_id } };
  const registered: ServerToNodeMessage = { ...envelope, type: "product.source.recovery.registered.v1", payload: {
    version: 1, registration_id: registration.registration_id, registration_digest: productSourceRecoveryRegistrationDigestV1(registration, sha),
    session_id: registration.epoch.session_id, status: "accepted" } };
  const command: ServerToNodeMessage = { ...envelope, type: "product.source.recovery.v1", payload: f.request };
  const control = { version: 1 as const, recovery_id: f.request.recovery_id, request_digest: f.checkpoint.request_digest };
  const receipt: ServerToNodeMessage = { ...envelope, type: "product.source.recovery.receipt.v1", payload: control,
    result_digest: sha(canonical(f.result)), status: "accepted" };
  return { ...f, sent, guardian, workspace, runtime, options, activate, suspend, session, registered, command, control, receipt,
    client: createProductSourceRecoveryClient(options), disconnect() { live = false; } };
}
describe("Windows recovery control ordering", () => {
  it("activates an initial runtime only after exact committed registration ACK", async () => {
    const f = fixture(); await f.client.handle(f.session);
    expect(f.sent.map(item => item.kind)).toEqual(["product.source.recovery.register.v1"]);
    expect(mocks.runtime).not.toHaveBeenCalled(); expect(f.client.isActive()).toBe(false);
    await f.client.handle(f.registered); await f.client.handle(f.registered);
    expect(f.activate).toHaveBeenCalledOnce(); expect(f.client.allowsOrdinary()).toBe(true);
  });
  it.each(["session_id", "registration_digest", "registration_id"] as const)("rejects changed registration %s without a target", async field => {
    const f = fixture(); await f.client.handle(f.session);
    const changed = structuredClone(f.registered); if (changed.type !== "product.source.recovery.registered.v1") throw Error("fixture");
    changed.payload[field] = field === "registration_id" ? "35d9b7c4-b331-4633-9b3c-e5bff598587a" : field.endsWith("digest") ? sha("foreign") : "foreign-session";
    await expect(f.client.handle(changed)).rejects.toThrow(); expect(f.activate).not.toHaveBeenCalled(); expect(f.client.isActive()).toBe(false);
  });
  it.each([true, false])("requires both new epoch registration and accepted checkpoint receipt, registration first=%s", async first => {
    const f = fixture(true); await f.client.handle(f.session); await f.client.handle(f.command);
    expect(mocks.reconnect).toHaveBeenCalledOnce(); expect(mocks.bootstrap).not.toHaveBeenCalled(); expect(mocks.runtime).not.toHaveBeenCalled();
    await f.client.handle(first ? f.registered : f.receipt); expect(f.activate).not.toHaveBeenCalled();
    await f.client.handle(first ? f.receipt : f.registered); expect(f.activate).toHaveBeenCalledWith(f.runtime, f.workspace);
    expect(f.client.allowsOrdinary()).toBe(false);
    const author = recoveryValidationRequestFixture().request;
    expect(f.client.readAccepted(author)).toBe(f.workspace);
    expect(() => f.client.assertAccepted(author, {} as never)).toThrow("original object");
    await f.client.handle(f.command); expect(mocks.transfer).toHaveBeenCalledOnce();
  });
  it("keeps unknown old closure fenced and does not prepare a checkpoint or runtime", async () => {
    const f = fixture(true); mocks.transfer.mockRejectedValue(Error("Old Job closure remains unknown"));
    await f.client.handle(f.session); await f.client.handle(f.command);
    expect(mocks.workspace).not.toHaveBeenCalled(); expect(mocks.runtime).not.toHaveBeenCalled();
    expect(f.sent.at(-1)).toMatchObject({ kind: "product.source.recovery.result.v1", payload: { outcome: "unknown", closed: false } });
  });
  it("waits for a racing dedicated author until both accepted facts arrive and cancels the wait on shutdown", async () => {
    const f = fixture(true); await f.client.handle(f.session); await f.client.handle(f.command);
    let ready = false; const waiting = f.client.awaitRecoveredActivation().then(() => { ready = true; });
    await f.client.handle(f.registered); expect(ready).toBe(false); await f.client.handle(f.receipt); await waiting; expect(ready).toBe(true);
    const stopped = fixture(true); await stopped.client.handle(stopped.session); await stopped.client.handle(stopped.command);
    const cancelled = stopped.client.awaitRecoveredActivation(); stopped.client.invalidate();
    await expect(cancelled).rejects.toThrow("invalidated");
  });
  it("rechecks pending native closure without treating elapsed time as closure evidence", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(true), available = mocks.availability.getMockImplementation()!;
      const complete = await available();
      mocks.availability.mockResolvedValueOnce({ ...complete, state: "unknown", reason: "Old pipes still open" }).mockResolvedValue(complete);
      await f.client.handle(f.session); expect(f.sent.at(-1)).toMatchObject({ payload: { state: "unknown" } });
      await vi.advanceTimersByTimeAsync(500); await f.client.settled();
      expect(f.sent.at(-1)).toMatchObject({ payload: { state: "recoverable" } }); expect(f.activate).not.toHaveBeenCalled();
      f.client.invalidate();
    } finally { vi.useRealTimers(); }
  });
  it("does not delete or replace an owner when native reconnect rejects", async () => {
    const f = fixture(true); mocks.reconnect.mockRejectedValue(Error("Guardian lost"));
    await expect(f.client.handle(f.session)).rejects.toThrow("Guardian lost");
    expect(mocks.bootstrap).not.toHaveBeenCalled(); expect(f.sent).toEqual([]); expect(mocks.runtime).not.toHaveBeenCalled();
  });
  it("rejects a checkpoint receipt in a different client even with identical JSON", async () => {
    const f = fixture(true); await f.client.handle(f.session); await f.client.handle(f.command);
    const second = createProductSourceRecoveryClient(f.options); await second.handle(f.session);
    await expect(second.handle(f.receipt)).rejects.toThrow("Original recovery control"); expect(mocks.runtime).not.toHaveBeenCalled();
  });
  it("retains a stop tombstone without manufacturing native closure", async () => {
    const f = fixture(true); await f.client.handle(f.session);
    await f.client.handle({ kind: "command", id: "stop", idempotency_key: "stop", type: "product.source.recovery.stop.v1", payload: f.control });
    await f.client.handle(f.command); expect(mocks.transfer).not.toHaveBeenCalled(); expect(f.activate).not.toHaveBeenCalled();
    expect(f.sent.at(-1)).toMatchObject({ payload: { outcome: "unknown", closed: false } });
  });
  it("cannot continue after transport loss or change the announced session", async () => {
    const f = fixture(); await f.client.handle(f.session); f.disconnect();
    await expect(f.client.handle(f.registered)).rejects.toThrow("invalidated"); expect(f.activate).not.toHaveBeenCalled();
    const other = fixture(); await other.client.handle(other.session);
    const changed = structuredClone(other.session); if (changed.type !== "product.source.recovery.session.v1") throw Error("fixture");
    changed.payload.session_id = "another-session"; await expect(other.client.handle(changed)).rejects.toThrow("current authenticated");
  });
});
