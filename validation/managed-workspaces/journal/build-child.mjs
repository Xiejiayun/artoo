// Preparation only: invoke later inside root's reviewed owned build phase.
import { build } from "esbuild";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const family = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(family, "../../..");
const productRoot = resolve(root, "apps/artood/dist");
const packages = Object.fromEntries(["domain", "protocol"].map((name) => [`@artoo/${name}`, resolve(root, `packages/${name}/dist/index.js`)]));
const child = resolve(family, "journal-child.ts");
const allowedInputs = new Set([child, resolve(family, "physical-run.fixture.ts")]);
const result = await build({
  absWorkingDir: root, entryPoints: [child], outfile: resolve(family, "dist/journal-child.mjs"),
  bundle: true, platform: "node", format: "esm", target: "node24", packages: "external",
  write: false, metafile: true, sourcemap: false,
  plugins: [{ name: "canonical-products-remain-external", setup(builder) {
    builder.onResolve({ filter: /^(?:\.\.\/){3}apps\/artood\/dist\// }, (args) => {
      const target = resolve(dirname(args.importer), args.path);
      if (!target.startsWith(productRoot + sep) || !existsSync(target)) throw new Error(`Missing canonical product: ${target}`);
      return { path: target, external: true };
    });
    builder.onResolve({ filter: /^@artoo\// }, (args) => {
      const target = packages[args.path];
      if (!target || !existsSync(target)) throw new Error(`Unreviewed or missing workspace package: ${args.path}`);
      return { path: target, external: true };
    });
  } }],
});
const inputs = Object.keys(result.metafile.inputs).map((name) => isAbsolute(name) ? name : resolve(root, name));
if (inputs.length !== allowedInputs.size || inputs.some((name) => !allowedInputs.has(name))) {
  throw new Error(`Child bundle included an unexpected implementation: ${JSON.stringify(inputs)}`);
}
for (const output of Object.values(result.metafile.outputs)) {
  for (const item of output.imports) {
    if (!item.external || !(item.path.startsWith("node:") || item.path.startsWith(productRoot + sep) || Object.values(packages).includes(item.path))) {
      throw new Error(`Child bundle has an unreviewed runtime import: ${item.path}`);
    }
  }
}
mkdirSync(resolve(family, "dist"), { recursive: true });
for (const output of result.outputFiles) writeFileSync(output.path, output.contents);
writeFileSync(resolve(family, "dist/child-bundle-inputs.json"), JSON.stringify({
  scope: "Harness-only bundle; canonical product JS and its real journal worker stay external",
  inputs: inputs.map((name) => relative(root, name)), metafile: result.metafile,
}, null, 2) + "\n");
