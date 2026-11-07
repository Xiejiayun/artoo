import { describe, expect, it } from "vitest";
import { isV2WebAcceptanceOptions, isV3WebAcceptanceOptions, normalizeWebAcceptanceOptions, NormalizedWebAcceptanceOptionsSchema,
  StaticWebCapabilitySnapshotSchema } from "./web-acceptance-config.js";

const digest = `sha256:${"a".repeat(64)}`;
const program = { version: 2, viewports: [{ id: "phone", width: 390, height: 844 }, { id: "phone-tall", width: 390, height: 1024 }] };

describe("versioned protected browser configuration", () => {
  it("preserves the explicit Windows Job opt-in in every program version without accepting authority or commands", () => {
    for (const base of [{}, { browser_program: program }, { browser_program: { ...program, version: 3 } }]) {
      const options = normalizeWebAcceptanceOptions({ ...base, windows_browser_process: { version: 1 } });
      expect(options.windows_browser_process).toEqual({ version: 1 });
      expect(NormalizedWebAcceptanceOptionsSchema.parse(options)).toEqual(options);
      expect(normalizeWebAcceptanceOptions(base)).not.toHaveProperty("windows_browser_process");
      for (const value of [null, true, {}, { version: 2 }, { version: 1, backend: {} }, { version: 1, argv: ["cmd.exe"] }]) {
        expect(() => normalizeWebAcceptanceOptions({ ...base, windows_browser_process: value })).toThrow();
      }
    }
  });
  it("preserves the exact normalized v1 bytes and adds no version-2 defaults", () => {
    const normalized = normalizeWebAcceptanceOptions({});
    expect(JSON.stringify(normalized)).toBe('{"action_timeout_ms":5000,"viewports":[1280,390],"design_capture_cases":false}');
    expect(isV2WebAcceptanceOptions(normalized)).toBe(false);
    expect(normalizeWebAcceptanceOptions({ action_timeout_ms: 5000, viewports: [1280, 390], design_capture_cases: false,
      browser_executable: undefined })).toEqual(normalized);
    expect(NormalizedWebAcceptanceOptionsSchema.parse(normalized)).toEqual(normalized);
  });

  it("explicitly opts into named width-height viewports without reinterpreting numeric widths", () => {
    const normalized = normalizeWebAcceptanceOptions({ browser_program: program });
    expect(normalized).toEqual({ action_timeout_ms: 5000, design_capture_cases: false, browser_program: program });
    expect(isV2WebAcceptanceOptions(normalized)).toBe(true);
    expect(isV3WebAcceptanceOptions(normalized)).toBe(false);
    expect(JSON.stringify(normalized)).toBe('{"action_timeout_ms":5000,"design_capture_cases":false,"browser_program":{"version":2,"viewports":[{"id":"phone","width":390,"height":844},{"id":"phone-tall","width":390,"height":1024}]}}');
    expect(normalized).not.toHaveProperty("viewports");
    expect(NormalizedWebAcceptanceOptionsSchema.parse(normalized)).toEqual(normalized);
    const binding = { version: 1, command_id: "web", profile_digest: digest, config_digest: digest, contract_digest: digest };
    expect(StaticWebCapabilitySnapshotSchema.parse({ version: 1, binding, options: normalized })).toEqual({ version: 1, binding, options: normalized });
    expect(StaticWebCapabilitySnapshotSchema.safeParse({ version: 1, binding, options: { browser_program: program } }).success).toBe(false);
  });

  it("rejects mixed versions, missing viewports, unknown selectors and oversized screenshots", () => {
    for (const options of [{ viewports: [390], browser_program: program }, { browser_program: { version: 2 } },
      { browser_program: { ...program, viewports: [] } }, { browser_program: { ...program, version: 4 } },
      { browser_program: { ...program, viewports: [program.viewports[0], program.viewports[0]] } },
      { browser_program: { ...program, script: "evaluate()" } },
      { browser_program: { ...program, viewports: [{ id: "huge", width: 8192, height: 8192 }] } },
      { browser_program: { ...program, viewports: [{ id: "bad", width: 390, height: 0 }] } },
      { browser_program: { ...program, viewports: [{ id: "bad", width: 390, height: 844, device_scale_factor: 2 }] } }]) {
      expect(() => normalizeWebAcceptanceOptions(options)).toThrow();
    }
  });

  it("keeps explicit v3 profiles distinct without changing old normalized bytes", () => {
    const v3Program = { ...program, version: 3 };
    const normalized = normalizeWebAcceptanceOptions({ browser_program: v3Program });
    expect(normalized).toEqual({ action_timeout_ms: 5000, design_capture_cases: false, browser_program: v3Program });
    expect(isV2WebAcceptanceOptions(normalized)).toBe(false);
    expect(isV3WebAcceptanceOptions(normalized)).toBe(true);
    expect(isV3WebAcceptanceOptions(normalizeWebAcceptanceOptions({}))).toBe(false);
    expect(NormalizedWebAcceptanceOptionsSchema.parse(normalized)).toEqual(normalized);
    expect(JSON.stringify(normalized)).toBe('{"action_timeout_ms":5000,"design_capture_cases":false,"browser_program":{"version":3,"viewports":[{"id":"phone","width":390,"height":844},{"id":"phone-tall","width":390,"height":1024}]}}');
    const binding = { version: 1, command_id: "web", profile_digest: digest, config_digest: digest, contract_digest: digest };
    expect(StaticWebCapabilitySnapshotSchema.parse({ version: 1, binding, options: normalized })).toEqual({ version: 1, binding, options: normalized });
    for (const options of [{ viewports: [390], browser_program: v3Program }, { browser_program: { version: 3 } },
      { browser_program: { ...v3Program, max_pages: 4 } }, { browser_program: { ...v3Program, viewports: [program.viewports[0], program.viewports[0]] } },
      { browser_program: { ...v3Program, viewports: [{ id: "huge", width: 8192, height: 8192 }] } }]) {
      expect(() => normalizeWebAcceptanceOptions(options)).toThrow();
    }
  });

  it("enables only the strict protected versioned storage extension on v3 and preserves absence otherwise", () => {
    const browser_program = { ...program, version: 3 }, storage_fault = { version: 1 };
    const normalized = normalizeWebAcceptanceOptions({ browser_program, storage_fault });
    expect(normalized).toEqual({ action_timeout_ms: 5000, design_capture_cases: false, browser_program, storage_fault });
    expect(NormalizedWebAcceptanceOptionsSchema.parse(normalized)).toEqual(normalized);
    expect(normalizeWebAcceptanceOptions({ browser_program, storage_fault: undefined })).not.toHaveProperty("storage_fault");
    for (const options of [{ storage_fault }, { browser_program: program, storage_fault },
      { browser_program, storage_fault: {} }, { browser_program, storage_fault: { version: 2 } },
      { browser_program, storage_fault: { version: 1, mode: "write-quota" } },
      { browser_program, storage_fault: { version: 1, script: "injection()" } },
      { browser_program, storage_fault: { version: 1, max_keys: 1024 } }, { browser_program, storage_fault: null }]) {
      expect(() => normalizeWebAcceptanceOptions(options)).toThrow();
    }
  });
});
