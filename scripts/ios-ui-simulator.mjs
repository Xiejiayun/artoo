import { spawnSync } from "node:child_process";
import { selectIPhoneSimulator } from "../apps/ios/scripts/simulator-selection.mjs";

const udidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Resolve the existing SDK-aware default before creating an observer. This
 * reads inventory only; it never creates, boots, erases or selects 'booted'. */
export function selectNativeFixtureSimulator({ requestedUDID, execute = spawnSync } = {}) {
  const read = (args) => {
    const result = execute("/usr/bin/xcrun", args, {
      encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"], shell: false,
    });
    if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
      throw new Error("Cannot resolve the fixture simulator from the selected Xcode SDK and inventory");
    }
    return result.stdout;
  };
  const selection = selectIPhoneSimulator({
    sdkVersion: read(["--sdk", "iphonesimulator", "--show-sdk-version"]).trim(),
    deviceInventory: JSON.parse(read(["simctl", "list", "devices", "--json"])),
    runtimeInventory: JSON.parse(read(["simctl", "list", "runtimes", "--json"])),
    requestedUDID,
  });
  assertFixtureSimulatorBinding(selection.device.udid, selection.device.udid);
  return selection;
}

/** Both parent and child must name the same inventory-selected fixture device. */
export function assertFixtureSimulatorBinding(fixtureUDID, selectedUDID) {
  if (typeof fixtureUDID !== "string" || !udidPattern.test(fixtureUDID) || fixtureUDID !== selectedUDID) {
    throw new Error("Clipboard observer must be bound to the exact selected fixture simulator");
  }
}
