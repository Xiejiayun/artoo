// Real esbuild over harmless, explicitly controlled source fixtures. The output
// is inspected as bytes only; no runtime, QuickJS, Wasm, native helper or product
// is imported or executed by this suite.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { stop } from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApplicationRuntime, inspectApplicationRuntime } from './build-application-runtime.mjs';

const temporaryParent = realpathSync.native(tmpdir());
const root = realpathSync.native(mkdtempSync(join(temporaryParent, 'artoo-runtime-build-')));
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const names = ['application-runtime-entry.ts', 'application-runtime-stdio.ts', 'application-runtime-loader.ts',
  'application-runtime-installation.ts', 'application-runtime-process-protocol.ts', 'application-runtime-channel.ts',
  'application-artifact-admission.ts', 'application-quickjs-wasm-boundary.ts', 'application-quickjs-session.ts',
  'application-build-primitives.ts', 'application-wire-v1.ts', 'application-data-contract.ts'];
const builtins = {
  'application-runtime-entry.ts': ['node:fs'], 'application-runtime-stdio.ts': ['node:util'],
  'application-runtime-loader.ts': ['node:module', 'node:url'],
  'application-runtime-installation.ts': ['node:crypto', 'node:fs', 'node:path', 'node:util'],
  'application-runtime-channel.ts': ['node:util/types'],
};
let index = 0;
function fixture() {
  const directory = join(root, 'fixture-' + index++), source = join(directory, 'apps/artood/src');
  const zod = join(directory, 'node_modules/zod'), output = join(root, 'output-' + index++);
  mkdirSync(source, { recursive: true }); mkdirSync(zod, { recursive: true });
  writeFileSync(join(directory, 'package.json'), '{"private":true}');
  writeFileSync(join(directory, 'package-lock.json'), '{"lockfileVersion":3}');
  writeFileSync(join(zod, 'package.json'), JSON.stringify({ name: 'zod', version: '4.6.7', module: './index.js' }));
  writeFileSync(join(zod, 'index.js'), 'export const z = Object.freeze({fixture: true});');
  const originals = new Map(), put = (name, value) => writeFileSync(join(source, name), value);
  for (const name of names) {
    const external = builtins[name] ?? [];
    let text = external.map((module, i) => `import * as builtin${i} from '${module}';`).join('\n');
    const values = external.map((_, i) => 'builtin' + i);
    if (name === 'application-data-contract.ts') { text += "\nimport {z} from 'zod';"; values.push('z'); }
    text += `\nexport const fixtureValue = [${values.join(',')}];`;
    if (name === 'application-runtime-loader.ts') text += `
      const url = name => 'file:///controlled-fixture/' + name;
      export async function fixtureLoad() {
        return [await import(url('core/dist/index.mjs')), await import(url('release-sync/dist/index.mjs'))];
      }`;
    if (name === 'application-runtime-entry.ts') text = external.map((module, i) => `import * as builtin${i} from '${module}';`).join('\n')
      + names.slice(1).map((name, i) => `\nimport * as source${i} from './${name.replace(/\.ts$/, '.js')}';`).join('')
      + `\nconsole.log(${[...values, ...names.slice(1).map((_, i) => 'source' + i)].join(',')});`
      + '\nthrow Error("CONTROLLED_OUTPUT_MUST_NEVER_EXECUTE");';
    originals.set(name, text); put(name, text);
  }
  return { directory, source, zod, output, originals, put,
    run: () => buildApplicationRuntime({ repoRoot: directory, outputDirectory: output }) };
}
after(() => {
  stop();
  // Only remove this suite's original physical temporary root.
  assert.equal(dirname(root), temporaryParent); assert.match(basename(root), /^artoo-runtime-build-/u);
  assert.equal(realpathSync.native(root), root); assert.equal(lstatSync(root).isSymbolicLink(), false);
  rmSync(root, { recursive: true });
});

test('packages the exact fixed closure as inert bytes and records every actual input', async () => {
  const f = fixture(), result = await f.run();
  assert.equal(result.qualifiedForProduct, false); assert.equal(result.entry.path, join(f.output, 'application-runtime.mjs'));
  const output = readFileSync(result.entry.path), metadata = readFileSync(result.manifest.path), report = JSON.parse(metadata);
  assert.equal(output.length, result.entry.bytes); assert.equal(sha(output), result.entry.sha256);
  assert.equal(metadata.length, result.manifest.bytes); assert.equal(sha(metadata), result.manifest.sha256);
  assert.match(output.toString(), /CONTROLLED_OUTPUT_MUST_NEVER_EXECUTE/u);
  assert.equal(report.qualified_for_product, false); assert.equal(report.format, 'artoo.application-runtime-entry-build.v1');
  assert.deepEqual(report.permitted_computed_imports.map(value => value.member).sort(), ['core/dist/index.mjs', 'release-sync/dist/index.mjs']);
  assert.equal(new Set(report.permitted_computed_imports.map(value => value.resolver)).size, 1);
  for (const name of names) assert.ok(report.inputs.some(input => input.path === join(f.source, name)));
  assert.ok(report.inputs.some(input => input.path === join(f.zod, 'index.js')));
  for (const input of report.inputs) {
    const bytes = readFileSync(input.path); assert.equal(input.bytes, bytes.length); assert.equal(input.sha256, sha(bytes));
  }
  assert.equal(report.input_digest, sha(JSON.stringify(report.inputs)));
  assert.deepEqual(Object.values(report.metafile.outputs)[0].exports, []);
});

for (const [label, module] of [['unknown project file', './not-reviewed.js'], ['other package', 'ulid'], ['builtin outside allowlist', 'node:child_process']]) {
  test(`rejects ${label} without a successful build manifest`, async () => {
    const f = fixture(); f.put('not-reviewed.ts', 'export const value = 1;');
    f.put(names[0], f.originals.get(names[0]) + `\nimport * as extra from '${module}'; console.log(extra);`);
    await assert.rejects(f.run(), /unlisted dependency|escapes fixed source closure/u);
    assert.equal(existsSync(f.output), true); assert.equal(existsSync(join(f.output, 'build.json')), false);
  });
}
test('rejects a known builtin loaded from the wrong reviewed owner', async () => {
  const f = fixture(); f.put('application-wire-v1.ts', "import * as fs from 'node:fs'; export const fixtureValue = fs;");
  await assert.rejects(f.run(), /builtin imported outside its reviewed owner/u);
});
test('rejects Zod imported from an unreviewed owner', async () => {
  const f = fixture(); f.put('application-wire-v1.ts', "import {z} from 'zod'; export const fixtureValue = z;");
  await assert.rejects(f.run(), /unreviewed Zod importer/u);
});
test('rejects relative Zod dependencies escaping its package', async () => {
  const f = fixture(); writeFileSync(join(f.directory, 'node_modules/outside.js'), 'export const z = 1;');
  writeFileSync(join(f.zod, 'index.js'), "export {z} from '../outside.js';");
  await assert.rejects(f.run(), /escapes fixed source closure/u);
});
test('rejects a changed dependency version', async () => {
  const f = fixture(); writeFileSync(join(f.zod, 'package.json'), JSON.stringify({ name: 'zod', version: '5.0.0', module: './index.js' }));
  await assert.rejects(f.run(), /unreviewed Zod package/u);
});

for (const [label, expression] of [
  ['arbitrary computed import', 'import(requested)'], ['literal vendor import', "import('core/dist/index.mjs')"],
  ['unlisted vendor member', "import(url('release-sync/dist/other.mjs'))"],
  ['import attributes', "import(url('core/dist/index.mjs'), {with:{type:'json'}})"],
]) test(`rejects ${label} in source before bundling`, async () => {
  const f = fixture(); f.put('application-runtime-loader.ts', f.originals.get('application-runtime-loader.ts') + `\nexport const extra = () => ${expression};`);
  await assert.rejects(f.run(), /unreviewed computed import/u);
});
test('rejects even a permitted vendor import in another source owner', async () => {
  const f = fixture(); f.put('application-wire-v1.ts', "export const fixtureValue = () => import(url('core/dist/index.mjs'));");
  await assert.rejects(f.run(), /unreviewed computed import/u);
});
test('requires both vendor imports and one shared resolver', async () => {
  const f = fixture(); f.put('application-runtime-loader.ts', f.originals.get('application-runtime-loader.ts').replace("url('release-sync", "other('release-sync"));
  await assert.rejects(f.run(), /both fixed vendor imports/u);
});
for (const resolver of ['require("node:fs")', 'createRequire(import.meta.url)', 'process.getBuiltinModule("fs")', 'import.meta.resolve("zod")']) {
  test(`rejects runtime resolver ${resolver}`, async () => {
    const f = fixture(); f.put('application-wire-v1.ts', `export const fixtureValue = () => ${resolver};`);
    await assert.rejects(f.run(), /runtime module resolver/u);
  });
}
test('inspects computed imports again in emitted code rather than trusting its metafile', async () => {
  const f = fixture(), built = await f.run(), output = readFileSync(built.entry.path, 'utf8');
  assert.throws(() => inspectApplicationRuntime(output + '\nimport(destination);', 'application-runtime.mjs', { emitted: true }), /unreviewed computed import/u);
  assert.throws(() => inspectApplicationRuntime(output + '\nimport "unlisted-package";', 'application-runtime.mjs', { emitted: true }), /unlisted emitted external/u);
  assert.throws(() => inspectApplicationRuntime(output + '\nconst __require = globalThis.require;', 'application-runtime.mjs', { emitted: true }), /runtime module resolver/u);
});
test('records direct code generation as an observation, never a proof of safety', async () => {
  const f = fixture(); writeFileSync(join(f.zod, 'index.js'), 'export const z = () => new Function("return 1");');
  const result = await f.run(), report = JSON.parse(readFileSync(result.manifest.path, 'utf8'));
  assert.equal(report.codegen_scan_is_not_a_proof, true); assert.ok(report.direct_codegen_sites.some(site => site.expression === 'Function'));
});
test('never overwrites a previous successful or failed output directory', async () => {
  const f = fixture(), result = await f.run(), previous = readFileSync(result.entry.path);
  await assert.rejects(f.run(), /already exists/u); assert.deepEqual(readFileSync(result.entry.path), previous);
  const failed = fixture(); failed.put('application-runtime-loader.ts', 'not valid TypeScript !');
  await assert.rejects(failed.run(), /invalid module syntax/u); await assert.rejects(failed.run(), /already exists/u);
});
test('rejects relative output and ambient loader configuration before creating an attempt', async () => {
  const f = fixture(); await assert.rejects(buildApplicationRuntime({ repoRoot: f.directory, outputDirectory: 'relative-output' }), /absolute output/u);
  const previous = process.env.NODE_OPTIONS;
  try { process.env.NODE_OPTIONS = ''; await assert.rejects(f.run(), /ambient build loader/u); }
  finally { if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous; }
  assert.equal(existsSync(f.output), false);
});
