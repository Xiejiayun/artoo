import assert from "node:assert/strict";
import { test } from "node:test";
import { selectIPhoneSimulator } from "./simulator-selection.mjs";

const runtime = (version, extra = {}) => ({ identifier: `com.apple.CoreSimulator.SimRuntime.iOS-${version.replaceAll(".", "-")}`, name: `iOS ${version}`, version, isAvailable: true, ...extra });
const phone = (udid, extra = {}) => ({ udid, name: `iPhone ${udid}`, deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro", isAvailable: true, state: "Shutdown", ...extra });
function inventory(sdkVersion = "18.5") {
  const old = runtime("18.4"), current = runtime("18.5"), future = runtime("26.2");
  return { sdkVersion, runtimeInventory: { runtimes: [future, old, current] }, deviceInventory: { devices: {
    [future.identifier]: [phone("future")], [current.identifier]: [phone("current")], [old.identifier]: [phone("old")],
  } } };
}

test("SDK 18.5 does not default to the installed iOS 26.2 runtime", () => {
  const input = inventory(), before = structuredClone(input);
  const result = selectIPhoneSimulator(input);
  assert.equal(result.device.udid, "current"); assert.equal(result.runtime.version, "18.5");
  assert.equal(result.mode, "sdk-default"); assert.equal(result.newerThanSdk, false);
  assert.match(result.diagnostics.find((line) => line.includes("future")), /newer than SDK 18.5/);
  assert.deepEqual(input, before, "Selection must not mutate simulator state or input inventories");
});

test("numeric runtime ordering is deterministic, including patch versions and renamed iPhones", () => {
  const older = runtime("18.9"), newer = runtime("18.10.1");
  const input = { sdkVersion: "18.10.1", runtimeInventory: { runtimes: [older, newer] }, deviceInventory: { devices: {
    [older.identifier]: [phone("old")], [newer.identifier]: [phone("b", { name: "Team phone B" }), phone("a", { name: "Team phone A" })],
  } } };
  assert.equal(selectIPhoneSimulator(input).device.udid, "a");
  input.runtimeInventory.runtimes.reverse(); input.deviceInventory.devices[newer.identifier].reverse();
  assert.equal(selectIPhoneSimulator(input).device.udid, "a");
});

test("an explicit available iPhone preserves the operator's choice beyond the SDK default", () => {
  const result = selectIPhoneSimulator({ ...inventory(), requestedUDID: " future " });
  assert.equal(result.device.udid, "future"); assert.equal(result.runtime.version, "26.2");
  assert.equal(result.mode, "explicit-udid"); assert.equal(result.newerThanSdk, true);
  assert.equal(selectIPhoneSimulator({ ...inventory(), requestedUDID: "old" }).device.udid, "old");
});

test("unavailable runtime or device cannot become the default or an explicit override", () => {
  for (const kind of ["runtime", "device"]) {
    const input = inventory();
    if (kind === "runtime") Object.assign(input.runtimeInventory.runtimes.find((item) => item.version === "18.5"), { isAvailable: false, availabilityError: "runtime image is unavailable" });
    else Object.assign(input.deviceInventory.devices[runtime("18.5").identifier][0], { isAvailable: false, availabilityError: "device is unavailable" });
    assert.equal(selectIPhoneSimulator(input).device.udid, "old");
    assert.throws(() => selectIPhoneSimulator({ ...input, requestedUDID: "current" }), new RegExp(`${kind} unavailable`));
  }
});

test("missing runtime metadata is diagnosed instead of inferring compatibility from the device key", () => {
  const input = inventory(); input.runtimeInventory.runtimes = [];
  assert.throws(() => selectIPhoneSimulator(input), /runtime metadata missing/);
  assert.throws(() => selectIPhoneSimulator({ ...input, requestedUDID: "current" }), /runtime metadata missing/);
});

test("a missing or invalid SDK fails clearly even with an explicit device", () => {
  for (const sdkVersion of [undefined, "", "unknown", "18.beta"]) {
    assert.throws(() => selectIPhoneSimulator({ ...inventory(), sdkVersion }), /iPhoneSimulator SDK version is unavailable or invalid/);
    assert.throws(() => selectIPhoneSimulator({ ...inventory(), sdkVersion, requestedUDID: "current" }), /show-sdk-version/);
  }
});

test("no matching default lists candidates and the SDK ceiling; an unknown override never falls back", () => {
  assert.throws(() => selectIPhoneSimulator(inventory("17.0")), (error) => {
    for (const value of ["SDK 17.0", "iPhone future", "iOS 26.2", "ARTOO_IOS_SIMULATOR_UDID"]) assert.ok(error.message.includes(value));
    return true;
  });
  assert.throws(() => selectIPhoneSimulator({ ...inventory(), requestedUDID: "missing" }), /UDID=missing.*Candidates:/s);
});

test("iPads and non-iOS runtimes cannot masquerade as iPhones through a device name", () => {
  const input = inventory();
  input.deviceInventory.devices[runtime("18.5").identifier] = [phone("ipad", { name: "iPhone renamed tablet", deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro" })];
  assert.equal(selectIPhoneSimulator(input).device.udid, "old");
  assert.throws(() => selectIPhoneSimulator({ ...input, requestedUDID: "ipad" }), /not an iPhone/);
  const nonIOS = runtime("2.0", { identifier: "com.apple.CoreSimulator.SimRuntime.xrOS-2-0", name: "visionOS 2.0" });
  input.runtimeInventory.runtimes.push(nonIOS); input.deviceInventory.devices[nonIOS.identifier] = [phone("wrong-platform")];
  assert.throws(() => selectIPhoneSimulator({ ...input, requestedUDID: "wrong-platform" }), /not an iOS runtime/);
});

test("empty, malformed and unusable runtime inventories have actionable failures", () => {
  assert.throws(() => selectIPhoneSimulator({ ...inventory(), deviceInventory: { devices: {} } }), /No simulator devices were listed/);
  assert.throws(() => selectIPhoneSimulator({ ...inventory(), deviceInventory: {} }), /device inventory is unavailable/);
  assert.throws(() => selectIPhoneSimulator({ ...inventory(), runtimeInventory: {} }), /runtime inventory is unavailable/);
  const input = inventory(); input.runtimeInventory.runtimes.find((item) => item.version === "18.5").version = "unknown";
  assert.equal(selectIPhoneSimulator(input).device.udid, "old");
  assert.throws(() => selectIPhoneSimulator({ ...input, requestedUDID: "current" }), /runtime version is not numeric/);
});
