import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { TextDecoder } from "node:util";
import { z } from "zod";
import type { ApplicationArtifactCaptureInput } from "./application-artifact-admission.js";
import { ApplicationRuntimeConfigurationSchema, ApplicationRuntimeFilePinSchema,
  APPLICATION_RUNTIME_PROCESS_LIMITS as limits, type ApplicationRuntimeFilePin } from "./application-runtime-process-protocol.js";

/** Content/physical-path verification only. Protected local admission remains an
 * independent original host responsibility; a hash cannot grant execution. */
export function readApplicationRuntimePin(input: ApplicationRuntimeFilePin): Buffer {
  const pin = ApplicationRuntimeFilePinSchema.parse(input);
  if (realpathSync.native(pin.path) !== pin.path) throw Error("runtime-pin-path");
  for (let current = pin.path;; current = dirname(current)) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (current !== pin.path && !stat.isDirectory())) throw Error("runtime-pin-path");
    if (current === dirname(current)) break;
  }
  const handle = openSync(pin.path, "r");
  try {
    const before = fstatSync(handle, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(pin.bytes)) throw Error("runtime-pin-file");
    const bytes = readFileSync(handle), after = fstatSync(handle, { bigint: true });
    if (!after.isFile() || after.nlink !== 1n || after.ino !== before.ino || after.dev !== before.dev
      || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
      || bytes.length !== pin.bytes || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== pin.sha256) throw Error("runtime-pin-changed");
    return bytes;
  } finally { closeSync(handle); }
}
const vendorSchema = z.object({
  version: z.literal(1), format: z.literal("artoo.quickjs-runtime-vendor.v1"), version_name: z.literal("0.32.0"),
  variant: z.literal("wasmfile-release-sync"), qualified_for_product: z.literal(false), provenance: z.string().max(4096),
  files: z.array(z.object({ path: z.string().regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/u),
    bytes: z.number().int().min(1).max(limits.fileBytes), sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    url: z.string().max(4096), integrity: z.string().max(256),
  }).strict()).min(1).max(64),
}).strict();
const json = (bytes: Buffer) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
const bundleSchema = z.object({
  version: z.literal(1), format: z.literal("artoo.quickjs-native-host.v1"), platform: z.literal("win32"), arch: z.literal("x64"),
  entry: z.literal("artoo-quickjs-process-host.exe"),
  files: z.array(z.object({ path: z.string().regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u),
    bytes: z.number().int().min(1).max(limits.fileBytes), sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  }).strict()).min(1).max(limits.files),
}).strict();
export { vendorSchema as ApplicationRuntimeVendorManifestSchema, bundleSchema as ApplicationRuntimeHelperManifestSchema };
/** Includes every actually published .NET dependency. SingleFile in a csproj
 * is not evidence that the measured native package consists of only its exe. */
export function loadApplicationRuntimeHelperManifest(helper: ApplicationRuntimeFilePin, manifest: ApplicationRuntimeFilePin): readonly ApplicationRuntimeFilePin[] {
  if (basename(manifest.path) !== "quickjs-native-manifest.json" || dirname(manifest.path) !== dirname(helper.path)
    || manifest.bytes > 4_194_304) throw Error("runtime-helper-manifest");
  const parsed = bundleSchema.parse(json(readApplicationRuntimePin(manifest))), root = dirname(manifest.path);
  const files = new Map<string, ApplicationRuntimeFilePin>(); let bytes = 0;
  for (const value of parsed.files) {
    if (value.path.split("/").some(part => part === "." || part === ".." || part.endsWith("."))) throw Error("runtime-helper-member");
    const path = join(root, ...value.path.split("/")), key = path.toLowerCase(); bytes += value.bytes;
    if (files.has(key) || key === manifest.path.toLowerCase() || bytes > limits.allFileBytes) throw Error("runtime-helper-member");
    const pin = Object.freeze({ path, bytes: value.bytes, sha256: value.sha256 }); readApplicationRuntimePin(pin); files.set(key, pin);
  }
  const actual = files.get(helper.path.toLowerCase());
  if (!actual || JSON.stringify(actual) !== JSON.stringify(helper) || basename(helper.path) !== parsed.entry) throw Error("runtime-helper-entry");
  let directoryCount = 0, fileCount = 0;
  const walk = (directory: string): void => {
    if (++directoryCount > 1024) throw Error("runtime-helper-inventory");
    const stat = lstatSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("runtime-helper-inventory");
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw Error("runtime-helper-inventory");
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (!entry.isFile() || ++fileCount > limits.files + 1 || path !== manifest.path && !files.has(path.toLowerCase())) throw Error("runtime-helper-inventory");
    }
  };
  walk(root); if (fileCount !== files.size + 1) throw Error("runtime-helper-inventory");
  return Object.freeze([Object.freeze({ ...manifest }), ...files.values()]);
}
export function loadApplicationRuntimeConfiguration(configuration: ApplicationRuntimeFilePin) {
  if (configuration.bytes > limits.nativeLineBytes) throw Error("runtime-configuration-limit");
  const config = ApplicationRuntimeConfigurationSchema.parse(json(readApplicationRuntimePin(configuration)));
  const all = new Map<string, ApplicationRuntimeFilePin>(), contents = new Map<string, Buffer>(); let total = 0;
  const add = (input: ApplicationRuntimeFilePin): Buffer => {
    const pin = Object.freeze(ApplicationRuntimeFilePinSchema.parse(input)), key = pin.path.toLowerCase(), existing = all.get(key);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(pin)) throw Error("runtime-pin-alias");
      return contents.get(key)!;
    }
    total += pin.bytes;
    if (all.size >= limits.files || total > limits.allFileBytes) throw Error("runtime-installation-limit");
    const bytes = readApplicationRuntimePin(pin); all.set(key, pin); contents.set(key, bytes); return bytes;
  };
  const vendor = vendorSchema.parse(json(add(config.vendorManifest))), vendorRoot = dirname(config.vendorManifest.path);
  const vendorPins = new Map<string, ApplicationRuntimeFilePin>();
  for (const value of vendor.files) {
    if (value.path.split("/").some(part => part === "." || part === ".." || part.endsWith("."))) throw Error("runtime-vendor-path");
    const path = join(vendorRoot, ...value.path.split("/")), local = relative(vendorRoot, path);
    if (local.startsWith(".." + sep) || local === ".." || vendorPins.has(value.path)) throw Error("runtime-vendor-path");
    const pin = { path, bytes: value.bytes, sha256: `sha256:${value.sha256}` }; add(pin); vendorPins.set(value.path, pin);
  }
  const capture: ApplicationArtifactCaptureInput = {
    source: config.source.map(value => ({ path: value.logicalPath, bytes: add(value.file) })),
    artifacts: config.artifacts.map(value => ({ path: value.logicalPath, bytes: add(value.file) })),
    toolchain: config.toolchain.map(value => ({ path: value.logicalPath, bytes: add(value.file) })),
  };
  return { config, capture, vendorRoot, vendorPins, runtimeFiles: Object.freeze([...all.values()]),
    readVendor: (name: string) => {
      const pin = vendorPins.get(name); if (!pin) throw Error("runtime-vendor-member"); return contents.get(pin.path.toLowerCase())!;
    } };
}
