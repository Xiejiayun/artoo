import { createHash } from "node:crypto";
import { posix } from "node:path";
import ts from "typescript";
import { createApplicationBuildKernel, type ApplicationBuildPlatform, type ApplicationBuildDraft,
  type ApplicationBuildRejection } from "./application-build-kernel.js";
export { APPLICATION_BUILD_EXECUTION_STATUS } from "./application-build-kernel.js";
export type { ApplicationBuildTextFile, ApplicationBuildFilePin, ApplicationBuildDiagnostic,
  ApplicationBuildManifest, ApplicationBuildDraft, ApplicationBuildRejection } from "./application-build-kernel.js";
/** Fail closed if TypeScript falls back to its own sys object. The operation is synchronous;
 * no application callback, async continuation or compiler plugin runs while the guard is held. */
let compilerInUse = false;
function guardCompilerSystemCalls<T>(operation: () => T, reject: Parameters<ApplicationBuildPlatform["guardCompilerSystemCalls"]>[1]): T {
  if (compilerInUse) reject("host-fallback", "compiler");
  if (Object.hasOwn(process.env, "NODE_OPTIONS") || Object.hasOwn(process.env, "NODE_PATH")) reject("ambient-runtime", "compiler");
  compilerInUse = true;
  const changed: [string, PropertyDescriptor][] = [];
  try {
    if (Object.getPrototypeOf(ts.sys) !== Object.prototype && Object.getPrototypeOf(ts.sys) !== null) reject("host-fallback", "compiler");
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(ts.sys))) {
      if (descriptor.get || descriptor.set) reject("host-fallback", "compiler");
      if (typeof descriptor.value !== "function") continue;
      Object.defineProperty(ts.sys, key, { ...descriptor, value: () => reject("host-fallback", "compiler") });
      changed.push([key, descriptor]);
    }
    return operation();
  } finally {
    try { for (const [key, descriptor] of changed.reverse()) Object.defineProperty(ts.sys, key, descriptor); }
    finally { compilerInUse = false; }
  }
}
// This fixed local adapter is not input data and cannot be selected by a remote request.
const kernel = createApplicationBuildKernel(ts, Object.freeze({
  utf8ByteLength: (text: string) => Buffer.byteLength(text, "utf8"),
  isWellFormedUtf8: (text: string) => Buffer.from(text, "utf8").toString("utf8") === text,
  sha256: (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`,
  dirname: posix.dirname, resolvePath: posix.resolve, guardCompilerSystemCalls,
}));

export function compileApplicationDraft(input: unknown): ApplicationBuildDraft | ApplicationBuildRejection {
  return kernel.compileApplicationDraft(input);
}
export function assertApplicationBuildOutput(draft: ApplicationBuildDraft, currentSource: unknown, currentOutputs: unknown): void {
  kernel.assertApplicationBuildOutput(draft, currentSource, currentOutputs);
}
