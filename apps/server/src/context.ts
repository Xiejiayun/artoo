import type { AiDataSharingPolicy } from "./config/ai-data-sharing.js";
import type { Clock, IdGen } from "@artoo/domain";
import type { DbClient } from "@artoo/storage";

import type { AuthConfig } from "./auth/auth-config.js";
import type { OidcHttp } from "./auth/oidc-client.js";
import type { DeviceAuthConfig } from "./config/device-auth.js";

/**
 * Per-request-independent server dependencies. Single org/tenant for v0.1, so
 * the organization and the acting user are pinned here (bootstrap seeds them).
 * Clock and IdGen are injected (Gate 0) so flows are deterministic under test.
 */
export interface ServerContext {
  db: DbClient;
  /** Explicit operator declaration; absent configuration cannot authorize AI. */
  aiDataSharingPolicy?: AiDataSharingPolicy | null;
  clock: Clock;
  idGen: IdGen;
  organizationId: string;
  /** The acting user for v0.1 (no auth yet); used as created_by / actor. */
  actorUserId: string;
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
}
