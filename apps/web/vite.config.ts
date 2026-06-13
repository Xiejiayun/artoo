import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev server / production build config for the web app. Vitest uses the root
// vitest.config.ts instead. The /api and /ws proxy targets point at the artoo
// server (task #5); adjust the port to match its bootstrap once it is exposed.
const SERVER_TARGET = process.env.ARTOO_SERVER_URL ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: SERVER_TARGET, changeOrigin: true },
      "/ws": { target: SERVER_TARGET.replace(/^http/, "ws"), ws: true },
    },
  },
});
