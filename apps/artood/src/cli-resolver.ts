import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";

function executable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch { return false; }
}

/** Resolve operator-installed executables without invoking a shell or searching a task's cwd. */
export function resolveCliCommand(command: string, searchPath = process.env.PATH ?? ""): string[] | undefined {
  const extensions = process.platform === "win32" && !extname(command) ? [".exe", ".cmd", ""] : [""];
  const candidates = isAbsolute(command)
    ? extensions.map((extension) => command + extension)
    : searchPath.split(delimiter).filter((directory) => directory && isAbsolute(directory)).flatMap((directory) => extensions.map((extension) => join(directory, command + extension)));
  for (const candidate of candidates) {
    if (!executable(candidate)) continue;
    if (/\.(cmd|bat)$/i.test(candidate)) {
      // npm's Windows shim points to its Node entrypoint. Resolve that exact
      // script and pass argv directly; never execute arbitrary batch syntax.
      const shim = readFileSync(candidate, "utf8");
      const script = /["']%dp0%[\\/]([^"'\r\n]+\.(?:c?js|mjs))["']/i.exec(shim)?.[1];
      if (!script) continue;
      const entry = resolve(dirname(candidate), script);
      if (!existsSync(entry) || !statSync(entry).isFile()) continue;
      return [process.execPath, entry];
    }
    return [candidate];
  }
  return undefined;
}

export function runtimeAvailable(runtime: string): boolean {
  return resolveCliCommand(runtime === "claude-code" ? "claude" : runtime) !== undefined;
}
