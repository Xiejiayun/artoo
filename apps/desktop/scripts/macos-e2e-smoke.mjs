import { runPackagedSmoke } from "./packaged-e2e-smoke.mjs";

runPackagedSmoke("darwin").catch((error) => { console.error(error); process.exitCode = 1; });
