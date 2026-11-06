import type { PreparedWindowsDaemonSupervisorAuthority } from "../windows-supervisor-authority.js";
vi.mock("../windows-supervisor-authority.js", () => ({ readWindowsDaemonSupervisorAuthority: () => ({ launchIdentityDigest: "sha256:" + "1".repeat(64) }) }));
import { importedValidationRequestFixture } from "../test-fixtures/imported-validation-request.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { productSourceRecoveryRegistrationDigestV1 } from "@artoo/domain";
import type { PreparedWindowsProcessBackend } from "./windows-owned-process.js";
import type { PreparedWindowsReleaseStorage } from "../windows-release-storage.js";

const mock = vi.hoisted(() => ({ invoke: vi.fn(), audit: vi.fn(), workspace: vi.fn(), marker: "" }));
vi.mock("./windows-owned-process.js", () => ({ assertWindowsProcessBackend: vi.fn(), assertWindowsProcessBackendImage: vi.fn(), invokeWindowsGuardianNative: mock.invoke, invokeWindowsGuardianNativeSync: vi.fn() }));
vi.mock("../windows-release-storage.js", () => ({ auditWindowsReleaseStorage: mock.audit, assertWindowsReleaseStorage: vi.fn(), assertWindowsReleaseStorageWorkspace: mock.workspace }));
vi.mock("../windows-local-acl.js", () => ({ physicalWindowsDirectory: (path: string) => path,
  windowsPathsOverlap: (left: string, right: string) => left === right }));
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  const owner = "C:\\private-store\\owner.lock";
  // Only this test's guardian marker is controlled. Shared request fixtures read
  // their real JSON inputs during module initialization, before beforeEach runs.
  return { ...actual,
    readFileSync: (path: Parameters<typeof actual.readFileSync>[0], options?: Parameters<typeof actual.readFileSync>[1]) =>
      path === owner ? mock.marker : actual.readFileSync(path, options),
    lstatSync: (path: Parameters<typeof actual.lstatSync>[0], options?: Parameters<typeof actual.lstatSync>[1]) =>
      path === owner ? { isFile: () => true, isSymbolicLink: () => false, nlink: 1, ino: 1, dev: 1, size: 128, mtimeMs: 1 }
        : actual.lstatSync(path, options),
  };
});

import { bootstrapWindowsGuardian, reconnectWindowsGuardian, createWindowsGuardianRegistration, acceptWindowsGuardianRegistration,
  reserveWindowsGuardianSlot, consumeWindowsGuardianSlot, transferWindowsGuardianEpoch, consumeWindowsRecoveryFence,
  type PreparedWindowsGuardian, type PreparedWindowsGuardianSlot, type WindowsRecoveryFence } from "./windows-runtime-guardian.js";

const sha = (text: string | Uint8Array) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const endpoint = { version: 1, capability: "artoo.windows-runtime-guardian.v1", pipeName: `artoo-guardian-${id(1)}`,
  guardianInstanceId: id(1), guardianPid: 4242, guardianCreationTime: "123456", executableDigest: sha("native") };
const binding = { version: 1, node_id: "node", device_id: "device", guardian_instance_id: id(1), store_identity_digest: sha("store"),
  configuration_digest: sha("config"), workspace_root: "C:\\workspace", workspace_identity_digest: sha("workspace") };
const epoch = { version: 1, epoch_id: id(2), generation: 0, session_id: "old-session", roster_revision: 0, roster_digest: sha("[]") };
const operation = { operationKind: "author" as const, operationId: "validation", bindingDigest: sha("request+profile+source"),
  serverOperation: { kind: "validation" as const, operation_id: "validation", request_digest: sha("request"), run_id: "run" } };
function local(sessionId = "old-session") { return { nodeId: "node", deviceId: "device", sessionId, configurationDigest: sha("config"),
  storeDirectory: "C:\\private-store", workspaceRoot: "C:\\workspace", storage: {} as PreparedWindowsReleaseStorage,
  supervisor: {} as PreparedWindowsDaemonSupervisorAuthority, controlDirectory: "C:\\private-control", controlStorage: {} as PreparedWindowsReleaseStorage,
  topology: "supervisor-plain-daemon.v1" as const }; }
function ack(registration: ReturnType<typeof createWindowsGuardianRegistration>) { return {
  kind: "command", id: "registered-command", idempotency_key: "registered-idempotency", type: "product.source.recovery.registered.v1",
  payload: { version: 1, registration_id: registration.registration_id, registration_digest: productSourceRecoveryRegistrationDigestV1(registration, sha),
    session_id: "old-session", status: "accepted" },
}; }
async function boot() {
  const backend = {} as PreparedWindowsProcessBackend; mock.invoke.mockResolvedValueOnce({ endpoint, binding, epoch });
  const guardian = await bootstrapWindowsGuardian(backend, local()); return { backend, guardian };
}
beforeEach(() => {
  vi.clearAllMocks(); mock.invoke.mockReset();
  mock.marker = JSON.stringify({ version: 1, capability: endpoint.capability, endpoint, binding });
});

describe("guardian Node authority boundary (controlled transport, not native qualification)", () => {
  it("rejects serialized guardian, reservation and fence objects before native work", async () => {
    await expect(reserveWindowsGuardianSlot({} as PreparedWindowsGuardian, operation)).rejects.toThrow(/same-process/);
    expect(() => consumeWindowsRecoveryFence({} as PreparedWindowsGuardian, {} as WindowsRecoveryFence)).toThrow(/same-process/);
    expect(() => consumeWindowsGuardianSlot({} as PreparedWindowsProcessBackend, {} as PreparedWindowsGuardianSlot, "C:\\workspace")).toThrow(/different backend/);
    expect(mock.invoke).not.toHaveBeenCalled();
  });
  it("does not reserve after merely creating or sending a registration", async () => {
    const { guardian } = await boot(), registration = createWindowsGuardianRegistration(guardian);
    expect(Object.isFrozen(registration.binding)).toBe(true);
    await expect(reserveWindowsGuardianSlot(guardian, operation)).rejects.toThrow(/active registered epoch/);
    expect(mock.invoke).toHaveBeenCalledTimes(1);
  });
  it.each(["registration_digest", "registration_id", "session_id"] as const)("rejects a changed %s in registration ACK", async field => {
    const { guardian } = await boot(), accepted = ack(createWindowsGuardianRegistration(guardian));
    accepted.payload[field] = field === "registration_id" ? id(20) : field === "registration_digest" ? sha("other") : "other-session";
    await expect(acceptWindowsGuardianRegistration(guardian, accepted)).rejects.toThrow(/ACK differs/);
    expect(mock.invoke).toHaveBeenCalledTimes(1);
  });
  it("requires an original unused reservation for every start on a bound backend", async () => {
    const { guardian, backend } = await boot(); mock.invoke.mockResolvedValueOnce({ activated: true });
    await acceptWindowsGuardianRegistration(guardian, ack(createWindowsGuardianRegistration(guardian)));
    mock.invoke.mockResolvedValueOnce({ version: 1, endpoint, epochId: epoch.epoch_id, slotId: id(3), ticket: id(4) });
    const slot = await reserveWindowsGuardianSlot(guardian, operation);
    expect(() => consumeWindowsGuardianSlot(backend, undefined, "C:\\workspace")).toThrow(/unused registered launch/);
    expect(() => consumeWindowsGuardianSlot(backend, structuredClone(slot), "C:\\workspace")).toThrow(/unused registered launch/);
    expect(() => consumeWindowsGuardianSlot(backend, slot, "C:\\outside")).toThrow(/unused registered launch/);
    expect(consumeWindowsGuardianSlot(backend, slot, "C:\\workspace")?.slotId).toBe(id(3));
    expect(() => consumeWindowsGuardianSlot(backend, slot, "C:\\workspace")).toThrow(/unused registered launch/);
    expect(consumeWindowsGuardianSlot({} as PreparedWindowsProcessBackend, undefined, "C:\\ordinary")).toBeUndefined();
  });
  it("does not turn a live incomplete roster into a recovery permit", async () => {
    const status = { binding, epoch, registrationId: id(5), frozen: true, closed: false, callerIsCurrentDaemon: false, operations: [] };
    mock.invoke.mockResolvedValue(status);
    const guardian = await reconnectWindowsGuardian({} as PreparedWindowsProcessBackend, local("new-session"));
    await expect(transferWindowsGuardianEpoch(guardian, { version: 1, recovery_id: "recovery", registration_id: id(5), origin: importedValidationRequestFixture().request.origin,
      origin_review_id: importedValidationRequestFixture().request.origin.review_id,
      goal_id: importedValidationRequestFixture().request.origin.execution_request.run_start.context_pack.payload.goal_context!.goal_id,
      plan_id: importedValidationRequestFixture().request.origin.execution_request.run_start.context_pack.payload.goal_context!.plan!.id,
      binding, previous_epoch: epoch, current_session_id: "new-session", new_daemon_identity_digest: sha("new-daemon"), challenge_id: id(6), operations: [],
      authorization: { event_id: "auth", actor_user_id: "user", consent_id: "consent", policy_version: "policy" } })).rejects.toThrow(/live complete roster/);
    expect(mock.invoke).toHaveBeenCalledTimes(2);
  });
  it("retains old-format fences and refuses discovery without a surviving guardian", async () => {
    mock.marker = JSON.stringify({ version: 1, owner: "old-H8" });
    await expect(reconnectWindowsGuardian({} as PreparedWindowsProcessBackend, local("new-session"))).rejects.toThrow(/old or changed owner/);
    expect(mock.invoke).not.toHaveBeenCalled();
  });
});
