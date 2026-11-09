import { z } from "zod";
import { ApplicationPublicationServiceIdentityV1Schema } from "@artoo/domain/dist/application-publication.js";

/** Fixed original-pipe control bounds; no command renews the root lease. */
export const APPLICATION_PUBLICATION_CONTROL_LIMITS = Object.freeze({ messages: 512, lineBytes: 4096, bytes: 2_097_152 });
/** One-use private request proof. It must never enter a response or product DTO. */
export const APPLICATION_PUBLICATION_CONTROL_PROBE_HEADER = "x-artoo-publication-control-probe";
export const ApplicationPublicationControlReadPathSchema = z.string().min(4).max(1024).refine(value => {
  if (!/^\/api(?:\/|\?|$)/u.test(value) || /[\\#\u0000-\u0020\u007f]/u.test(value)) return false;
  const parsed = new URL(value, "http://127.0.0.1:1234");
  return parsed.origin === "http://127.0.0.1:1234" && parsed.pathname + parsed.search === value;
}, "Expected the original bounded same-origin API read path");
export const ApplicationPublicationControlSelectionSchema = z.object({ version: z.literal(1),
  read_path: ApplicationPublicationControlReadPathSchema }).strict();
export type ApplicationPublicationControlSelection = z.infer<typeof ApplicationPublicationControlSelectionSchema>;
const count = z.number().int().min(0).max(256);
export const ApplicationPublicationControlCountersSchema = z.object({ observed_at: z.string().datetime(),
  requests_used: count, in_flight: z.number().int().min(0).max(1), closed_transports: count,
}).strict().refine(value => value.in_flight <= value.requests_used && value.closed_transports <= value.requests_used);
const command = { version: z.literal(1), identity: ApplicationPublicationServiceIdentityV1Schema,
  sequence: z.number().int().min(0).max(APPLICATION_PUBLICATION_CONTROL_LIMITS.messages - 1), cycle: count };
export const ApplicationPublicationControlCommandSchema = z.discriminatedUnion("kind", [
  z.object({ ...command, kind: z.literal("pause") }).strict(),
  z.object({ ...command, kind: z.literal("probe"), path: z.union([z.literal("/"), ApplicationPublicationControlReadPathSchema]),
    nonce: z.string().uuid() }).strict(),
  z.object({ ...command, kind: z.literal("resume") }).strict(),
  z.object({ ...command, kind: z.literal("drain") }).strict(),
]);
export type ApplicationPublicationControlCommand = z.infer<typeof ApplicationPublicationControlCommandSchema>;
export const ApplicationPublicationQuiescenceSchema = z.object({ counters: ApplicationPublicationControlCountersSchema,
  closure: z.object({ version: z.literal(1), scope: z.literal("original-native-owners"), invocations: count,
    runtime_normal_closures: count, broker_normal_closures: count }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.counters.in_flight !== 0 || value.counters.closed_transports !== value.counters.requests_used
    || value.closure.invocations > value.counters.requests_used
    || value.closure.invocations !== value.closure.runtime_normal_closures
    || value.closure.invocations !== value.closure.broker_normal_closures)
    ctx.addIssue({ code: "custom", message: "Quiescence requires every original transport, runtime and broker settlement" });
});
export type ApplicationPublicationQuiescence = z.infer<typeof ApplicationPublicationQuiescenceSchema>;
export const ApplicationPublicationControlStatusSchema = z.object({ version: z.literal(1), kind: z.literal("application-publication.control"),
  identity: ApplicationPublicationServiceIdentityV1Schema, sequence: z.number().int().min(-1).max(APPLICATION_PUBLICATION_CONTROL_LIMITS.messages - 1),
  cycle: count, state: z.enum(["quiesced", "probe-ready", "resumed"]),
  counters: ApplicationPublicationControlCountersSchema, closure: z.object({ version: z.literal(1), scope: z.literal("original-native-owners"),
    invocations: count, runtime_normal_closures: count, broker_normal_closures: count }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.sequence === -1 && (value.cycle !== 0 || value.state !== "quiesced"
    || value.counters.requests_used !== 0 || value.closure.invocations !== 0))
    ctx.addIssue({ code: "custom", message: "Only the original startup can report initial quiescence" });
  if (value.state !== "resumed" && !ApplicationPublicationQuiescenceSchema.safeParse({ counters: value.counters, closure: value.closure }).success)
    ctx.addIssue({ code: "custom", message: "Paused and armed control status requires original quiescence" });
});
export type ApplicationPublicationControlStatus = z.infer<typeof ApplicationPublicationControlStatusSchema>;

/** The authenticated parent and fixed host share one canonical encoding. This
 * also rejects duplicate keys, alternate escapes and extra data on raw input. */
export function encodeApplicationPublicationControlCommand(input: ApplicationPublicationControlCommand): string {
  const line = JSON.stringify(ApplicationPublicationControlCommandSchema.parse(input)) + "\n";
  if (Buffer.byteLength(line) > APPLICATION_PUBLICATION_CONTROL_LIMITS.lineBytes) throw Error("Publication control line exceeds its fixed bound");
  return line;
}
export function decodeApplicationPublicationControlCommand(line: string): ApplicationPublicationControlCommand {
  if (!line.endsWith("\n") || Buffer.byteLength(line) > APPLICATION_PUBLICATION_CONTROL_LIMITS.lineBytes)
    throw Error("Publication control requires one bounded complete line");
  const command = ApplicationPublicationControlCommandSchema.parse(JSON.parse(line));
  if (encodeApplicationPublicationControlCommand(command) !== line) throw Error("Publication control must retain its exact canonical encoding");
  return command;
}
