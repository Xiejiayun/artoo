// Controlled startup ordering only. Real old-listener isolation is tested by the publisher/native owners.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInProcessChannel, createMockAdapter } from "@artoo/testkit";
const f = vi.hoisted(() => ({ order: [] as string[], source: Object.freeze({}),
  activate: undefined as undefined | ((runtime: never, workspace?: never) => void),
  fence: vi.fn(), sourceActivate: vi.fn(), start: vi.fn(), history: vi.fn(), health: vi.fn(),
  validation: { handle: vi.fn(), invalidate: vi.fn(), settled: vi.fn(), prepareRelease: vi.fn() },
  recovery: { handle: vi.fn(), isActive: vi.fn(), allowsOrdinary: vi.fn(), readRuntime: vi.fn(), invalidate: vi.fn(), settled: vi.fn() } }));
vi.mock("./source-recovery-client.js", () => ({ createProductSourceRecoveryClient: (options: { activate: typeof f.activate }) => {
  f.activate = options.activate; return f.recovery;
} }));
vi.mock("./windows-source-recovery.js", () => ({
  readWindowsRecoverySourceRuntime: () => f.source,
  readPreparedRecoveryValidationRelease: vi.fn(), claimRecoveryValidationRelease: vi.fn(), readRecoveryValidationResearch: vi.fn(),
  isPreparedRecoveryValidationRelease: () => false,
  withWindowsSourceRecoveryOperation: (_runtime: unknown, _descriptor: unknown, work: () => unknown) => work() }));
vi.mock("./imported-recovery-validation.js", () => ({ createImportedRecoveryValidationClient: () => {
  f.order.push("validation-controller"); return f.validation;
} }));
vi.mock("./product-release.js", async original => ({ ...await original<typeof import("./product-release.js")>(),
  createProductReleaseExecutor: () => ({ fenceRecoveredWorkspace: f.fence, start: f.start, requestStop: vi.fn(), stop: vi.fn(async () => {}),
    getPublicationReceipts: f.history, getHealthReports: f.health }) }));
import { createNodeClient } from "./node-client.js";
beforeEach(() => {
  vi.clearAllMocks(); f.order.length = 0; f.activate = undefined;
  f.fence.mockImplementation(() => { f.order.push("publication-fence"); });
  f.sourceActivate.mockImplementation(() => { f.order.push("source-activation"); return f.source; });
  f.start.mockImplementation(async () => { f.order.push("listener-start"); });
  f.history.mockReturnValue([]); f.health.mockReturnValue([]); f.recovery.isActive.mockReturnValue(false);
  f.recovery.settled.mockResolvedValue(undefined); f.validation.settled.mockResolvedValue(undefined);
});
function client() {
  const channel = createInProcessChannel();
  return createNodeClient({ nodeId: "node", transport: channel.node, adapter: createMockAdapter(), productSourceRecovery: {
    configuration: {} as never, features: [], isCurrent: () => true, activate: f.sourceActivate } });
}
describe("recovered Node publication startup order", () => {
  it("fences old publication history before source/controller activation and starts no listener from a checkpoint", async () => {
    const node = client(); node.start(); await node.ready();
    expect(f.start).not.toHaveBeenCalled(); f.activate!({} as never, {} as never);
    expect(f.order).toEqual(["publication-fence", "source-activation", "validation-controller"]);
    expect(f.start).not.toHaveBeenCalled(); expect(f.history).not.toHaveBeenCalled(); expect(f.health).not.toHaveBeenCalled();
    await node.stop();
  });
  it("keeps source and validation inactive when the original publication fence is unavailable", async () => {
    f.fence.mockImplementationOnce(() => { throw Error("Original recovery publication fence missing"); });
    const node = client(); node.start();
    expect(() => f.activate!({} as never, {} as never)).toThrow("Original recovery publication fence missing");
    expect(f.sourceActivate).not.toHaveBeenCalled(); expect(f.order).toEqual([]); expect(f.start).not.toHaveBeenCalled();
    await node.stop();
  });
});
