// Real esbuild with controlled source modules. Only these harmless fixture
// outputs are imported; no application, native helper, browser or guest runs.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { build, stop } from 'esbuild';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { auditApplicationServiceHostBuild, buildApplicationServiceHost, verifyApplicationServiceHostBundle } from './build-application-service-host.mjs';

const temporaryParent = realpathSync.native(tmpdir()), root = realpathSync.native(mkdtempSync(join(temporaryParent, 'artoo-app-host-build-')));
const manifestName = 'application-service-host-manifest.json', bootstrapName = 'application-service-bootstrap', hostName = 'application-service-host-api';
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const requireBuild = createRequire(import.meta.url);
const pin = path => { const bytes = readFileSync(path); return { path, bytes: bytes.length, sha256: sha(bytes) }; };
let index = 0;
function fixture() {
  const directory = join(root, 'fixture-' + index++), source = join(directory, 'apps/artood/src'); mkdirSync(source, { recursive: true });
  const marker = 'artooBuildFixture_' + randomUUID().replaceAll('-', '_');
  const original = {
    'windows-code-installation.ts': `const owners = new WeakMap();
      export function prepare() { const token = Object.freeze({}); owners.set(token, true); globalThis.${marker}_created = true; return token; }
      export function assert(token) { if (!owners.has(token)) throw Error('original fixture token required'); return true; }`,
    [bootstrapName + '.ts']: `import { prepare } from './windows-code-installation.js';
      export function loaded() { return globalThis.${marker} ?? 0; }
      export async function run(forged = false) { const token = prepare();
        const { check } = await import('./${hostName}.js'); return check(forged ? JSON.parse(JSON.stringify(token)) : token); }`,
    [hostName + '.ts']: `import { assert } from './windows-code-installation.js';
      if (!globalThis.${marker}_created) throw Error('host ran before fixture admission');
      globalThis.${marker} = (globalThis.${marker} ?? 0) + 1;
      export function check(token) { return assert(token); }`,
  };
  const put = (name, value) => writeFileSync(join(source, name), value);
  for (const [name, value] of Object.entries(original)) put(name, value);
  return { directory, source, marker, original, put, output: join(root, 'output-' + index++) };
}
async function compile(f, extra = {}) {
  return build({ absWorkingDir: f.directory, entryPoints: {
    [bootstrapName]: join(f.source, bootstrapName + '.ts'), [hostName]: join(f.source, hostName + '.ts'),
  }, outdir: f.output, outExtension: { '.js': '.mjs' }, chunkNames: 'chunks/[name]-[hash]', bundle: true, splitting: true,
  platform: 'node', target: 'node24', format: 'esm', write: false, metafile: true, logLevel: 'silent', ...extra });
}
const audit = (f, result) => auditApplicationServiceHostBuild(result, { repoRoot: f.directory, outputDirectory: f.output });
async function packagedFixture() {
  const f = fixture(), result = await buildApplicationServiceHost({ repoRoot: f.directory, outputDirectory: f.output });
  return { ...f, result, manifestPath: join(f.output, manifestName) };
}
after(() => {
  stop();
  // Delete only the physical temporary directory created by this suite.
  assert.equal(dirname(root), temporaryParent); assert.match(basename(root), /^artoo-app-host-build-/u);
  assert.equal(realpathSync.native(root), root); rmSync(root, { recursive: true });
});

test('one real split graph keeps host deferred and original WeakMap tokens shared', async () => {
  const f = await packagedFixture(), manifest = verifyApplicationServiceHostBundle(f.output, f.result.manifest);
  assert.equal(f.result.qualifiedForProduct, false);
  assert.equal(manifest.format, 'artoo.application-service-host.v1');
  assert.deepEqual(manifest.files.map(item => item.path).sort(), [bootstrapName + '.mjs', hostName + '.mjs',
    ...readdirSync(join(f.output, 'chunks')).map(name => 'chunks/' + name)].sort());
  assert.ok(manifest.files.every(item => /^sha256:[a-f0-9]{64}$/u.test(item.sha256)));
  const bootstrap = await import(pathToFileURL(join(f.output, bootstrapName + '.mjs')).href);
  assert.equal(bootstrap.loaded(), 0);
  assert.equal(await bootstrap.run(), true); assert.equal(bootstrap.loaded(), 1);
  await assert.rejects(bootstrap.run(true), /original fixture token required/);
  delete globalThis[f.marker]; delete globalThis[f.marker + '_created'];
});

test('rejects a static host import even though the same authority can be shared', async () => {
  const f = fixture();
  f.put(bootstrapName + '.ts', `import {prepare} from './windows-code-installation.js';
    import {check} from './${hostName}.js'; export function run() { return check(prepare()); }`);
  const result = await compile(f);
  assert.throws(() => audit(f, result), /fixed deferred host import|before admission/u);
});

test('rejects application schema initialization hoisted into the shared bootstrap chunk', async () => {
  const f = fixture(), schema = 'application-runtime-process-protocol';
  f.put(schema + '.ts', 'export function schema(value) { return value + 1; }');
  f.put(bootstrapName + '.ts', f.original[bootstrapName + '.ts'] + `\nimport {schema} from './${schema}.js'; export const bump = schema;`);
  f.put(hostName + '.ts', f.original[hostName + '.ts'] + `\nimport {schema} from './${schema}.js'; export const hostBump = schema;`);
  const result = await compile(f);
  assert.throws(() => audit(f, result), /application source in bootstrap static closure: application-runtime-process-protocol.ts/u);
});

test('rejects independently bundled authority copies instead of accepting their matching names', async () => {
  const f = fixture(), result = await compile(f);
  const authorityPath = Object.keys(result.metafile.inputs).find(name => name.endsWith('windows-code-installation.ts'));
  const independent = await build({ absWorkingDir: f.directory, entryPoints: [join(f.source, 'windows-code-installation.ts')],
    outfile: join(f.output, 'second-authority.mjs'), bundle: true, platform: 'node', target: 'node24', format: 'esm', write: false, metafile: true, logLevel: 'silent' });
  // Model an invalid two-build assembly. Its second initializer is put in the
  // existing host output, so the exact output graph remains otherwise intact.
  const hostKey = Object.keys(result.metafile.outputs).find(name => name.endsWith(hostName + '.mjs'));
  const hostOutput = result.outputFiles.find(file => file.path.endsWith(hostName + '.mjs'));
  const second = independent.outputFiles[0].text.replace(/export \{[\s\S]*?\};?\s*$/u, '');
  const changed = Buffer.from('const duplicatedAuthority = (() => {\n' + second
    + '\nreturn {prepare, assert}; })();\n' + hostOutput.text + '\nexport {duplicatedAuthority};\n');
  const mutated = { metafile: structuredClone(result.metafile), outputFiles: result.outputFiles.map(file => file === hostOutput ? { path: file.path, contents: changed } : file) };
  mutated.metafile.outputs[hostKey].inputs[authorityPath] = { bytesInOutput: second.length };
  assert.throws(() => audit(f, mutated), /authority must be one shared module instance/u);
});

test('allows the fixed SQLite builtin only in the deferred host graph, without executing it', async () => {
  const f = fixture(), sqlite = "import {DatabaseSync} from 'node:sqlite'; export const sqliteClass = DatabaseSync;";
  f.put(hostName + '.ts', f.original[hostName + '.ts'] + '\n' + sqlite);
  const result = await compile(f), files = audit(f, result);
  assert.match(files.get(hostName + '.mjs').toString('utf8'), /from "node:sqlite"/u);
  f.put(bootstrapName + '.ts', f.original[bootstrapName + '.ts'] + '\n' + sqlite);
  const early = await compile(f); assert.throws(() => audit(f, early), /SQLite must remain in the deferred host/u);
});

function ulidFixture() {
  const f = fixture(), actual = dirname(requireBuild.resolve('ulid/package.json')), dependency = join(f.directory, 'node_modules/ulid');
  mkdirSync(join(dependency, 'dist'), { recursive: true });
  copyFileSync(join(actual, 'package.json'), join(dependency, 'package.json'));
  copyFileSync(join(actual, 'dist/index.esm.js'), join(dependency, 'dist/index.esm.js'));
  f.put(bootstrapName + '.ts', f.original[bootstrapName + '.ts'] + `
    import {ulid, factory, monotonicFactory, decodeTime} from 'ulid';
    export const nextId = ulid, timestamp = decodeTime;
    export function knownId(time) { return factory(() => 0)(time); }
    export function orderedIds(time) { const next = monotonicFactory(() => 0); return [next(time), next(time), next(time - 1)]; }`);
  return { ...f, dependency };
}
test('bundles the locked real ULID ESM with static crypto while preserving ID and secure PRNG semantics', async () => {
  const f = ulidFixture(), built = await buildApplicationServiceHost({ repoRoot: f.directory, outputDirectory: f.output });
  verifyApplicationServiceHostBundle(f.output, built.manifest);
  const random = Math.random;
  try {
    Math.random = () => { throw Error('insecure random fallback forbidden'); };
    // This is the harmless fixture's generated module, not the application host.
    const api = await import(pathToFileURL(join(f.output, bootstrapName + '.mjs')).href), time = 1234;
    const id = api.nextId(time);
    assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/u); assert.equal(api.timestamp(id), time);
    assert.equal(api.knownId(time), '000000016J0000000000000000');
    assert.deepEqual(api.orderedIds(time), ['000000016J0000000000000000', '000000016J0000000000000001', '000000016J0000000000000002']);
    assert.equal(api.loaded(), 0, 'the fixture host is still deferred');
  } finally { Math.random = random; }
});
for (const change of ['hash', 'expression', 'duplicate-expression', 'version', 'module-path']) test('rejects fixed ULID input drift: ' + change, async () => {
  const f = ulidFixture(), path = join(f.dependency, 'dist/index.esm.js'), metadataPath = join(f.dependency, 'package.json');
  const original = readFileSync(path, 'utf8');
  if (change === 'hash') writeFileSync(path, original + '\n// changed dependency\n');
  if (change === 'expression') writeFileSync(path, original.replace('require("crypto")', 'require("node:crypto")'));
  if (change === 'duplicate-expression') writeFileSync(path, original + '\nconst nodeCrypto = require("crypto");\n');
  if (change === 'version' || change === 'module-path') {
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    if (change === 'version') metadata.version = '2.4.1'; else metadata.module = './dist/other.js';
    writeFileSync(metadataPath, JSON.stringify(metadata));
  }
  await assert.rejects(buildApplicationServiceHost({ repoRoot: f.directory, outputDirectory: f.output }),
    change === 'hash' ? /ULID ESM source hash changed/u : change.includes('expression') ? /ULID crypto import expression changed/u : /ULID package version or ESM entry changed/u);
  assert.equal(existsSync(f.output), false);
});

for (const [name, extraSource, external, expected] of [
  ['bare external package', "export {value} from 'unlisted-package';", ['unlisted-package'], /unsupported external module/u],
  ['third-party SQLite package', "export {value} from 'sqlite3';", ['sqlite3'], /unsupported external module/u],
  ['unknown Node builtin', "export * from 'node:artoo_missing_builtin';", [], /unsupported external module/u],
  ['unapproved module loader builtin', "import {createRequire as loader} from 'node:module'; export const load = loader(import.meta.url);", [], /unsupported external module/u],
  ['variable dynamic import', 'export const load = name => import(name);', [], /nonliteral module loading/u],
  ['dynamic require', 'export const load = name => require(name);', [], /runtime module resolver/u],
  ['aliased require', 'const runtimeLoader = require; export const load = name => runtimeLoader(name);', [], /runtime module resolver/u],
  ['process builtin resolver', "export const load = () => process.getBuiltinModule('module');", [], /runtime module resolver/u],
]) test('rejects module graph escape: ' + name, async () => {
  const f = fixture(); f.put(bootstrapName + '.ts', f.original[bootstrapName + '.ts'] + '\n' + extraSource);
  const result = await compile(f, { external });
  if (name === 'variable dynamic import') {
    const meta = Object.entries(result.metafile.outputs).find(([file]) => file.endsWith(bootstrapName + '.mjs'))[1];
    assert.equal(meta.imports.filter(item => item.kind === 'dynamic-import').length, 1, 'metafile omits the additional variable import');
  }
  assert.throws(() => audit(f, result), expected);
});

test('module rejection identifies a bounded emitted file, literal module and line without source text', async () => {
  const f = fixture(), name = 'unlisted-' + 'x'.repeat(1024);
  f.put(bootstrapName + '.ts', f.original[bootstrapName + '.ts'] + `\nexport {value} from '${name}';`);
  const result = await compile(f, { external: [name] });
  let error; try { audit(f, result); } catch (caught) { error = caught; }
  assert.match(error.message, /unsupported external module/u);
  const context = JSON.parse(error.message.match(/\[module_edge\.v1 (.+)\]$/u)[1]);
  assert.equal(context.file, bootstrapName + '.mjs'); assert.equal(context.module, name.slice(0, 256));
  assert.equal(context.kind, 'import-statement'); assert.ok(context.line > 0 && context.column > 0);
  assert.ok(error.message.length < 1024); assert.equal(error.message.includes('export {value}'), false);
});

test('published output exactly matches its independent manifest pin and closed file set', async () => {
  for (const change of ['extra-file', 'extra-directory', 'linked-directory', 'hardlink-file', 'missing-chunk', 'changed-bytes',
    'wrong-manifest-pin', 'unsafe-manifest-path', 'case-alias']) {
    const f = await packagedFixture(), manifest = JSON.parse(readFileSync(f.manifestPath, 'utf8'));
    let expected = f.result.manifest;
    const chunk = manifest.files.find(file => file.path.startsWith('chunks/')).path;
    if (change === 'extra-file') writeFileSync(join(f.output, 'extra.mjs'), 'export const extra = true;');
    if (change === 'extra-directory') mkdirSync(join(f.output, 'extra'));
    if (change === 'linked-directory') symlinkSync(join(f.output, 'chunks'), join(f.output, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    if (change === 'hardlink-file') linkSync(join(f.output, chunk), join(f.output, 'duplicate.mjs'));
    if (change === 'missing-chunk') rmSync(join(f.output, chunk));
    if (change === 'changed-bytes') writeFileSync(join(f.output, chunk), 'throw Error("changed fixture");');
    if (change === 'wrong-manifest-pin') expected = { ...expected, sha256: 'sha256:' + '0'.repeat(64) };
    if (change === 'unsafe-manifest-path' || change === 'case-alias') {
      if (change === 'unsafe-manifest-path') manifest.files[0].path = '../outside.mjs';
      else manifest.files.push({ ...manifest.files[0], path: manifest.files[0].path.replace(/^a/u, 'A') });
      writeFileSync(f.manifestPath, JSON.stringify(manifest)); expected = pin(f.manifestPath);
    }
    assert.throws(() => verifyApplicationServiceHostBundle(f.output, expected), /extra output|linked output|invalid build file|missing output|output bytes|independent manifest|invalid manifest/u, change);
  }
});

test('existing output remains byte-for-byte and physically unchanged', async () => {
  const f = fixture(); mkdirSync(f.output); const sentinel = join(f.output, 'keep.txt'); writeFileSync(sentinel, 'user-owned');
  const original = lstatSync(sentinel, { bigint: true });
  await assert.rejects(buildApplicationServiceHost({ repoRoot: f.directory, outputDirectory: f.output }), /output directory already exists/u);
  assert.equal(readFileSync(sentinel, 'utf8'), 'user-owned'); assert.equal(lstatSync(sentinel, { bigint: true }).ino, original.ino);
});

test('concurrent builders cannot publish two generations to the same output', async () => {
  const f = fixture(), options = { repoRoot: f.directory, outputDirectory: f.output };
  const outcomes = await Promise.allSettled([buildApplicationServiceHost(options), buildApplicationServiceHost(options)]);
  const completed = outcomes.filter(item => item.status === 'fulfilled'), rejected = outcomes.filter(item => item.status === 'rejected');
  assert.equal(completed.length, 1); assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'EEXIST');
  verifyApplicationServiceHostBundle(f.output, completed[0].value.manifest);
});

test('graph failure never publishes output and retains its own failed staging', async () => {
  const f = fixture(); f.put(bootstrapName + '.ts', f.original[bootstrapName + '.ts'] + '\nexport const load = name => import(name);');
  await assert.rejects(buildApplicationServiceHost({ repoRoot: f.directory, outputDirectory: f.output }), /nonliteral module loading/u);
  assert.equal(existsSync(f.output), false);
  assert.ok(readdirSync(root).some(name => name.startsWith('.' + basename(f.output) + '.build-')));
  assert.equal(existsSync(join(root, '.' + basename(f.output) + '.application-host.lock')), false);
});

test('rejects ambient Node loader settings before creating output', async () => {
  const f = fixture(), old = process.env.NODE_OPTIONS;
  try {
    process.env.NODE_OPTIONS = '--import=unreviewed-loader';
    await assert.rejects(buildApplicationServiceHost({ repoRoot: f.directory, outputDirectory: f.output }), /ambient build loader configuration/u);
    assert.equal(existsSync(f.output), false);
  } finally { if (old === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = old; }
});
