// Compatibility entrypoint: retain Windows scope defaults and evidence names.
import { runInstalledLiveProvider } from "./installed-live-provider.mjs";

export function runWindowsLiveCopilot(options) {
  return runInstalledLiveProvider({ ...options, platform: "win32" });
}
