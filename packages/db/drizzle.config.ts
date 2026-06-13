import { defineConfig } from "drizzle-kit";

// Drizzle schema is the source of truth; `drizzle-kit generate` emits
// Postgres-compatible SQL into ./migrations, applied on PGlite (dev/test)
// and Postgres (prod) alike via DbClient.migrate.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
});
