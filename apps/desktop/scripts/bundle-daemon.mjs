import { build } from "esbuild";
import { fileURLToPath } from "node:url";
await build({
  entryPoints: [fileURLToPath(new URL("../../artood/src/main.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("../daemon/artood.mjs", import.meta.url)),
  bundle: true, platform: "node", format: "esm", target: "node24",
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  external: ["bufferutil", "utf-8-validate"],
});
// The daemon's import.meta.url resolves this worker beside artood.mjs inside
// the unpacked app. Keep CommonJS for the standalone Electron-as-Node worker.
await build({
  entryPoints: [fileURLToPath(new URL("../../artood/src/managed/journal-worker.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("../daemon/journal-worker.js", import.meta.url)),
  bundle: true, platform: "node", format: "cjs", target: "node24",
});
