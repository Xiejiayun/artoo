import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { verifySimulatorClipboardEvidence } from "./ios-ui-clipboard-evidence.mjs";

const simulatorUDID = "11111111-1111-1111-1111-111111111111";
function valid() {
  return [1, 2, 3, 4].flatMap((n) => ["seed", "read", "clear"].map((action) => {
    const value = action === "clear" ? "" : action === "seed" ? `sentinel${n}` : `actual copied bytes ${n}`;
    return { action, simulator_udid: simulatorUDID, probe_id: `00000000-0000-0000-0000-00000000000${n}`,
      origin: "request", byte_length: Buffer.byteLength(value), sha256: createHash("sha256").update(value).digest("hex") };
  }));
}
const verify = (receipts) => verifySimulatorClipboardEvidence({ receipts, simulatorUDID, expectedProbes: 4 });
test("requires four serial changed-value native Copy probes", () => {
  assert.equal(verify(valid()).probes, 4);
  assert.throws(() => verify(valid().slice(0, -3)));
  assert.throws(() => verify(valid().slice(0, -1)));
});
test("cleanup, observer error, stale sentinel and another simulator cannot manufacture acceptance", () => {
  for (const mutate of [
    (v) => { v[2].origin = "cleanup"; },
    (v) => { v[1].action = "error"; },
    (v) => { v[1].sha256 = v[0].sha256; },
    (v) => { v[1].simulator_udid = "22222222-2222-2222-2222-222222222222"; },
    (v) => { v[3].probe_id = v[0].probe_id; },
    (v) => { v[2].byte_length = 1; },
    (v) => { v[2].sha256 = "a".repeat(64); },
  ]) { const receipts = valid(); mutate(receipts); assert.throws(() => verify(receipts)); }
});
