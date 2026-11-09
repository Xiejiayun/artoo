import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createApplicationRuntimeChannel } from "./application-runtime-channel.js";
import { ApplicationWireDecoder, ApplicationWireEncoder } from "./application-wire-v1.js";
import type { ApplicationQuickJSSession, ApplicationQuickJSSessionStatus } from "./application-quickjs-session.js";
import { serveApplicationRuntime, type OwnedApplicationRuntime } from "./application-runtime-stdio.js";

const admission = { version: 1, kind: "admit", protocol: "artoo.application-runtime.v1", remainingMs: 1000 };
const line = (value: unknown) => JSON.stringify(value) + "\n";
async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 1)); }
  throw Error("controlled stream condition did not occur");
}
function fixture(blockOutput = false) {
  let state: ApplicationQuickJSSessionStatus["state"] = "ready", disposed = false, jobs = 0, time = 100;
  const messages: string[] = [], outputs: string[] = [], input = new PassThrough();
  const status = (): ApplicationQuickJSSessionStatus => ({ state, failure: null, jobs, operations: jobs, guestDisposed: disposed, qualifiedForProduct: false });
  const close = vi.fn(() => { state = "closed"; disposed = true; });
  const pump = vi.fn(() => { jobs++; return status(); });
  const session: ApplicationQuickJSSession = { get status() { return status(); }, close, pump,
    receive(text) { messages.push(text); if (JSON.parse(text).kind === "invoke") outputs.push(JSON.stringify({ kind: "response", call_id: "call-1", response: { status: 200, body: { ok: true } } })); },
    drain() { return outputs.splice(0); } };
  const channel = createApplicationRuntimeChannel(session), chunks: Buffer[] = [];
  let releaseWrite: (() => void) | undefined;
  const output = new Writable({ write(bytes: Buffer, _encoding, callback) {
    chunks.push(Buffer.from(bytes));
    if (blockOutput && JSON.parse(bytes.toString()).kind === "output") releaseWrite = () => callback();
    else callback();
  } });
  const originalCheck = vi.fn(() => { if (!disposed) throw Error("original VM still alive"); }), release = vi.fn();
  const owner: OwnedApplicationRuntime = { channel, assertDisposed: originalCheck, release };
  const factory = vi.fn(async (_deadline: number) => owner);
  const reports = () => Buffer.concat(chunks).toString().trim().split("\n").filter(Boolean).map(text => JSON.parse(text));
  const serve = () => serveApplicationRuntime(input, output, factory, () => time);
  const invoke = new ApplicationWireEncoder("host-to-application").encode(JSON.stringify({ kind: "invoke", call_id: "call-1",
    request: { request_id: "request-1", method: "GET", path: "/items", query: {}, body: null } }));
  return { input, output, channel, close, pump, reports, originalCheck, release, factory, serve, invoke,
    setTime(value: number) { time = value; }, unblock() { releaseWrite?.(); }, isBlocked: () => !!releaseWrite };
}
describe("fixed runtime original stdio", () => {
  it("routes actual wire bytes and records input EOF only after close plus natural stream completion", async () => {
    const f = fixture(), work = f.serve(); void work.catch(() => {});
    try {
      f.input.write(line(admission));
      await until(() => f.reports().some(value => value.kind === "ready"));
      f.input.write(line({ version: 1, sequence: 0, kind: "receive", data: f.invoke.toString("base64") }));
      await until(() => f.reports().some(value => value.kind === "output"));
      const bytes = Buffer.from(f.reports().find(value => value.kind === "output").payload.data, "base64");
      const messages = new ApplicationWireDecoder("application-to-host").push(bytes);
      // The application wire's original encoder starts at 1; the outer trusted
      // control protocol separately starts at 0. Keep both exact assertions.
      expect(messages[0]).toMatchObject({ version: 1, sequence: 1, kind: "response", response: { status: 200, body: { ok: true } } });
      f.input.write(line({ version: 1, sequence: 1, kind: "close" }));
      await until(() => f.channel.status.state === "closed");
      expect(f.channel.status.inputEnded).toBe(false); expect(f.reports().some(value => value.kind === "closed")).toBe(false);
      f.input.end(); await work;
      expect(f.input.readableEnded).toBe(true); expect(f.channel.status.inputEnded).toBe(true);
      expect(f.close).toHaveBeenCalledTimes(1); expect(f.originalCheck).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledOnce();
      expect(f.reports().at(-1)).toMatchObject({ kind: "closed", payload: { guestDisposed: true, inputEnded: true, discardedOutputBytes: 0 } });
    } finally { f.input.destroy(); f.output.destroy(); await work.catch(() => {}); }
  });
  it("rejects close followed by truncated input instead of declaring channel EOF", async () => {
    const f = fixture(), work = f.serve(); void work.catch(() => {}); f.input.write(line(admission));
    await until(() => f.reports().some(value => value.kind === "ready"));
    f.input.end(line({ version: 1, sequence: 0, kind: "close" }) + "{");
    await expect(work).rejects.toThrow("truncated");
    expect(f.channel.status.inputEnded).toBe(false); expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.originalCheck).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledOnce();
  });
  it("rejects unexpected natural EOF before owner close", async () => {
    const f = fixture(), work = f.serve(); void work.catch(() => {}); f.input.write(line(admission));
    await until(() => f.reports().some(value => value.kind === "ready")); f.input.end();
    await expect(work).rejects.toThrow("unexpected-eof"); expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.reports().some(value => value.kind === "closed")).toBe(false);
  });
  it("does not pump past a blocked actual stdout write and rejects its late completion", async () => {
    const f = fixture(true), work = f.serve(); void work.catch(() => {}); f.input.write(line(admission));
    await until(() => f.reports().some(value => value.kind === "ready"));
    f.input.write(line({ version: 1, sequence: 0, kind: "receive", data: f.invoke.toString("base64") }));
    await until(f.isBlocked); const pumps = f.pump.mock.calls.length;
    f.input.write(line({ version: 1, sequence: 1, kind: "close" }));
    await new Promise(resolve => setTimeout(resolve, 3)); expect(f.pump).toHaveBeenCalledTimes(pumps);
    expect(f.close).not.toHaveBeenCalled(); f.setTime(1101); f.unblock();
    await expect(work).rejects.toThrow("deadline"); expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.reports().some(value => value.kind === "closed")).toBe(false);
  });
  it("includes factory startup time in the original deadline and cleans its returned owner", async () => {
    const f = fixture(); f.factory.mockImplementation(async deadline => { expect(deadline).toBe(1100); f.setTime(1101);
      return { channel: f.channel, assertDisposed: f.originalCheck, release: f.release }; });
    const work = f.serve(); void work.catch(() => {}); f.input.write(line(admission));
    await expect(work).rejects.toThrow("deadline"); expect(f.close).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledOnce();
    expect(f.reports()).toEqual([]);
  });
  it("rejects commands after close even when the stream subsequently ends normally", async () => {
    const f = fixture(), work = f.serve(); void work.catch(() => {}); f.input.write(line(admission));
    await until(() => f.reports().some(value => value.kind === "ready"));
    f.input.end(line({ version: 1, sequence: 0, kind: "close" }) + line({ version: 1, sequence: 1, kind: "close" }));
    await expect(work).rejects.toThrow("after-close"); expect(f.channel.status.inputEnded).toBe(false);
  });
});
