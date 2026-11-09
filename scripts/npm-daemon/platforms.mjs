// npm's independent os/cpu filters admit their Cartesian product. This exact
// list is the executable contract, including the Windows arm64 exclusion.
export const SUPPORTED_PLATFORMS = Object.freeze([
  "win32-x64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64",
]);

export function assertSupportedPlatform(mode) {
  const tuple = `${process.platform}-${process.arch}`;
  if (mode === "supervised" && tuple !== "win32-x64")
    throw Error("--windows-supervised is supported only on Windows x64.");
  if (!SUPPORTED_PLATFORMS.includes(tuple))
    throw Error(`Unsupported platform ${tuple}. Supported: Windows x64, macOS x64/arm64, Linux x64/arm64.`);
}
