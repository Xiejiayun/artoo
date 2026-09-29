import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
if (existsSync(".env")) loadEnvFile(".env");
process.env.NODE_ENV = "production";
process.env.ARTOO_WEB_DIST ||= resolve("apps/web/dist");
const { startServer } = await import("../apps/server/dist/main.js");
const server = await startServer();
console.log(`Artoo trusted-team preview ready; persistent data: ${server.dataRoot}`);
let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  void server.close().catch((error) => { console.error(error.message); process.exitCode = 1; });
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
