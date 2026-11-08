/** Pure guest-local primitives. None of these functions crosses the QuickJS host boundary. */
export function isWellFormedApplicationUtf8(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(++i);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

/** Match Buffer's replacement-byte semantics even for inputs later rejected as malformed. */
export function applicationUtf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}

function forEachUtf8Byte(text: string, emit: (byte: number) => void): void {
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) { code = 0x10000 + ((code - 0xd800) << 10) + low - 0xdc00; i++; }
      else code = 0xfffd;
    } else if (code >= 0xdc00 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) emit(code);
    else if (code < 0x800) { emit(0xc0 | (code >>> 6)); emit(0x80 | (code & 63)); }
    else if (code < 0x10000) { emit(0xe0 | (code >>> 12)); emit(0x80 | ((code >>> 6) & 63)); emit(0x80 | (code & 63)); }
    else { emit(0xf0 | (code >>> 18)); emit(0x80 | ((code >>> 12) & 63)); emit(0x80 | ((code >>> 6) & 63)); emit(0x80 | (code & 63)); }
  }
}

const roundConstants = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);
const rotate = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));

/** SHA-256 over actual UTF-8 bytes; retain one 64-byte block and one 64-word schedule. */
export function applicationSha256(text: string): string {
  const state = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const block = new Uint8Array(64), words = new Uint32Array(64);
  let offset = 0;
  const compress = () => {
    for (let i = 0; i < 16; i++) { const p = i * 4; words[i] = (block[p]! << 24) | (block[p + 1]! << 16) | (block[p + 2]! << 8) | block[p + 3]!; }
    for (let i = 16; i < 64; i++) {
      const a = words[i - 15]!, b = words[i - 2]!;
      words[i] = words[i - 16]! + (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)) + words[i - 7]! + (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10));
    }
    let a = state[0]!, b = state[1]!, c = state[2]!, d = state[3]!, e = state[4]!, f = state[5]!, g = state[6]!, h = state[7]!;
    for (let i = 0; i < 64; i++) {
      const one = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + roundConstants[i]! + words[i]!) | 0;
      const two = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + one) | 0; d = c; c = b; b = a; a = (one + two) | 0;
    }
    const values = [a, b, c, d, e, f, g, h];
    for (let i = 0; i < 8; i++) state[i] = state[i]! + values[i]!;
  };
  const emit = (byte: number) => { block[offset++] = byte; if (offset === 64) { compress(); offset = 0; } };
  forEachUtf8Byte(text, emit);
  const length = applicationUtf8ByteLength(text), high = Math.floor(length / 0x20000000), low = (length * 8) >>> 0;
  emit(0x80);
  while (offset !== 56) emit(0);
  for (let shift = 24; shift >= 0; shift -= 8) emit((high >>> shift) & 255);
  for (let shift = 24; shift >= 0; shift -= 8) emit((low >>> shift) & 255);
  return "sha256:" + Array.from(state, value => value.toString(16).padStart(8, "0")).join("");
}

/** POSIX dirname semantics, including root/trailing slash cases; no filesystem lookup. */
export function applicationVirtualDirname(path: string): string {
  if (!path.length) return ".";
  const rooted = path[0] === "/";
  let end = -1, trailingSlash = true;
  for (let i = path.length - 1; i >= 1; i--) {
    if (path[i] === "/") { if (!trailingSlash) { end = i; break; } }
    else trailingSlash = false;
  }
  if (end === -1) return rooted ? "/" : ".";
  return rooted && end === 1 ? "//" : path.slice(0, end);
}

/** The kernel supplies an absolute virtual base, so no ambient current directory exists. */
export function resolveApplicationVirtualPath(base: string, relative: string): string {
  if (!base.startsWith("/")) throw Error("application_virtual_path_requires_absolute_base");
  const parts: string[] = [];
  for (const part of (relative.startsWith("/") ? relative : base + "/" + relative).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return "/" + parts.join("/");
}
