import { describe, expect, it } from "vitest";
import { PostgresDbClient } from "./postgres-db-client.js";

describe("PostgresDbClient connection admission", () => {
  it("rejects malformed or non-Postgres URLs without echoing credentials", async () => {
    for (const connectionString of ["password=private-value", "https://user:private-value@example.com/db"]) {
      await expect(PostgresDbClient.create({ connectionString })).rejects.toThrow("Invalid PostgreSQL connection URL");
    }
  });

  it("refuses transaction-pooler connections before opening a socket", async () => {
    await expect(PostgresDbClient.create({ connectionString: "postgresql://user:secret@example.com:6543/postgres" }))
      .rejects.toThrow("Transaction pooler port 6543 is unsupported");
  });

  it("rejects encoded domain socket hosts which would bypass TLS", async () => {
    await expect(PostgresDbClient.create({ connectionString: "postgresql://user:secret@%2Fvar%2Frun%2Fpostgresql/db" }))
      .rejects.toThrow("requires a TCP hostname");
  });

  it("refuses TLS downgrade parameters", async () => {
    for (const mode of ["disable", "allow", "prefer", "verify-ca", "no-verify"]) {
      await expect(PostgresDbClient.create({ connectionString: `postgresql://user:secret@example.com/db?sslmode=${mode}` }))
        .rejects.toThrow("requires verified TLS");
    }
  });

  it("refuses URL SSL overrides which could replace the verified TLS options", async () => {
    for (const parameter of ["ssl=false", "sslrootcert=untrusted.pem", "uselibpqcompat=true"]) {
      await expect(PostgresDbClient.create({ connectionString: `postgresql://user:secret@example.com/db?${parameter}` }))
        .rejects.toThrow("URL SSL overrides");
    }
  });

  it("never permits the local plaintext exception for a remote host", async () => {
    await expect(PostgresDbClient.create({ connectionString: "postgresql://user:secret@example.com/db", allowInsecureLocalhost: true }))
      .rejects.toThrow("only for a local test database");
  });

  it("rejects query parameters which override checked endpoints or deadlines", async () => {
    for (const parameter of ["host=remote.example.com", "port=6543", "query_timeout=0", "statement_timeout=0", "options=-c%20statement_timeout%3D0"]) {
      await expect(PostgresDbClient.create({ connectionString: `postgresql://localhost/db?${parameter}`, allowInsecureLocalhost: true }))
        .rejects.toThrow("URL query parameters other than sslmode");
    }
  });

  it("requires bounded connection and query deadlines", async () => {
    for (const timeout of [0, -1, 0.5, Number.POSITIVE_INFINITY, 300001]) {
      await expect(PostgresDbClient.create({ connectionString: "postgresql://localhost/db", connectionTimeoutMillis: timeout }))
        .rejects.toThrow("timeout must be an integer");
      await expect(PostgresDbClient.create({ connectionString: "postgresql://localhost/db", queryTimeoutMillis: timeout }))
        .rejects.toThrow("timeout must be an integer");
    }
  });
});
