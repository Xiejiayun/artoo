import { check } from "./support.mjs";

/** Preserve an explicit scale-to-zero or always-on single-replica policy. */
export function validateScaleConfiguration(scale) {
  check(
    scale !== null &&
      typeof scale === "object" &&
      !Array.isArray(scale) &&
      (scale.minReplicas === 0 || scale.minReplicas === 1) &&
      scale.maxReplicas === 1,
    "Expected explicit minReplicas 0 or 1 and maxReplicas 1.",
  );
  return { minReplicas: scale.minReplicas, maxReplicas: scale.maxReplicas };
}

export function verifyScaleConfiguration(snapshot, expected) {
  const actual = validateScaleConfiguration(snapshot?.properties?.template?.scale);
  const wanted = validateScaleConfiguration(expected);
  check(
    actual.minReplicas === wanted.minReplicas && actual.maxReplicas === wanted.maxReplicas,
    "Azure replica scale configuration differs from the original release state.",
  );
}
