import { describe, expect, it } from "vitest";
import { loadStorageConfig } from "./storage.js";

describe("persistent storage configuration", () => {
  it("preserves local defaults and slows only the remote event poll", () => {
    expect(loadStorageConfig({})).toEqual({ blobBackend: "filesystem", eventPollMs: 200 });
    expect(loadStorageConfig({ ARTOO_DATABASE_URL: "postgresql://example/db" }).eventPollMs).toBe(1000);
  });
  it("fails closed if a container would use ephemeral database or blobs", () => {
    for (const env of [{}, { ARTOO_DATABASE_URL: "postgresql://example/db" }, { ARTOO_BLOB_BACKEND: "supabase" }]) {
      expect(() => loadStorageConfig({ ...env, ARTOO_REQUIRE_REMOTE_STORAGE: "1" })).toThrow("requires ARTOO_DATABASE_URL");
    }
  });
  it("requires complete remote credentials without including them in errors", () => {
    expect(() => loadStorageConfig({ ARTOO_BLOB_BACKEND: "supabase", SUPABASE_SERVICE_ROLE_KEY: "private-value" }))
      .toThrow("Supabase storage requires");
    const config = loadStorageConfig({ ARTOO_DATABASE_URL: "postgresql://example/db", ARTOO_BLOB_BACKEND: "supabase",
      SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "private-value", ARTOO_SUPABASE_STORAGE_BUCKET: "artoo",
      ARTOO_REQUIRE_REMOTE_STORAGE: "1" });
    expect(config.supabase?.bucket).toBe("artoo");
  });
  it("rejects typos, conflicting backends, and unsafe polling intervals", () => {
    for (const env of [
      { ARTOO_BLOB_BACKEND: "supa" }, { ARTOO_REQUIRE_REMOTE_STORAGE: "true" },
      { ARTOO_DATABASE_CA_FILE: "ca.pem" }, { ARTOO_DATABASE_URL: "postgresql://example/db", ARTOO_DB_DIR: "local-db" },
      ...["", "0", "199", "60001", "1.5", "NaN"].map(ARTOO_EVENT_POLL_MS => ({ ARTOO_EVENT_POLL_MS })),
    ]) expect(() => loadStorageConfig(env)).toThrow();
  });
});
