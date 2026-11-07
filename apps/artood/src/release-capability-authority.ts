import { isDeepStrictEqual } from "node:util";
import { ReleaseCapabilitiesV1Schema, type ContextPack, type ReleaseCapabilitiesV1 } from "@artoo/domain";

/** Installed by node composition only. Serialized capability data never grants this authority. */
export type ReleaseCapabilityReader = () => ReleaseCapabilitiesV1;

export function assertReleaseCapabilityContext(context: ContextPack | undefined,
  read: ReleaseCapabilityReader | undefined): ReleaseCapabilitiesV1 | undefined {
  const supplied = context?.release_capabilities;
  if (!read) {
    if (supplied !== undefined) throw new Error("Release capabilities require the node's local binding");
    return undefined;
  }
  const expected = ReleaseCapabilitiesV1Schema.parse(read()), parsed = ReleaseCapabilitiesV1Schema.safeParse(supplied);
  if (!parsed.success || !isDeepStrictEqual(parsed.data, expected)) throw new Error("Release capabilities differ from the node's local binding");
  if (!context || context.project.id !== expected.binding.project_id || context.workspace.root !== expected.binding.workspace_root
    || !context.goal_context?.plan) throw new Error("Release capabilities require the exact project, workspace and goal plan");
  return expected;
}
