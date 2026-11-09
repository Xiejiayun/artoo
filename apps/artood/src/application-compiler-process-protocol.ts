import { z } from "zod";
import { APPLICATION_COMPILER_LIMITS } from "./application-compiler-contract.js";
import { APPLICATION_RUNTIME_PROCESS_LIMITS, ApplicationRuntimeFilePinSchema,
  ApplicationRuntimeNativeOutputSchema } from "./application-runtime-process-protocol.js";

export const APPLICATION_COMPILER_PROCESS_PROTOCOL = "artoo.application-compiler-process.v1" as const;
/** Fixed compiler transport policy; no request/configuration can change it.
 * Resource ceilings remain the existing native owner's ceilings. */
export const APPLICATION_COMPILER_PROCESS_LIMITS = Object.freeze({ ...APPLICATION_RUNTIME_PROCESS_LIMITS,
  requestBytes: APPLICATION_COMPILER_LIMITS.inputBytes, responseBytes: APPLICATION_COMPILER_LIMITS.outputBytes,
  childInputBytes: APPLICATION_COMPILER_LIMITS.inputBytes + 256,
  childOutputBytes: APPLICATION_COMPILER_LIMITS.outputBytes, helperOutputBytes: 144 * 1024 * 1024,
  nativeWrites: 4096,
});
// Both fixed native modes emit the same ownership/control envelope, not the
// runtime's application ready/output/closed child protocol.
export const ApplicationCompilerNativeOutputSchema = ApplicationRuntimeNativeOutputSchema;
export const ApplicationCompilerAdmissionSchema = z.object({ version: z.literal(1), kind: z.literal("admit"),
  protocol: z.literal(APPLICATION_COMPILER_PROCESS_PROTOCOL),
  remainingMs: z.number().int().min(1).max(APPLICATION_COMPILER_PROCESS_LIMITS.lifetimeMs) }).strict();
export const ApplicationCompilerConfigurationSchema = z.object({ version: z.literal(1),
  protocol: z.literal(APPLICATION_COMPILER_PROCESS_PROTOCOL),
  vendorManifest: ApplicationRuntimeFilePinSchema, compilerManifest: ApplicationRuntimeFilePinSchema }).strict();
