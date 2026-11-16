import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadServerAccessConfig } from "./server-access-config.js";
import type { startServerRuntime } from "./server-runtime.js";

export async function startServer(
  env: NodeJS.ProcessEnv = process.env,
  options: { onFatal?: () => void } = {},
): Promise<Awaited<ReturnType<typeof startServerRuntime>>> {
  // Capture before the import await: later environment mutation cannot change
  // the access checks or select a different storage/runtime configuration.
  const captured = Object.freeze({ ...env });
  const access = loadServerAccessConfig(captured);
  const { startServerRuntime: start } = await import("./server-runtime.js");
  return start(captured, options, access);
}

export async function main(): Promise<void> {
  const server = await startServer(process.env, {
    onFatal: () => {
      console.error("Database ownership lost; server shutting down");
      process.exitCode = 1;
    },
  });
  const address = server.app.server.address();
  console.log(
    `Artoo server ready on ${typeof address === "object" && address ? address.port : address}; storage=${server.persistent ? "persistent" : "ephemeral"}`,
  );
  const shutdown = (): void => {
    void server.close().catch(() => {
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  // Only a parent that deliberately created an IPC child can use this channel.
  // Windows service/package tests use the same graceful shutdown path.
  if (process.send !== undefined) {
    process.on("message", (message: unknown) => {
      if (typeof message === "object" && message !== null && "type" in message && message.type === "shutdown") {
        void server.close().finally(() => process.disconnect?.());
      }
    });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Server startup failed");
    process.exitCode = 1;
  });
}
