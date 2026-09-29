// Optional Windows syntax check. Install parser tools in a temporary directory,
// then pass that directory as argv[2]. This does not replace Xcode type checking.
const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const runtime = process.argv[2];
  if (!runtime) throw new Error("Usage: node check-swift-syntax.cjs <temporary parser directory>");
  const Parser = require(path.resolve(runtime, "node_modules/web-tree-sitter"));
  await Parser.init();
  const parser = new Parser();
  parser.setLanguage(await Parser.Language.load(path.resolve(runtime, "node_modules/tree-sitter-wasms/out/tree-sitter-swift.wasm")));
  const root = path.resolve(__dirname, "..");
  const files = ["Sources", "Tests"].flatMap((dir) => fs.readdirSync(path.join(root, dir), { recursive: true })
    .filter((file) => file.endsWith(".swift")).map((file) => path.join(root, dir, file)));
  let errors = 0;
  for (const file of files) {
    const tree = parser.parse(fs.readFileSync(file, "utf8"));
    const visit = (node) => {
      if (node.type === "ERROR" || node.isMissing()) {
        console.error(`${path.relative(root, file)}:${node.startPosition.row + 1}:${node.startPosition.column + 1} ${node.type}: ${node.text.slice(0, 100)}`);
        errors++;
      } else for (const child of node.children) if (child.hasError()) visit(child);
    };
    if (tree.rootNode.hasError()) visit(tree.rootNode);
    tree.delete();
  }
  parser.delete();
  if (errors) throw new Error(`${errors} Swift syntax diagnostics`);
  console.log(`Swift syntax: ${files.length} source/test files parsed without errors (not a type check).`);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
