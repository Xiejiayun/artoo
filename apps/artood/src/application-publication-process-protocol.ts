import { createHash } from "node:crypto";
import { z } from "zod";
// The early bootstrap needs only this pure wire contract, never the domain barrel.
import { ApplicationPublicationServiceIdentityV1Schema } from "@artoo/domain/dist/application-publication.js";
import { APPLICATION_PUBLICATION_CONTROL_LIMITS, ApplicationPublicationControlSelectionSchema, ApplicationPublicationControlStatusSchema } from "./application-publication-control-protocol.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const path = z.string().min(1).max(4096);
// Host admission performs canonical physical Windows path checks. The wire
// schema must not reinterpret a Windows pin using the observer's OS.
const pin = z.object({ path, bytes: z.number().int().min(1).max(268_435_456), sha256: digest }).strict();
const count = z.number().int().min(0).max(256);
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,39})$/u);
export const APPLICATION_PUBLICATION_STATUS_LIMITS = Object.freeze({ lineBytes: 2_097_152, outputBytes: 4_194_304,
  events: 772 + 2 * APPLICATION_PUBLICATION_CONTROL_LIMITS.messages });
export const APPLICATION_PUBLICATION_IDENTITY_HEADER = "x-artoo-publication-identity";
export const APPLICATION_PUBLICATION_PROBE_HEADER = "x-artoo-publication-probe";
export const APPLICATION_PUBLICATION_DRAIN_TEXT = '{"version":1,"kind":"drain"}\n';

/** Protected selection data only. Original host admission is still required. */
export const ApplicationPublicationProbeBindingSchema = z.object({ version: z.literal(1),
  identity: ApplicationPublicationServiceIdentityV1Schema, challenge: z.string().uuid(),
  control: ApplicationPublicationControlSelectionSchema.optional(),
}).strict();
export type ApplicationPublicationProbeBinding = z.infer<typeof ApplicationPublicationProbeBindingSchema>;
export function applicationPublicationProbeHeaders(input: ApplicationPublicationProbeBinding) {
  const binding = ApplicationPublicationProbeBindingSchema.parse(input);
  return Object.freeze({
    [APPLICATION_PUBLICATION_IDENTITY_HEADER]: `sha256:${createHash("sha256").update(JSON.stringify(binding.identity)).digest("hex")}`,
    [APPLICATION_PUBLICATION_PROBE_HEADER]: binding.challenge,
  });
}
const common = { version: z.literal(1), node_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
  writable_workspace_roots: z.array(path).min(1).max(128), node: pin, host_manifest: pin,
  backend: z.object({ directory: path, manifest_sha256: digest }).strict(), system_root: path, shutdown: z.literal("stdin"),
};
export const ApplicationPublicationInitializeSelectionSchema = z.object({ ...common,
  format: z.literal("artoo.application-publication-initialize-selection.v1"), installation_parent: path, source_manifest: pin,
}).strict();
export const ApplicationPublicationServiceSelectionSchema = z.object({ ...common,
  format: z.literal("artoo.application-publication-service-selection.v1"), installation_reference: pin,
  publication: ApplicationPublicationProbeBindingSchema,
}).strict();
const member = z.object({ path, bytes: z.number().int().min(1).max(268_435_456), sha256: digest }).strict();
const bytes = member.omit({ path: true });
export const ApplicationPublicationRelocationSchema = z.object({ version: z.literal(1),
  format: z.literal("artoo.application-installation-relocation.v1"), scope: z.literal("fixed-configuration-plan-only"),
  source: z.object({ manifest: pin, directory: path, storage_directory: path, profile: pin, plan_digest: digest }).strict(),
  target: z.object({ generation_id: z.string().uuid(), directory: path, storage_directory: path, profile: pin, plan_digest: digest }).strict(),
  rewritten: z.array(z.object({ role: z.enum(["runtime", "broker-create", "broker-open", "service-profile"]), path,
    source: bytes, target: bytes }).strict()).length(4), retained: z.array(member).max(1024),
  preserved: z.object({ source_members_digest: digest, artifact_members_digest: digest, toolchain_members_digest: digest,
    runtime_expectation_digest: digest, schema_json_digest: digest, http_digest: digest, http_origin: z.string().max(64),
    maximum_access: z.enum(["read", "write"]), candidate_scope: z.object({ product_id: z.string(), data_generation: z.string(),
      service_generation: z.number().int().min(1), artifact_digest: digest }).strict() }).strict(),
}).strict();
export const ApplicationPublicationInstallationFactsSchema = z.object({ version: z.literal(1), generation_id: z.string().uuid(),
  reference: pin, database: z.object({ path, dev: decimal, ino: decimal }).strict(),
  scope: z.object({ product_id: z.string(), data_generation: z.string(), service_generation: z.number().int().min(1), artifact_digest: digest }).strict(),
  schema_digest: digest, origin: z.string().max(64), client_entry_digest: digest,
}).strict();
export const ApplicationPublicationCountersSchema = z.object({ observed_at: z.string().datetime(),
  requests_used: count, in_flight: z.number().int().min(0).max(1), closed_transports: count,
}).strict().refine(value => value.in_flight <= value.requests_used && value.closed_transports <= value.requests_used);
export type ApplicationPublicationCounters = z.infer<typeof ApplicationPublicationCountersSchema>;
const identity = ApplicationPublicationServiceIdentityV1Schema;
export const ApplicationPublicationInitializedStatusSchema = z.object({ version: z.literal(1),
  kind: z.literal("application-publication.initialized"), reference: pin,
  installation: ApplicationPublicationInstallationFactsSchema, provenance: ApplicationPublicationRelocationSchema,
  closure: z.object({ version: z.literal(1), scope: z.literal("original-native-owners"), create_broker_normal: z.literal(true),
    installation_audited: z.literal(true), session_released: z.literal(true) }).strict(),
}).strict();
export const ApplicationPublicationListeningStatusSchema = z.object({ version: z.literal(1),
  kind: z.literal("application-publication.listening"), identity,
  preflight: z.object({ existing_database: z.literal(true), process_exit_confirmed: z.literal(true) }).strict(),
  counters: ApplicationPublicationCountersSchema, maximum_requests: z.literal(256), maximum_concurrent: z.literal(1),
  control: ApplicationPublicationControlStatusSchema.optional(),
}).strict();
export const ApplicationPublicationProgressStatusSchema = z.object({ version: z.literal(1),
  kind: z.literal("application-publication.progress"), identity, counters: ApplicationPublicationCountersSchema,
}).strict();
export const ApplicationPublicationClosedStatusSchema = z.object({ version: z.literal(1),
  kind: z.literal("application-publication.closed"), identity, reason: z.literal("stdin-drain"),
  counters: ApplicationPublicationCountersSchema,
  closure: z.object({ version: z.literal(1), scope: z.literal("original-native-owners"), invocations: count,
    runtime_normal_closures: count, broker_normal_closures: count, listener_closed: z.literal(true),
    preflight_normal: z.literal(true), installation_audited: z.literal(true), session_released: z.literal(true),
  }).strict().refine(value => value.invocations === value.runtime_normal_closures && value.invocations === value.broker_normal_closures),
}).strict();
