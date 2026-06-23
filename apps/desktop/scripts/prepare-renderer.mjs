import { cp, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, "..");
const repoRoot = resolve(desktopDir, "..", "..");
const webDist = resolve(repoRoot, "apps", "web", "dist");
const renderer = resolve(desktopDir, "renderer");

await rm(renderer, { recursive: true, force: true });
await cp(webDist, renderer, { recursive: true });

console.log(`Copied web dist -> ${renderer}`);
