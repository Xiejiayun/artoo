// Controlled route snapshots only. No model, native verifier, import or publication runs here.
import { describe, expect, it } from "vitest";
import { releaseAcceptanceFixture } from "./test-fixtures/release-acceptance.js";
import { selectResearchDestinationSlots } from "./services/research-destination-pool-service.js";
import type { SchedulerCandidate } from "./services/scheduler.js";
import type { ProductSourceDestinationMappingV1, ProductSourceExportV2 } from "@artoo/domain";

function fixture(roots = ["C:/pool/workspace", "C:/pool/slots/1", "C:/pool/slots/2", "C:/pool/slots/3"]) {
  const f = releaseAcceptanceFixture("research"), source = structuredClone(f.release);
  source.binding.workspace_root = "C:/source";
  const mappings: ProductSourceDestinationMappingV1[] = roots.map((root, index) => {
    const release = structuredClone(f.release);
    release.binding.workspace_root = root; release.binding.release_profile_id = `release-${index}`;
    release.binding.verification_profile_id = `verify-${index}`;
    return { source_release: source, destination_release: release,
      command_pairs: f.capabilities.checks.map(check => ({ source_command_id: check.command_id, destination_command_id: check.command_id })) };
  });
  const candidate = (role: string, index: number): SchedulerCandidate => ({ agent_instance_id: `${role}-${index}`, agent_id: role,
    computer_id: "destination", runtime: "codex", model_profile_id: null, effort_profile_id: null, score: 135 });
  const writers = roots.map((_, index) => candidate("author", index)), reviewers = roots.map((_, index) => candidate("peer", index));
  const instances = roots.flatMap((root, index) => [writers[index]!, reviewers[index]!].map(role => ({ id: role.agent_instance_id,
    computerId: role.computer_id, workspaceRoot: root, agentId: role.agent_id, runtime: role.runtime,
    modelProfileId: role.model_profile_id, effortProfileId: role.effort_profile_id })));
  let ids = 0, paired = true, feature = true;
  const ctx: Parameters<typeof selectResearchDestinationSlots>[0] = {
    idGen: { generate: prefix => `${prefix}-${++ids}` },
    getPairedNodeSession: () => paired ? { computerId: "destination", sessionId: "controlled-session", deviceId: "device", tokenLookup: "controlled" } : undefined,
    getProductSourceRouting: () => ({ version: 1, source_exports: [], destination_mappings: mappings }),
    supportsExecutionFeature: () => feature,
    getReleaseCapabilities: (_node, release, _project, root, profile) => mappings.find(mapping => {
      const scope = mapping.destination_release.binding;
      return scope.release_profile_id === release && scope.workspace_root === root && scope.verification_profile_id === profile;
    })?.destination_release,
    getVerificationCapabilities: () => f.capabilities,
  };
  const proof: Pick<ProductSourceExportV2, "source_capabilities" | "measurement_v2"> = {
    source_capabilities: f.capabilities, measurement_v2: { version: 1, source_release: source },
  };
  const input = { computerId: "destination", maxRetries: roots.length - 1, proof, firstMapping: mappings[0]!,
    writer: writers[0]!, reviewer: reviewers[0]!, writers, reviewers, instances };
  return { ctx, input, mappings, writers, reviewers, instances, pair: (value: boolean) => { paired = value; },
    features: (value: boolean) => { feature = value; }, select: () => selectResearchDestinationSlots(ctx, input) };
}

describe("finite research destination pool selection", () => {
  it("keeps the first admitted route and freezes only the bounded same-role prepared slots", () => {
    const f = fixture(), selected = f.select();
    expect(selected).toHaveLength(4);
    expect(selected[0]!.mapping.destination_release.binding.workspace_root).toBe("C:/pool/workspace");
    expect(selected.map(slot => slot.index)).toEqual([0, 1, 2, 3]);
    expect(new Set(selected.flatMap(slot => [slot.writer.instance_id, slot.reviewer.instance_id])).size).toBe(8);
    f.mappings[1]!.destination_release.binding.workspace_root = "C:/changed";
    expect(selected[1]!.mapping.destination_release.binding.workspace_root).toBe("C:/pool/slots/1");
  });

  it.each(["logical-agent", "model", "effort", "runtime", "instance-root"])("does not replace a frozen role after %s drift", change => {
    const f = fixture();
    if (change === "logical-agent") f.reviewers[1]!.agent_id = "other";
    if (change === "model") f.writers[1]!.model_profile_id = "another-model";
    if (change === "effort") f.reviewers[1]!.effort_profile_id = "another-effort";
    if (change === "runtime") f.writers[1]!.runtime = "claude";
    if (change === "instance-root") f.instances.find(instance => instance.id === "author-1")!.workspaceRoot = "C:/other";
    expect(f.select).toThrow(/complete prepared destination pool/);
  });

  it("rejects overlapping normalized Windows scopes instead of leasing a child root", () => {
    const f = fixture(["C:/Pool/Workspace", "c:\\pool\\workspace\\child"]);
    expect(f.select).toThrow(/disjoint physical scopes/);
  });

  it("requires original paired configuration and all target features", () => {
    const f = fixture(); f.pair(false); expect(f.select).toThrow(/no longer prepared/);
    f.pair(true); f.features(false); expect(f.select).toThrow(/complete prepared destination pool/);
  });

  it("rejects a changed source release and never expands a zero-retry selection", () => {
    const f = fixture(); f.input.maxRetries = 0;
    expect(f.select()).toHaveLength(1);
    f.input.maxRetries = 3;
    f.mappings[1]!.source_release = structuredClone(f.mappings[1]!.source_release);
    f.mappings[1]!.source_release.binding.release_profile_digest = "sha256:" + "a".repeat(64);
    expect(f.select).toThrow(/complete prepared destination pool/);
  });

  it.each([-1, 11, 0.5, Infinity])("rejects unsupported retry budget %s", value => {
    const f = fixture(); f.input.maxRetries = value; expect(f.select).toThrow(/finite retry budget/);
  });
});
