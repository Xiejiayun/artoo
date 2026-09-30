import { runPackagedSmoke } from "./packaged-e2e-smoke.mjs";

runPackagedSmoke("win32").catch((error) => { console.error(error); process.exitCode = 1; });
