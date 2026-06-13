import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev server / production build config for the web app. Vitest uses the root
// vitest.config.ts instead. Proxies REST + the client WebSocket to the artoo
// server (task #5). ARTOO_SERVER_URL overrides the target (e.g. for E2E).
const SERVER_TARGET = process.env.ARTOO_SERVER_URL ?? "http://localhost:4000";
const WS_TARGET = SERVER_TARGET.replace(/^http/, "ws");

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Client realtime WS lives under /api, so it must be matched (with
      // ws:true) before the generic /api http proxy.
      "/api/v1/ws": { target: WS_TARGET, ws: true },
      "/api": { target: SERVER_TARGET, changeOrigin: true },
    },
  },
});
