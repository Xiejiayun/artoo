import { describe, expect, it } from "vitest";
import {
  APPLICATION_WIRE_LIMITS as limits, ApplicationWireDecoder, ApplicationWireEncoder, ApplicationWireError,
  type ApplicationWireDirection, type ApplicationWireEnvelope, type ApplicationWireErrorCode,
} from "./application-wire-v1.js";

const host = "host-to-application", child = "application-to-host";
const invoke = { kind: "invoke", call_id: "call-1", request: {
  request_id: "request-1", method: "POST", path: "/items", query: { view: "recent" }, body: { title: "库存 🗃", count: 2 },
} };
const response = { kind: "response", call_id: "call-1", response: { status: 201, body: { id: "item-1" } } };
const dataCall = { kind: "data-call", call_id: "call-1", data_call_id: "data-1",
  request_json: JSON.stringify({ version: 1, kind: "read", query: { kind: "query", table: "items", columns: ["id"], limit: 1 } }) };
function frame(value: unknown, sequence = 1): Buffer {
  const bytes = Buffer.from(JSON.stringify({ version: 1, sequence, ...(value as object) }), "utf8");
  const header = Buffer.alloc(4); header.writeUInt32BE(bytes.length);
  return Buffer.concat([header, bytes]);
}
function rawFrame(bytes: Buffer): Buffer {
  const header = Buffer.alloc(4); header.writeUInt32BE(bytes.length);
  return Buffer.concat([header, bytes]);
}
function error(operation: () => unknown, code: ApplicationWireErrorCode): ApplicationWireError {
  try { operation(); } catch (value) {
    expect(value).toBeInstanceOf(ApplicationWireError);
    expect((value as ApplicationWireError).code).toBe(code);
    return value as ApplicationWireError;
  }
  throw new Error("Expected a rejected data channel operation");
}
function decodePieces(decoder: ApplicationWireDecoder, bytes: Buffer, width: number): readonly ApplicationWireEnvelope[] {
  const result: ApplicationWireEnvelope[] = [];
  for (let offset = 0; offset < bytes.length; offset += width) result.push(...decoder.push(bytes.subarray(offset, offset + width)));
  return result;
}

describe("unintegrated application data wire v1", () => {
  it("matches the fixed four-byte big-endian wire representation", () => {
    const bytes = Buffer.concat([Buffer.from([0, 0, 0, 44]), Buffer.from('{"version":1,"sequence":1,"kind":"shutdown"}')]);
    expect(new ApplicationWireEncoder(host).encode('{"kind":"shutdown"}')).toEqual(bytes);
    const decoder = new ApplicationWireDecoder(host);
    expect(decoder.push(bytes)).toEqual([{ version: 1, sequence: 1, kind: "shutdown" }]);
    decoder.finish();
  });

  it("round-trips an SDK request across every header/Unicode byte boundary and freezes parsed data", () => {
    const encoded = new ApplicationWireEncoder(host).encode(JSON.stringify(invoke));
    const decoder = new ApplicationWireDecoder(host);
    const result = decodePieces(decoder, encoded, 1);
    expect(result).toEqual([{ version: 1, sequence: 1, ...invoke }]);
    expect(Object.isFrozen(result[0])).toBe(true);
    if (result[0]?.kind !== "invoke") throw new Error("Expected invoke");
    expect(Object.isFrozen(result[0].request.body)).toBe(true);
    decoder.finish();
  });

  it("decodes multiple complete frames and a following partial header without retaining input aliases", () => {
    const encoder = new ApplicationWireEncoder(child), decoder = new ApplicationWireDecoder(child);
    const first = encoder.encode(JSON.stringify(dataCall)), second = encoder.encode(JSON.stringify(response));
    expect(decoder.push(Buffer.concat([first, second.subarray(0, 2)]))).toEqual([{ version: 1, sequence: 1, ...dataCall }]);
    first.fill(0); second.fill(0, 0, 2);
    expect(decoder.push(second.subarray(2))).toEqual([{ version: 1, sequence: 2, ...response }]);
    decoder.finish();
  });

  it("round-trips all host data variants while leaving broker schema validation external", () => {
    const messages = [invoke,
      { kind: "data-result", call_id: "call-1", data_call_id: "data-1", reply_json: JSON.stringify({ version: 1, result: { kind: "read", scope: { product_id: "example" }, rows: [] } }) },
      { kind: "data-error", call_id: "call-1", data_call_id: "data-2", code: "revoked" },
      { kind: "cancel", call_id: "call-1" }, { kind: "shutdown" },
    ];
    const encoder = new ApplicationWireEncoder(host), decoder = new ApplicationWireDecoder(host);
    const bytes = Buffer.concat(messages.map(value => encoder.encode(JSON.stringify(value))));
    expect(decoder.push(bytes)).toEqual(messages.map((value, index) => ({ version: 1, sequence: index + 1, ...value })));
    decoder.finish();
    error(() => encoder.encode(JSON.stringify(invoke)), "closed");
    error(() => decoder.push(Buffer.alloc(0)), "closed");
  });

  it("rejects extra authority/control fields, wrong versions and messages in the wrong direction", () => {
    const cases: [ApplicationWireDirection, unknown][] = [
      [child, invoke], [host, response], [host, dataCall], [child, { kind: "shutdown" }],
      [child, { ...dataCall, scope: { product_id: "other" } }],
      [child, { ...dataCall, permit: "fabricated" }], [child, { ...dataCall, argv: ["cmd.exe"] }],
      [child, { ...dataCall, path: "C:/private/database.sqlite" }],
      [child, { kind: "verification", passed: true }], [child, { kind: "cleanup", closed: true }],
      [child, { kind: "publication", url: "https://example.test" }],
      [child, { ...response, version: 2 }],
      [host, { ...invoke, request: { ...invoke.request, authorization: "secret" } }],
      [child, { ...response, response: { ...response.response, headers: { "Set-Cookie": "x" } } }],
    ];
    for (const [channel, value] of cases) error(() => new ApplicationWireDecoder(channel).push(frame(value)), "invalid-message");
  });

  it.each([0, limits.frameBytes + 1, 0xffff_ffff])("rejects an advertised payload length %i before buffering its body", length => {
    const header = Buffer.alloc(4); header.writeUInt32BE(length);
    const decoder = new ApplicationWireDecoder(child);
    const first = error(() => decoder.push(header), "frame-limit");
    expect(error(() => decoder.push(frame(response)), "frame-limit")).toBe(first);
    expect(error(() => decoder.finish(), "frame-limit")).toBe(first);
  });

  it("accepts a bounded large frame only through bounded chunks", () => {
    const value = { ...response, response: { status: 200, body: "x".repeat(200_000) } };
    const bytes = new ApplicationWireEncoder(child).encode(JSON.stringify(value));
    const decoder = new ApplicationWireDecoder(child);
    expect(decodePieces(decoder, bytes, limits.chunkBytes)).toEqual([{ version: 1, sequence: 1, ...value }]);
    decoder.finish();
    error(() => new ApplicationWireDecoder(child).push(bytes), "chunk-limit");
  });

  it.each([1, 3, 5, 40])("fails terminally when EOF truncates the first frame at %i bytes", length => {
    const decoder = new ApplicationWireDecoder(child);
    expect(decoder.push(frame(response).subarray(0, length))).toEqual([]);
    const first = error(() => decoder.finish(), "truncated");
    expect(error(() => decoder.push(frame(response)), "truncated")).toBe(first);
  });

  it("rejects invalid UTF-8 rather than inserting replacement characters", () => {
    error(() => new ApplicationWireDecoder(child).push(rawFrame(Buffer.from([0x7b, 0x22, 0x80, 0x22, 0x3a, 0x31, 0x7d]))), "invalid-utf8");
    error(() => new ApplicationWireDecoder(child).push(rawFrame(Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("{}")]))), "invalid-json");
  });

  it.each(["{", "{} trailing", '{"value":"\\ud800"}', '{"value":1e999}'])("rejects malformed or unsupported JSON without returning raw input", json => {
    const failure = error(() => new ApplicationWireDecoder(child).push(rawFrame(Buffer.from(json))), "invalid-json");
    expect(failure.message).toBe("Application data channel rejected: invalid-json");
  });

  it("rejects deep, wide and excessive-entry JSON before returning any message", () => {
    const deep = "[".repeat(limits.jsonDepth + 1) + "null" + "]".repeat(limits.jsonDepth + 1);
    error(() => new ApplicationWireDecoder(child).push(rawFrame(Buffer.from(deep))), "json-limit");
    const wide = Array.from({ length: limits.arrayEntries + 1 }, () => null);
    error(() => new ApplicationWireDecoder(child).push(rawFrame(Buffer.from(JSON.stringify(wide)))), "json-limit");
    const tooMany = Array.from({ length: 20 }, () => Array.from({ length: 1_000 }, () => 0));
    error(() => new ApplicationWireDecoder(child).push(rawFrame(Buffer.from(JSON.stringify(tooMany)))), "json-limit");
    const object = Object.fromEntries(Array.from({ length: limits.objectEntries + 1 }, (_, index) => [String(index), null]));
    error(() => new ApplicationWireDecoder(child).push(rawFrame(Buffer.from(JSON.stringify(object)))), "json-limit");
  });

  it("rejects sequence gaps and replay within the original directional stream", () => {
    error(() => new ApplicationWireDecoder(child).push(frame(response, 2)), "sequence");
    const decoder = new ApplicationWireDecoder(child);
    expect(decoder.push(frame(response))).toHaveLength(1);
    error(() => decoder.push(frame(response)), "sequence");
  });

  it("uses the complete envelope entry budget for both encoding and decoding", () => {
    const value = (firstLength: number) => ({ ...response, response: { status: 200,
      body: Array.from({ length: 16 }, (_, index) => Array.from({ length: index === 0 ? firstLength : 1_022 }, () => 0)),
    } });
    // Root/response fields and body containers contribute 31 entries, including
    // version/sequence. 1,023 + 15 * 1,022 scalar values reach exactly 16,384.
    const atLimit = value(1_023);
    const decoder = new ApplicationWireDecoder(child);
    expect(decoder.push(new ApplicationWireEncoder(child).encode(JSON.stringify(atLimit))))
      .toEqual([{ version: 1, sequence: 1, ...atLimit }]);
    decoder.finish();
    const encoder = new ApplicationWireEncoder(child);
    const first = error(() => encoder.encode(JSON.stringify(value(1_024))), "json-limit");
    expect(error(() => encoder.encode(JSON.stringify(response)), "json-limit")).toBe(first);
  });

  it("returns no prefix messages when a later frame in the same push is invalid", () => {
    const decoder = new ApplicationWireDecoder(child);
    error(() => decoder.push(Buffer.concat([frame(response), frame(response, 3)])), "sequence");
    error(() => decoder.push(frame(response, 2)), "sequence");
  });

  it("does not accept commands after shutdown or input after the caller reports EOF", () => {
    error(() => new ApplicationWireDecoder(host).push(Buffer.concat([frame({ kind: "shutdown" }), frame(invoke, 2)])), "closed");
    const decoder = new ApplicationWireDecoder(child);
    decoder.finish();
    error(() => decoder.finish(), "closed");
    error(() => decoder.push(frame(response)), "closed");
  });

  it.each(["https://example.test/items", "//host/items", "C:/private", "/../private", "/x/./y", "/x%2fy", "/x?token=secret", "/x\\y"])("rejects non-route path %s", path => {
    error(() => new ApplicationWireEncoder(host).encode(JSON.stringify({ ...invoke, request: { ...invoke.request, path } })), "invalid-message");
  });

  it("bounds SDK body/query values and requires an empty 204 response", () => {
    error(() => new ApplicationWireEncoder(child).encode(JSON.stringify({ ...response, response: { status: 204, body: "not empty" } })), "invalid-message");
    error(() => new ApplicationWireEncoder(child).encode(JSON.stringify({ ...response, response: { status: 200, body: "x".repeat(limits.bodyBytes) } })), "json-limit");
    error(() => new ApplicationWireEncoder(host).encode(JSON.stringify({ ...invoke, request: { ...invoke.request, query: { key: "x".repeat(limits.queryValueBytes + 1) } } })), "invalid-message");
  });

  it("bounds and parses nested data JSON but leaves schema/permit checks to the trusted broker boundary", () => {
    error(() => new ApplicationWireEncoder(child).encode(JSON.stringify({ ...dataCall, request_json: "{" })), "invalid-json");
    error(() => new ApplicationWireEncoder(child).encode(JSON.stringify({ ...dataCall, request_json: " ".repeat(65_537) })), "invalid-message");
    const unvalidated = { ...dataCall, request_json: '{"not_a_broker_request":true}' };
    expect(new ApplicationWireDecoder(child).push(new ApplicationWireEncoder(child).encode(JSON.stringify(unvalidated))))
      .toEqual([{ version: 1, sequence: 1, ...unvalidated }]);
  });

  it("accepts JSON text only and never invokes an object serialization hook", () => {
    let invoked = false;
    const object = { toJSON() { invoked = true; return response; } };
    const encoder = new ApplicationWireEncoder(child);
    error(() => encoder.encode(object as unknown as string), "invalid-json");
    expect(invoked).toBe(false);
    error(() => encoder.encode(JSON.stringify(response)), "invalid-json");
  });
});
