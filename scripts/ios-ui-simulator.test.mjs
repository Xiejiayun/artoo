import assert from "node:assert/strict";
import { test } from "node:test";
import { assertFixtureSimulatorBinding, selectNativeFixtureSimulator } from "./ios-ui-simulator.mjs";

const selected = "11111111-1111-1111-1111-111111111111";
const newer = "22222222-2222-2222-2222-222222222222";
function mockInventory({ failure = false } = {}) {
  const calls = [], runtime = (version) => `com.apple.CoreSimulator.SimRuntime.iOS-${version.replaceAll(".", "-")}`;
  const devices = Object.fromEntries([["26.5", selected], ["26.6", newer]].map(([version, udid]) => [runtime(version), [{
    name: `iPhone ${version}`, udid, isAvailable: true, deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
  }]]));
  const results = ["26.5\n", JSON.stringify({ devices }), JSON.stringify({ runtimes: ["26.5", "26.6"].map((version) => ({
    identifier: runtime(version), version, name: `iOS ${version}`, isAvailable: true,
  })) })];
  return { calls, execute(command, args, options) {
    calls.push({ command, args, options });
    return { status: failure ? 1 : 0, stdout: results[calls.length - 1] };
  } };
}

test("parent preserves SDK-aware default without an environment UDID", () => {
  const mock = mockInventory();
  const result = selectNativeFixtureSimulator({ execute: mock.execute });
  assert.equal(result.device.udid, selected); assert.equal(result.mode, "sdk-default");
  assert.deepEqual(mock.calls.map(({ command, args }) => ({ command, args })), [
    { command: "/usr/bin/xcrun", args: ["--sdk", "iphonesimulator", "--show-sdk-version"] },
    { command: "/usr/bin/xcrun", args: ["simctl", "list", "devices", "--json"] },
    { command: "/usr/bin/xcrun", args: ["simctl", "list", "runtimes", "--json"] },
  ]);
  assert.ok(mock.calls.every(({ options }) => options.timeout === 15_000 && options.shell === false));
});

test("parent retains a valid operator-selected available UDID and rejects an unlisted one", () => {
  const result = selectNativeFixtureSimulator({ requestedUDID: newer, execute: mockInventory().execute });
  assert.equal(result.device.udid, newer); assert.equal(result.mode, "explicit-udid"); assert.equal(result.newerThanSdk, true);
  assert.throws(() => selectNativeFixtureSimulator({ requestedUDID: "booted", execute: mockInventory().execute }));
});

test("selection failure cannot create an unbound clipboard observer", () => {
  const mock = mockInventory({ failure: true });
  assert.throws(() => selectNativeFixtureSimulator({ execute: mock.execute })); assert.equal(mock.calls.length, 1);
});

test("child binding rejects absent, symbolic, malformed and other-device identifiers", () => {
  for (const value of [undefined, "", "booted", "any", selected.toLowerCase() + "/x", newer]) {
    assert.throws(() => assertFixtureSimulatorBinding(value, selected));
  }
  assert.doesNotThrow(() => assertFixtureSimulatorBinding(selected, selected));
});
