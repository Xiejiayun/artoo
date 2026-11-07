// Production launcher sequencing with explicitly controlled owners/admissions.
// No native process, model, protected grant or live closure is created here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtoodConfig } from "./main.js";
import type { CleanSupervisedCompletion, CleanSupervisedOwner } from "./windows-clean-supervised-owner.js";
const local = vi.hoisted(() => ({ prepare: vi.fn(), open: vi.fn(), claim: vi.fn(), generation: vi.fn(), describe: vi.fn(), close: vi.fn(),
  start: vi.fn(), load: vi.fn(), remove: vi.fn(), stop: undefined as (() => void) | undefined }));
vi.mock("./source-lifecycle-observer.js", () => ({ openSourceLifecycleObserver: local.open, claimSourceCleanRestart: local.claim,
  closeSourceLifecycleObserver: local.close }));
vi.mock("./windows-clean-local-configuration.js", () => ({ prepareCleanSupervisorConfiguration: local.prepare,
  prepareCleanRestartGeneration: local.generation, describeCleanRestartGeneration: local.describe }));
vi.mock("./windows-clean-supervised-owner.js", () => ({ startCleanWindowsSupervisor: local.start }));
vi.mock("./windows-daemon-launcher.js", () => ({ supervisedStdinControlEnabled: () => true,
  installSupervisedStdinControl: (_input: unknown, stop: () => void) => { local.stop = stop; return local.remove; } }));
vi.mock("./main.js", () => ({ loadConfigFromEnv: local.load }));
import { launchCleanWindowsSupervisedCli } from "./windows-clean-launcher.js";
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject };
}
const config = { nodeId: "node", url: "ws://127.0.0.1/api/v1/node" } as ArtoodConfig;
const env = { ARTOO_SOURCE_CLEAN_CONFIG_FILE: "C:\\protected\\lineage.json", ARTOO_SUPERVISED_STDIN_CONTROL: "1" };
const receipt = { stop_id: "00000000-0000-4000-8000-000000000001" } as NonNullable<CleanSupervisedCompletion["receipt"]>;
let owners: ReturnType<typeof owner>[];
function owner() {
  const result = deferred<CleanSupervisedCompletion>();
  const value: CleanSupervisedOwner = { ready: Promise.resolve(), completion: result.promise,
    transitionAfterAcceptedH6: vi.fn(async () => {}), stop: vi.fn(async () => { result.resolve({ reason: "user-stop" }); }) };
  return { value, result };
}
beforeEach(() => {
  vi.resetAllMocks(); local.stop = undefined; owners = [owner(), owner()];
  local.prepare.mockReturnValueOnce({ configuration: "initial" }).mockReturnValueOnce({ configuration: "successor" });
  local.open.mockResolvedValueOnce({ observer: "initial" }).mockResolvedValueOnce({ observer: "successor" });
  local.claim.mockResolvedValue({ controlledGrant: true }); local.generation.mockReturnValue({ controlledGeneration: true });
  local.describe.mockReturnValue({ source_configuration_file: "C:\\protected\\successor\\source.json" }); local.load.mockReturnValue(config);
  local.start.mockReturnValueOnce(owners[0]!.value).mockReturnValueOnce(owners[1]!.value);
  local.close.mockResolvedValue(undefined); vi.spyOn(process.stdout, "write").mockReturnValue(true);
});
afterEach(() => { vi.restoreAllMocks(); });
const start = () => launchCleanWindowsSupervisedCli(env, config, "C:\\protected\\artood.mjs");
async function started(count = 1) { await vi.waitFor(() => expect(local.start).toHaveBeenCalledTimes(count)); }

describe("persistent native clean launcher", () => {
  it("joins the original planned receipt and observer closure before one fresh claim and native launch", async () => {
    const closed = deferred<void>(); local.close.mockImplementationOnce(() => closed.promise);
    const work = start(); await started();
    expect(owners[0]!.value.transitionAfterAcceptedH6).toHaveBeenCalledOnce();
    expect(local.start.mock.calls[0]![0]).toMatchObject({ manageStopSignals: false });
    owners[0]!.result.resolve({ reason: "planned-transition", receipt });
    await vi.waitFor(() => expect(local.close).toHaveBeenCalledOnce());
    expect(local.open).toHaveBeenCalledTimes(1); expect(local.claim).not.toHaveBeenCalled();
    closed.resolve(); await started(2);
    expect(local.claim).toHaveBeenCalledWith({ observer: "successor" }, receipt.stop_id);
    expect(local.generation).toHaveBeenCalledWith({ predecessor: { configuration: "initial" }, observer: { observer: "successor" }, grant: { controlledGrant: true } });
    expect(local.start.mock.calls[1]![0].configuration).toEqual({ configuration: "successor" });
    expect(owners[1]!.value.transitionAfterAcceptedH6).not.toHaveBeenCalled();
    local.stop!(); await work;
    expect(local.open).toHaveBeenCalledTimes(2); expect(local.remove).toHaveBeenCalledOnce();
  });
  it("honors user stop while the initial observer is opening without starting any owner", async () => {
    const opening = deferred<object>(); local.open.mockReset().mockReturnValueOnce(opening.promise);
    const work = start(); local.stop!(); opening.resolve({ observer: "initial" }); await work;
    expect(local.start).not.toHaveBeenCalled(); expect(local.claim).not.toHaveBeenCalled(); expect(local.close).toHaveBeenCalledOnce();
  });
  it("does not restart a user-stopped owner even if it retains a valid clean receipt", async () => {
    const work = start(); await started();
    owners[0]!.result.resolve({ reason: "user-stop", receipt }); await work;
    expect(local.open).toHaveBeenCalledTimes(1); expect(local.claim).not.toHaveBeenCalled();
  });
  it("keeps user stop latched while the old observer is closing", async () => {
    const closing = deferred<void>(); local.close.mockImplementationOnce(() => closing.promise);
    const work = start(); await started(); owners[0]!.result.resolve({ reason: "planned-transition", receipt });
    await vi.waitFor(() => expect(local.close).toHaveBeenCalledOnce()); local.stop!(); closing.resolve(); await work;
    expect(local.open).toHaveBeenCalledTimes(1); expect(local.claim).not.toHaveBeenCalled();
  });
  it("keeps user stop latched during successor claim and leaves its reservation unstarted", async () => {
    const claiming = deferred<object>(); local.claim.mockReturnValueOnce(claiming.promise);
    const work = start(); await started(); owners[0]!.result.resolve({ reason: "planned-transition", receipt });
    await vi.waitFor(() => expect(local.claim).toHaveBeenCalledOnce()); local.stop!(); claiming.resolve({ controlledGrant: true }); await work;
    expect(local.generation).not.toHaveBeenCalled(); expect(local.start).toHaveBeenCalledTimes(1); expect(local.close).toHaveBeenCalledTimes(2);
  });
  it("stops the current successor and cannot begin another planned generation", async () => {
    const work = start(); await started(); owners[0]!.result.resolve({ reason: "planned-transition", receipt }); await started(2);
    local.stop!(); await work;
    expect(owners[1]!.value.stop).toHaveBeenCalledOnce(); expect(owners[1]!.value.transitionAfterAcceptedH6).not.toHaveBeenCalled();
    expect(local.claim).toHaveBeenCalledOnce();
  });
  it("retains failure and never claims a successor after uncertain native closure", async () => {
    const failure = Error("Controlled original closure unknown"), work = start();
    const outcome = expect(work).rejects.toThrow("Controlled original closure unknown");
    await started(); owners[0]!.result.reject(failure); await outcome;
    expect(local.claim).not.toHaveBeenCalled(); expect(local.start).toHaveBeenCalledTimes(1);
  });
});
