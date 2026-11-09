import { build, stop, version as esbuildVersion } from 'esbuild';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

if (process.argv.length !== 4 || process.argv[2] !== '--out-dir') throw Error('Usage: build-application-compiler.mjs --out-dir <new directory>');
if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)
  || Object.keys(process.env).some(key => /^(?:ESBUILD_.*|NODE_OPTIONS|NODE_PATH)$/iu.test(key))) throw Error('Unsupported or ambient packaging environment');
const directory = resolve(process.argv[3]);
await mkdir(directory); // An exclusive fresh directory preserves previous packages and evidence.
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
const binaryPackage = requireBuild.resolve(`@esbuild/win32-${process.arch}/package.json`);
const binary = join(dirname(binaryPackage), 'esbuild.exe');
const allowedSource = ['application-compiler-entry.ts', 'application-compiler-protocol.ts', 'application-compiler-contract.ts',
  'application-build-core.ts', 'application-build-kernel.ts', 'application-sdk-v1.ts']
  .map(name => resolve(scripts, '../src', name));
const sdkSource = join(root, 'packages/domain/src/application-sdk-v1.ts');
allowedSource.push(sdkSource);
const sourceSet = new Set(allowedSource);
const allowedBuiltins = new Set(['fs', 'path', 'os', 'crypto', 'perf_hooks', 'util'].flatMap(name => [name, `node:${name}`]));
const deniedCompatibility = new Set(['source-map-support', 'inspector']);
const allowedExternal = new Set([...allowedBuiltins, ...deniedCompatibility]);

/** Review executable resolver uses, not string contents or just esbuild's static imports.
 * This is a fixed trusted dependency audit, not a JavaScript security sandbox. */
function auditResolvers(text, label) {
  const parsed = ts.createSourceFile(label, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (parsed.parseDiagnostics.length) throw Error('Unparseable runtime dependency');
  const calls = [], hostCalls = []; let internalCommonJsHelpers = 0;
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) throw Error('Surviving dynamic import');
    if (ts.isIdentifier(node) && ['createRequire', 'loadBuiltin'].includes(node.text)) throw Error('Unchecked resolver alias');
    if (ts.isIdentifier(node) && node.text === '__require') {
      const parent = node.parent;
      // esbuild uses this local function name for its internal module cache. It never
      // captures Node's require. Accept only this exact, reviewed helper body.
      const body = '{ try { return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports; } catch (e) { throw mod = 0, e; } }';
      if (!ts.isFunctionExpression(parent) || parent.name !== node || parent.parameters.length
        || parent.body.getText(parsed).replace(/\s/gu, '') !== body.replace(/\s/gu, '')) {
        throw Error('Unchecked require compatibility shim');
      }
      internalCommonJsHelpers++;
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)
      && ['require', 'createRequire'].includes(node.argumentExpression.text)) throw Error('Computed resolver access');
    if (ts.isIdentifier(node) && node.text === 'require') {
      const parent = node.parent;
      if (ts.isCallExpression(parent) && parent.expression === node && parent.arguments.length === 1) {
        const argument = parent.arguments[0];
        if (ts.isStringLiteral(argument) && allowedExternal.has(argument.text)) calls.push(argument.text);
        else if (ts.isIdentifier(argument) && argument.text === 'modulePath') calls.push('<guarded:modulePath>');
        else throw Error('Unreviewed require call');
      } else if (ts.isTypeOfExpression(parent) && parent.expression === node) {
        // TypeScript's Node capability check does not obtain a resolver alias.
      } else if (ts.isPropertyAssignment(parent) && parent.name === node) {
        // TypeScript's sys object and SyntaxKind table have a named require property.
      } else if (ts.isPropertyAccessExpression(parent) && parent.name === node
        && (ts.isIdentifier(parent.expression) && parent.expression.text === 'host'
          || ts.isPropertyAccessExpression(parent.expression) && parent.expression.name.text === 'host'
            && parent.expression.expression.kind === ts.SyntaxKind.ThisKeyword)) {
        hostCalls.push('host.require'); // Inert language-service plugin path; no such host is supplied by our core.
      } else throw Error('Unchecked require reference or require.resolve');
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  if (calls.filter(value => value === '<guarded:modulePath>').length !== 1) throw Error('Changed TypeScript dynamic resolver shape');
  return { calls, languageServiceHostReferences: hostCalls.length, internalCommonJsHelpers, dynamic_imports: 0, resolver_aliases: 0 };
}

try {
  const compilerBytes = await capture(compiler);
  // Upgrades require explicitly reviewing the new compiler and its runtime resolver paths.
  if (ts.version !== '5.9.3' || digest(compilerBytes) !== 'sha256:3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675') throw Error('Unreviewed TypeScript implementation');
  const compilerResolverAudit = auditResolvers(utf8(compilerBytes), 'typescript.js');
  const libraries = [];
  for (const name of (await readdir(compilerDirectory)).filter(name => /^lib\.[a-z0-9.]+\.d\.ts$/u.test(name)).sort()) {
    libraries.push({ path: name, text: utf8(await capture(join(compilerDirectory, name))) });
  }
  if (libraries.length < 1 || libraries.length > 128 || libraries.some(file => Buffer.byteLength(file.text) > 4 * 1024 * 1024)
    || libraries.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0) > 16 * 1024 * 1024) throw Error('Unsupported compiler libraries');
  const injectedLibraries = JSON.stringify(libraries);
  const bootstrapPath = join(scripts, 'application-compiler-bootstrap.cjs'), bootstrap = utf8(await capture(bootstrapPath));
  const buildMetadata = [script, join(root, 'package.json'), join(root, 'package-lock.json'),
    requireBuild.resolve('typescript/package.json'), zodPackage, requireBuild.resolve('esbuild/package.json'),
    requireBuild.resolve('esbuild'), binaryPackage, binary, process.execPath];
  for (const path of buildMetadata) await capture(path);
  const result = await build({ absWorkingDir: root, entryPoints: [allowedSource[0]], bundle: true, platform: 'node', target: 'node24',
    format: 'cjs', write: false, metafile: true, outfile: join(directory, 'application-compiler.cjs'), logLevel: 'silent',
    tsconfigRaw: { compilerOptions: { useDefineForClassFields: true } }, legalComments: 'none',
    external: [...deniedCompatibility], define: { __ARTOO_PACKAGED_COMPILER_LIBRARIES__: injectedLibraries },
    plugins: [{ name: 'fixed-compiler-inputs', setup(plugin) {
      plugin.onResolve({ filter: /^(?:typescript|zod)$/ }, args => ({ path: args.path === 'typescript' ? compiler : zod }));
      plugin.onResolve({ filter: /^@artoo\/domain$/ }, args => {
        if (resolve(args.importer) !== resolve(scripts, '../src/application-sdk-v1.ts')) throw Error('Unexpected domain import');
        return { path: sdkSource };
      });
      plugin.onLoad({ filter: /\.(?:[cm]?js|ts)$/, namespace: 'file' }, async args => {
        const path = resolve(args.path);
        if (!sourceSet.has(path) && path !== compiler && !(path.startsWith(zodRoot + sep) && /\.[cm]?js$/u.test(path))) throw Error('Unexpected packaged input');
        return { contents: utf8(await capture(path)), loader: path.endsWith('.ts') ? 'ts' : 'js' };
      });
    } }] });
  if (result.outputFiles.length !== 1 || Object.values(result.metafile.outputs).some(output =>
    output.imports.some(imported => !imported.external || !allowedExternal.has(imported.path)))) throw Error('Unexpected runtime dependency');
  for (const name of Object.keys(result.metafile.inputs)) {
    if (name.startsWith('<define:') && name === '<define:__ARTOO_PACKAGED_COMPILER_LIBRARIES__>') continue;
    if (!captured.has(resolve(root, name))) throw Error('Unmeasured bundle input');
  }
  const rawBundle = result.outputFiles[0].text;
  const bundleResolverAudit = auditResolvers(rawBundle, 'application-compiler.cjs');
  // A banner is deliberately added only AFTER auditing the raw bundle. The sole original
  // resolver capture is the small, measured bootstrap; it is unavailable to bundle code.
  const output = Buffer.from(bootstrap + '\n' + rawBundle, 'utf8');
  for (const [path, original] of captured) if (!(await readFile(path)).equals(original)) throw Error('Packaging input changed');
  const inputs = [...captured].map(([path, bytes]) => pin(path, bytes)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const entry = pin(join(directory, 'application-compiler.cjs'), output);
  const manifest = { version: 1, format: 'artoo.application-compiler-package.v1', qualified_for_product: false,
    execution: 'unavailable: native profile, isolated compiler process, protected staging and closure are not integrated',
    compiler_version: ts.version, esbuild_version: esbuildVersion, packaging_node_version: process.version,
    entry, inputs, input_digest: digest(Buffer.from(JSON.stringify(inputs))),
    compiler: pin(compiler, compilerBytes), bootstrap: pin(bootstrapPath, captured.get(bootstrapPath)),
    libraries: libraries.map(file => ({ logical_path: file.path, ...pin(join(compilerDirectory, file.path), captured.get(join(compilerDirectory, file.path))) })),
    injected_libraries: { bytes: Buffer.byteLength(injectedLibraries), sha256: digest(Buffer.from(injectedLibraries)) },
    runtime_resolvers: { allowed_builtins: [...allowedBuiltins], denied_compatibility: [...deniedCompatibility], compilerResolverAudit, bundleResolverAudit },
    metafile: result.metafile };
  await writeFile(entry.path, output, { flag: 'wx' });
  await writeFile(join(directory, 'build.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify({ entry, inputs: inputs.length, libraries: libraries.length, qualified_for_product: false }) + '\n');
} finally { stop(); }
