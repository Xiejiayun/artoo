// Real fixed protocol/state machine over controlled streams and lifecycle
// promises. No native process, database, HTTP listener or provider executes.
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { installApplicationPublicationBootstrapControl } from "./application-publication-bootstrap-control.js";
import { ApplicationPublicationControlCommandSchema, ApplicationPublicationControlStatusSchema,
  decodeApplicationPublicationControlCommand, encodeApplicationPublicationControlCommand,
  type ApplicationPublicationControlCommand, type ApplicationPublicationControlStatus,
  type ApplicationPublicationQuiescence } from "./application-publication-control-protocol.js";

const digest = "sha256:" + "a".repeat(64), nonce = "11111111-1111-4111-8111-111111111111";
const identity = { publication_id: "publication", lease_id: "lease", owner_id: "owner", generation: 1 as const,
  deployment_generation: "deployment", reopen_pin_digest: digest, database_identity: { device: "1", inode: "2" },
  schema_digest: digest, scope_digest: digest, artifact_digest: digest, origin: "http://127.0.0.1:31000" };
const readPath = "/api/items?limit=1";
const proof = (requests = 0): ApplicationPublicationQuiescence => ({
  counters: { observed_at: "2026-11-09T12:00:00.000Z", requests_used: requests, in_flight: 0, closed_transports: requests },
  closure: { version: 1, scope: "original-native-owners", invocations: requests, runtime_normal_closures: requests, broker_normal_closures: requests },
});
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); void promise.catch(() => {}); return { promise, resolve, reject }; }
const flush = async () => { for (let count = 0; count < 20; count++) await Promise.resolve(); };
class Input extends EventEmitter { readableObjectMode = false; readableEncoding = null; readableEnded = false; destroyed = false; pause = vi.fn(); }
function fixture(signal?: AbortSignal) {
  const input = new Input(), statuses: ApplicationPublicationControlStatus[] = [];
  const onStatus = vi.fn(async (status: ApplicationPublicationControlStatus) => { statuses.push(status); });
  const operations = { pause: vi.fn(async () => proof()), probe: vi.fn(async (_path: string, _nonce: string) => proof(1)),
    resume: vi.fn(), drain: vi.fn(async () => {}) };
  const control = installApplicationPublicationBootstrapControl(input, { identity, selection: { version: 1, read_path: readPath }, signal,
    onStatus });
  const send = (kind: ApplicationPublicationControlCommand["kind"], sequence: number, cycle = 0, extra = {}) =>
    input.emit("data", Buffer.from(encodeApplicationPublicationControlCommand({ version: 1, identity, kind, sequence, cycle, ...extra } as ApplicationPublicationControlCommand)));
  return { input, operations, control, statuses, onStatus, send };
}

describe("original publication private control", () => {
  it("retains canonical identity and rejects duplicate keys, alternate encoding and unsupported bounds", () => {
    const command: ApplicationPublicationControlCommand = { version: 1, identity, kind: "probe", sequence: 0, cycle: 0, path: readPath, nonce };
    const line = encodeApplicationPublicationControlCommand(command);
    expect(decodeApplicationPublicationControlCommand(line)).toEqual(command);
    expect(() => decodeApplicationPublicationControlCommand(line.replace('"version":1', '"version":1,"version":1'))).toThrow(/canonical/);
    expect(() => decodeApplicationPublicationControlCommand(" " + line)).toThrow(/canonical/);
    expect(ApplicationPublicationControlCommandSchema.safeParse({ ...command, sequence: 512 }).success).toBe(false);
    expect(ApplicationPublicationControlCommandSchema.safeParse({ ...command, path: "/api/../private" }).success).toBe(false);
    expect(ApplicationPublicationControlStatusSchema.safeParse({ version: 1, kind: "application-publication.control", identity,
      sequence: 0, cycle: 0, state: "quiesced", ...proof(), counters: { ...proof().counters, in_flight: 1, requests_used: 1 } }).success).toBe(false);
  });
  it("initially waits for real quiescence and sequences one private probe before resume and the next pause cycle", async () => {
    const f = fixture(), initial = deferred<ApplicationPublicationQuiescence>(); f.operations.pause.mockReturnValueOnce(initial.promise);
    let ready = false; const attached = f.control.attach(f.operations).then(status => { ready = true; return status; });
    await flush(); expect(ready).toBe(false); initial.resolve(proof());
    expect(await attached).toMatchObject({ sequence: -1, cycle: 0, state: "quiesced" });
    const probe = deferred<ApplicationPublicationQuiescence>(); f.operations.probe.mockReturnValueOnce(probe.promise);
    f.send("probe", 0, 0, { path: readPath, nonce }); await flush();
    expect(f.operations.probe).toHaveBeenCalledWith(readPath, nonce); expect(f.statuses.map(item => item.state)).toEqual(["probe-ready"]);
    probe.resolve(proof(1)); await flush(); expect(f.statuses.at(-1)).toMatchObject({ sequence: 0, cycle: 0, state: "quiesced" });
    expect(JSON.stringify(f.statuses)).not.toContain(nonce);
    f.send("resume", 1); await flush(); expect(f.operations.resume).toHaveBeenCalledOnce();
    f.operations.pause.mockResolvedValueOnce(proof(2)); f.send("pause", 2, 1); await flush();
    expect(f.statuses.at(-1)).toMatchObject({ sequence: 2, cycle: 1, state: "quiesced", counters: { requests_used: 2 } });
    f.send("drain", 3, 1); f.input.emit("end"); await f.control.finish(); expect(f.control.failure).toBeUndefined(); f.control.dispose();
  });
  it.each(["sequence", "cycle", "identity", "path", "nonce"] as const)("fails closed on changed/replayed %s", async changed => {
    const f = fixture(); await f.control.attach(f.operations);
    f.send("probe", 0, 0, { path: readPath, nonce }); await flush();
    if (changed === "identity") f.input.emit("data", Buffer.from(encodeApplicationPublicationControlCommand({ version: 1,
      identity: { ...identity, owner_id: "replacement" }, kind: "resume", sequence: 1, cycle: 0 })));
    else if (changed === "sequence") f.send("resume", 0);
    else if (changed === "cycle") f.send("resume", 1, 1);
    else f.send("probe", 1, 0, { path: changed === "path" ? "/api/other" : readPath,
      nonce: changed === "nonce" ? nonce : "22222222-2222-4222-8222-222222222222" });
    expect(f.control.signal.aborted).toBe(true); expect(f.operations.resume).not.toHaveBeenCalled(); f.control.dispose();
  });
  it("lets final drain dominate a pending probe while joining the same owner and actual final EOF", async () => {
    const f = fixture(), probe = deferred<ApplicationPublicationQuiescence>(), drain = deferred<void>();
    await f.control.attach(f.operations); f.operations.probe.mockReturnValueOnce(probe.promise);
    f.operations.drain.mockImplementationOnce(() => { probe.reject(Error("Original probe stopped")); return drain.promise; });
    f.send("probe", 0, 0, { path: "/", nonce }); await flush();
    f.send("drain", 1); expect(f.operations.drain).toHaveBeenCalledOnce();
    let completed = false; const finishing = f.control.finish().then(() => { completed = true; });
    drain.resolve(); await flush(); expect(completed).toBe(false); f.input.emit("end"); await finishing;
    expect(f.control.failure).toBeUndefined(); expect(f.statuses.map(item => item.state)).toEqual(["probe-ready"]); f.control.dispose();
  });
  it("joins an interrupted probe when final EOF precedes its outstanding status write", async () => {
    const f = fixture(), probe = deferred<ApplicationPublicationQuiescence>(), output = deferred<void>();
    await f.control.attach(f.operations); f.operations.probe.mockReturnValueOnce(probe.promise);
    f.onStatus.mockImplementationOnce(async status => { f.statuses.push(status); await output.promise; });
    f.operations.drain.mockImplementationOnce(async () => { probe.reject(Error("Original probe stopped")); });
    f.send("probe", 0, 0, { path: "/", nonce }); f.send("drain", 1); f.input.emit("end");
    let completed = false; const finishing = f.control.finish().then(() => { completed = true; });
    await flush(); expect(completed).toBe(false); output.resolve(); await finishing;
    expect(f.control.failure).toBeUndefined(); expect(f.operations.drain).toHaveBeenCalledOnce();
    expect(f.statuses.map(item => item.state)).toEqual(["probe-ready"]); f.control.dispose();
  });
  it("retains a real final drain failure while an interrupted probe status is pending", async () => {
    const f = fixture(), probe = deferred<ApplicationPublicationQuiescence>(), output = deferred<void>();
    const failure = Error("Original final owner closure unconfirmed");
    await f.control.attach(f.operations); f.operations.probe.mockReturnValueOnce(probe.promise);
    f.onStatus.mockImplementationOnce(async status => { f.statuses.push(status); await output.promise; });
    f.operations.drain.mockImplementationOnce(async () => { probe.reject(Error("Original probe stopped")); throw failure; });
    f.send("probe", 0, 0, { path: "/", nonce }); f.send("drain", 1); f.input.emit("end");
    const finishing = f.control.finish(); await expect(finishing).rejects.toBe(failure);
    output.resolve(); await flush(); expect(f.control.failure).toBe(failure); f.control.dispose();
  });
  it("does not turn unresolved native closure into quiescence", async () => {
    const f = fixture(); await f.control.attach(f.operations); f.send("resume", 0); await flush();
    f.operations.pause.mockRejectedValueOnce(Error("Original broker closure unconfirmed")); f.send("pause", 1, 1); await flush();
    expect(f.control.failure?.message).toContain("closure unconfirmed");
    expect(f.statuses.filter(item => item.state === "quiesced")).toHaveLength(0); f.control.dispose();
  });
  it("rejects EOF without a final command and bytes following final drain", async () => {
    const f = fixture(); await f.control.attach(f.operations); f.input.emit("end"); expect(f.control.signal.aborted).toBe(true); f.control.dispose();
    const g = fixture(); await g.control.attach(g.operations); g.send("drain", 0); g.input.emit("data", Buffer.from("x"));
    expect(g.control.signal.aborted).toBe(true); g.control.dispose();
  });
  it("keeps cancellation reachable while final drain awaits original EOF", async () => {
    const abort = new AbortController(), f = fixture(abort.signal), failure = Error("Original host cancelled");
    await f.control.attach(f.operations); f.send("drain", 0); const finishing = f.control.finish();
    abort.abort(failure); await expect(finishing).rejects.toBe(failure); f.control.dispose();
  });
});
