import { describe, expect, it, vi } from "vitest";
import { parseWindowsBrowserAncestryFailure, parseWindowsBrowserObservationBoundFailure } from "./windows-browser-negative-evidence.js";

const history = { parentPid: 7001, pids: [7002, 7003] };
const evidence = () => ({ version: 1, attempt: 1, census: "first", root_pid: 7001, parent_pid: 7002, child_pid: 7003,
  root_filetime: "134383440000000000", parent_filetime: "134383440000000101", child_filetime: "134383440000000100",
  root_type: "System.Int64", parent_type: "System.Int64", child_type: "System.Int64", delta_ticks: "-1" });

describe("bounded browser ancestry negative evidence", () => {
  it.each(["first", "second", "corroborating"])("keeps exact 100ns values and only closed fields for %s", census => {
    const source = { ...evidence(), census }, result = parseWindowsBrowserAncestryFailure(source, history);
    expect(result).toEqual(source); expect(result).not.toBe(source); expect(Object.isFrozen(result)).toBe(true);
    source.child_filetime = "1"; expect(result.child_filetime).toBe("134383440000000100");
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(768);
  });
  it("accepts the exact Int64 and uint32 limits with a root parent without rounding", () => {
    const source = { ...evidence(), attempt: 3, root_pid: 0xffffffff, parent_pid: 0xffffffff, child_pid: 1,
      root_filetime: "9223372036854775807", parent_filetime: "9223372036854775807", child_filetime: "1", delta_ticks: "-9223372036854775806" };
    expect(parseWindowsBrowserAncestryFailure(source, { parentPid: 0xffffffff, pids: [1] })).toEqual(source);
  });
  it.each([
    { version: 2 }, { version: "1" }, { attempt: 0 }, { attempt: 4 }, { attempt: 1.5 }, { attempt: "1" },
    { census: "final" }, { root_pid: 0 }, { root_pid: "7001" }, { root_pid: 7004 }, { parent_pid: 7004 },
    { child_pid: 7004 }, { child_pid: 7001 }, { child_pid: 7002 }, { child_pid: 0x100000000 }, { child_pid: 7003.5 },
    { root_filetime: "0" }, { root_filetime: "01" }, { root_filetime: "9223372036854775808" },
    { parent_filetime: 134383440000000100 }, { child_filetime: "1e17" }, { child_filetime: "+100" },
    { child_filetime: " 100" }, { child_filetime: "100\n" }, { child_filetime: "9".repeat(2000) },
    { root_type: "System.Double" }, { parent_type: null }, { child_type: "System.UInt64" },
    { delta_ticks: "-0" }, { delta_ticks: "0" }, { delta_ticks: "-01" }, { delta_ticks: -1 }, { delta_ticks: "-2" },
    { child_filetime: "134383440000000102", delta_ticks: "1" }, { parent_pid: 7001 }, { owned: true },
  ])("rejects malformed or unbound diagnostic fields %j", change => {
    expect(() => parseWindowsBrowserAncestryFailure({ ...evidence(), ...change }, history)).toThrow("Invalid protected browser ancestry failure evidence");
  });
  it.each(Object.keys(evidence()))("requires field %s", key => {
    const source: Record<string, unknown> = evidence(); delete source[key];
    expect(() => parseWindowsBrowserAncestryFailure(source, history)).toThrow();
  });
  it.each(["root_filetime", "parent_filetime", "child_filetime", "delta_ticks"].flatMap(field =>
    ["\n", "\r\n", "\u2028", "\u2029"].map(suffix => ({ field, suffix }))))("rejects trailing line terminators in $field: $suffix", ({ field, suffix }) => {
    const source = evidence();
    expect(() => parseWindowsBrowserAncestryFailure({ ...source, [field]: source[field as keyof typeof source] + suffix }, history)).toThrow();
  });
  it.each([null, [], "diagnostic", Object.create(null)])("rejects non-record values %j", value => {
    expect(() => parseWindowsBrowserAncestryFailure(value, history)).toThrow();
  });
  it("does not invoke an accessor or retain symbol fields", () => {
    const source = evidence(), getter = vi.fn(() => "134383440000000100");
    Object.defineProperty(source, "child_filetime", { get: getter });
    expect(() => parseWindowsBrowserAncestryFailure(source, history)).toThrow(); expect(getter).not.toHaveBeenCalled();
    expect(() => parseWindowsBrowserAncestryFailure({ ...evidence(), [Symbol("extra")]: true }, history)).toThrow();
  });
  it.each([{ parentPid: 7001, pids: [] }, { parentPid: 7001, pids: [7002, 7003, 7003] }, { parentPid: 7001, pids: [7001, 7002, 7003] }])(
    "cannot supply or repair invalid exit history %j", binding => {
      expect(() => parseWindowsBrowserAncestryFailure(evidence(), binding)).toThrow();
    });
});

const boundEvidence = () => ({ version: 1, boundary: "current_subtree", limit: 128, attempt: 1, census: "first", root_pid: 7001,
  root_handle_state: "live", current_count: 129, current_count_is_lower_bound: true, history_count: 3 });
const fullHistory = { parentPid: 7001, pids: Array.from({ length: 127 }, (_, index) => 8000 + index) };

describe("bounded browser process-count negative evidence", () => {
  it.each(["live", "exited", "unavailable"])("keeps the original HANDLE state %s as negative facts only", root_handle_state => {
    const source = { ...boundEvidence(), root_handle_state }, result = parseWindowsBrowserObservationBoundFailure(source, history);
    expect(result).toEqual(source); expect(result).not.toBe(source); expect(Object.isFrozen(result)).toBe(true);
    source.current_count = 5000; expect(result.current_count).toBe(129);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(384);
  });
  it.each(["first", "second", "corroborating"])("distinguishes the history union guard at %s from a raw subtree count", census => {
    const source = { ...boundEvidence(), boundary: "history_union", attempt: 3, census,
      current_count: 2, current_count_is_lower_bound: false, history_count: 128 };
    expect(parseWindowsBrowserObservationBoundFailure(source, fullHistory)).toEqual(source);
    expect(parseWindowsBrowserObservationBoundFailure({ ...source, current_count: 128 }, fullHistory).current_count).toBe(128);
  });
  it("permits an empty retained history when raw selection failed before registration", () => {
    expect(parseWindowsBrowserObservationBoundFailure({ ...boundEvidence(), history_count: 1 }, { parentPid: 7001, pids: [] }).history_count).toBe(1);
  });
  it.each([
    { version: 2 }, { version: "1" }, { boundary: "global_inventory" }, { limit: 129 }, { limit: "128" },
    { attempt: 0 }, { attempt: 4 }, { attempt: 1.5 }, { attempt: "1" }, { census: "final" },
    { root_pid: 7002 }, { root_pid: "7001" }, { root_handle_state: "owned" }, { root_handle_state: true },
    { current_count: 128 }, { current_count: 130 }, { current_count: "129" }, { current_count_is_lower_bound: false },
    { current_count_is_lower_bound: 1 }, { history_count: 0 }, { history_count: 2 }, { history_count: 4 }, { history_count: "3" },
    { command_line: "do not serialize" }, { processes: [] }, { owned: true },
  ])("rejects malformed, unbound, or non-closed fields %j", change => {
    expect(() => parseWindowsBrowserObservationBoundFailure({ ...boundEvidence(), ...change }, history)).toThrow("Invalid protected browser observation bound failure evidence");
  });
  it.each([
    { history_count: 3 }, { current_count: 1 }, { current_count: 129 }, { current_count: 2.5 },
    { current_count: "2" }, { current_count_is_lower_bound: true },
  ])("rejects inconsistent history-union facts %j", change => {
    const source = { ...boundEvidence(), boundary: "history_union", current_count: 2, current_count_is_lower_bound: false, history_count: 128 };
    expect(() => parseWindowsBrowserObservationBoundFailure({ ...source, ...change }, fullHistory)).toThrow();
  });
  it.each(Object.keys(boundEvidence()))("requires count diagnostic field %s", key => {
    const source: Record<string, unknown> = boundEvidence(); delete source[key];
    expect(() => parseWindowsBrowserObservationBoundFailure(source, history)).toThrow();
  });
  it.each([null, [], "diagnostic", Object.create(null)])("rejects a non-record count diagnostic %j", value => {
    expect(() => parseWindowsBrowserObservationBoundFailure(value, history)).toThrow();
  });
  it("does not execute accessors or accept symbol fields", () => {
    const source = boundEvidence(), getter = vi.fn(() => 129);
    Object.defineProperty(source, "current_count", { get: getter });
    expect(() => parseWindowsBrowserObservationBoundFailure(source, history)).toThrow(); expect(getter).not.toHaveBeenCalled();
    expect(() => parseWindowsBrowserObservationBoundFailure({ ...boundEvidence(), [Symbol("extra")]: true }, history)).toThrow();
  });
  it.each([
    { parentPid: 0, pids: [7002, 7003] }, { parentPid: 7001, pids: [7001, 7003] },
    { parentPid: 7001, pids: [7002, 7002] }, { parentPid: 7001, pids: [7002, 0x100000000] },
    { parentPid: 7001, pids: Array.from({ length: 128 }, (_, index) => 8000 + index) },
  ])("cannot provide or repair an invalid cleanup history %j", binding => {
    expect(() => parseWindowsBrowserObservationBoundFailure({ ...boundEvidence(), history_count: binding.pids.length + 1 }, binding)).toThrow();
  });
});
