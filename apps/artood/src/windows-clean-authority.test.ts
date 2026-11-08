import { describe, expect, it } from "vitest";
import { consumeOriginalSupervisedCleanClosure, startCleanWindowsSupervisor, type PreparedSupervisedCleanClosure } from "./windows-clean-supervised-owner.js";
import { sourceLifecycleObserverIdentity, readAuthenticatedSourceCleanRestartGrant, consumeAuthenticatedSourceCleanRestartGrant,
  openSourceLifecycleObserver, type PreparedSourceLifecycleObserver, type AuthenticatedSourceCleanRestartGrant } from "./source-lifecycle-observer.js";
import { readCleanSupervisorConfiguration, assertCleanSourceLineage, describeCleanRestartGeneration,
  readCleanDaemonQuarantine, readCleanDaemonVerificationProfile, bindCleanDaemonGuardian,
  type PreparedCleanSupervisorConfiguration, type PreparedCleanSourceGeneration, type PreparedCleanDaemonConfiguration } from "./windows-clean-local-configuration.js";
import { readCleanDaemonCheckpoint, type PreparedCleanDaemonCheckpoint } from "./windows-clean-daemon-client.js";
import type { SourceCleanStopIntentV1 } from "@artoo/domain";
import type { PreparedWindowsGuardian } from "./owned/windows-runtime-guardian.js";
import { readCleanGuardianProductSourceConfiguration, type PreparedProductSourceRuntime } from "./product-source-runtime.js";

describe("clean lifecycle original-object authority boundaries", () => {
  it("rejects a copied successful process/Job transcript as a closure token", () => {
    const transcript = JSON.parse(JSON.stringify({ version: 1, kind: "whole-supervisor-job-closed.v1", job_empty_observed: true,
      normal_daemon_shutdown: true, parent: { spawned: true, exited: true, closed: true, stdout_eof: true, stderr_eof: true,
        exit_code: 0, close_code: 0, signal: null, close_signal: null, inputs_unchanged: true } }));
    expect(() => consumeOriginalSupervisedCleanClosure(transcript as PreparedSupervisedCleanClosure,
      {} as PreparedSourceLifecycleObserver, {} as SourceCleanStopIntentV1)).toThrow(/original unconsumed supervised closure/);
  });
  it("rejects observer identity and saved challenge JSON without the original socket", () => {
    expect(() => sourceLifecycleObserverIdentity({ observer_id: "00000000-0000-4000-8000-000000000001", challenge: "a".repeat(64) } as unknown as PreparedSourceLifecycleObserver)).toThrow(/Original live source lifecycle observer/);
  });
  it("rejects a saved Server grant without its original parent connection", () => {
    const copied = { version: 1, scope: "unverified-h7-recovery" } as unknown as AuthenticatedSourceCleanRestartGrant;
    expect(() => readAuthenticatedSourceCleanRestartGrant(copied, {} as PreparedSourceLifecycleObserver)).toThrow(/authenticated restart grant/);
    expect(() => consumeAuthenticatedSourceCleanRestartGrant(copied, {} as PreparedSourceLifecycleObserver)).toThrow(/authenticated restart grant/);
  });
  it("rejects configuration descriptions before any native process can be started", () => {
    const copied = { policyDigest: "sha256:" + "a".repeat(64) } as unknown as PreparedCleanSupervisorConfiguration;
    expect(() => readCleanSupervisorConfiguration(copied)).toThrow(/Original prepared clean supervisor configuration/);
    expect(() => startCleanWindowsSupervisor({ configuration: copied, observer: {} as PreparedSourceLifecycleObserver })).toThrow();
  });
  it("never adopts a generation from a grant file or retained directory path", () => {
    const copied = { generation_id: "00000000-0000-4000-8000-000000000002", store_root: "C:\\retained" } as unknown as PreparedCleanSourceGeneration;
    expect(() => assertCleanSourceLineage(copied)).toThrow(/Original in-process source store lineage/);
    expect(() => describeCleanRestartGeneration(copied)).toThrow(/Original in-process source store lineage/);
  });
  it("does not deserialize parent configuration or Server checkpoint JSON as daemon authority", () => {
    const config = { observer_id: "00000000-0000-4000-8000-000000000003", expected_grant: { scope: "unverified-h7-recovery" } } as unknown as PreparedCleanDaemonConfiguration;
    expect(() => readCleanDaemonQuarantine(config)).toThrow(/Original native clean daemon configuration/);
    expect(() => readCleanDaemonVerificationProfile(config, "native-web")).toThrow(/Original native clean daemon configuration/);
    expect(() => bindCleanDaemonGuardian(config, {} as PreparedWindowsGuardian)).toThrow(/Original native clean daemon configuration/);
    expect(() => readCleanGuardianProductSourceConfiguration({} as PreparedProductSourceRuntime,
      {} as PreparedWindowsGuardian, config)).toThrow(/original live local runtime/);
    const checkpoint = { source_state: "unverified", receipt: { source_state: "unverified" } } as unknown as PreparedCleanDaemonCheckpoint;
    expect(() => readCleanDaemonCheckpoint(checkpoint)).toThrow(/Original accepted clean daemon checkpoint/);
  });
  it.each(["ws://example.com/api/v1/node?token=dev", "ws://127.0.0.1/api/v1/node?token=dev",
    "ws://127.0.0.1/api/v1/node/source-lifecycle?token=dev", "ws://user:password@127.0.0.1/api/v1/node?token=dev"])
  ("refuses an unpaired or substituted endpoint before opening a socket: %s", async nodeUrl => {
    await expect(openSourceLifecycleObserver({ nodeUrl, nodeId: "node" })).rejects.toThrow(/exact paired endpoint/);
  });
});
