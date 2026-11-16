// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { bootstrapFixture } from "../test/utils.js";
import { squadInstances } from "./useProjectSquad.js";

describe("squadInstances", () => {
  it("admits shared instances only for explicit members and never borrows another project's scope", () => {
    const base = bootstrapFixture().agent_instances[0]!;
    const instances = [
      base,
      { ...base, id: "shared", project_id: null },
      { ...base, id: "foreign", project_id: "other" },
      { ...base, id: "other-agent", project_id: null, agent_id: "not_a_member" },
    ];
    const squad = {
      version: 1 as const,
      project_id: "proj_artoo",
      revision: 1,
      source: "configured" as const,
      agent_ids: [base.agent_id],
    };
    expect(squadInstances(squad, instances).map((value) => value.id)).toEqual([base.id, "shared"]);
    expect(squadInstances({ ...squad, source: "legacy_instances" }, instances).map((value) => value.id)).toEqual([
      base.id,
    ]);
  });
});
