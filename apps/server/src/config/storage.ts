export interface StorageConfig {
  databaseUrl?: string;
  databaseCaFile?: string;
  blobBackend: "filesystem" | "supabase";
  supabase?: { url: string; serviceRoleKey: string; bucket: string };
  eventPollMs: number;
}

/** Container images require external persistence; ordinary local startup keeps
 * PGlite and filesystem defaults. Validate before opening or migrating data. */
export function loadStorageConfig(env: NodeJS.ProcessEnv): StorageConfig {
  const databaseUrl = env.ARTOO_DATABASE_URL?.trim() || undefined;
  const databaseCaFile = env.ARTOO_DATABASE_CA_FILE?.trim() || undefined;
  const blobBackend = env.ARTOO_BLOB_BACKEND?.trim() || "filesystem";
  if (blobBackend !== "filesystem" && blobBackend !== "supabase") {
    throw new Error("ARTOO_BLOB_BACKEND must be filesystem or supabase");
  }
  if (databaseUrl && env.ARTOO_DB_DIR?.trim()) {
    throw new Error("Configure either ARTOO_DATABASE_URL or ARTOO_DB_DIR, not both");
  }
  if (databaseCaFile && !databaseUrl) throw new Error("ARTOO_DATABASE_CA_FILE requires ARTOO_DATABASE_URL");
  if (env.ARTOO_REQUIRE_REMOTE_STORAGE !== undefined && !["0", "1"].includes(env.ARTOO_REQUIRE_REMOTE_STORAGE)) {
    throw new Error("ARTOO_REQUIRE_REMOTE_STORAGE must be 0 or 1");
  }
  if (env.ARTOO_REQUIRE_REMOTE_STORAGE === "1" && (!databaseUrl || blobBackend !== "supabase")) {
    throw new Error("This deployment requires ARTOO_DATABASE_URL and ARTOO_BLOB_BACKEND=supabase");
  }
  const url = env.SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const bucket = env.ARTOO_SUPABASE_STORAGE_BUCKET?.trim();
  if (blobBackend === "supabase" && (!url || !serviceRoleKey || !bucket)) {
    throw new Error("Supabase storage requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and ARTOO_SUPABASE_STORAGE_BUCKET");
  }
  const eventPollMs = Number(env.ARTOO_EVENT_POLL_MS ?? (databaseUrl ? "1000" : "200"));
  if (!Number.isSafeInteger(eventPollMs) || eventPollMs < 200 || eventPollMs > 60_000) {
    throw new Error("ARTOO_EVENT_POLL_MS must be an integer between 200 and 60000");
  }
  return {
    ...(databaseUrl ? { databaseUrl } : {}), ...(databaseCaFile ? { databaseCaFile } : {}),
    blobBackend, eventPollMs,
    ...(blobBackend === "supabase" ? { supabase: { url: url!, serviceRoleKey: serviceRoleKey!, bucket: bucket! } } : {}),
  };
}
