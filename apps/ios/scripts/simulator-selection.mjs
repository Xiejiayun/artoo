function versionParts(value) {
  if (typeof value !== "string" || !/^\d+(?:\.\d+){0,2}$/.test(value.trim())) return null;
  const parts = value.trim().split(".").map(Number);
  if (!parts.every(Number.isSafeInteger)) return null;
  while (parts.length < 3) parts.push(0);
  return parts;
}

function compareVersions(a, b) {
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

/** Pure selection over simctl inventories. The SDK ceiling is a conservative
 * default, not certification that a particular Xcode/runtime pair is stable.
 * An explicit available iPhone UDID retains the operator's choice.
 */
export function selectIPhoneSimulator({ sdkVersion, deviceInventory, runtimeInventory, requestedUDID }) {
  const sdk = versionParts(sdkVersion);
  if (!sdk) throw new Error(`The selected Xcode's iPhoneSimulator SDK version is unavailable or invalid (${JSON.stringify(sdkVersion) ?? "missing"}); expected the numeric result of xcrun --sdk iphonesimulator --show-sdk-version`);
  if (!deviceInventory?.devices || typeof deviceInventory.devices !== "object" || Array.isArray(deviceInventory.devices)) {
    throw new Error("simctl device inventory is unavailable or malformed");
  }
  if (!Array.isArray(runtimeInventory?.runtimes)) throw new Error("simctl runtime inventory is unavailable or malformed");
  const runtimes = new Map(runtimeInventory.runtimes.map((runtime) => [runtime.identifier, runtime]));
  const candidates = Object.entries(deviceInventory.devices).flatMap(([identifier, devices]) => {
    if (!Array.isArray(devices)) throw new Error(`simctl device list is malformed for runtime ${identifier}`);
    const runtime = runtimes.get(identifier);
    const version = versionParts(runtime?.version);
    return devices.map((device) => {
      const reasons = [];
      const iPhone = typeof device.deviceTypeIdentifier === "string"
        ? device.deviceTypeIdentifier.startsWith("com.apple.CoreSimulator.SimDeviceType.iPhone-")
        : typeof device.name === "string" && /^iPhone\b/.test(device.name);
      if (!iPhone) reasons.push("not an iPhone");
      if (!device.udid || !device.name) reasons.push("missing device identity");
      if (device.isAvailable !== true) reasons.push(`device unavailable${device.availabilityError ? `: ${device.availabilityError}` : ""}`);
      if (!runtime) reasons.push("runtime metadata missing");
      else {
        if (!identifier.startsWith("com.apple.CoreSimulator.SimRuntime.iOS-")) reasons.push("not an iOS runtime");
        if (runtime.isAvailable !== true) reasons.push(`runtime unavailable${runtime.availabilityError ? `: ${runtime.availabilityError}` : ""}`);
        if (!version) reasons.push("runtime version is not numeric");
      }
      return { device, runtime, identifier, version, reasons, newerThanSdk: version !== null && compareVersions(version, sdk) > 0 };
    });
  });
  const diagnostics = candidates.map(({ device, runtime, identifier, reasons, newerThanSdk }) => {
    const status = [...reasons, ...(newerThanSdk ? [`newer than SDK ${sdkVersion}; explicit override only`] : [])];
    return `${device.name ?? "Unnamed device"} (${device.udid ?? "no UDID"}), ${runtime?.name ?? identifier} [${runtime?.version ?? "unknown version"}]: ${status.length ? status.join("; ") : "eligible"}`;
  });
  const inventorySummary = `Candidates:\n${diagnostics.length ? diagnostics.map((line) => `- ${line}`).join("\n") : "- No simulator devices were listed"}`;
  const requested = requestedUDID?.trim();
  let selected;
  if (requested) {
    const matches = candidates.filter(({ device }) => device.udid === requested);
    if (matches.length !== 1 || matches[0].reasons.length) {
      throw new Error(`ARTOO_IOS_SIMULATOR_UDID=${requested} must identify exactly one available iPhone on an available iOS runtime. ${matches.length > 1 ? "The UDID appears more than once. " : ""}${inventorySummary}`);
    }
    selected = matches[0];
  } else {
    selected = candidates.filter((candidate) => candidate.reasons.length === 0 && !candidate.newerThanSdk)
      .sort((a, b) => compareVersions(b.version, a.version)
        || a.device.name.localeCompare(b.device.name, "en", { numeric: true }) || a.device.udid.localeCompare(b.device.udid))[0];
    if (!selected) throw new Error(`No available iPhone has an available iOS runtime at or below the selected iPhoneSimulator SDK ${sdkVersion}. Install a matching runtime/device yourself or set ARTOO_IOS_SIMULATOR_UDID explicitly; this script does not switch Xcode or create simulators. ${inventorySummary}`);
  }
  return { device: selected.device, runtime: selected.runtime, sdkVersion: sdkVersion.trim(),
    mode: requested ? "explicit-udid" : "sdk-default", newerThanSdk: selected.newerThanSdk, diagnostics };
}
