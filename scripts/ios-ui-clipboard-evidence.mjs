import assert from "node:assert/strict";

/** Infrastructure probe integrity only. Exact expected UTF-8 equality and the
 * real visible Copy tap remain assertions in the native XCTest. */
export function verifySimulatorClipboardEvidence({ receipts, simulatorUDID, expectedProbes }) {
  assert.ok(Array.isArray(receipts) && Number.isSafeInteger(expectedProbes) && expectedProbes > 0);
  const completed = new Set(); let active, reads = 0;
  for (const receipt of receipts) {
    assert.equal(receipt.simulator_udid, simulatorUDID, "Clipboard evidence must target the selected simulator");
    assert.equal(receipt.origin, "request", "Cleanup cannot satisfy an unfinished native Copy probe");
    assert.ok(["seed", "read", "clear"].includes(receipt.action), "Every clipboard observer operation must succeed");
    assert.ok(typeof receipt.probe_id === "string" && /^[a-f0-9-]{36}$/i.test(receipt.probe_id));
    assert.ok(Number.isSafeInteger(receipt.byte_length) && receipt.byte_length >= 0 && receipt.byte_length <= 16_384);
    assert.match(receipt.sha256, /^[a-f0-9]{64}$/);
    if (receipt.action === "seed") {
      assert.equal(active, undefined, "Copy probes must be serial and fully cleaned up");
      assert.ok(!completed.has(receipt.probe_id) && receipt.byte_length > 0, "Each Copy probe needs a fresh nonempty sentinel");
      active = { id: receipt.probe_id, sentinel: receipt.sha256, reads: 0, last: receipt.sha256 };
    } else {
      assert.equal(receipt.probe_id, active?.id, "Observation must belong to the active Copy probe");
      if (receipt.action === "read") { active.reads++; reads++; active.last = receipt.sha256; }
      else {
        assert.ok(active.reads > 0 && active.last !== active.sentinel, "Native Copy must replace its stale sentinel before cleanup");
        assert.equal(receipt.byte_length, 0, "Copy probe cleanup must observe an empty simulator pasteboard");
        assert.equal(receipt.sha256, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "Empty pasteboard bytes must retain their exact digest");
        completed.add(active.id); active = undefined;
      }
    }
  }
  assert.equal(active, undefined, "No Copy probe may remain unfinished");
  assert.equal(completed.size, expectedProbes, "Every required native path/branch Copy check must have its own probe");
  return { passed: true, probes: completed.size, reads, simulator_udid: simulatorUDID,
    scope: "Simulator probe integrity; original expected UTF-8 equality is asserted by XCTest" };
}
