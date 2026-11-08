import { basename, dirname, join } from "node:path";
import { readdirSync } from "node:fs";
import { z } from "zod";
import { readApplicationRuntimePin } from "./application-runtime-installation.js";
import { type ApplicationRuntimeFilePin } from "./application-runtime-process-protocol.js";
import { ApplicationCompilerConfigurationSchema } from "./application-compiler-process-protocol.js";
import { isWellFormedApplicationUtf8 } from "./application-build-primitives.js";

export const APPLICATION_COMPILER_TYPESCRIPT_SHA256 = "sha256:3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675";
export const APPLICATION_COMPILER_VENDOR_MEMBERS = Object.freeze(["core/dist/index.mjs", "core/dist/chunk-TAV5CUKK.mjs",
  "core/dist/chunk-V2S4ZYJR.mjs", "core/dist/module-ES6BEMUI.mjs", "release-sync/dist/index.mjs", "release-sync/dist/ffi.mjs",
  "release-sync/dist/emscripten-module.mjs", "release-sync/dist/emscripten-module.wasm", "ffi-types/dist/index.mjs"]);
const measured = z.object({ bytes: z.number().int().min(1).max(268435456), sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u) }).strict();
const packageSchema = z.object({ version: z.literal(1), format: z.literal("artoo.application-compiler-installation.v1"),
  qualified_for_product: z.literal(false), compiler_version: z.literal("5.9.3"),
  typescript: measured, guest: measured, libraries: measured }).strict();
const librariesSchema = z.array(z.object({ path: z.string().regex(/^lib\.[a-z0-9.]+\.d\.ts$/u),
  text: z.string().max(4 * 1024 * 1024) }).strict()).min(1).max(128);
const vendorSchema = z.object({ version: z.literal(1), format: z.literal("artoo.quickjs-runtime-vendor.v1"),
  version_name: z.literal("0.32.0"), variant: z.literal("wasmfile-release-sync"), qualified_for_product: z.literal(false),
  provenance: z.string().max(4096), files: z.array(z.object({ path: z.string().max(512),
    bytes: z.number().int().min(1).max(268435456), sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    url: z.string().max(4096), integrity: z.string().max(256) }).strict()).length(APPLICATION_COMPILER_VENDOR_MEMBERS.length) }).strict();
const json = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));

/** Fixed data/byte closure only. The caller separately owns protected installation
 * admission; neither this manifest nor its JSON creates process provenance. */
export function loadApplicationCompilerConfiguration(configuration: ApplicationRuntimeFilePin) {
  if (configuration.bytes > 65536) throw Error("compiler-configuration-bound");
  const config = ApplicationCompilerConfigurationSchema.parse(json(readApplicationRuntimePin(configuration)));
  if (basename(config.compilerManifest.path) !== "compiler-installation.json" || config.compilerManifest.bytes > 65536
    || config.vendorManifest.bytes > 4 * 1024 * 1024) throw Error("compiler-manifest-bound");
  const manifest = packageSchema.parse(json(readApplicationRuntimePin(config.compilerManifest)));
  const root = dirname(config.compilerManifest.path);
  const names = ["compiler-installation.json", "typescript.js", "application-compiler-guest.js", "application-compiler-libraries.json"];
  if (JSON.stringify(readdirSync(root).sort()) !== JSON.stringify([...names].sort())) throw Error("compiler-package-inventory");
  const typescript = Object.freeze({ path: join(root, names[1]!), ...manifest.typescript });
  const guest = Object.freeze({ path: join(root, names[2]!), ...manifest.guest });
  const librariesPin = Object.freeze({ path: join(root, names[3]!), ...manifest.libraries });
  if (typescript.sha256 !== APPLICATION_COMPILER_TYPESCRIPT_SHA256 || librariesPin.bytes > 100 * 1024 * 1024)
    throw Error("compiler-fixed-toolchain");
  readApplicationRuntimePin(typescript); readApplicationRuntimePin(guest);
  const libraries = librariesSchema.parse(json(readApplicationRuntimePin(librariesPin)));
  let libraryBytes = 0; const seen = new Set<string>();
  for (const file of libraries) {
    const bytes = Buffer.byteLength(file.text); libraryBytes += bytes;
    if (seen.has(file.path) || bytes > 4 * 1024 * 1024 || libraryBytes > 16 * 1024 * 1024 || !isWellFormedApplicationUtf8(file.text))
      throw Error("compiler-library-snapshot");
    seen.add(file.path); Object.freeze(file);
  }
  const vendor = vendorSchema.parse(json(readApplicationRuntimePin(config.vendorManifest)));
  if (JSON.stringify(vendor.files.map(file => file.path).sort()) !== JSON.stringify([...APPLICATION_COMPILER_VENDOR_MEMBERS].sort()))
    throw Error("compiler-vendor-members");
  const vendorPins = new Map<string, ApplicationRuntimeFilePin>();
  const files: ApplicationRuntimeFilePin[] = [config.compilerManifest, typescript, guest, librariesPin, config.vendorManifest];
  for (const file of vendor.files) {
    const pin = Object.freeze({ path: join(dirname(config.vendorManifest.path), ...file.path.split("/")), bytes: file.bytes, sha256: "sha256:" + file.sha256 });
    readApplicationRuntimePin(pin); vendorPins.set(file.path, pin); files.push(pin);
  }
  if (files.reduce((sum, file) => sum + file.bytes, 0) > 536870912) throw Error("compiler-toolchain-bound");
  return Object.freeze({ config, typescript, guest, librariesPin, vendorPins, files: Object.freeze(files.map(file => Object.freeze({ ...file }))),
    compilerInputs: Object.freeze({ compilerVersion: manifest.compiler_version, libraries: Object.freeze(libraries) }) });
}
