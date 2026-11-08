import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { createApplicationArtifactOwner, type ApplicationArtifactExpectation } from "./application-artifact-admission.js";
import { createApplicationQuickJsWasmBoundary } from "./application-quickjs-wasm-boundary.js";
import { createApplicationQuickJSSession, type ApplicationQuickJSContext, type ApplicationQuickJSModule,
  type ApplicationQuickJSRuntime, type ApplicationQuickJSSession } from "./application-quickjs-session.js";
import { createApplicationRuntimeChannel } from "./application-runtime-channel.js";
import { loadApplicationRuntimeConfiguration } from "./application-runtime-installation.js";
import type { OwnedApplicationRuntime } from "./application-runtime-stdio.js";

import type { ApplicationRuntimeFilePin } from "./application-runtime-process-protocol.js";

export async function createApplicationRuntime(configuration: ApplicationRuntimeFilePin, deadline: number): Promise<OwnedApplicationRuntime> {
  // This factory is invoked only after the actual stdin admission record. All
  // file/vendor/Wasm work consumes its remaining original deadline.
  const fixed = loadApplicationRuntimeConfiguration(configuration);
  const owner = createApplicationArtifactOwner(fixed.config.expectation as ApplicationArtifactExpectation);
  const captured = owner.capture(fixed.capture);
  let cleanupBoundary: ReturnType<typeof createApplicationQuickJsWasmBoundary> | undefined;
  let runtime: ApplicationQuickJSRuntime | undefined, context: ApplicationQuickJSContext | undefined;
  let session: ApplicationQuickJSSession | undefined, channel: ReturnType<typeof createApplicationRuntimeChannel> | undefined;
  let transferred = false;
  try {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 1) throw Error("runtime-deadline");
    const boundary = cleanupBoundary = createApplicationQuickJsWasmBoundary({ lifetimeMs: remaining });
    const names = ["core/dist/index.mjs", "core/dist/chunk-TAV5CUKK.mjs", "core/dist/chunk-V2S4ZYJR.mjs",
      "core/dist/module-ES6BEMUI.mjs", "release-sync/dist/index.mjs", "release-sync/dist/ffi.mjs",
      "release-sync/dist/emscripten-module.mjs", "ffi-types/dist/index.mjs"];
    const url = (name: string) => {
      const pin = fixed.vendorPins.get(name); if (!pin) throw Error("runtime-vendor-member"); return pathToFileURL(pin.path).href;
    };
    const allowed = new Set(names.map(url)), ffi = url("ffi-types/dist/index.mjs"), glue = url("release-sync/dist/emscripten-module.mjs");
    registerHooks({ resolve(specifier, resolution, next) {
      if (specifier === "@jitl/quickjs-ffi-types" && allowed.has(resolution.parentURL!)) return { url: ffi, shortCircuit: true };
      if (specifier === "@jitl/quickjs-wasmfile-release-sync/emscripten-module"
        && resolution.parentURL === url("release-sync/dist/index.mjs")) return { url: glue, shortCircuit: true };
      if (["node:module", "node:fs", "node:path", "node:url"].includes(specifier) && resolution.parentURL === glue) return next(specifier, resolution);
      const resolved = new URL(specifier, resolution.parentURL ?? import.meta.url).href;
      if (!allowed.has(resolved)) throw Error("runtime-vendor-import"); return { url: resolved, shortCircuit: true };
    } });
    // The guard is installed before either dynamic import. Product text is never
    // part of this URL set and can only reach the real QuickJS module loader.
    const core = await import(url("core/dist/index.mjs")) as {
      newQuickJSWASMModuleFromVariant(variant: unknown): Promise<ApplicationQuickJSModule>;
    };
    const base = (await import(url("release-sync/dist/index.mjs"))).default as {
      importModuleLoader(): Promise<(options: unknown) => unknown>;
    };
    const wasm = Uint8Array.from(fixed.readVendor("release-sync/dist/emscripten-module.wasm"));
    const variant = { ...base, async importModuleLoader() {
      const original = await base.importModuleLoader();
      return () => {
        const options = { ...boundary.moduleOptions, arguments: [], wasmBinary: wasm,
          locateFile() { throw Error("runtime-artifact-fallback"); },
          instantiateWasm(imports: unknown, receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void) {
            const compiled = new WebAssembly.Module(wasm);
            const instance = new WebAssembly.Instance(compiled, boundary.wrapImports(imports, options));
            receive(instance, compiled); return instance.exports;
          } };
        return original(options);
      };
    } };
    const module = await core.newQuickJSWASMModuleFromVariant(variant);
    session = createApplicationQuickJSSession({ module, artifactOwner: owner, captured, deadline, boundary: {
      onRuntime(value) { runtime = value; boundary.onRuntime(value); },
      onContext(value) { context = value; boundary.onContext(value); },
      boundedReadString: boundary.boundedReadString.bind(boundary),
    } });
    channel = createApplicationRuntimeChannel(session);
    const result: OwnedApplicationRuntime = Object.freeze({ channel,
      assertDisposed() { if (!runtime || !context || runtime.alive !== false || context.alive !== false) throw Error("runtime-original-disposal"); },
      release() { owner.revoke(captured); boundary.close(); },
    });
    transferred = true; return result;
  } finally {
    if (!transferred) {
      try { if (channel) channel.close(); else session?.close(); }
      finally { owner.revoke(captured); cleanupBoundary?.close(); }
    }
  }
}
