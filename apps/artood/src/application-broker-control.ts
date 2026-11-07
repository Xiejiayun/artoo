import { z } from "zod";
import { isAbsolute } from "node:path";
import { ApplicationDataBroker } from "./application-data-broker.js";
import { APPLICATION_DATA_LIMITS, ApplicationDataError, ApplicationDataScopeSchema, type ApplicationDataRequest } from "./application-data-contract.js";
import { ApplicationInvocationBridge, type ApplicationInvocationHandle, type ApplicationInvocationEvent } from "./application-invocation-bridge.js";
import { APPLICATION_WIRE_LIMITS, ApplicationWireDecoder } from "./application-wire-v1.js";

export const APPLICATION_BROKER_LIMITS = Object.freeze({
  lineBytes: 1_500_000, totalInputBytes: 8_388_608, totalOutputBytes: 8_388_608,
  commands: 1_024, nativeChunkBytes: 16_384, nativeChunks: 2_048,
});
export const ApplicationBrokerConfigurationSchema = z.object({
  version: z.literal(1), protocol: z.literal("artoo.application-broker.v1"),
  databasePath: z.string().min(1).max(4096).refine(value => isAbsolute(value) && !value.includes("\0")),
  mode: z.enum(["create", "open"]), schemaJson: z.string().max(32_768),
  scope: ApplicationDataScopeSchema, maximumAccess: z.enum(["read", "write"]),
}).strict();
export type ApplicationBrokerConfiguration = z.infer<typeof ApplicationBrokerConfigurationSchema>;
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const envelope = { version: z.literal(1), sequence: z.number().int().min(0).max(APPLICATION_BROKER_LIMITS.commands - 1) };
const CommandSchema = z.discriminatedUnion("kind", [
  z.object({ ...envelope, kind: z.literal("begin"), invocation: id, requestJson: z.string().max(1_048_576),
    purpose: z.enum(["application", "health", "peer"]), access: z.enum(["read", "write"]), lifetimeMs: z.number().int().min(1).max(30_000) }).strict(),
  z.object({ ...envelope, kind: z.literal("receive"), data: z.string().min(4).max(87_384) }).strict(),
  z.object({ ...envelope, kind: z.literal("cancel"), invocation: id }).strict(),
  z.object({ ...envelope, kind: z.literal("poll") }).strict(),
  z.object({ ...envelope, kind: z.literal("shutdown") }).strict(),
]);
export type ApplicationBrokerCommand = z.infer<typeof CommandSchema>;
export type ApplicationBrokerAction = ApplicationBrokerCommand extends infer T
  ? T extends ApplicationBrokerCommand ? Omit<T, "version" | "sequence"> : never : never;
export interface ApplicationBrokerReply {
  readonly version: 1; readonly sequence: number; readonly kind: "result";
  readonly frames: readonly string[];
  readonly responses: readonly { readonly invocation: string; readonly response: unknown }[];
  readonly terminated: readonly { readonly invocation: string; readonly reason: string }[];
  readonly stopped: boolean;
}
export const BROKER_FAILURE = "Application broker control rejected";
function reject(): never { throw Error(BROKER_FAILURE); }
export function parseApplicationBrokerCommand(value: unknown): ApplicationBrokerCommand {
  const parsed = CommandSchema.safeParse(value); if (!parsed.success) return reject(); return parsed.data;
}
export function decodeBrokerBytes(text: string, maximum = 65_536): Buffer {
  if (typeof text !== "string" || text.length > Math.ceil(maximum / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(text)) return reject();
  const bytes = Buffer.from(text, "base64");
  if (bytes.length < 1 || bytes.length > maximum || bytes.toString("base64") !== text) return reject();
  return bytes;
}

/** Host-only control core. Its constructor and accept() must stay off application pipes. */
export class ApplicationBrokerControl {
  private readonly broker: ApplicationDataBroker;
  private readonly bridge: ApplicationInvocationBridge;
  private readonly handles = new Map<string, ApplicationInvocationHandle>();
  private readonly identities = new WeakMap<ApplicationInvocationHandle, string>();
  private readonly used = new Set<string>();
  private readonly preview = new ApplicationWireDecoder("application-to-host");
  // The actual fixed ready line is smaller. Reserving 512 also covers its newline.
  private outputBytes = 512;
  private sequence = 0;
  private closed = false;
  constructor(configuration: ApplicationBrokerConfiguration) {
    const config = ApplicationBrokerConfigurationSchema.parse(configuration);
    this.broker = new ApplicationDataBroker(config);
    try { this.bridge = new ApplicationInvocationBridge(this.broker, config.scope, config.maximumAccess); }
    catch (error) { this.broker.close(); throw error; }
  }
  accept(value: unknown): ApplicationBrokerReply {
    if (this.closed) return reject();
    try {
      const command = parseApplicationBrokerCommand(value);
      if (command.sequence !== this.sequence++) return reject();
      const input = command.kind === "receive" ? decodeBrokerBytes(command.data) : undefined;
      const maximum = this.maximumReply(command, input);
      if (maximum > APPLICATION_BROKER_LIMITS.lineBytes || this.outputBytes + maximum > APPLICATION_BROKER_LIMITS.totalOutputBytes) return reject();
      const frames: string[] = [], responses: ApplicationBrokerReply["responses"][number][] = [],
        terminated: ApplicationBrokerReply["terminated"][number][] = [];
      const collect = (events: readonly ApplicationInvocationEvent[]) => {
        for (const event of events) {
          if (event.kind === "send") frames.push(event.frame.toString("base64"));
          else {
            const invocation = this.identities.get(event.invocation); if (!invocation || !this.handles.has(invocation)) return reject();
            this.handles.delete(invocation);
            if (event.kind === "response") responses.push({ invocation, response: event.response });
            else terminated.push({ invocation, reason: event.reason });
          }
        }
      };
      if (command.kind === "begin") {
        if (this.used.has(command.invocation)) return reject();
        const begun = this.bridge.begin(command.requestJson, { purpose: command.purpose, access: command.access, lifetime_ms: command.lifetimeMs });
        this.used.add(command.invocation); this.handles.set(command.invocation, begun.invocation);
        this.identities.set(begun.invocation, command.invocation); frames.push(begun.frame.toString("base64"));
      } else if (command.kind === "receive") collect(this.bridge.receive(input!));
      else if (command.kind === "cancel") {
        const handle = this.handles.get(command.invocation); if (!handle) return reject(); collect(this.bridge.cancel(handle));
      } else if (command.kind === "poll") collect(this.bridge.poll());
      else {
        frames.push(this.bridge.close().toString("base64")); this.closed = true; this.broker.close(); this.handles.clear();
      }
      const reply = Object.freeze({ version: 1 as const, sequence: command.sequence, kind: "result" as const, frames, responses, terminated, stopped: this.closed });
      const actual = Buffer.byteLength(JSON.stringify(reply), "utf8") + 1;
      if (actual > maximum) return reject(); // A violated bound never reports rollback or successful delivery.
      this.outputBytes += actual;
      return reply;
    } catch (error) { this.dispose(); throw error; }
  }
  dispose(): void {
    if (this.closed) return; this.closed = true;
    try { this.bridge.close(); } finally { this.handles.clear(); this.broker.close(); }
  }
  private maximumReply(command: ApplicationBrokerCommand, input: Buffer | undefined): number {
    const framedBase64 = (bytes: number) => 4 * Math.ceil((bytes + 4) / 3) + 3; // wire header, base64, quotes/comma
    if (command.kind === "begin") return 512 + framedBase64(APPLICATION_WIRE_LIMITS.frameBytes);
    if (command.kind === "poll") return 8192; // at most eight cancel frames and host IDs
    if (command.kind === "cancel") return 2048;
    if (command.kind === "shutdown") return 1024;
    let maximum = 512; // fixed result envelope, sequence and array punctuation
    // The preview has its own persistent bounded framing/sequence state. It admits
    // the whole batch before the real bridge can grant its first data operation.
    for (const message of this.preview.push(input!)) {
      if (message.kind === "response") { maximum += APPLICATION_WIRE_LIMITS.bodyBytes + 1024; continue; }
      if (message.kind !== "data-call") return reject();
      let replyBytes: number = APPLICATION_DATA_LIMITS.replyBytes;
      try {
        this.broker.describeRequest(message.request_json); // schema validation only, no permit or SQL execution
        const request = JSON.parse(message.request_json) as ApplicationDataRequest;
        if (request.kind === "transaction" && request.operations.every(operation => operation.kind !== "query")) {
          // Full reply + scope metadata fits 1024 bytes. Each mutation result has
          // fixed keys/kind, an ASCII ID <=128 and a safe integer revision: <=256.
          // Replay has the same request shape; conflict is smaller.
          replyBytes = Math.min(replyBytes, 1024 + 256 * request.operations.length);
        }
      } catch (error) {
        if (!(error instanceof ApplicationDataError) || !["invalid-request", "limit"].includes(error.code)) throw error;
        maximum += 2048; continue; // the bridge's fixed data-error frame
      }
      // The broker caps the complete JSON reply before COMMIT. JSON-quoting that
      // valid JSON string expands its UTF-8 bytes by at most 2x; 1024 covers the
      // wire envelope and both <=128-byte ASCII correlation IDs.
      maximum += framedBase64(2 * replyBytes + 1024);
    }
    return maximum;
  }
}
