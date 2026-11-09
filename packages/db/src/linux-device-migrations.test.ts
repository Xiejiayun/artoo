import { PgliteDbClient } from "@artoo/storage";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { loadMigrationStatements } from "./migrations.js";
import { devices, deviceTokens, pairingCodes } from "./schema.js";
import { seed } from "./seed.js";

it("adds Linux devices without changing legacy records or migration history", async () => {
  const before = await loadMigrationStatements("0055_application_publication.sql");
  const after = await loadMigrationStatements("0056_linux_devices.sql");
  expect(after.slice(0, before.length)).toEqual(before);
  expect(after).toHaveLength(before.length + 2);
  const client = await PgliteDbClient.create();
  try {
    await client.migrate(before);
    const now = "2026-11-09T00:00:00.000Z";
    const ids = await seed(client, now);
    const device = (platform: string) => ({
      id: `device_${platform}`, organizationId: ids.organizationId, displayName: `${platform} host`,
      platform, appVersion: "0.1.0", enrolledByUserId: ids.userId, trust: "active", createdAt: now,
    });
    const pairing = (platform: string | null) => ({
      id: `pair_${platform ?? "any"}`, organizationId: ids.organizationId, codeHash: `hash_${platform ?? "any"}`,
      createdByUserId: ids.userId, intendedPlatform: platform, status: "pending", expiresAt: now, createdAt: now,
    });
    for (const platform of ["windows", "macos", "android", "ios"]) {
      await client.db.insert(devices).values(device(platform));
      await client.db.insert(pairingCodes).values({ ...pairing(platform), status: "claimed", claimedByDeviceId: `device_${platform}`, claimedAt: now });
      for (const kind of ["control_session", "node"]) {
        await client.db.insert(deviceTokens).values({
          id: `token_${platform}_${kind}`, organizationId: ids.organizationId, deviceId: `device_${platform}`,
          kind, tokenLookup: `lookup_${platform}_${kind}`, tokenHash: "legacy-hash", status: "active", createdAt: now,
        });
      }
    }
    await client.db.insert(pairingCodes).values(pairing(null));
    await expect(client.db.insert(devices).values(device("linux"))).rejects.toThrow();
    await expect(client.db.insert(pairingCodes).values(pairing("linux"))).rejects.toThrow();

    const snapshot = async () => ({
      devices: (await client.db.execute(sql`SELECT to_jsonb(d) AS row FROM devices d ORDER BY id`)).rows,
      pairings: (await client.db.execute(sql`SELECT to_jsonb(p) AS row FROM pairing_codes p ORDER BY id`)).rows,
      tokens: (await client.db.execute(sql`SELECT to_jsonb(t) AS row FROM device_tokens t ORDER BY id`)).rows,
    });
    const original = await snapshot();
    const journal = (await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows;
    await client.migrate(after);
    expect(await snapshot()).toEqual(original);
    const upgraded = (await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows;
    expect(upgraded.slice(0, journal.length)).toEqual(journal);
    expect(upgraded).toHaveLength(journal.length + 2);

    await client.db.insert(devices).values(device("linux"));
    await client.db.insert(pairingCodes).values(pairing("linux"));
    expect((await client.db.select().from(devices)).find(row => row.platform === "linux")?.id).toBe("device_linux");
    expect((await client.db.select().from(pairingCodes)).find(row => row.intendedPlatform === "linux")?.id).toBe("pair_linux");
    await expect(client.db.insert(devices).values(device("blackberry"))).rejects.toThrow();
    await expect(client.db.insert(pairingCodes).values(pairing("blackberry"))).rejects.toThrow();

    const migrated = await snapshot();
    await client.migrate(after);
    expect(await snapshot()).toEqual(migrated);
    expect((await client.db.execute(sql`SELECT * FROM artoo_meta.migrations ORDER BY position`)).rows).toEqual(upgraded);
  } finally {
    await client.close();
  }
});
