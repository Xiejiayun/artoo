import { build, stop, version as esbuildVersion } from 'esbuild';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
if (process.argv.length !== 4 || process.argv[2] !== '--out-dir') throw Error('Usage: build-application-compiler-child.mjs --out-dir <new directory>');
if (process.platform !== 'win32' || process.arch !== 'x64'
  || Object.keys(process.env).some(key => /^(?:ESBUILD_.*|NODE_OPTIONS|NODE_PATH)$/iu.test(key))) throw Error('Unsupported or ambient packaging environment');
const script = fileURLToPath(import.meta.url), scripts = dirname(script), sourceTree = resolve(scripts, '../../..');
// The reviewed artifact overlay and normal repository layout are the only
// supported source roots. This is packaging-local, never a request parameter.
const artifactOverlay = basename(sourceTree) === 'overlay' && basename(dirname(sourceTree)) === 'application-compiler-child-draft-r1'
  && basename(dirname(dirname(sourceTree))) === 'artifacts';
const root = artifactOverlay ? resolve(sourceTree, '../../..') : sourceTree;
const out = resolve(process.argv[3]), requireBuild = createRequire(import.meta.url), captured = new Map();
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const utf8 = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
const pin = (path, bytes) => ({ path, bytes: bytes.length, sha256: digest(bytes) });
const measure = bytes => ({ bytes: bytes.length, sha256: digest(bytes) });
async function capture(path) { path = resolve(path); if (!captured.has(path)) captured.set(path, await readFile(path)); return captured.get(path); }
const guestNames = ['application-compiler-guest-entry.ts', 'application-compiler-contract.ts', 'application-build-kernel.ts', 'application-build-primitives.ts', 'application-sdk-v1.ts'];
const hostNames = ['application-compiler-process-entry.ts', 'application-compiler-process-stdio.ts', 'application-compiler-loader.ts',
  'application-compiler-session.ts', 'application-compiler-installation.ts', 'application-compiler-process-protocol.ts',
  'application-compiler-contract.ts', 'application-quickjs-wasm-boundary.ts', 'application-runtime-installation.ts',
  'application-runtime-process-protocol.ts', 'application-build-primitives.ts'];
const overlayNames = new Set((await readdir(resolve(scripts, '../src'))).filter(name => name.endsWith('.ts')));
const sources = new Map([...new Set([...guestNames, ...hostNames])].map(name => [name,
  overlayNames.has(name) ? resolve(scripts, '../src', name) : join(root, 'apps/artood/src', name)]));
const sdkSource = join(root, 'packages/domain/src/application-sdk-v1.ts');
const zod = requireBuild.resolve('zod'), zodPackage = requireBuild.resolve('zod/package.json'), zodRoot = dirname(zodPackage);
const allowedBuiltins = new Set(['node:crypto', 'node:fs', 'node:module', 'node:path', 'node:url', 'node:util']);
function plugin(names, host) {
  const allowed = new Set(names.map(name => sources.get(name)));
  if (names.includes('application-sdk-v1.ts')) allowed.add(sdkSource);
  return { name: 'fixed-compiler-package-closure', setup(api) {
    api.onResolve({ filter: /^zod$/ }, () => ({ path: zod }));
    api.onResolve({ filter: /^@artoo\/domain$/ }, args => {
      if (resolve(args.importer) !== sources.get('application-sdk-v1.ts') || !allowed.has(sdkSource)) throw Error('Unexpected domain import');
      return { path: sdkSource };
    });
    api.onResolve({ filter: /^node:/ }, args => {
      if (!host || !allowedBuiltins.has(args.path)) throw Error('Unexpected packaged builtin'); return { path: args.path, external: true };
    });
    api.onResolve({ filter: /^\.\/.+\.js$/ }, args => {
      if (!allowed.has(resolve(args.importer))) return;
      const path = sources.get(basename(args.path).replace(/\.js$/u, '.ts'));
      if (!path || !allowed.has(path)) throw Error('Unexpected packaged source import'); return { path };
    });
    api.onLoad({ filter: /\.(?:[cm]?js|ts)$/, namespace: 'file' }, async args => {
      const path = resolve(args.path);
      if (!allowed.has(path) && !(path.startsWith(zodRoot + sep) && /\.[cm]?js$/u.test(path))) throw Error('Unexpected packaged input');
      return { contents: utf8(await capture(path)), loader: path.endsWith('.ts') ? 'ts' : 'js' };
    });
  } };
}
function audit(text, host) {
  const parsed = ts.createSourceFile(host ? 'host.mjs' : 'guest.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (parsed.parseDiagnostics.length) throw Error('Unparseable fixed bundle'); let dynamic = 0;
  const visit = node => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (!host || !node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier) || !allowedBuiltins.has(node.moduleSpecifier.text)) throw Error('Unexpected bundle import');
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const value = node.arguments[0];
      if (!host || node.arguments.length !== 1 || !value || !ts.isCallExpression(value) || !ts.isIdentifier(value.expression)
        || value.expression.text !== 'url' || value.arguments.length !== 1 || !ts.isStringLiteral(value.arguments[0])
        || !['core/dist/index.mjs', 'release-sync/dist/index.mjs'].includes(value.arguments[0].text)) throw Error('Unexpected dynamic bundle import');
      dynamic++;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['require', 'createRequire'].includes(node.expression.text)) throw Error('Unexpected host resolver');
    ts.forEachChild(node, visit);
  };
  visit(parsed); if (host && dynamic !== 2) throw Error('Missing fixed vendor loads');
}
try {
  await mkdir(out); // Exclusive generation; no old package or evidence is overwritten.
  for (const name of ['compiler', 'host', 'vendor']) await mkdir(join(out, name));
  const compilerPath = requireBuild.resolve('typescript'), compilerBytes = await capture(compilerPath);
  if (ts.version !== '5.9.3' || digest(compilerBytes) !== 'sha256:3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675') throw Error('Unreviewed TypeScript implementation');
  const libraryFiles = (await readdir(dirname(compilerPath))).filter(name => /^lib\.[a-z0-9.]+\.d\.ts$/u.test(name)).sort();
  const libraries = [];
  for (const name of libraryFiles) libraries.push({ path: name, text: utf8(await capture(join(dirname(compilerPath), name))) });
  if (libraries.length < 1 || libraries.length > 128 || libraries.some(file => !file.text.isWellFormed() || Buffer.byteLength(file.text) > 4 * 1024 * 1024)
    || libraries.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0) > 16 * 1024 * 1024) throw Error('Unsupported compiler libraries');
  const snapshot = Buffer.from(JSON.stringify(libraries));
  if (snapshot.length > 100 * 1024 * 1024) throw Error('Snapshot wire bound');
  const binaryPackage = requireBuild.resolve('@esbuild/win32-x64/package.json');
  for (const path of [script, join(root, 'package.json'), join(root, 'package-lock.json'), requireBuild.resolve('typescript/package.json'),
    zodPackage, requireBuild.resolve('esbuild/package.json'), requireBuild.resolve('esbuild'), binaryPackage, join(dirname(binaryPackage), 'esbuild.exe'), process.execPath]) await capture(path);
  const guestBuild = await build({ absWorkingDir: root, entryPoints: [sources.get(guestNames[0])], bundle: true, platform: 'neutral', target: 'es2023',
    format: 'iife', globalName: '__artooApplicationCompilerV1', write: false, metafile: true, logLevel: 'silent', legalComments: 'none',
    tsconfigRaw: { compilerOptions: { useDefineForClassFields: true } }, plugins: [plugin(guestNames, false)],
    define: { __ARTOO_GUEST_TYPESCRIPT__: 'ts', __ARTOO_PACKAGED_COMPILER_LIBRARIES__: utf8(snapshot) } });
  const hostBuild = await build({ absWorkingDir: root, entryPoints: [sources.get(hostNames[0])], bundle: true, platform: 'node', target: 'node24',
    format: 'esm', write: false, metafile: true, logLevel: 'silent', legalComments: 'none',
    tsconfigRaw: { compilerOptions: { useDefineForClassFields: true } }, plugins: [plugin(hostNames, true)] });
  if (guestBuild.outputFiles.length !== 1 || hostBuild.outputFiles.length !== 1
    || Object.values(guestBuild.metafile.outputs).some(output => output.imports.length)
    || Object.values(hostBuild.metafile.outputs).some(output => output.imports.some(item => !item.external || !allowedBuiltins.has(item.path)))) throw Error('Unexpected bundle closure');
  const guest = Buffer.from(guestBuild.outputFiles[0].text), host = Buffer.from(hostBuild.outputFiles[0].text);
  audit(utf8(guest), false); audit(utf8(host), true);
  for (const result of [guestBuild, hostBuild]) for (const name of Object.keys(result.metafile.inputs)) {
    if (name === '<define:__ARTOO_PACKAGED_COMPILER_LIBRARIES__>') continue;
    if (!captured.has(resolve(root, name))) throw Error('Unmeasured bundle input');
  }
  const vendorRoot = join(root, 'apps/artood/vendor/quickjs-0.32.0'), vendorManifestBytes = await capture(join(vendorRoot, 'manifest.json'));
  const vendor = JSON.parse(utf8(vendorManifestBytes));
  const expected = ['core/dist/index.mjs', 'core/dist/chunk-TAV5CUKK.mjs', 'core/dist/chunk-V2S4ZYJR.mjs', 'core/dist/module-ES6BEMUI.mjs',
    'release-sync/dist/index.mjs', 'release-sync/dist/ffi.mjs', 'release-sync/dist/emscripten-module.mjs', 'release-sync/dist/emscripten-module.wasm', 'ffi-types/dist/index.mjs'];
  const support = ['core/LICENSE', 'core/package.json', 'release-sync/LICENSE', 'release-sync/package.json', 'ffi-types/LICENSE', 'ffi-types/package.json'];
  if (vendor.format !== 'artoo.quickjs-runtime-vendor.v1' || vendor.version_name !== '0.32.0' || vendor.variant !== 'wasmfile-release-sync'
    || vendor.qualified_for_product !== false || JSON.stringify(vendor.files.map(file => file.path).sort()) !== JSON.stringify([...expected, ...support].sort())) throw Error('Fixed vendor package required');
  const outputs = new Map();
  for (const file of vendor.files) {
    const bytes = await capture(join(vendorRoot, file.path));
    if (bytes.length !== file.bytes || digest(bytes) !== 'sha256:' + file.sha256) throw Error('Vendor content changed');
    outputs.set(join(out, expected.includes(file.path) ? 'vendor' : 'vendor-support', file.path), bytes);
  }
  const runtimeVendorManifest = Buffer.from(JSON.stringify({ ...vendor, files: vendor.files.filter(file => expected.includes(file.path)) }, null, 2) + '\n');
  outputs.set(join(out, 'vendor/manifest.json'), runtimeVendorManifest);
  outputs.set(join(out, 'compiler/typescript.js'), compilerBytes); outputs.set(join(out, 'compiler/application-compiler-guest.js'), guest);
  outputs.set(join(out, 'compiler/application-compiler-libraries.json'), snapshot);
  const manifest = Buffer.from(JSON.stringify({ version: 1, format: 'artoo.application-compiler-installation.v1', qualified_for_product: false,
    compiler_version: '5.9.3', typescript: measure(compilerBytes), guest: measure(guest), libraries: measure(snapshot) }) + '\n');
  const compilerManifestPath = join(out, 'compiler/compiler-installation.json'); outputs.set(compilerManifestPath, manifest);
  const configuration = Buffer.from(JSON.stringify({ version: 1, protocol: 'artoo.application-compiler-process.v1',
    vendorManifest: pin(join(out, 'vendor/manifest.json'), runtimeVendorManifest), compilerManifest: pin(compilerManifestPath, manifest) }) + '\n');
  outputs.set(join(out, 'host/application-compiler-process.mjs'), host); outputs.set(join(out, 'host/application-compiler-process.json'), configuration);
  for (const [path, original] of captured) if (!(await readFile(path)).equals(original)) throw Error('Packaging input changed');
  for (const [path, bytes] of outputs) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes, { flag: 'wx' }); }
  const inputs = [...captured].map(([path, bytes]) => pin(path, bytes)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const report = { version: 1, format: 'artoo.application-compiler-child-package.v1', qualified_for_product: false,
    scope: 'fixed packaging only; no native helper or compiler child executed; protected installation admission not established',
    compiler_version: ts.version, esbuild_version: esbuildVersion, packaging_node_version: process.version,
    inputs, input_digest: digest(Buffer.from(JSON.stringify(inputs))), outputs: [...outputs].map(([path, bytes]) => pin(path, bytes)),
    libraries: libraryFiles.length, guest_host_callbacks: [], guest_runtime_resolvers: [],
    host_builtins: [...allowedBuiltins].sort(), guest_metafile: guestBuild.metafile, host_metafile: hostBuild.metafile };
  await writeFile(join(out, 'build.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify({ output: out, inputs: inputs.length, outputs: outputs.size, libraries: libraries.length, qualified_for_product: false }) + '\n');
} finally { stop(); }
