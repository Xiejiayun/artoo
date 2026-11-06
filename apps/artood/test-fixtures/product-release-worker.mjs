// Isolated publication process: the parent fixture terminates this with real SIGKILL at journal boundaries.
import { readFileSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { prepareVerificationProfiles } from "../dist/verification.js";
import { createProductReleaseExecutor, prepareReleaseProfiles } from "../dist/product-release.js";

const { rawVerifier, rawProfile, request, killAfterMonitoringPhase, killAfterPublicationPhase } = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (killAfterMonitoringPhase || killAfterPublicationPhase) {
  // Crash injection is confined to this fixture. Kill only after the actual rename AND directory fsync.
  const rename = fs.renameSync, sync = fs.fsyncSync;
  let pendingKill = false;
  fs.renameSync = (from, to) => {
    rename(from, to);
    if (String(to).endsWith(".json")) {
      if (String(to).includes("/health/") && killAfterMonitoringPhase) pendingKill = JSON.parse(readFileSync(to, "utf8")).phase === killAfterMonitoringPhase;
      if (String(to).includes("/operations/") && killAfterPublicationPhase) pendingKill = JSON.parse(readFileSync(to, "utf8")).phase === killAfterPublicationPhase;
    }
  };
  fs.fsyncSync = (fd) => { sync(fd); if (pendingKill) process.kill(process.pid, "SIGKILL"); };
  syncBuiltinESMExports();
}
const profiles = prepareReleaseProfiles([rawProfile], prepareVerificationProfiles([rawVerifier]));
const executor = createProductReleaseExecutor(profiles);
try {
  await executor.start();
  process.stdout.write(`${JSON.stringify(request ? await executor.release(request) : executor.getHealthReports())}\n`);
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1;
} finally {
  await executor.stop();
}
