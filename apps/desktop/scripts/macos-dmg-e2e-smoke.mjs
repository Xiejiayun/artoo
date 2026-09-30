import { runPackagedSmoke } from "./packaged-e2e-smoke.mjs";

runPackagedSmoke("darwin", { macDistribution: "dmg" }).catch((error) => { console.error(error); process.exitCode = 1; });
