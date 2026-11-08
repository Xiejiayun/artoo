import { describe, expect, it } from "vitest";
import { APPLICATION_COMPILER_LIMITS as limits, encodeApplicationCompilerResponse,
  type ApplicationCompilerResponse } from "./application-compiler-protocol.js";
import { decodeApplicationCompilerResponse, readApplicationCompilerResponse } from "./application-compiler-response.js";

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const response = (text: string): ApplicationCompilerResponse => ({ version: 1, kind: "compile-result", request_id: "fixture",
  qualified_for_product: false, result: { status: "rejected", execution: "unavailable: native profile, isolated compiler process, protected staging and closure are not integrated",
    diagnostics: [{ category: "input", code: "fixture", message: text }] } });

describe("bounded host compiler response transport (content only)", () => {
  it("decodes a complete response across UTF-8 boundaries and empty chunks", async () => {
    const value = response("中文 😀"), encoded = encodeApplicationCompilerResponse(value);
    async function* chunks() { for (const byte of encoded) { yield Buffer.alloc(0); yield Uint8Array.of(byte); } }
    expect(await readApplicationCompilerResponse(chunks())).toEqual(value);
  });
  it("does not settle on complete JSON before actual EOF and preserves a later transport failure", async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), observed = new Promise<void>(resolve => { entered = resolve; });
    const value = response("bounded");
    async function* chunks() { yield encodeApplicationCompilerResponse(value); entered(); await gate; }
    let done = false; const pending = readApplicationCompilerResponse(chunks()); void pending.then(() => { done = true; });
    await observed; expect(done).toBe(false); release(); expect(await pending).toEqual(value);
    const original = Error("original transport failure");
    async function* broken() { yield encodeApplicationCompilerResponse(value); throw original; }
    await expect(readApplicationCompilerResponse(broken())).rejects.toBe(original);
  });
  it.each([Buffer.from(""), Buffer.from("{}{}"), Buffer.from([0xc3, 0x28]), Buffer.from([0xf0, 0x9f, 0x98]),
    Buffer.from("\ufeff{}"), encodeApplicationCompilerResponse(response("complete")).subarray(0, -3)])(
    "rejects empty, multiple, malformed/truncated UTF-8, BOM and truncated JSON", value => {
      expect(() => decodeApplicationCompilerResponse(value)).toThrow("protocol_failed");
    });
  it.each([
    { ...response("one"), qualified_for_product: true },
    { ...response("one"), processClosed: true },
    { ...response("one"), request_id: "../other" },
    { ...response("one"), result: { ...response("one").result, execution: "verified" } },
    { ...response("one"), result: { ...response("one").result, diagnostics: [] } },
    { ...response("one"), result: { ...response("one").result, diagnostics: Array(33).fill({ category: "compiler", code: "x", message: "x" }) } },
  ])("rejects authority claims and unsupported result shapes", value => {
    expect(() => decodeApplicationCompilerResponse(bytes(value))).toThrow("protocol_failed");
  });
  it("checks true storage size and rejects unsupported chunk buffers", async () => {
    const tooLarge = new Uint8Array(limits.outputBytes + 1);
    Object.defineProperty(tooLarge, "byteLength", { value: 1 });
    expect(() => decodeApplicationCompilerResponse(tooLarge)).toThrow("protocol_failed");
    const detachedBuffer = new ArrayBuffer(1), detached = new Uint8Array(detachedBuffer);
    structuredClone(detachedBuffer, { transfer: [detachedBuffer] });
    for (const value of [new Uint8Array(new SharedArrayBuffer(1)),
      new Uint8Array(Reflect.construct(ArrayBuffer, [1, { maxByteLength: 2 }])), detached, {} as Uint8Array]) {
      expect(() => decodeApplicationCompilerResponse(value)).toThrow("protocol_failed");
    }
    let consumed = 0;
    async function* chunks() {
      for (let index = 0; index < 102; index++) { consumed++; yield Buffer.alloc(1024 * 1024, 32); }
    }
    await expect(readApplicationCompilerResponse(chunks())).rejects.toThrow("protocol_failed"); expect(consumed).toBe(101);
  });
  it("accepts exactly 100 MiB of a valid response plus whitespace", () => {
    const value = response("exact bound"), encoded = encodeApplicationCompilerResponse(value);
    const padded = Buffer.alloc(limits.outputBytes, 32); encoded.copy(padded);
    expect(decodeApplicationCompilerResponse(padded)).toEqual(value);
  });
});
