import { crc32, inflateSync } from "node:zlib";

export const MAX_PNG_BYTES = 64 * 1024 * 1024;
const MAX_PIXEL_BYTES = 128 * 1024 * 1024;
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const adam7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

/** Bounded PNG evidence integrity, not a complete image/colour decoder.
 * Checks chunk framing/CRC, critical structure and the entire zlib pixel stream,
 * including scanline lengths and filter bytes for noninterlaced/Adam7 data.
 * Does not reconstruct pixels, validate palette indices or interpret ancillary
 * colour/profile metadata. Animated PNG is outside this static capture scope. */
export function hasCompletePNGPixelStream(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 57 || bytes.length > MAX_PNG_BYTES || !bytes.subarray(0, 8).equals(signature)) return false;
  let offset = 8, header, palette = false, dataStarted = false, dataEnded = false, ended = false;
  const compressedParts = [];
  while (offset < bytes.length) {
    if (bytes.length - offset < 12) return false;
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) return false;
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || (bytes[offset + 6] & 32) !== 0
        || crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) return false;
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (!header && type !== "IHDR") return false;
    if (type === "IHDR") {
      if (header || offset !== 8 || length !== 13) return false;
      const width = data.readUInt32BE(0), height = data.readUInt32BE(4), depth = data[8], colour = data[9], interlace = data[12];
      if (!width || !height || width > 0x7fffffff || height > 0x7fffffff || !depths[colour]?.includes(depth)
          || data[10] !== 0 || data[11] !== 0 || interlace > 1) return false;
      header = { width, height, depth, colour, interlace };
    } else if (type === "PLTE") {
      if (palette || dataStarted || [0, 4].includes(header.colour) || !length || length % 3 !== 0 || length > 768
          || (header.colour === 3 && length / 3 > 2 ** header.depth)) return false;
      palette = true;
    } else if (type === "IDAT") {
      if (dataEnded || (header.colour === 3 && !palette)) return false;
      dataStarted = true;
      compressedParts.push(data);
    } else if (type === "IEND") {
      if (!dataStarted || length !== 0) return false;
      ended = true;
    } else if (/^[A-Z]/.test(type) || ["acTL", "fcTL", "fdAT"].includes(type)) return false;
    if (dataStarted && type !== "IDAT") dataEnded = true;
    offset += length + 12;
    if (ended) break;
  }
  if (!ended || offset !== bytes.length) return false;
  const { width, height, depth, colour, interlace } = header;
  const passes = (interlace ? adam7 : [[0, 0, 1, 1]]).map(([x, y, dx, dy]) => {
    const columns = Math.max(0, Math.ceil((width - x) / dx)), rows = Math.max(0, Math.ceil((height - y) / dy));
    return { rows: columns ? rows : 0, stride: 1 + Math.ceil(columns * channels[colour] * depth / 8) };
  });
  const expected = passes.reduce((total, { rows, stride }) => total + rows * stride, 0);
  if (!Number.isSafeInteger(expected) || expected < 1 || expected > MAX_PIXEL_BYTES) return false;
  const compressed = Buffer.concat(compressedParts);
  let pixels;
  try {
    const result = inflateSync(compressed, { maxOutputLength: expected, info: true });
    if (result.engine.bytesWritten !== compressed.length || result.buffer.length !== expected) return false;
    pixels = result.buffer;
  } catch { return false; }
  let rowOffset = 0;
  for (const { rows, stride } of passes) {
    for (let row = 0; row < rows; row++, rowOffset += stride) if (pixels[rowOffset] > 4) return false;
  }
  return rowOffset === pixels.length;
}
