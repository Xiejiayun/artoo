import { PgliteDbClient } from "@artoo/storage";

import { loadMigrationStatements } from "./migrations.js";
import { organizations } from "./schema.js";

export const TEST_ORG = "org_default";
export const TEST_NOW = "2026-06-13T00:00:00.000Z";

/** A fresh embedded db with the schema applied and a default organization, so
 *  event/idempotency tests satisfy the event_log.organization_id FK. */
export async function createMigratedClient(): Promise<PgliteDbClient> {
  const client = await PgliteDbClient.create();
  await client.migrate(await loadMigrationStatements());
  await client.db
    .insert(organizations)
    .values({ id: TEST_ORG, name: "Default Org", createdAt: TEST_NOW });
  return client;
}
