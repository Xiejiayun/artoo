import type { Clock, IdGen } from "@artoo/domain";
import type { DbClient } from "@artoo/storage";

/**
 * Per-request-independent server dependencies. Single org/tenant for v0.1, so
 * the organization and the acting user are pinned here (bootstrap seeds them).
 * Clock and IdGen are injected (Gate 0) so flows are deterministic under test.
 */
export interface ServerContext {
  db: DbClient;
  clock: Clock;
  idGen: IdGen;
  organizationId: string;
  /** The acting user for v0.1 (no auth yet); used as created_by / actor. */
  actorUserId: string;
}
