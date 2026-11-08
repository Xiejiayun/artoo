import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderWindowsBrowserObservationRequest } from "./windows-browser-exit.js";

const paths = {
  executable: "C:\\任务 読書\\📚\\it's `chrome` \"quoted\"; $($script:injected = $true).exe",
  profile: "C:\\资料\\'; $script:injected = $true; #\r\n\t${profile}\\e\u0301-\ufffd-😀\\",
};

describe("protected one-shot Windows observer request fields", () => {
  it.runIf(process.platform === "win32")("round-trips both fixed shapes as data through the actual PowerShell renderer", () => {
    // Controlled strings only: no process observation or filesystem operation is invoked.
    const requests = [{ parent_pid: 0xffffffff, ...paths }, paths];
    const script = "$ErrorActionPreference = 'Stop'\n$script:injected = $false\n"
      + requests.map(request => renderWindowsBrowserObservationRequest(request) + String.raw`
[Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$request.executable)))
[Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$request.profile)))
[Console]::Out.WriteLine(($request.PSObject.Properties.Name -join ','))
if ($null -ne $request.PSObject.Properties['parent_pid']) {
  [Console]::Out.WriteLine($request.parent_pid.GetType().FullName + ':' + $request.parent_pid.ToString([Globalization.CultureInfo]::InvariantCulture))
} else { [Console]::Out.WriteLine('no_parent') }
`).join("\n") + "\n[Console]::Out.WriteLine($script:injected.ToString())\n";
    expect(script).not.toContain("ConvertFrom-Json");
    expect(script).not.toContain(paths.executable); expect(script).not.toContain(paths.profile);
    const entrypoint = "[Console]::InputEncoding = [Text.UTF8Encoding]::new($false); & ([scriptblock]::Create([Console]::In.ReadToEnd()))";
    const output = execFileSync(join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(entrypoint, "utf16le").toString("base64")],
      { input: script, windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024, encoding: "utf8" });
    const encodedPaths = [paths.executable, paths.profile].map(value => Buffer.from(value, "utf8").toString("base64"));
    expect(output.trim().split(/\r?\n/)).toEqual([
      ...encodedPaths, "parent_pid,executable,profile", "System.UInt32:4294967295",
      ...encodedPaths, "executable,profile", "no_parent", "False",
    ]);
  });

  it.each([null, [], "request", {}, { executable: paths.executable }, { ...paths, extra: true },
    { ...paths, parent_pid: undefined }, { ...paths, [Symbol("hidden")]: true },
    Object.assign(Object.create({ parent_pid: 101 }) as object, paths),
    { ...paths, executable: 1 }, { ...paths, profile: null },
  ])("rejects malformed or extended request shapes without exposing their values: %j", request => {
    expect(() => renderWindowsBrowserObservationRequest(request)).toThrow("Invalid Windows observation request");
  });

  it.each([0, -0, -1, 1.5, 0x100000000, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "101", 101n])(
    "rejects a PID outside the uint32 request contract: %s", parent_pid => {
      expect(() => renderWindowsBrowserObservationRequest({ ...paths, parent_pid })).toThrow("Invalid Windows observation request");
    });

  it("rejects request accessors without invoking them", () => {
    for (const field of ["executable", "profile", "parent_pid"]) {
      const read = vi.fn(() => field === "parent_pid" ? 101 : "private value");
      const request = Object.defineProperty({ ...paths }, field, { enumerable: true, get: read });
      expect(() => renderWindowsBrowserObservationRequest(request)).toThrow("Invalid Windows observation request");
      expect(read).not.toHaveBeenCalled();
    }
  });

  it.each(["\ud800", "\udfff", "prefix\ud800suffix", "\udfff\ud800", "\ud800\ud800\udfff"])(
    "rejects unpaired UTF-16 in either path before UTF-8 can replace it: %j", value => {
      for (const field of ["executable", "profile"]) {
        expect(() => renderWindowsBrowserObservationRequest({ ...paths, [field]: value })).toThrow("Invalid Windows observation request");
      }
    });
});
