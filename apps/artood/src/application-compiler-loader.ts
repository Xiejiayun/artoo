import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { loadApplicationCompilerConfiguration, APPLICATION_COMPILER_VENDOR_MEMBERS } from "./application-compiler-installation.js";
import { readApplicationRuntimePin } from "./application-runtime-installation.js";
import { createApplicationCompilerWasmBoundary } from "./application-quickjs-wasm-boundary.js";
import { createApplicationCompilerSession, type ApplicationCompilerSession } from "./application-compiler-session.js";
import type { ApplicationQuickJSModule } from "./application-quickjs-session.js";
import type { ApplicationRuntimeFilePin } from "./application-runtime-process-protocol.js";
import type { OwnedApplicationCompiler } from "./application-compiler-process-stdio.js";
let used = false;
/** Invoked after original native admission only. All disk/import/Wasm/session
 * work consumes that original deadline; only fixed pinned vendor URLs load. */
export async function createApplicationCompiler(configuration: ApplicationRuntimeFilePin, deadline: number): Promise<OwnedApplicationCompiler> {
  if (used) throw Error("compiler-loader-used"); used = true;
  const fixed = loadApplicationCompilerConfiguration(configuration);
  let boundary: ReturnType<typeof createApplicationCompilerWasmBoundary> | undefined;
  let hooks: ReturnType<typeof registerHooks> | undefined, session: ApplicationCompilerSession | undefined;
  let transferred = false, released = false;
  const release = () => {
    if (released) return; released = true;
    try { session?.close(); } finally { try { boundary?.close(); } finally { hooks?.deregister(); } }
  };
  try {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 1 || remaining > 30_000) throw Error("compiler-loader-deadline");
    boundary = createApplicationCompilerWasmBoundary({ lifetimeMs: remaining });
    const guarded = boundary;
    const url = (name: string) => {
      const pin = fixed.vendorPins.get(name); if (!pin) throw Error("compiler-vendor-member"); return pathToFileURL(pin.path).href;
    };
    const allowed = new Map(APPLICATION_COMPILER_VENDOR_MEMBERS.filter(name => name.endsWith(".mjs"))
      .map(name => [url(name), fixed.vendorPins.get(name)!]));
    const ffi = url("ffi-types/dist/index.mjs"), glue = url("release-sync/dist/emscripten-module.mjs");
    hooks = registerHooks({ resolve(specifier, resolution, next) {
      if (specifier === "@jitl/quickjs-ffi-types" && allowed.has(resolution.parentURL!)) return { url: ffi, shortCircuit: true };
      if (specifier === "@jitl/quickjs-wasmfile-release-sync/emscripten-module"
        && resolution.parentURL === url("release-sync/dist/index.mjs")) return { url: glue, shortCircuit: true };
      if (["node:module", "node:fs", "node:path", "node:url"].includes(specifier) && resolution.parentURL === glue) return next(specifier, resolution);
      const resolved = new URL(specifier, resolution.parentURL ?? import.meta.url).href;
      if (!allowed.has(resolved)) throw Error("compiler-vendor-import"); return { url: resolved, shortCircuit: true };
    }, load(address, context, next) {
      const pin = allowed.get(address);
      if (pin) return { format: "module", source: readApplicationRuntimePin(pin), shortCircuit: true };
      if (["node:module", "node:fs", "node:path", "node:url"].includes(address)) return next(address, context);
      throw Error("compiler-vendor-load");
    } });
    const core = await import(url("core/dist/index.mjs")) as {
      newQuickJSWASMModuleFromVariant(variant: unknown): Promise<ApplicationQuickJSModule>;
    };
    const base = (await import(url("release-sync/dist/index.mjs"))).default as {
      importModuleLoader(): Promise<(options: unknown) => unknown>;
    };
    const wasm = Uint8Array.from(readApplicationRuntimePin(fixed.vendorPins.get("release-sync/dist/emscripten-module.wasm")!));
    const variant = { ...base, async importModuleLoader() {
      const original = await base.importModuleLoader();
      return () => {
        const options = { ...guarded.moduleOptions, arguments: [], wasmBinary: wasm,
          locateFile() { throw Error("compiler-artifact-fallback"); },
          instantiateWasm(imports: unknown, receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) {
            const compiled = new WebAssembly.Module(wasm);
            const instance = new WebAssembly.Instance(compiled, guarded.wrapImports(imports, options));
            receive(instance, compiled); return instance.exports;
          } };
        return original(options);
      };
    } };
    const module = await core.newQuickJSWASMModuleFromVariant(variant);
    const decode = (pin: ApplicationRuntimeFilePin) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readApplicationRuntimePin(pin));
    session = createApplicationCompilerSession({ module, boundary: guarded, typescript: decode(fixed.typescript), guest: decode(fixed.guest), deadline });
    const owned = session;
    transferred = true;
    return Object.freeze({ compile: owned.compile, assertDisposed: owned.assertDisposed, release });
  } finally { if (!transferred) release(); }
}
