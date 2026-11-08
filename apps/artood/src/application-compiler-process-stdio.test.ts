import { PassThrough, Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { serveApplicationCompiler } from "./application-compiler-process-stdio.js";
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const admission = (extra = {}) => Buffer.from(JSON.stringify({ version: 1, kind: "admit", protocol: "artoo.application-compiler-process.v1", remainingMs: 1000, ...extra }) + "\n");
function fixture() {
  const chunks: Buffer[] = [], input = new PassThrough(), output = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  const owned = { compile: vi.fn((_bytes: Uint8Array) => Buffer.from('{"controlled":true}\n')), assertDisposed: vi.fn(), release: vi.fn() };
  const create = vi.fn(async (_deadline: number) => owned);
  return { input, output, chunks, owned, create };
}
describe("compiler admission then raw JSON/EOF controlled transport", () => {
  it("waits for real EOF before loading, preserves raw bytes and emits only after disposal and release", async () => {
    const f = fixture(), work = serveApplicationCompiler(f.input, f.output, f.create);
    f.input.write(admission()); f.input.write('{"source":"controlled 😀"}'); await tick(); expect(f.create).not.toHaveBeenCalled();
    f.input.end(); await work;
    expect(f.owned.compile.mock.calls[0]![0]).toEqual(Buffer.from('{"source":"controlled 😀"}'));
    expect(f.owned.assertDisposed.mock.invocationCallOrder[0]).toBeLessThan(f.owned.release.mock.invocationCallOrder[0]!);
    expect(Buffer.concat(f.chunks).toString()).toBe('{"controlled":true}\n');
  });
  it("accepts split admission bytes while retaining its original remaining deadline", async () => {
    const f = fixture(); let now = 100;
    const work = serveApplicationCompiler(f.input, f.output, f.create, () => now), first = admission();
    f.input.write(first.subarray(0, 9)); await tick(); now = 200; f.input.write(first.subarray(9)); await tick(); now = 250;
    f.input.end("{}"); await work; expect(f.create).toHaveBeenCalledWith(1200);
  });
  it.each(["protocol", "oversized-admission", "truncated-admission", "no-request", "object-mode"])("rejects %s without loading a compiler", async kind => {
    const f = fixture();
    const input = kind === "object-mode" ? Readable.from([{}]) : f.input;
    const work = serveApplicationCompiler(input, f.output, f.create);
    if (kind === "protocol") f.input.end(Buffer.concat([admission({ protocol: "artoo.application-runtime.v1" }), Buffer.from("{}") ]));
    if (kind === "oversized-admission") f.input.end("x".repeat(256));
    if (kind === "truncated-admission") f.input.end("{\"version\":1}");
    if (kind === "no-request") f.input.end(admission());
    await expect(work).rejects.toThrow(); expect(f.create).not.toHaveBeenCalled(); expect(f.chunks).toEqual([]);
  });
  it.each(["compile", "dispose", "release", "deadline"])("withholds output when %s fails", async kind => {
    const f = fixture(); let now = 100;
    if (kind === "compile") f.owned.compile.mockImplementation(() => { throw Error("controlled compile failure"); });
    if (kind === "dispose") f.owned.assertDisposed.mockImplementation(() => { throw Error("controlled disposal failure"); });
    if (kind === "release") f.owned.release.mockImplementation(() => { throw Error("controlled release failure"); });
    if (kind === "deadline") f.owned.assertDisposed.mockImplementation(() => { now = 1101; });
    const work = serveApplicationCompiler(f.input, f.output, f.create, () => now); f.input.end(Buffer.concat([admission(), Buffer.from("{}") ]));
    await expect(work).rejects.toThrow(); expect(f.owned.release).toHaveBeenCalled(); expect(f.chunks).toEqual([]);
  });
  it("rejects destroyed input instead of treating it as original EOF", async () => {
    const f = fixture(), work = serveApplicationCompiler(f.input, f.output, f.create); f.input.write(admission());
    f.input.destroy(Error("controlled stream failure")); await expect(work).rejects.toThrow(); expect(f.create).not.toHaveBeenCalled();
  });
});
