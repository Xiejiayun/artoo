import type { PreparedGoalEntryConfigV1 } from "./config/goal-entry.js";
import type { AuditSignerV1 } from "./audit-signature.js";
import type { AiDataSharingPolicy } from "./config/ai-data-sharing.js";
import type { SourceLifecycleRegistry } from "./services/source-clean-lifecycle-service.js";
import type {
  Clock,
  IdGen,
  VerificationCapabilities,
  ReleaseCapabilitiesV1,
  NodeOwnedResultProfileDescriptorV1,
  ProductSourceRoutingV1,
} from "@artoo/domain";
import type { ApplicationPublicationCapabilitiesV1 } from "@artoo/domain";
import type { ContentAddressedBlobStore, DbClient } from "@artoo/storage";

import type { AuthConfig } from "./auth/auth-config.js";
import type { OidcHttp } from "./auth/oidc-client.js";
import type { DeviceAuthConfig } from "./config/device-auth.js";

/** Server-local maintenance routing; never an execution command or caller-supplied receipt. */
export type ImportedSourceReceiptFamily =
  | "design"
  | "design-review"
  | "execution"
  | "execution-review"
  | "execution-repair"
  | "validation"
  | "validation-review";

/**
 * Per-request-independent server dependencies. Single org/tenant for v0.1, so
 * the organization and the acting user are pinned here (bootstrap seeds them).
 * Clock and IdGen are injected (Gate 0) so flows are deterministic under test.
 */
export interface ServerContext {
  /** Startup-only signing capability; no private key or request-selected identity. */
  auditSigner?: AuditSignerV1;
  /** Process-local original-parent observers; never reconstructed from DB JSON. */
  sourceLifecycle?: Pick<SourceLifecycleRegistry, "registerDaemon" | "checkpoint">;
  db: DbClient;
  /** Immutable local startup configuration; never accepted from an API request. */
  goalEntry?: PreparedGoalEntryConfigV1;
  /** Explicit operator declaration; absent configuration cannot authorize AI. */
  aiDataSharingPolicy?: AiDataSharingPolicy | null;
  clock: Clock;
  idGen: IdGen;
  organizationId: string;
  /** The acting user for v0.1 (no auth yet); used as created_by / actor. */
  actorUserId: string;
  /** Internal automation attribution; never populated from an HTTP request. */
  automationActor?: { type: "system"; id: "goal_runner" };
  /** Device-auth secrets/policy (#28): pairing pepper + dev node-token escape. */
  deviceAuth: DeviceAuthConfig;
  /** Google-auth wiring (#34): OIDC provider coords, cookies, session policy. */
  authConfig: AuthConfig;
  /** OIDC transport (#34): token exchange + JWKS. fetch in prod; fake in tests. */
  oidcHttp: OidcHttp;
  /**
   * Optional hook fired (after commit) when a run is queued by assignment, so a
   * node binding can dispatch run.start over the node transport. Absent in pure
   * REST tests (the dev mock-execute path drives ingestion directly instead).
   */
  onRunQueued?: (runId: string) => Promise<void>;
  /** Query an exact execution contract on the current accepted node session. */
  supportsExecutionFeature?: (computerId: string, feature: string) => boolean;
  /** Exact public verifier binding from the current authenticated node session. */
  supportsVerificationProfile?: (
    computerId: string,
    profileId: string,
    projectId: string,
    workspaceRoot: string,
  ) => boolean;
  /** Resolve a lexical location to one current node-advertised root; never proves physical alias equivalence. */
  getVerificationWorkspace?: (
    computerId: string,
    profileId: string,
    projectId: string,
    workspaceRoot: string,
  ) => string | undefined;
  /** Exact descriptor from a current fully qualified managed receipt session. */
  getOwnedResultProfile?: (
    computerId: string,
    resultProfileId: string,
    verifierTemplateId: string,
    projectId: string,
  ) => NodeOwnedResultProfileDescriptorV1 | undefined;
  /** One defensive snapshot from the current authenticated connection, never caller metadata. */
  getVerificationCapabilities?: (
    computerId: string,
    profileId: string,
    projectId: string,
    workspaceRoot: string,
  ) => VerificationCapabilities | undefined;
  supportsReleaseProfile?: (
    computerId: string,
    profileId: string,
    projectId: string,
    workspaceRoot: string,
    verificationProfileId: string,
  ) => boolean;
  /** Exact configured publication scope from the current authenticated node, never an agent declaration. */
  getReleaseCapabilities?: (
    computerId: string,
    profileId: string,
    projectId: string,
    workspaceRoot: string,
    verificationProfileId: string,
  ) => ReleaseCapabilitiesV1 | undefined;
  onProductReleaseQueued?: (releaseId: string) => Promise<void>;
  onProductReleaseCancel?: (releaseId: string) => Promise<void>;
  getApplicationPublicationCapabilities?: (
    computerId: string,
    profileId: string,
    projectId: string,
  ) => ApplicationPublicationCapabilitiesV1 | undefined;
  onApplicationPublicationQueued?: (publicationId: string, control: "start" | "stop" | "status") => Promise<void>;
  /** Dedicated imported-subject controller; never routes through ordinary run.start. */
  onImportedProductReviewQueued?: (reviewId: string, control: "start" | "stop" | "status") => Promise<void>;
  onProductSourceOperationQueued?: (
    operationId: string,
    control: "start" | "stop" | "status" | "qualify",
  ) => Promise<void>;
  /** Private durable bytes configured at startup, never supplied by a task or frame. */
  artifactStore?: ContentAddressedBlobStore;
  /** Compatibility for local development callers; artifactStore takes precedence. */
  productSourceArtifactDir?: string;
  onImportedDesignContinuationQueued?: (continuationId: string, control: "start" | "stop" | "status") => Promise<void>;
  onImportedDesignReviewQueued?: (reviewId: string, control: "start" | "stop" | "status") => Promise<void>;
  onImportedExecutionQueued?: (executionId: string, control: "start" | "stop" | "status") => Promise<void>;
  onImportedExecutionReviewQueued?: (reviewId: string, control: "start" | "stop" | "status") => Promise<void>;
  onImportedExecutionRepairQueued?: (repairId: string, control: "start" | "stop" | "status") => Promise<void>;
  onImportedValidationQueued?: (validationId: string, control: "start" | "stop" | "status") => Promise<void>;
  onImportedValidationReviewQueued?: (reviewId: string, control: "start" | "stop" | "status") => Promise<void>;
  /** Re-send a committed original result receipt through its current authenticated binding. */
  redeliverImportedSourceReceipt?: (
    computerId: string,
    family: ImportedSourceReceiptFamily,
    id: string,
  ) => Promise<void>;
  onSourceRecoveryQueued?: (recoveryId: string, control: "start" | "stop" | "status") => Promise<void>;
  onRecoveryValidationQueued?: (validationId: string, control: "start" | "stop" | "status") => Promise<void>;
  onCleanValidationQueued?: (validationId: string, control: "start" | "stop" | "status") => Promise<void>;
  onRecoveryValidationReviewQueued?: (reviewId: string, control: "start" | "stop" | "status") => Promise<void>;
  onCleanValidationReviewQueued?: (reviewId: string, control: "start" | "stop" | "status") => Promise<void>;
  /** Current paired transport identity. Frames and profile metadata cannot populate this. */
  getPairedNodeSession?: (
    computerId: string,
  ) => { computerId: string; deviceId: string; tokenLookup: string; sessionId: string } | undefined;
  /** Current paired node's prepared routing description; never an execution grant. */
  getProductSourceRouting?: (computerId: string) => ProductSourceRoutingV1 | undefined;
}
