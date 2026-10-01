import assert from "node:assert/strict";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import test from "node:test";
import { hasCompletePNGPixelStream } from "./png-evidence.mjs";

// Independent Pillow-generated 2x2 images; no client/UI evidence is fabricated.
const rgba = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8KuTxn4GBgYGJAQoAI8UCUpBcPuMAAAAASUVORK5CYII=", "base64");
const rgb = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNkj9nCwMDAxMDAwMDAAAAMkQEb4gUwQgAAAABJRU5ErkJggg==", "base64");
const grayAlpha = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAQAAADYv8WvAAAAEklEQVR4nGM8Uc/AwMTAwMAAAAseAUuFlIPyAAAAAElFTkSuQmCC", "base64");
const signature = rgba.subarray(0, 8);
function chunks(bytes = rgba) {
  const result = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    result.push({ type: bytes.toString("latin1", offset + 4, offset + 8), data: Buffer.from(bytes.subarray(offset + 8, offset + 8 + length)) });
    offset += length + 12;
  }
  return result;
}
function encode(parts) {
  return Buffer.concat([signature, ...parts.map(({ type, data }) => {
    const bytes = Buffer.alloc(data.length + 12);
    bytes.writeUInt32BE(data.length); bytes.write(type, 4, 4, "latin1"); data.copy(bytes, 8);
    bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
    return bytes;
  })]);
}
function changed(mutate) { const parts = chunks(); mutate(parts); return encode(parts); }
function changedPixels(mutate) {
  return changed((parts) => { const data = parts.find((chunk) => chunk.type === "IDAT"); data.data = deflateSync(mutate(inflateSync(data.data))); });
}

test("RGB/RGBA/gray-alpha PNGs accept complete pixel streams and valid Apple ancillary chunks", () => {
  for (const fixture of [rgba, rgb, grayAlpha]) assert.equal(hasCompletePNGPixelStream(fixture), true);
  const nativeLike = chunks(rgb);
  nativeLike.splice(1, 0, { type: "sRGB", data: Buffer.from([0]) }, { type: "eXIf", data: Buffer.from([73, 73, 42, 0, 8, 0, 0, 0, 0, 0]) });
  assert.equal(hasCompletePNGPixelStream(encode(nativeLike)), true, "Ancillary metadata is CRC-checked, not interpreted as colour/pixel semantics");
  const split = chunks(); const at = split.findIndex(({ type }) => type === "IDAT"), payload = split[at].data;
  split.splice(at, 1, { type: "IDAT", data: payload.subarray(0, 5) }, { type: "IDAT", data: Buffer.alloc(0) }, { type: "IDAT", data: payload.subarray(5) });
  assert.equal(hasCompletePNGPixelStream(encode(split)), true);
});

test("packed indexed samples and 16-bit samples have the correct byte-length contract", () => {
  const indexed = chunks(); indexed[0].data[8] = 1; indexed[0].data[9] = 3;
  indexed.splice(1, 0, { type: "PLTE", data: Buffer.from([255, 0, 0, 0, 0, 255]) });
  indexed.find(({ type }) => type === "IDAT").data = deflateSync(Buffer.from([0, 0, 0, 0]));
  assert.equal(hasCompletePNGPixelStream(encode(indexed)), true);
  for (const [colour, sampleBytes] of [[0, 2], [2, 6], [4, 4], [6, 8]]) {
    const parts = chunks(); parts[0].data.writeUInt32BE(1, 0); parts[0].data.writeUInt32BE(1, 4); parts[0].data[8] = 16; parts[0].data[9] = colour;
    parts.find(({ type }) => type === "IDAT").data = deflateSync(Buffer.alloc(1 + sampleBytes));
    assert.equal(hasCompletePNGPixelStream(encode(parts)), true);
  }
  indexed.splice(1, 1);
  assert.equal(hasCompletePNGPixelStream(encode(indexed)), false, "Indexed PNG requires a palette before pixels");
});

test("Adam7 validates each nonempty pass, including tiny images and all five legal row filters", () => {
  const row = (width, filter) => Buffer.concat([Buffer.from([filter]), Buffer.alloc(width * 4)]);
  const parts = chunks(); parts[0].data.writeUInt32BE(3, 0); parts[0].data.writeUInt32BE(3, 4); parts[0].data[12] = 1;
  // A 3x3 RGBA image has pass rows: 1; empty; empty; 1; 2; 1,1; 3.
  const pixels = Buffer.concat([row(1, 0), row(1, 1), row(2, 2), row(1, 3), row(1, 4), row(3, 0)]);
  parts[1].data = deflateSync(pixels);
  assert.equal(hasCompletePNGPixelStream(encode(parts)), true);
  const invalid = Buffer.from(pixels); invalid[invalid.length - 13] = 5; parts[1].data = deflateSync(invalid);
  assert.equal(hasCompletePNGPixelStream(encode(parts)), false, "The final pass filter must also be valid");
  parts[0].data.writeUInt32BE(1, 0); parts[0].data.writeUInt32BE(1, 4); parts[1].data = deflateSync(row(1, 0));
  assert.equal(hasCompletePNGPixelStream(encode(parts)), true, "Empty Adam7 passes contain no filter bytes");
});

test("correct CRCs cannot hide incomplete, excess or invalid filtered pixel data", () => {
  for (const mutate of [
    (pixels) => pixels.subarray(0, -1),
    (pixels) => Buffer.concat([pixels, Buffer.from([0])]),
    (pixels) => { pixels[0] = 5; return pixels; },
    (pixels) => { pixels[9] = 255; return pixels; },
  ]) assert.equal(hasCompletePNGPixelStream(changedPixels(mutate)), false);
});

test("the entire IDAT payload must be exactly one complete zlib stream", () => {
  for (const mutate of [
    (bytes) => bytes.subarray(0, -1),
    (bytes) => Buffer.concat([bytes, Buffer.from("trailing bytes")]),
    (bytes) => Buffer.concat([bytes, bytes]),
    () => Buffer.alloc(0),
  ]) assert.equal(hasCompletePNGPixelStream(changed((parts) => { parts[1].data = mutate(parts[1].data); })), false);
});

test("CRC, framing, required order and static-PNG structure reject damaged evidence", () => {
  const corruptedCRC = Buffer.from(rgba); corruptedCRC[29] ^= 1;
  const bogusLength = Buffer.from(rgba); bogusLength.writeUInt32BE(0xffffffff, 8);
  for (const bytes of [undefined, "PNG", Buffer.alloc(0), rgba.subarray(0, 8), rgba.subarray(0, -1), corruptedCRC, bogusLength, Buffer.concat([rgba, Buffer.from([0])])]) {
    assert.equal(hasCompletePNGPixelStream(bytes), false);
  }
  const mutations = [
    (parts) => parts.unshift({ type: "tEXt", data: Buffer.from("before IHDR") }),
    (parts) => parts.splice(1, 0, parts[0]),
    (parts) => { parts[0].type = "\u00c9HDR"; },
    (parts) => parts.splice(1, 0, { type: "ABCD", data: Buffer.alloc(0) }),
    (parts) => parts.splice(1, 0, { type: "abct", data: Buffer.alloc(0) }),
    (parts) => parts.splice(1, 0, { type: "acTL", data: Buffer.alloc(8) }),
    (parts) => parts.splice(1, 1),
    (parts) => parts.pop(),
    (parts) => { parts.at(-1).data = Buffer.from([0]); },
    (parts) => { const data = parts[1].data; parts.splice(1, 1, { type: "IDAT", data: data.subarray(0, 5) }, { type: "tEXt", data: Buffer.from("between IDAT") }, { type: "IDAT", data: data.subarray(5) }); },
  ];
  for (const mutate of mutations) assert.equal(hasCompletePNGPixelStream(changed(mutate)), false);
});

test("invalid IHDR modes and oversized decompression claims fail before allocating pixel data", () => {
  for (const mutate of [
    (data) => data.writeUInt32BE(0, 0),
    (data) => data.writeUInt32BE(0, 4),
    (data) => data.writeUInt32BE(0x80000000, 0),
    (data) => { data.writeUInt32BE(1_000_000, 0); data.writeUInt32BE(1_000_000, 4); },
    (data) => { data[8] = 4; },
    (data) => { data[9] = 1; },
    (data) => { data[10] = 1; },
    (data) => { data[11] = 1; },
    (data) => { data[12] = 2; },
  ]) assert.equal(hasCompletePNGPixelStream(changed((parts) => mutate(parts[0].data))), false);
});
