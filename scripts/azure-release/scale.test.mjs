import test from "node:test";
import assert from "node:assert/strict";
import { command } from "./support.mjs";
import { imageUpdateArguments, policyForPhase } from "./policy.mjs";
import { validateScaleConfiguration, verifyScaleConfiguration } from "./scale.mjs";

const snapshot = (scale) => ({ properties: { template: { scale } } });

test("preparation accepts only explicit zero-or-one minimum and one maximum", () => {
  for (const minReplicas of [0, 1]) {
    const original = { minReplicas, maxReplicas: 1, pollingInterval: 30, rules: [] };
    const before = structuredClone(original);
    assert.deepEqual(validateScaleConfiguration(original), { minReplicas, maxReplicas: 1 });
    assert.deepEqual(original, before);
  }
  for (const invalid of [
    undefined,
    null,
    [],
    {},
    { minReplicas: 0 },
    { maxReplicas: 1 },
    { minReplicas: null, maxReplicas: 1 },
    { minReplicas: false, maxReplicas: 1 },
    { minReplicas: "0", maxReplicas: 1 },
    { minReplicas: "1", maxReplicas: 1 },
    { minReplicas: 0.5, maxReplicas: 1 },
    { minReplicas: -1, maxReplicas: 1 },
    { minReplicas: 2, maxReplicas: 1 },
    { minReplicas: NaN, maxReplicas: 1 },
    { minReplicas: Infinity, maxReplicas: 1 },
    { minReplicas: 0, maxReplicas: null },
    { minReplicas: 0, maxReplicas: "1" },
    { minReplicas: 1, maxReplicas: true },
    { minReplicas: 0, maxReplicas: 0 },
    { minReplicas: 1, maxReplicas: -1 },
    { minReplicas: 1, maxReplicas: 1.5 },
    { minReplicas: 0, maxReplicas: 2 },
    { minReplicas: 1, maxReplicas: 2 },
    { minReplicas: 2, maxReplicas: 2 },
  ]) {
    assert.throws(() => validateScaleConfiguration(invalid), /Expected explicit minReplicas/);
    assert.throws(
      () => imageUpdateArguments([], "server", "image", "release", null, invalid),
      /Expected explicit minReplicas/,
    );
  }
});

test("deployment and recovery argv preserve the original minimum without shell parsing", async () => {
  const plan = { before: { kind: "absent" }, update: null };
  for (const minReplicas of [0, 1]) {
    const state = { snapshot: snapshot({ minReplicas, maxReplicas: 1 }) };
    for (const phase of ["deploy", "recover"]) {
      const scale = validateScaleConfiguration(state.snapshot.properties.template.scale);
      const policy = policyForPhase(plan, phase);
      const args = imageUpdateArguments(["--name", "fixture-app"], "server", "image", "release", policy.write, scale);
      const observed = JSON.parse(
        await command(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", ...args]),
      );
      assert.deepEqual(observed, [
        "containerapp",
        "update",
        "--name",
        "fixture-app",
        "--container-name",
        "server",
        "--image",
        "image",
        "--revision-suffix",
        "release",
        "--min-replicas",
        String(minReplicas),
        "--max-replicas",
        "1",
        ...(phase === "recover" ? ["--remove-env-vars", "ARTOO_AI_DATA_SHARING_POLICY"] : []),
      ]);
    }
  }
});

test("Azure readback rejects a changed valid minimum, missing scale or multiple replicas", () => {
  for (const minReplicas of [0, 1]) {
    const expected = { minReplicas, maxReplicas: 1 };
    verifyScaleConfiguration(snapshot({ ...expected, rules: [] }), expected);
    assert.throws(
      () => verifyScaleConfiguration(snapshot({ minReplicas: 1 - minReplicas, maxReplicas: 1 }), expected),
      /differs from the original/,
    );
    for (const invalid of [undefined, {}, { minReplicas, maxReplicas: 2 }]) {
      assert.throws(() => verifyScaleConfiguration(snapshot(invalid), expected), /Expected explicit/);
    }
    assert.throws(() => verifyScaleConfiguration({}, expected), /Expected explicit/);
  }
});
