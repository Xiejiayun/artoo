// Controlled recovery worker: fresh local preparation and actual HTTP against disk-backed publication.
// It does not invoke a provider, inject verification evidence, or represent production delivery.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ProductReleaseRequestSchema } from "@artoo/domain";
import { prepareVerificationProfiles } from "../dist/verification.js";
import { createProductReleaseExecutor, prepareReleaseProfiles } from "../dist/product-release.js";

const { rawVerifier, rawProfile, request: input } = JSON.parse(readFileSync(process.argv[2], "utf8"));
const request = ProductReleaseRequestSchema.parse(input);
assert.ok(request.acceptance_binding, "This worker exercises the new persisted acceptance binding");
const [profile] = prepareReleaseProfiles([rawProfile], prepareVerificationProfiles([rawVerifier]));
const executor = createProductReleaseExecutor([profile]);
let parentClosed = false;
// If the owning test process disappears, stop serving rather than orphaning this listener.
const parentExit = () => { parentClosed = true; executor.requestStop(); void executor.stop().catch(() => { process.exitCode = 1; }); };
process.stdin.once("end", parentExit); process.stdin.resume();
try {
  let result;
  try {
    await executor.start();
    const read = executor.getCapabilityReader(profile.id), capability = read();
    assert.deepEqual(capability.binding, request.acceptance_binding.release_binding);
    const receipt = await executor.release(request);
    assert.equal(receipt.outcome, "published", receipt.reason);
    const response = await fetch(profile.public_url, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(profile.health_timeout_ms) });
    const bytes = Buffer.from(await response.arrayBuffer());
    const http = { status: response.status, release_id: response.headers.get("x-artoo-release-id"),
      artifact_digest: response.headers.get("x-artoo-artifact-digest"), body_digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
    assert.equal(http.status, 200); assert.equal(http.release_id, request.release_id); assert.equal(http.artifact_digest, request.subject_digest);
    assert.equal(http.body_digest, receipt.health_checks.find(check => check.path === "/").body_digest);
    await executor.checkHealth();
    const health = executor.getHealthReports().find(item => item.request.release_id === request.release_id);
    assert.equal(health.state, "healthy"); assert.deepEqual(health.request, request);
    result = { version: 1, worker_pid: process.pid, capability_binding: capability.binding, receipt, health, http };
  } finally {
    await executor.stop(); process.stdin.removeListener("end", parentExit); process.stdin.destroy();
  }
  assert.equal(parentClosed, false, "The parent must remain present through recovery and closure");
  process.stdout.write(`${JSON.stringify({ ...result, executor_stopped: true })}\n`);
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1;
}
