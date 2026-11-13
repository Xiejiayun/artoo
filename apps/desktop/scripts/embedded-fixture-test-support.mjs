import assert from "node:assert/strict";
import ts from "typescript";

/** Read the actual embedded fixture writer without depending on its formatting. */
export function packagedFixtureWriter(source) {
  const file = ts.createSourceFile("packaged-e2e-smoke.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(file.parseDiagnostics.length, 0, "Packaged smoke source must parse");
  const writers = [];
  const visit = (node) => {
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
      const call = node.expression;
      if (
        ts.isIdentifier(call.expression) &&
        call.expression.text === "writeFileSync" &&
        call.arguments.length === 2 &&
        ts.isIdentifier(call.arguments[0]) &&
        call.arguments[0].text === "fixtureEntry" &&
        ts.isTemplateExpression(call.arguments[1])
      )
        writers.push(node.getText(file));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.equal(writers.length, 1, "Exactly one real embedded fixture writer is required");
  return writers[0];
}
