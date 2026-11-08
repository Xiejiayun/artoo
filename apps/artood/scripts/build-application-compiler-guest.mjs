import { build, stop, version as esbuildVersion } from 'esbuild';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

if (process.argv.length !== 4 || process.argv[2] !== '--out-dir') throw Error('Usage: build-application-compiler-guest.mjs --out-dir <new directory>');
if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)
  || Object.keys(process.env).some(key => /^(?:ESBUILD_.*|NODE_OPTIONS|NODE_PATH)$/iu.test(key))) throw Error('Unsupported or ambient packaging environment');
const directory = resolve(process.argv[3]);
await mkdir(directory); // A fresh exclusive directory never rewrites an earlier package or diagnostic.
const script = fileURLToPath(import.meta.url), scripts = dirname(script), root = resolve(scripts, '../../..');
const requireBuild = createRequire(import.meta.url), captured = new Map();
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const pin = (path, bytes) => ({ path, bytes: bytes.length, sha256: digest(bytes) });
const utf8 = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
async function capture(path) {
  path = resolve(path);
  if (!captured.has(path)) captured.set(path, await readFile(path));
  return captured.get(path);
}
const compiler = requireBuild.resolve('typescript'), compilerDirectory = dirname(compiler);
const zod = requireBuild.resolve('zod'), zodPackage = requireBuild.resolve('zod/package.json'), zodRoot = dirname(zodPackage);
const binaryPackage = requireBuild.resolve(`@esbuild/win32-${process.arch}/package.json`), binary = join(dirname(binaryPackage), 'esbuild.exe');
const allowedSource = ['application-compiler-guest-entry.ts', 'application-compiler-contract.ts',
  'application-build-kernel.ts', 'application-build-primitives.ts', 'application-sdk-v1.ts'].map(name => resolve(scripts, '../src', name));
const sourceSet = new Set(allowedSource);

function auditGuestImports(text) {
  const parsed = ts.createSourceFile('application-compiler-guest.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (parsed.parseDiagnostics.length) throw Error('Unparseable guest bundle');
  const visit = node => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) && node.moduleSpecifier
      || ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || ts.isIdentifier(node.expression) && ['require', 'createRequire'].includes(node.expression.text))) throw Error('Guest runtime resolver is unsupported');
    ts.forEachChild(node, visit);
  };
  visit(parsed);
}

try {
  const compilerBytes = await capture(compiler);
  if (ts.version !== '5.9.3' || digest(compilerBytes) !== 'sha256:3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675') throw Error('Unreviewed TypeScript implementation');
  const libraries = [];
  for (const name of (await readdir(compilerDirectory)).filter(name => /^lib\.[a-z0-9.]+\.d\.ts$/u.test(name)).sort())
    libraries.push({ path: name, text: utf8(await capture(join(compilerDirectory, name))) });
  if (libraries.length < 1 || libraries.length > 128 || libraries.some(file => Buffer.byteLength(file.text) > 4 * 1024 * 1024)
    || libraries.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0) > 16 * 1024 * 1024) throw Error('Unsupported compiler libraries');
  const injectedLibraries = JSON.stringify(libraries);
  for (const path of [script, join(root, 'package.json'), join(root, 'package-lock.json'),
    requireBuild.resolve('typescript/package.json'), zodPackage, requireBuild.resolve('esbuild/package.json'),
    requireBuild.resolve('esbuild'), binaryPackage, binary, process.execPath]) await capture(path);
  const result = await build({ absWorkingDir: root, entryPoints: [allowedSource[0]], bundle: true, platform: 'neutral', target: 'es2023',
    format: 'iife', globalName: '__artooApplicationCompilerV1', write: false, metafile: true,
    outfile: join(directory, 'application-compiler-guest.js'), logLevel: 'silent', legalComments: 'none',
    tsconfigRaw: { compilerOptions: { useDefineForClassFields: true } },
    define: { __ARTOO_GUEST_TYPESCRIPT__: 'ts', __ARTOO_PACKAGED_COMPILER_LIBRARIES__: injectedLibraries },
    plugins: [{ name: 'fixed-guest-compiler-inputs', setup(plugin) {
      plugin.onResolve({ filter: /^zod$/ }, () => ({ path: zod }));
      plugin.onLoad({ filter: /\.(?:[cm]?js|ts)$/, namespace: 'file' }, async args => {
        const path = resolve(args.path);
        if (!sourceSet.has(path) && !(path.startsWith(zodRoot + sep) && /\.[cm]?js$/u.test(path))) throw Error('Unexpected packaged guest input');
        return { contents: utf8(await capture(path)), loader: path.endsWith('.ts') ? 'ts' : 'js' };
      });
    } }] });
  if (result.outputFiles.length !== 1 || Object.values(result.metafile.outputs).some(output => output.imports.length)) throw Error('Guest runtime dependency');
  for (const name of Object.keys(result.metafile.inputs)) {
    if (name === '<define:__ARTOO_PACKAGED_COMPILER_LIBRARIES__>') continue;
    if (!captured.has(resolve(root, name))) throw Error('Unmeasured guest bundle input');
  }
  const bundle = Buffer.from(result.outputFiles[0].text, 'utf8');
  auditGuestImports(utf8(bundle));
  for (const [path, original] of captured) if (!(await readFile(path)).equals(original)) throw Error('Guest packaging input changed');
  const inputs = [...captured].map(([path, bytes]) => pin(path, bytes)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const entry = pin(join(directory, 'application-compiler-guest.js'), bundle), typescript = pin(join(directory, 'typescript.js'), compilerBytes);
  const manifest = { version: 1, format: 'artoo.application-compiler-guest-package.v1', qualified_for_product: false,
    execution: 'unavailable: native profile, isolated compiler process, protected staging and closure are not integrated',
    compiler_version: ts.version, esbuild_version: esbuildVersion, packaging_node_version: process.version,
    entry, typescript, inputs, input_digest: digest(Buffer.from(JSON.stringify(inputs))),
    compiler: pin(compiler, compilerBytes),
    libraries: libraries.map(file => ({ logical_path: file.path, ...pin(join(compilerDirectory, file.path), captured.get(join(compilerDirectory, file.path))) })),
    injected_libraries: { bytes: Buffer.byteLength(injectedLibraries), sha256: digest(Buffer.from(injectedLibraries)) },
    runtime_resolvers: [], guest_host_callbacks: [], metafile: result.metafile };
  await writeFile(typescript.path, compilerBytes, { flag: 'wx' });
  await writeFile(entry.path, bundle, { flag: 'wx' });
  await writeFile(join(directory, 'build.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify({ entry, typescript, inputs: inputs.length, libraries: libraries.length, qualified_for_product: false }) + '\n');
} finally { stop(); }
