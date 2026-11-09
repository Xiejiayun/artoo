// Controlled parser/policy cases, not real NTFS or kernel-EA qualification.
import { describe, expect, it } from "vitest";
import { isWindowsSealedRecordAudit, isWindowsSealedRecordBinding, isWindowsSealedRecordIntegrity,
  type WindowsSealedRecordAuditV1, type WindowsSealedRecordBindingV1 } from "./windows-sealed-record-observer.js";
const binding: WindowsSealedRecordBindingV1 = { version: 1, dev: "42", ino: "9007199254740993", size: "148",
  mtimeNs: "1790000000000000100", sha256: "sha256:" + "a".repeat(64) };
const initialCtime = 1790000000000000200n, finalCtime = 1790000000000000300n;
function fixture(): WindowsSealedRecordAuditV1 {
  const before = { ...binding, ctimeNs: initialCtime.toString(), birthtimeNs: binding.mtimeNs, attributes: 32, links: 1,
    securitySha256: "sha256:" + "b".repeat(64), eas: [], streams: [{ name: "::$DATA", size: binding.size, allocation: "4096" }] };
  const { version: _version, ...snapshot } = before;
  return { version: 1, before: snapshot, after: { ...structuredClone(snapshot), ctimeNs: finalCtime.toString(), eas: [{
    name: "$KERNEL.SEC.ENDPOINTDLP", flags: 0, bytes: 192, sha256: "sha256:" + "c".repeat(64), containsExpectedSha256: false,
  }] } };
}
const accepted = (value: WindowsSealedRecordAuditV1) => isWindowsSealedRecordIntegrity(value, binding);
describe("original-writer sealed dispatch semantic integrity", () => {
  it("requires the independent writer digest and identity even when both snapshots agree", () => {
    const value = fixture(); expect(accepted(value)).toBe(true);
    expect(isWindowsSealedRecordIntegrity(value, { ...binding, ino: "7" })).toBe(false);
    expect(isWindowsSealedRecordIntegrity(value, { ...binding, sha256: "sha256:" + "d".repeat(64) })).toBe(false);
    for (const field of ["dev", "ino", "size", "mtimeNs", "sha256"] as const) {
      const changed = fixture(), replacement = field === "sha256" ? "sha256:" + "d".repeat(64) : "99";
      changed.before[field] = replacement; changed.after[field] = replacement;
      expect(accepted(changed)).toBe(false);
    }
  });
  it.each(["dev", "ino", "size", "mtimeNs", "sha256", "securitySha256", "birthtimeNs", "attributes", "links"] as const)("rejects changed %s", field => {
    const value = fixture();
    (value.after as unknown as Record<string, unknown>)[field] = typeof value.after[field] === "number" ? 64
      : field.endsWith("Sha256") || field === "sha256" ? "sha256:" + "d".repeat(64) : "99";
    expect(accepted(value)).toBe(false);
  });
  it("rejects extra streams, changed default stream facts and unsupported file kinds", () => {
    const stream = fixture(); stream.after.streams.push({ name: ":hidden:$DATA", size: "0", allocation: "0" }); expect(accepted(stream)).toBe(false);
    const allocation = fixture(); allocation.after.streams[0]!.allocation = "8192"; expect(accepted(allocation)).toBe(false);
    for (const attributes of [16, 1024]) {
      const value = fixture(); value.before.attributes = value.after.attributes = attributes; expect(accepted(value)).toBe(false);
    }
  });
  it("accepts arbitrary bounded ctime diagnostics without an EA or a monotonic interval requirement", () => {
    for (const times of [["0", "0"], ["1", "999"], ["999", "1"]]) {
      const value = fixture(); value.before.ctimeNs = times[0]!; value.after.ctimeNs = times[1]!;
      value.before.eas = []; value.after.eas = []; expect(accepted(value)).toBe(true);
    }
  });
  it.each(["USER.DATA", "$KERNEL.UNKNOWN", "$KERNEL.PURGE.SEC.FILEHASH"])("does not grant authority through %s names, flags, size or embedded hashes", name => {
    const value = fixture(); value.after.eas = [{ name, flags: 255, bytes: 65535,
      sha256: "sha256:" + "d".repeat(64), containsExpectedSha256: false }];
    expect(accepted(value)).toBe(true);
    value.before.eas = structuredClone(value.after.eas); expect(accepted(value)).toBe(true);
    value.after.eas[0]!.sha256 = "sha256:" + "e".repeat(64); expect(accepted(value)).toBe(true);
    value.after.eas = []; expect(accepted(value)).toBe(true);
  });
  it("still requires complete bounded diagnostics and exact report fields", () => {
    const duplicate = fixture(); duplicate.after.eas.push({ ...duplicate.after.eas[0]! }); expect(accepted(duplicate)).toBe(false);
    const overflow = fixture(); overflow.after.eas[0]!.bytes = 65536; expect(accepted(overflow)).toBe(false);
    const malformedTime = fixture(); malformedTime.after.ctimeNs = "-1"; expect(accepted(malformedTime)).toBe(false);
    expect(isWindowsSealedRecordAudit({ ...fixture(), trusted: true }, binding)).toBe(false);
    expect(isWindowsSealedRecordAudit({ version: 1, before: fixture().before }, binding)).toBe(false);
    expect(isWindowsSealedRecordBinding({ ...binding, allowCtimeChange: true })).toBe(false);
    expect(isWindowsSealedRecordBinding({ ...binding, size: "65537" })).toBe(false);
    expect(isWindowsSealedRecordBinding({ ...binding, ino: "01" })).toBe(false);
  });
});
