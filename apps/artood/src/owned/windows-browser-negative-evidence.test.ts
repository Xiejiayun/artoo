import { describe, expect, it, vi } from "vitest";
import { parseWindowsBrowserAncestryFailure, parseWindowsBrowserBoundFailure } from "./windows-browser-negative-evidence.js";

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

describe("bounded browser observation count evidence", () => {
  const boundHistory = { parentPid: 7001, pids: Array.from({ length: 127 }, (_, index) => 8000 + index) };
  const evidence = () => ({ version: 1, source: "current_subtree", count: 128, attempt: 1, census: "first", root_pid: 7001 });
  it.each(["current_subtree", "history_union"])("copies only the fixed %s failure facts", source => {
    for (const [attempt, census] of [[1, "first"], [2, "second"], [3, "corroborating"]] as const) {
      const input = { ...evidence(), source, attempt, census }, result = parseWindowsBrowserBoundFailure(input, boundHistory);
      expect(result).toEqual(input); expect(Object.isFrozen(result)).toBe(true); expect(result).not.toBe(input);
      input.root_pid = 8001; expect(result.root_pid).toBe(7001);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(192);
    }
  });
  it.each([{ version: 2 }, { source: "owned" }, { count: 127 }, { count: 129 }, { count: "128" },
    { attempt: 0 }, { attempt: 4 }, { attempt: 1.5 }, { attempt: "1" }, { census: "final" },
    { root_pid: 8001 }, { root_pid: "7001" }, { profile: "private" }, { pids: [9001] }])("rejects malformed or unbound fields %j", change => {
    expect(() => parseWindowsBrowserBoundFailure({ ...evidence(), ...change }, boundHistory)).toThrow("Invalid protected browser bound failure evidence");
  });
  it.each(Object.keys(evidence()))("requires field %s", key => {
    const source: Record<string, unknown> = evidence(); delete source[key];
    expect(() => parseWindowsBrowserBoundFailure(source, boundHistory)).toThrow();
  });
  it("does not use a count to fill missing history or invoke accessors", () => {
    expect(parseWindowsBrowserBoundFailure(evidence(), { parentPid: 7001, pids: [] }).source).toBe("current_subtree");
    expect(() => parseWindowsBrowserBoundFailure({ ...evidence(), source: "history_union" }, history)).toThrow();
    const input = evidence(), getter = vi.fn(() => 128); Object.defineProperty(input, "count", { get: getter });
    expect(() => parseWindowsBrowserBoundFailure(input, boundHistory)).toThrow(); expect(getter).not.toHaveBeenCalled();
    expect(() => parseWindowsBrowserBoundFailure({ ...evidence(), [Symbol("extra")]: true }, boundHistory)).toThrow();
    for (const value of [null, [], "diagnostic", Object.create(null)]) {
      expect(() => parseWindowsBrowserBoundFailure(value, boundHistory)).toThrow();
    }
    for (const binding of [{ parentPid: 0, pids: [] }, { parentPid: 7001, pids: [7001] },
      { parentPid: 7001, pids: [7002, 7002] }, { parentPid: 7001, pids: Array.from({ length: 128 }, (_, i) => 8000 + i) }]) {
      expect(() => parseWindowsBrowserBoundFailure(evidence(), binding)).toThrow();
    }
  });
});
