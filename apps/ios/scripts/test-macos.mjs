#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") throw new Error("Xcode/XCTest requires macOS; static checks are not a native test result.");
const ios = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(ios, "../../artifacts/ios");
mkdirSync(output, { recursive: true });
function run(command, args, capture = false) {
  const result = spawnSync(command, args, { cwd: ios, stdio: capture ? "pipe" : "inherit", encoding: "utf8", timeout: 1_200_000 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? `${command} failed (${result.status}): ${result.stderr ?? "see output"}`);
  return result.stdout;
}
run("xcodebuild", ["-version"]);
run("xcodegen", ["generate"]);
const inventory = JSON.parse(run("xcrun", ["simctl", "list", "devices", "available", "--json"], true));
const candidates = Object.entries(inventory.devices).sort(([a], [b]) => b.localeCompare(a, undefined, { numeric: true }))
  .flatMap(([, devices]) => devices).filter((device) => device.isAvailable && device.name.startsWith("iPhone"));
const requested = process.env.ARTOO_IOS_SIMULATOR_UDID;
const device = requested ? candidates.find((item) => item.udid === requested) : candidates[0];
if (!device) throw new Error(requested ? "ARTOO_IOS_SIMULATOR_UDID must identify an available iPhone simulator" : "Install an iOS simulator runtime in Xcode before running this gate");
// Simulator ad-hoc signing needs no developer certificate, but provides the
// application/keychain entitlements required by the real Keychain XCTest.
const common = ["-project", "Artoo.xcodeproj", "-scheme", "Artoo", "-derivedDataPath", resolve(output, "DerivedData"),
  "CODE_SIGNING_ALLOWED=YES", "CODE_SIGN_IDENTITY=-", "CODE_SIGNING_REQUIRED=YES"];
run("xcodebuild", [...common, "-destination", "generic/platform=iOS Simulator", "build-for-testing"]);
run("codesign", ["--display", "--entitlements", ":-", resolve(output, "DerivedData/Build/Products/Debug-iphonesimulator/Artoo.app")]);
console.log(`Testing on ${device.name} (${device.udid})`);
run("xcodebuild", [...common, "-destination", `platform=iOS Simulator,id=${device.udid}`, "-parallel-testing-enabled", "NO",
  "-resultBundlePath", resolve(output, `Artoo-${Date.now()}.xcresult`), "test-without-building"]);
