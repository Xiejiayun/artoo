import { describe, expect, it } from "vitest";
import { APPLICATION_COMPILER_LIMITS as limits, decodeApplicationCompilerRequest, encodeApplicationCompilerResponse,
  readApplicationCompilerRequest, type ApplicationCompilerResponse } from "./application-compiler-protocol.js";

const request = { version: 1, kind: "compile", request_id: "trusted_fixture-1", source: [
  { path: "product/client/index.html", text: "<title>Fixture</title>" },
  { path: "product/server/handler.ts", text: "export {};" },
] };
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const response = (text: string): ApplicationCompilerResponse => ({ version: 1, kind: "compile-result", request_id: "fixture",
  qualified_for_product: false, result: { status: "rejected", execution: "unavailable: native profile, isolated compiler process, protected staging and closure are not integrated",
    diagnostics: [{ category: "input", code: "fixture", message: text }] } });

describe("one-shot compiler transport (data only)", () => {
  it("decodes a complete request across UTF-8 chunk boundaries", async () => {
    const value = { ...request, source: request.source.map(file => ({ ...file, text: file.text + "中文" })) };
    const encoded = bytes(value);
    async function* chunks() { for (let offset = 0; offset < encoded.length; offset += 7) yield encoded.subarray(offset, offset + 7); }
    expect(await readApplicationCompilerRequest(chunks())).toEqual(value);
  });
  it("handles repeated empty and one-byte chunks without retaining one object per chunk", async () => {
    const encoded = bytes(request), space = Buffer.from(" "), empty = Buffer.alloc(0);
    async function* chunks() {
      yield encoded;
      for (let index = 0; index < 200_000; index++) { yield empty; yield space; }
    }
    expect(await readApplicationCompilerRequest(chunks())).toEqual(request);
  });
  it.each([
    { ...request, libraries: [] }, { ...request, compilerOptions: {} }, { ...request, request_id: "../private" },
    { ...request, source: [{ ...request.source[0], extra: true }, request.source[1]] }, { ...request, kind: "compile-again" },
    { version: 1, kind: "compile", source: request.source }, { ...request, source: [] },
  ])("rejects unsupported request fields and shapes", value => expect(() => decodeApplicationCompilerRequest(bytes(value))).toThrow("protocol_failed"));
  it.each([Buffer.from("{}{}"), Buffer.from([0xc3, 0x28]), Buffer.from("\ufeff{}"), Buffer.from("")])(
    "rejects multiple values, invalid UTF-8, BOM and empty input", value => expect(() => decodeApplicationCompilerRequest(value)).toThrow("protocol_failed"));
  it("checks actual input bytes before retaining the chunk which crosses 52 MiB", async () => {
    let consumed = 0;
    async function* chunks() {
      for (let index = 0; index < 54; index++) { consumed++; yield Buffer.alloc(1024 * 1024, 32); }
    }
    await expect(readApplicationCompilerRequest(chunks())).rejects.toThrow("protocol_failed");
    expect(consumed).toBe(53);
  });
  it("accepts a request padded to exactly 52 MiB and rejects one additional byte", () => {
    const encoded = bytes(request), padded = Buffer.alloc(limits.inputBytes, 32); encoded.copy(padded);
    expect(decodeApplicationCompilerRequest(padded)).toEqual(request);
    expect(() => decodeApplicationCompilerRequest(Buffer.alloc(limits.inputBytes + 1, 32))).toThrow("protocol_failed");
  });
  it("measures escaped output independently: 16 MiB of NULs fits, 17 MiB exceeds 100 MiB", () => {
    // Synthetic transport data, not a compiler result or an authority-granting draft.
    const encoded = encodeApplicationCompilerResponse(response("\0".repeat(16 * 1024 * 1024)));
    expect(encoded.length).toBeGreaterThan(96 * 1024 * 1024);
    expect(encoded.length).toBeLessThan(limits.outputBytes);
    expect(encoded[encoded.length - 1]).toBe(10);
    expect(() => encodeApplicationCompilerResponse(response("\0".repeat(17 * 1024 * 1024)))).toThrow("protocol_failed");
  });
});
