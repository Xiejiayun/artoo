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
  /**
   * Optional hook fired (after commit) when a run is queued by assignment, so a
   * node binding can dispatch run.start over the node transport. Absent in pure
   * REST tests (the dev mock-execute path drives ingestion directly instead).
   */
  onRunQueued?: (runId: string) => Promise<void>;
}
