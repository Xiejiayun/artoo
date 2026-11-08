import { z } from "zod";
import { isAbsolute } from "node:path";

export const APPLICATION_RUNTIME_PROTOCOL = "artoo.application-runtime.v1" as const;
export const APPLICATION_RUNTIME_PROCESS_LIMITS = Object.freeze({
  lifetimeMs: 30_000, cleanupMs: 5_000, processCommitBytes: 1_610_612_736,
  nativeLineBytes: 65_536, nativeChunkBytes: 16_384, nativeWrites: 2_048,
  childLineBytes: 90_000, childChunkBytes: 65_536, childInputBytes: 8_388_608,
  childOutputBytes: 16_777_216, helperOutputBytes: 25_165_824, stderrBytes: 16_384,
  queuedOutputBytes: 1_048_576, inputCommands: 4_096, files: 1_024, fileBytes: 268_435_456,
  allFileBytes: 536_870_912,
});
const limits = APPLICATION_RUNTIME_PROCESS_LIMITS;
export const ApplicationRuntimeFilePinSchema = z.object({
  path: z.string().min(1).max(32760).refine(value => isAbsolute(value) && !value.includes("\0")),
  bytes: z.number().int().min(1).max(limits.fileBytes), sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
}).strict();
export type ApplicationRuntimeFilePin = z.infer<typeof ApplicationRuntimeFilePinSchema>;
const member = z.object({ logicalPath: z.string().min(1).max(4096), file: ApplicationRuntimeFilePinSchema }).strict();
/** Fixed local data only. The existing artifact owner validates the complete
 * content expectation before any product text can reach the interpreter. */
export const ApplicationRuntimeConfigurationSchema = z.object({
  version: z.literal(1), protocol: z.literal(APPLICATION_RUNTIME_PROTOCOL),
  vendorManifest: ApplicationRuntimeFilePinSchema,
  expectation: z.unknown(),
  source: z.array(member).min(2).max(256), artifacts: z.array(member).min(2).max(256),
  toolchain: z.array(member).min(1).max(1024),
}).strict();
export type ApplicationRuntimeConfiguration = z.infer<typeof ApplicationRuntimeConfigurationSchema>;
export const ApplicationRuntimeAdmissionSchema = z.object({
  version: z.literal(1), kind: z.literal("admit"), protocol: z.literal(APPLICATION_RUNTIME_PROTOCOL),
  remainingMs: z.number().int().min(1).max(limits.lifetimeMs),
}).strict();
const childEnvelope = { version: z.literal(1), sequence: z.number().int().min(0).max(limits.inputCommands - 1) };
export const ApplicationRuntimeInputSchema = z.discriminatedUnion("kind", [
  z.object({ ...childEnvelope, kind: z.literal("receive"), data: z.string().min(4).max(87384) }).strict(),
  z.object({ ...childEnvelope, kind: z.literal("close") }).strict(),
]);
export const ApplicationRuntimeOutputSchema = z.discriminatedUnion("kind", [
  z.object({ ...childEnvelope, kind: z.literal("ready"), payload: z.object({
    protocol: z.literal(APPLICATION_RUNTIME_PROTOCOL), qualifiedForProduct: z.literal(false),
  }).strict() }).strict(),
  z.object({ ...childEnvelope, kind: z.literal("output"), payload: z.object({
    data: z.string().min(4).max(87384),
  }).strict() }).strict(),
  z.object({ ...childEnvelope, kind: z.literal("closed"), payload: z.object({
    guestDisposed: z.literal(true), inputEnded: z.literal(true), discardedOutputBytes: z.literal(0),
    qualifiedForProduct: z.literal(false),
  }).strict() }).strict(),
]);
const nativeEnvelope = { version: z.literal(1), sequence: z.number().int().nonnegative() };
export const ApplicationRuntimeTerminalSchema = z.object({
  pid: z.number().int().positive().nullable(), originalExitObserved: z.boolean(), exitCode: z.number().int().nonnegative().nullable(),
  jobAssigned: z.boolean(), jobLimitsReadBack: z.boolean(), jobEmptyObserved: z.boolean(),
  inputSettled: z.boolean(), inputClosed: z.boolean(), stdoutEof: z.boolean(), stderrEof: z.boolean(),
  outputTasksSettled: z.boolean(), terminationRequested: z.boolean(), terminationSucceeded: z.boolean(),
  inputsUnchanged: z.boolean(), failure: z.string().max(128).nullable(),
}).strict();
export const ApplicationRuntimeNativeOutputSchema = z.discriminatedUnion("kind", [
  z.object({ ...nativeEnvelope, kind: z.literal("started"), payload: z.object({
    pid: z.number().int().positive(), creationTime: z.string().regex(/^\d{1,20}$/u), image: z.string().min(1).max(32760),
    jobAssigned: z.literal(true), jobLimitsReadBack: z.literal(true),
    processCommitLimitBytes: z.literal(limits.processCommitBytes), activeProcessLimit: z.literal(1),
  }).strict() }).strict(),
  z.object({ ...nativeEnvelope, kind: z.literal("admitted"), payload: z.object({
    bytes: z.number().int().min(1).max(256), remainingMs: z.number().int().min(1).max(limits.lifetimeMs),
  }).strict() }).strict(),
  z.object({ ...nativeEnvelope, kind: z.literal("input-written"), payload: z.object({
    nonce: z.string().uuid(), bytes: z.number().int().min(1).max(limits.nativeChunkBytes),
  }).strict() }).strict(),
  z.object({ ...nativeEnvelope, kind: z.literal("input-closed"), payload: z.object({ nonce: z.string().uuid() }).strict() }).strict(),
  z.object({ ...nativeEnvelope, kind: z.literal("output"), payload: z.object({
    stream: z.enum(["stdout", "stderr"]), data: z.string().min(4).max(10924),
  }).strict() }).strict(),
  z.object({ ...nativeEnvelope, kind: z.literal("terminal"), payload: ApplicationRuntimeTerminalSchema }).strict(),
]);
export function decodeApplicationRuntimeBytes(value: string, maximum: number): Buffer {
  if (value.length > 4 * Math.ceil(maximum / 3)
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) throw Error("runtime-base64");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length < 1 || bytes.length > maximum || bytes.toString("base64") !== value) throw Error("runtime-base64");
  return bytes;
}
