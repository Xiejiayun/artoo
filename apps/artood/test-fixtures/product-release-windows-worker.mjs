// Fixture-only crash boundary observer. All actual I/O executes before the parent terminates this child.
import { readFileSync } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const { rawVerifier, rawProfile, request, killAfterMonitoringPhase, killAfterPublicationPhase, bundle } = config;
if (killAfterMonitoringPhase || killAfterPublicationPhase) {
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    rename(from, to);
    if (!String(to).endsWith(".json")) return;
    const parent = path.basename(path.dirname(to));
    if (parent !== "health" && parent !== "operations") return;
    const phase = JSON.parse(readFileSync(to, "utf8")).phase;
    if (parent === "health" && phase === killAfterMonitoringPhase || parent === "operations" && phase === killAfterPublicationPhase) {
      if (!process.send) throw new Error("Crash qualification requires the parent observer channel");
      process.send({ type: "crash-boundary", operation: "actual-rename-completed", directory: parent, phase });
      // No graceful finalizer or later state transition runs. The parent must observe and terminate this exact child.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      throw new Error("Crash boundary unexpectedly resumed");
    }
  };
  syncBuiltinESMExports();
}
const { prepareVerificationProfiles, attachWindowsVerificationBackend } = await import("../dist/verification.js");
const { createProductReleaseExecutor, prepareReleaseProfiles } = await import("../dist/product-release.js");
const { prepareWindowsProcessInstallation } = await import("../dist/windows-process-installation.js");
const { prepareWindowsReleaseStorage } = await import("../dist/windows-release-storage.js");
const [verifier] = prepareVerificationProfiles([rawVerifier], bundle.writableWorkspaceRoots);
attachWindowsVerificationBackend(verifier, prepareWindowsProcessInstallation(bundle));
const authority = prepareWindowsReleaseStorage({ directory: rawProfile.storage_root, writableWorkspaceRoots: bundle.writableWorkspaceRoots });
const profiles = prepareReleaseProfiles([rawProfile], [verifier], { windowsStorage: new Map([[rawProfile.storage_root, authority]]) });
const executor = createProductReleaseExecutor(profiles);
try {
  await executor.start();
  process.stdout.write(`${JSON.stringify(request ? await executor.release(request) : executor.getHealthReports())}\n`);
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1;
} finally {
  await executor.stop();
  if (process.connected) process.disconnect();
}
