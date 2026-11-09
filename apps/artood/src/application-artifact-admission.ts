import { createHash } from "node:crypto";
import { applicationVirtualDirname, resolveApplicationVirtualPath } from "./application-build-primitives.js";
import type { ApplicationBuildFilePin } from "./application-build-kernel.js";

/** Host-only content capture, not compiler provenance or permission to execute. */
export interface ApplicationArtifactPinSet {
  readonly digest: string;
  readonly files: readonly ApplicationBuildFilePin[];
}
export interface ApplicationArtifactExpectation {
  readonly version: 1;
  readonly source: ApplicationArtifactPinSet;
  readonly artifacts: ApplicationArtifactPinSet;
  readonly toolchain: ApplicationArtifactPinSet;
}
export interface ApplicationArtifactByteFile { readonly path: string; readonly bytes: Uint8Array }
export interface ApplicationArtifactCaptureInput {
  readonly source: readonly ApplicationArtifactByteFile[];
  readonly artifacts: readonly ApplicationArtifactByteFile[];
  readonly toolchain: readonly ApplicationArtifactByteFile[];
}
declare const capturedBrand: unique symbol;
export interface CapturedApplicationArtifact { readonly [capturedBrand]: true }
declare const clientReaderBrand: unique symbol;
/** Local capability for captured public client bytes only; JSON carries no authority. */
export interface ApplicationClientReader { readonly [clientReaderBrand]: true }
const clientReaders = new WeakMap<ApplicationClientReader, {
  assert(): void; read(canonical: string): Uint8Array | undefined;
}>();
export function assertApplicationClientReader(reader: ApplicationClientReader): void {
  const saved = clientReaders.get(reader); if (!saved) return fail("client-reader-required"); saved.assert();
}
export function readApplicationClientArtifact(reader: ApplicationClientReader, canonical: string): Uint8Array | undefined {
  const saved = clientReaders.get(reader); if (!saved) return fail("client-reader-required");
  return saved.read(canonical);
}
/** Idempotent host cleanup; it never revokes a separate runtime's capture. */
export function revokeApplicationClientReader(reader: ApplicationClientReader): void { clientReaders.delete(reader); }
export interface ApplicationArtifactOwner {
  capture(input: ApplicationArtifactCaptureInput): CapturedApplicationArtifact;
  clientReader(captured: CapturedApplicationArtifact): ApplicationClientReader;
  entry(captured: CapturedApplicationArtifact): "server/handler.js";
  resolve(captured: CapturedApplicationArtifact, base: string, specifier: string): string;
  load(captured: CapturedApplicationArtifact, canonical: string): string;
  /** Trusted fixed-loader use only. Returns a new copy, never the owner's backing buffer. */
  readToolchain(captured: CapturedApplicationArtifact, logicalId: string): Uint8Array;
  revoke(captured: CapturedApplicationArtifact): void;
}
type Role = "source" | "artifacts" | "toolchain";
type Failure = "invalid-input" | "limit" | "pin-mismatch" | "invalid-utf8" | "capture-required" | "client-reader-required" | "module-rejected" | "toolchain-rejected";
export class ApplicationArtifactAdmissionError extends Error {
  constructor(readonly code: Failure) { super("Application artifact capture rejected: " + code); }
}
const fail = (code: Failure = "invalid-input"): never => { throw new ApplicationArtifactAdmissionError(code); };
const roles: readonly Role[] = ["source", "artifacts", "toolchain"];
const limits = {
  source: { count: 256, bytes: 8 * 1024 * 1024, fileBytes: 128 * 1024, minimum: 2 },
  artifacts: { count: 256, bytes: 16 * 1024 * 1024, fileBytes: 16 * 1024 * 1024, minimum: 2 },
  toolchain: { count: 1024, bytes: 256 * 1024 * 1024, fileBytes: 256 * 1024 * 1024, minimum: 1 },
} as const;
const virtualProduct = "/__source/product/", virtualServer = virtualProduct + "server/";
const sha = (bytes: Uint8Array | string): string => "sha256:" + createHash("sha256").update(bytes).digest("hex");
const digest = (pins: readonly ApplicationBuildFilePin[]): string => sha(JSON.stringify(pins));
const order = (a: { path: string }, b: { path: string }) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
const pinDigest = (value: unknown): value is string => typeof value === "string" && value.length === 71 && /^sha256:[a-f0-9]{64}$/u.test(value);

// Metadata is data-only. In particular, do not invoke getters while checking a
// caller's claimed byte count or copy using a caller-overridden TypedArray method.
function fields(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value), actual = Reflect.ownKeys(descriptors);
  if (actual.length !== names.length || names.some(name => !Object.hasOwn(descriptors, name))) return fail();
  const result: Record<string, unknown> = Object.create(null);
  for (const name of names) {
    const descriptor = descriptors[name]!; if (!("value" in descriptor)) return fail(); result[name] = descriptor.value;
  }
  return result;
}
function list(value: unknown, role: Role): readonly unknown[] {
  if (!Array.isArray(value) || value.length < limits[role].minimum || value.length > limits[role].count) return fail("limit");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) return fail();
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors["" + index]; if (!descriptor || !("value" in descriptor)) return fail(); result.push(descriptor.value);
  }
  return result;
}
function portable(path: unknown): path is string {
  return typeof path === "string" && path.length <= 512 && !/[^\x20-\x7e]/u.test(path) && path.split("/").every(part =>
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(part) && !/[. ]$/u.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part));
}
function pathFor(role: Role, path: unknown): asserts path is string {
  if (!portable(path)) return fail();
  if (role === "source" && (!/^product\/(?:client\/.+\.(?:html|css|ts)|server\/.+\.ts)$/u.test(path)
    || path.endsWith(".d.ts") || path.split("/").some(part => part.toLowerCase() === "node_modules"))) fail();
  if (role === "artifacts" && !/^(?:client\/.+\.(?:html|css|js)|server\/.+\.js)$/u.test(path)) fail();
}
interface Expected { readonly pins: readonly ApplicationBuildFilePin[]; readonly byPath: ReadonlyMap<string, ApplicationBuildFilePin>; readonly digest: string }
function expectedSet(value: unknown, role: Role): Expected {
  const item = fields(value, ["digest", "files"]); if (!pinDigest(item.digest)) return fail();
  const pins: ApplicationBuildFilePin[] = [], seen = new Set<string>(); let total = 0;
  for (const raw of list(item.files, role)) {
    const pin = fields(raw, ["path", "bytes", "sha256"]); pathFor(role, pin.path);
    if (typeof pin.bytes !== "number" || !Number.isSafeInteger(pin.bytes) || pin.bytes < 0 || !pinDigest(pin.sha256)) return fail();
    total += pin.bytes; if (pin.bytes > limits[role].fileBytes || total > limits[role].bytes) return fail("limit");
    const key = pin.path.toLowerCase(); if (seen.has(key)) return fail(); seen.add(key);
    pins.push(Object.freeze({ path: pin.path, bytes: pin.bytes, sha256: pin.sha256 }));
  }
  pins.sort(order); if (digest(pins) !== item.digest) return fail("pin-mismatch");
  return { pins: Object.freeze(pins), byPath: new Map(pins.map(pin => [pin.path, pin])), digest: item.digest };
}

// Use the original intrinsic accessors: a forged .buffer/.byteLength property
// cannot hide shared storage, a detached view, or an oversized byte allocation.
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const bufferOf = Object.getOwnPropertyDescriptor(typedArray, "buffer")!.get!;
const lengthOf = Object.getOwnPropertyDescriptor(typedArray, "byteLength")!.get!;
const offsetOf = Object.getOwnPropertyDescriptor(typedArray, "byteOffset")!.get!;
const arrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!;
const arrayBufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;
interface View { readonly original: Uint8Array; readonly buffer: ArrayBuffer; readonly offset: number; readonly length: number }
function view(value: unknown): View {
  try {
    if (!(value instanceof Uint8Array)) return fail();
    const buffer: unknown = Reflect.apply(bufferOf, value, []);
    // The intrinsic ArrayBuffer getter rejects SharedArrayBuffer and fake/proxy objects.
    Reflect.apply(arrayBufferLength, buffer, []);
    if (arrayBufferResizable && Reflect.apply(arrayBufferResizable, buffer, [])) return fail();
    const offset: number = Reflect.apply(offsetOf, value, []), length: number = Reflect.apply(lengthOf, value, []);
    new Uint8Array(buffer as ArrayBuffer, offset, length); // Reject detached backing even for an empty view.
    return { original: value, buffer: buffer as ArrayBuffer, offset, length };
  } catch { return fail(); }
}
interface Reference extends View { readonly path: string }
function references(value: unknown, role: Role, expected: Expected): Reference[] {
  const files = list(value, role); if (files.length !== expected.pins.length) return fail("pin-mismatch");
  const seen = new Set<string>(), result: Reference[] = []; let total = 0;
  for (const raw of files) {
    const file = fields(raw, ["path", "bytes"]); pathFor(role, file.path);
    const input = view(file.bytes); total += input.length;
    if (input.length > limits[role].fileBytes || total > limits[role].bytes) return fail("limit");
    if (seen.has(file.path.toLowerCase())) return fail(); seen.add(file.path.toLowerCase());
    const pin = expected.byPath.get(file.path); if (!pin || pin.bytes !== input.length) return fail("pin-mismatch");
    result.push({ path: file.path, ...input });
  }
  return result.sort(order);
}
interface Snapshot { readonly bytes: Uint8Array; readonly text?: string }
interface Capture { readonly snapshots: readonly ReadonlyMap<string, Snapshot>[]; readonly server: ReadonlyMap<string, string> }

/** Expected pins must be selected independently by trusted local owner code. Passing
 * a model/compiler-supplied manifest here does not establish that trust or build causality. */
export function createApplicationArtifactOwner(expectation: ApplicationArtifactExpectation): ApplicationArtifactOwner {
  const raw = fields(expectation, ["version", "source", "artifacts", "toolchain"]); if (raw.version !== 1) return fail();
  const expected = { source: expectedSet(raw.source, "source"), artifacts: expectedSet(raw.artifacts, "artifacts"), toolchain: expectedSet(raw.toolchain, "toolchain") };
  if (!expected.source.byPath.has("product/client/index.html") || !expected.source.byPath.has("product/server/handler.ts")
    || !expected.artifacts.byPath.has("client/index.html") || !expected.artifacts.byPath.has("server/handler.js")
    || expected.source.pins.length !== expected.artifacts.pins.length) return fail();
  for (const source of expected.source.pins) {
    const output = source.path.slice("product/".length).replace(/\.ts$/u, ".js"), artifact = expected.artifacts.byPath.get(output);
    if (!artifact || (!source.path.endsWith(".ts") && (source.bytes !== artifact.bytes || source.sha256 !== artifact.sha256))) return fail("pin-mismatch");
  }
  const captures = new WeakMap<CapturedApplicationArtifact, Capture>();
  const original = (token: CapturedApplicationArtifact): Capture => captures.get(token) ?? fail("capture-required");
  return Object.freeze({
    capture(input: ApplicationArtifactCaptureInput): CapturedApplicationArtifact {
      const values = fields(input, roles);
      // Inspect every count, true byte length and aggregate bound before any large
      // copy/hash. No shared or resizable backing is admitted; this function never yields.
      const inputs = roles.map(role => references(values[role], role, expected[role]));
      const snapshots: Map<string, Snapshot>[] = [], server = new Map<string, string>();
      for (let index = 0; index < roles.length; index++) {
        const role = roles[index]!, files = inputs[index]!, saved = new Map<string, Snapshot>(), pins: ApplicationBuildFilePin[] = [];
        for (const file of files) {
          const bytes = new Uint8Array(file.length); bytes.set(new Uint8Array(file.buffer, file.offset, file.length));
          const pin = { path: file.path, bytes: bytes.length, sha256: sha(bytes) };
          if (pin.sha256 !== expected[role].byPath.get(file.path)!.sha256) return fail("pin-mismatch");
          let text: string | undefined;
          if (role !== "toolchain") {
            try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return fail("invalid-utf8"); }
            const encoded = new TextEncoder().encode(text);
            if (encoded.length !== bytes.length || encoded.some((byte, position) => byte !== bytes[position])) return fail("invalid-utf8");
            if (role === "artifacts" && file.path.startsWith("server/")) server.set(file.path, text);
          }
          saved.set(file.path, { bytes, text }); pins.push(pin);
        }
        if (digest(pins) !== expected[role].digest) return fail("pin-mismatch"); snapshots.push(saved);
      }
      // Recheck the supplied view identities/bytes too. Later caller mutation is
      // harmless: only private copies and immutable strings are kept by this owner.
      for (let index = 0; index < roles.length; index++) for (const file of inputs[index]!) {
        const current = view(file.original);
        if (current.buffer !== file.buffer || current.offset !== file.offset || current.length !== file.length
          || sha(new Uint8Array(current.buffer, current.offset, current.length)) !== expected[roles[index]!].byPath.get(file.path)!.sha256) return fail("pin-mismatch");
      }
      const token = Object.freeze({}) as CapturedApplicationArtifact; captures.set(token, { snapshots, server }); return token;
    },
    clientReader(token: CapturedApplicationArtifact): ApplicationClientReader {
      original(token);
      const reader = Object.freeze({}) as ApplicationClientReader;
      clientReaders.set(reader, {
        assert() { original(token); },
        read(canonical: string) {
          const saved = original(token).snapshots[1]!;
          if (!portable(canonical) || !/^client\/.+\.(?:html|css|js)$/u.test(canonical)) return undefined;
          const file = saved.get(canonical); if (!file) return undefined;
          const copy = new Uint8Array(file.bytes.length); copy.set(file.bytes); return copy;
        },
      });
      return reader;
    },
    entry(token: CapturedApplicationArtifact) { original(token); return "server/handler.js" as const; },
    resolve(token: CapturedApplicationArtifact, base: string, specifier: string): string {
      const saved = original(token);
      if (typeof base !== "string" || !saved.server.has(base) || typeof specifier !== "string" || specifier.length > limits.source.fileBytes
        || !/^(?:\.\/|\.\.\/)[A-Za-z0-9_./-]+\.js$/u.test(specifier)) return fail("module-rejected");
      // Match the compiler's exact virtual root and POSIX final resolution, including
      // harmless relative spelling aliases. These strings are never filesystem paths.
      const target = resolveApplicationVirtualPath(applicationVirtualDirname(virtualProduct + base), specifier);
      const canonical = target.slice(virtualProduct.length);
      if (!target.startsWith(virtualServer) || !saved.server.has(canonical)) return fail("module-rejected");
      return canonical;
    },
    load(token: CapturedApplicationArtifact, canonical: string): string {
      const saved = original(token);
      if (typeof canonical !== "string" || !saved.server.has(canonical)) return fail("module-rejected");
      return saved.server.get(canonical)!;
    },
    readToolchain(token: CapturedApplicationArtifact, logicalId: string): Uint8Array {
      const saved = original(token).snapshots[2]!; // The fixed third capture role is toolchain.
      const file = typeof logicalId === "string" ? saved.get(logicalId) : undefined;
      if (!file) return fail("toolchain-rejected");
      const copy = new Uint8Array(file.bytes.length); copy.set(file.bytes); return copy;
    },
    revoke(token: CapturedApplicationArtifact) { original(token); captures.delete(token); },
  });
}
