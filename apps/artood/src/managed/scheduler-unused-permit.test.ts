import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Journal, JournalRun } from "./journal-types.js";
import { ManagedDelivery, type ManagedEventChannel } from "./managed-delivery.js";
import { readSchedulerUnusedPermit } from "./scheduler-unused-permit.js";

function fixture() {
  const namespace = randomUUID(),
    grantId = randomUUID(),
    nodeAttemptId = randomUUID();
  const payload = {
    version: 1,
    scope: "scheduler-unused-permit.v1",
    grant_id: grantId,
    journal_namespace: namespace,
    node_attempt_id: nodeAttemptId,
    process_never_started: true,
  };
  const receipt = {
    id: randomUUID(),
    namespace,
    nodeId: "node",
    runId: "run",
    launchKey: "a".repeat(64),
    ownerRevision: 3,
    kind: "not_started_fenced" as const,
    contentJson: "",
  };
  receipt.contentJson = JSON.stringify({
    version: 1,
    namespace,
    nodeId: "node",
    runId: "run",
    launchKey: receipt.launchKey,
    ownerRevision: 3,
    kind: receipt.kind,
    detail: payload,
  });
  const run: JournalRun = {
    namespace,
    runId: "run",
    mode: "per-run",
    launchKey: receipt.launchKey,
    revision: 3,
    phase: "closed",
    stopRequested: true,
    ownership: "fenced",
    receipt,
    liveAbort: null,
    schedulerStartGrant: {
      version: 1,
      grantId,
      readyId: randomUUID(),
      nodeAttemptId,
      proposalDigest: `sha256:${"a".repeat(64)}`,
      grantDigest: `sha256:${"b".repeat(64)}`,
    },
    finalOutcomeJson: JSON.stringify({ schedulerUnusedPermit: { type: "scheduler.permit_unused", payload } }),
  };
  const delivery = new ManagedDelivery({ namespace } as Journal, undefined, "node", "run", {} as ManagedEventChannel);
  return { payload, run, delivery };
}
describe("explicit scheduler never-started settlement scope", () => {
  it("keeps the existing physical closure consumer strict and uses the independent scope", () => {
    const f = fixture();
    expect(readSchedulerUnusedPermit(f.run)).toEqual(f.payload);
    expect(() => f.delivery.useClosed(f.run)).toThrow("physical settlement");
    f.delivery.useUnusedSchedulerPermit(f.run);
    f.delivery.useUnusedSchedulerPermit(f.run);
  });
  it("does not reinterpret old fences as unused scheduler authority", () => {
    const f = fixture();
    const run = {
      ...f.run,
      receipt: { ...f.run.receipt!, contentJson: JSON.stringify({ detail: { scope: "run-wide-permanent-fence" } }) },
    };
    expect(readSchedulerUnusedPermit(run)).toBeUndefined();
    expect(() => f.delivery.useUnusedSchedulerPermit(run)).toThrow("exact original unused");
  });
  it.each(["namespace", "grant", "attempt", "event"])("rejects changed original %s identity", (field) => {
    const f = fixture(),
      run = structuredClone(f.run);
    if (field === "namespace") Object.assign(run, { namespace: randomUUID() });
    if (field === "grant") Object.assign(run.schedulerStartGrant!, { grantId: randomUUID() });
    if (field === "attempt") Object.assign(run.schedulerStartGrant!, { nodeAttemptId: randomUUID() });
    if (field === "event")
      Object.assign(run, {
        finalOutcomeJson: JSON.stringify({ terminal: { type: "run.lifecycle", payload: { phase: "cancelled" } } }),
      });
    expect(() => readSchedulerUnusedPermit(run)).toThrow();
    expect(() => f.delivery.useUnusedSchedulerPermit(run)).toThrow();
  });
});
