import { build, stop } from 'esbuild';
import ts from 'typescript';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const BOOTSTRAP = 'application-service-bootstrap.mjs', HOST = 'application-service-host-api.mjs';
const MANIFEST = 'application-service-host-manifest.json', FORMAT = 'artoo.application-service-host.v1';
const BUILTINS = new Set(['node:assert/strict', 'node:async_hooks', 'node:buffer', 'node:child_process', 'node:crypto',
  'node:events', 'node:fs', 'node:fs/promises', 'node:http', 'node:net', 'node:os', 'node:path', 'node:perf_hooks',
  'node:process', 'node:sqlite', 'node:stream', 'node:stream/promises', 'node:string_decoder', 'node:url', 'node:util', 'node:util/types']);
const EARLY_APPLICATION = new Set(['application-service-bootstrap.ts', 'application-bootstrap-control.ts', 'application-bootstrap-admission.ts']);
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const measure = bytes => ({ bytes: bytes.length, sha256: sha(bytes) });
const fail = message => { throw Error('Application host bundle: ' + message); };
const portable = path => path.split(sep).join('/');
const member = path => typeof path === 'string' && path.length > 0 && path.length <= 512 && path.endsWith('.mjs')
  && path.split('/').every(part => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(part) && !/[. ]$/u.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part));
function physicalDirectory(path) {
  const absolute = resolve(path), stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(absolute) !== absolute) fail('physical directory required');
  return absolute;
}
function localOutput(path, root, directory) {
  const local = portable(relative(directory, resolve(root, path)));
  if (!member(local)) fail('output is outside the fixed module layout');
  return local;
}
function edgeKey(edge) { return `${edge.kind}:${edge.path}`; }
function sortedKeys(edges) { return [...new Set(edges.map(edgeKey))].sort(); }
function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function moduleFailure(reason, file, name, kind, position = {}) {
  fail(reason + ' [module_edge.v1 ' + JSON.stringify({ file: String(file).slice(0, 512), module: String(name).slice(0, 256), kind, ...position }) + ']');
}

// ulid 2.4.0 advertises an ESM entry, but its Node PRNG still calls require.
// Bind only this reviewed source and replace that one builtin load at build
// time. The randomBytes/encoding algorithms and default secure PRNG are intact;
// no runtime resolver, package mutation or generic CommonJS fallback is added.
function ulidStaticCrypto() {
  const selected = new Set(), expression = 'const nodeCrypto = require("crypto");';
  const sourceHash = 'sha256:79b51740a560fcc06921aaa05868434df677c028cdb2b79c880fe8d0165b64b6';
  return { name: 'fixed-ulid-esm-crypto', setup(api) {
    api.onResolve({ filter: /^ulid$/ }, args => {
      if (args.kind !== 'import-statement') moduleFailure('ULID requires a static ESM import', args.importer, args.path, args.kind);
      const metadataPath = realpathSync.native(createRequire(args.importer).resolve('ulid/package.json'));
      const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
      if (metadata.name !== 'ulid' || metadata.version !== '2.4.0' || metadata.module !== './dist/index.esm.js')
        fail('ULID package version or ESM entry changed');
      const file = join(dirname(metadataPath), 'dist', 'index.esm.js');
      const stat = lstatSync(file);
      if (realpathSync.native(file) !== file || !stat.isFile() || stat.isSymbolicLink()) fail('ULID ESM must be the fixed physical member');
      selected.add(file); return { path: file };
    });
    api.onLoad({ filter: /[\\/]index\.esm\.js$/ }, args => {
      if (!selected.has(args.path)) return;
      const bytes = readFileSync(args.path), source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (source.split(expression).length !== 2) fail('ULID crypto import expression changed');
      if (sha(bytes) !== sourceHash) fail('ULID ESM source hash changed');
      return { loader: 'js', contents: 'import * as __artooUlidNodeCrypto from "node:crypto";\n'
        + source.replace(expression, 'const nodeCrypto = __artooUlidNodeCrypto;') };
    });
  } };
}

// Metafiles omit import(variable) and runtime require. Audit emitted JavaScript,
// too. This checks the fixed trusted build's module graph, not arbitrary JS safety.
function emittedImports(file, text, files) {
  const parsed = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), edges = [];
  if (parsed.parseDiagnostics.length) fail('unparseable emitted module');
  const add = (value, kind) => {
    const position = value ? parsed.getLineAndCharacterOfPosition(value.getStart(parsed)) : undefined;
    const reject = (reason, name) => moduleFailure(reason, file, name, kind,
      position ? { line: position.line + 1, column: position.character + 1 } : {});
    if (!value || !ts.isStringLiteral(value)) reject('nonliteral module loading', '<nonliteral>');
    const name = value.text;
    if (BUILTINS.has(name)) edges.push({ path: name, kind });
    else {
      if (!name.startsWith('./') && !name.startsWith('../') || /[\\?#%]/u.test(name)) reject('unsupported external module', name);
      const target = posix.normalize(posix.join(posix.dirname(file), name));
      if (!member(target) || !files.has(target)) reject('unlisted module import', name);
      edges.push({ path: target, kind });
    }
  };
  const visit = node => {
    const reject = (reason, name, kind) => {
      const position = parsed.getLineAndCharacterOfPosition(node.getStart(parsed));
      moduleFailure(reason, file, name, kind, { line: position.line + 1, column: position.character + 1 });
    };
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) && node.moduleSpecifier) add(node.moduleSpecifier, 'import-statement');
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (node.arguments.length !== 1) reject('unsupported dynamic module loading', '<dynamic-import>', 'dynamic-import');
      add(node.arguments[0], 'dynamic-import');
    }
    // node:module is not in the builtin allowlist. Reject CJS loaders and process
    // loader access as well, including esbuild's runtime require shim and aliases.
    if (ts.isIdentifier(node) && /^(?:require|__require\d*|createRequire|getBuiltinModule|mainModule)$/u.test(node.text)
      || ts.isStringLiteral(node) && ['getBuiltinModule', 'mainModule'].includes(node.text)) {
      const argument = ts.isCallExpression(node.parent) && node.parent.expression === node ? node.parent.arguments[0] : undefined;
      reject('runtime module resolver', argument && ts.isStringLiteral(argument) ? argument.text : '<runtime-resolver>', 'runtime-resolver');
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'resolve' && ts.isMetaProperty(node.expression))
      reject('runtime module resolver', '<import.meta.resolve>', 'runtime-resolver');
    ts.forEachChild(node, visit);
  };
  visit(parsed); return edges;
}

/** Pure output/graph inspection. Never imports the built application. */
export function auditApplicationServiceHostBuild(result, { repoRoot, outputDirectory }) {
  const files = new Map(), metadata = new Map();
  for (const output of result.outputFiles) {
    const name = localOutput(output.path, repoRoot, outputDirectory);
    if ([...files.keys()].some(path => path.toLowerCase() === name.toLowerCase())) fail('duplicate output');
    files.set(name, Buffer.from(output.contents));
  }
  if (!files.has(BOOTSTRAP) || !files.has(HOST)) fail('fixed entries missing');
  for (const [path, value] of Object.entries(result.metafile.outputs)) metadata.set(localOutput(path, repoRoot, outputDirectory), value);
  if (!same([...metadata.keys()].sort(), [...files.keys()].sort())) fail('metafile/output set differs');
  const graph = new Map();
  for (const [file, bytes] of files) {
    const imports = emittedImports(file, new TextDecoder('utf-8', { fatal: true }).decode(bytes), files);
    const declared = metadata.get(file).imports.map(item => {
      if (item.external && !BUILTINS.has(item.path)) moduleFailure('unsupported external module', file, item.path, item.kind);
      if (!['import-statement', 'dynamic-import'].includes(item.kind)) moduleFailure('unsupported module edge', file, item.path, item.kind);
      return { path: item.external ? item.path : localOutput(item.path, repoRoot, outputDirectory), kind: item.kind };
    });
    if (!same(sortedKeys(imports), sortedKeys(declared))) fail('emitted imports differ from metafile');
    graph.set(file, imports);
  }
  const source = name => resolve(repoRoot, 'apps/artood/src', name);
  for (const [file, expected] of [[BOOTSTRAP, source('application-service-bootstrap.ts')], [HOST, source('application-service-host-api.ts')]]) {
    if (resolve(repoRoot, metadata.get(file).entryPoint ?? '') !== expected) fail('entry source differs');
  }
  for (const [file, data] of metadata) if (data.entryPoint && ![BOOTSTRAP, HOST].includes(file)) fail('unexpected entry output');
  const dynamic = [...graph].flatMap(([from, edges]) => edges.filter(edge => edge.kind === 'dynamic-import').map(edge => [from, edge.path]));
  if (!same(dynamic, [[BOOTSTRAP, HOST]])) fail('one fixed deferred host import required');
  const closure = entry => {
    const found = new Set(), visit = file => {
      if (found.has(file)) return; found.add(file);
      for (const edge of graph.get(file)) if (edge.kind === 'import-statement' && files.has(edge.path)) visit(edge.path);
    };
    visit(entry); return found;
  };
  const early = closure(BOOTSTRAP), host = closure(HOST);
  if (early.has(HOST)) fail('host imported before admission');
  // The trusted broker core imports SQLite without opening a store at module
  // evaluation. It belongs to the delayed application graph, never bootstrap.
  for (const file of early) if (graph.get(file).some(edge => edge.path === 'node:sqlite'))
    moduleFailure('SQLite must remain in the deferred host', file, 'node:sqlite', 'import-statement');
  for (const file of early) for (const [input, contribution] of Object.entries(metadata.get(file).inputs)) {
    if (contribution.bytesInOutput > 0 && basename(input).startsWith('application-') && !EARLY_APPLICATION.has(basename(input)))
      fail('application source in bootstrap static closure: ' + basename(input));
  }
  const authority = source('windows-code-installation.ts');
  const owners = [...metadata].filter(([, value]) => Object.entries(value.inputs).some(([input, contribution]) =>
    resolve(repoRoot, input) === authority && contribution.bytesInOutput > 0)).map(([file]) => file);
  if (owners.length !== 1 || !early.has(owners[0]) || !host.has(owners[0])) fail('authority must be one shared module instance');
  const reachable = new Set([...early, ...host]);
  if (reachable.size !== files.size) fail('unreachable output module');
  return files;
}

function parseManifest(bytes) {
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!same(Object.keys(manifest).sort(), ['version', 'format', 'platform', 'arch', 'bootstrap', 'host_api', 'files'].sort())
    || manifest.version !== 1 || manifest.format !== FORMAT || manifest.platform !== 'win32' || manifest.arch !== 'x64'
    || manifest.bootstrap !== BOOTSTRAP || manifest.host_api !== HOST || !Array.isArray(manifest.files)
    || manifest.files.length < 2 || manifest.files.length > 1024) fail('invalid host manifest');
  const names = new Set(); let total = 0;
  for (const file of manifest.files) {
    if (!file || !same(Object.keys(file).sort(), ['bytes', 'path', 'sha256']) || !member(file.path)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 64 * 1024 * 1024
      || !/^sha256:[a-f0-9]{64}$/u.test(file.sha256) || names.has(file.path.toLowerCase())) fail('invalid manifest member');
    names.add(file.path.toLowerCase()); total += file.bytes;
  }
  if (!names.has(BOOTSTRAP) || !names.has(HOST) || total > 128 * 1024 * 1024) fail('manifest bounds or entries');
  return manifest;
}
function readBuildFile(file) {
  const before = lstatSync(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 64n * 1024n * 1024n) fail('invalid build file');
  const bytes = readFileSync(file), after = lstatSync(file, { bigint: true });
  if (realpathSync.native(file) !== file || !after.isFile() || after.nlink !== 1n || after.dev !== before.dev || after.ino !== before.ino
    || after.size !== before.size || after.mtimeNs !== before.mtimeNs || BigInt(bytes.length) !== after.size) fail('build file changed while reading');
  return bytes;
}
/** Packaging readback only: checks bytes/identity, not runtime ACL/ctime admission. */
export function verifyApplicationServiceHostBundle(directory, manifestPin) {
  directory = physicalDirectory(directory);
  const manifestPath = join(directory, MANIFEST), bytes = readBuildFile(manifestPath);
  if (bytes.length > 4 * 1024 * 1024 || manifestPin.path !== manifestPath || !same(measure(bytes), { bytes: manifestPin.bytes, sha256: manifestPin.sha256 }))
    fail('independent manifest pin differs');
  const manifest = parseManifest(bytes), expectedFiles = new Map(manifest.files.map(file => [file.path, file]));
  expectedFiles.set(MANIFEST, manifestPin);
  const expectedDirectories = new Set();
  for (const file of manifest.files) for (let dir = posix.dirname(file.path); dir !== '.'; dir = posix.dirname(dir)) expectedDirectories.add(dir);
  const actualFiles = new Set(), actualDirectories = new Set();
  const visit = (dir, depth) => {
    if (depth > 64 || actualFiles.size + actualDirectories.size > 2048) fail('output inventory bound');
    for (const name of readdirSync(dir).sort()) {
      if (actualFiles.size + actualDirectories.size >= 2048) fail('output inventory bound');
      const path = join(dir, name), local = portable(relative(directory, path)), stat = lstatSync(path);
      if (stat.isSymbolicLink() || realpathSync.native(path) !== path) fail('linked output');
      if (stat.isDirectory()) {
        if (!expectedDirectories.has(local)) fail('extra output directory');
        actualDirectories.add(local); visit(path, depth + 1);
      } else {
        const fixed = expectedFiles.get(local); if (!fixed) fail('extra output file');
        if (!same(measure(readBuildFile(path)), { bytes: fixed.bytes, sha256: fixed.sha256 })) fail('output bytes differ');
        actualFiles.add(local);
      }
    }
  };
  visit(directory, 0);
  if (actualFiles.size !== expectedFiles.size || actualDirectories.size !== expectedDirectories.size) fail('missing output member');
  return manifest;
}

export async function buildApplicationServiceHost({ repoRoot = fileURLToPath(new URL('../../..', import.meta.url)), outputDirectory } = {}) {
  if (Object.keys(process.env).some(key => /^(?:NODE_OPTIONS|NODE_PATH|ESBUILD_.*)$/iu.test(key))) fail('ambient build loader configuration');
  repoRoot = physicalDirectory(repoRoot);
  if (!outputDirectory || !isAbsolute(outputDirectory)) fail('explicit new absolute output directory required');
  const output = resolve(outputDirectory), parent = physicalDirectory(dirname(output));
  if (existsSync(output)) fail('output directory already exists');
  const lockPath = join(parent, '.' + basename(output) + '.application-host.lock'), lock = openSync(lockPath, 'wx', 0o600);
  let staging;
  try {
    if (existsSync(output)) fail('output directory already exists');
    staging = join(parent, '.' + basename(output) + '.build-' + randomUUID()); mkdirSync(staging);
    const source = join(repoRoot, 'apps/artood/src');
    const result = await build({ absWorkingDir: repoRoot, entryPoints: {
      'application-service-bootstrap': join(source, 'application-service-bootstrap.ts'),
      'application-service-host-api': join(source, 'application-service-host-api.ts'),
    }, outdir: staging, outExtension: { '.js': '.mjs' }, chunkNames: 'chunks/[name]-[hash]', bundle: true, splitting: true,
    platform: 'node', target: 'node24', format: 'esm', write: false, metafile: true, logLevel: 'silent', legalComments: 'inline',
    tsconfigRaw: { compilerOptions: { useDefineForClassFields: true } }, plugins: [ulidStaticCrypto()] });
    const files = auditApplicationServiceHostBuild(result, { repoRoot, outputDirectory: staging });
    const manifestBytes = Buffer.from(JSON.stringify({ version: 1, format: FORMAT, platform: 'win32', arch: 'x64',
      bootstrap: BOOTSTRAP, host_api: HOST, files: [...files].map(([path, bytes]) => ({ path, ...measure(bytes) }))
        .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) }, null, 2) + '\n');
    for (const [file, bytes] of files) { mkdirSync(dirname(join(staging, file)), { recursive: true }); writeFileSync(join(staging, file), bytes, { flag: 'wx' }); }
    writeFileSync(join(staging, MANIFEST), manifestBytes, { flag: 'wx' });
    verifyApplicationServiceHostBundle(staging, { path: join(staging, MANIFEST), ...measure(manifestBytes) });
    if (existsSync(output)) fail('output appeared before publish');
    renameSync(staging, output);
    const manifest = { path: join(output, MANIFEST), ...measure(manifestBytes) };
    verifyApplicationServiceHostBundle(output, manifest);
    return { outputDirectory: output, manifest, qualifiedForProduct: false };
  } catch (error) {
    throw new Error(`Application host build failed; output and staging retained (${staging ?? 'not created'}): ${error.message}`, { cause: error });
  } finally {
    try {
      const held = fstatSync(lock), named = lstatSync(lockPath);
      if (!named.isFile() || named.isSymbolicLink() || held.dev !== named.dev || held.ino !== named.ino) fail('build lock replaced; retained');
      unlinkSync(lockPath);
    } finally { closeSync(lock); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--out-dir') fail('usage: build-application-service-host.mjs --out-dir <new absolute directory>');
    process.stdout.write(JSON.stringify(await buildApplicationServiceHost({ outputDirectory: process.argv[3] })) + '\n');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { stop(); }
}
