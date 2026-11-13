import assert from "node:assert/strict";
import test from "node:test";
import { packagedFixtureWriter } from "./embedded-fixture-test-support.mjs";

test("writer discovery preserves actual template bytes across call formatting", () => {
  for (const source of [
    "writeFileSync(fixtureEntry, `start ${fixtureKey} end`);",
    "writeFileSync(\n  fixtureEntry,\n  `start ${fixtureKey} end`,\n);",
  ]) {
    let written;
    new Function("writeFileSync", "fixtureEntry", "fixtureKey", packagedFixtureWriter(source))(
      (path, bytes) => {
        assert.equal(path, "owned-fixture");
        written = bytes;
      },
      "owned-fixture",
      "controlled-key",
    );
    assert.equal(written, "start controlled-key end");
  }
});

test("comments, strings and unrelated writes cannot substitute for or duplicate the fixture writer", () => {
  const actual = "writeFileSync(fixtureEntry, `actual ${fixtureKey}`);";
  assert.equal(
    packagedFixtureWriter(
      `// writeFileSync(fixtureEntry, \`fake\`);\nconst decoy = 'writeFileSync(fixtureEntry, fake)';\nwriteFileSync(other, \`other\`);\n${actual}`,
    ),
    actual,
  );
  for (const source of ["", "writeFileSync(fixtureEntry, 'replacement');", `${actual}\n${actual}`, "writeFileSync("]) {
    assert.throws(() => packagedFixtureWriter(source));
  }
});
