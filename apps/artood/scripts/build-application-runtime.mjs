// Packages the fixed trusted runtime entry only. Never imports its output,
// the selected QuickJS vendor, Wasm, native helper or generated product code.
import { build, stop, version as esbuildVersion } from 'esbuild';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const sourceNames = [
  'application-runtime-entry.ts', 'application-runtime-stdio.ts', 'application-runtime-loader.ts',
  'application-runtime-installation.ts', 'application-runtime-process-protocol.ts', 'application-runtime-channel.ts',
  'application-artifact-admission.ts', 'application-quickjs-wasm-boundary.ts', 'application-quickjs-session.ts',
  'application-build-primitives.ts', 'application-wire-v1.ts', 'application-data-contract.ts',
];
const builtinOwners = {
  'node:crypto': ['application-artifact-admission.ts', 'application-data-contract.ts', 'application-runtime-installation.ts'],
  'node:fs': ['application-runtime-entry.ts', 'application-runtime-installation.ts'],
  'node:module': ['application-runtime-loader.ts'],
  'node:path': ['application-runtime-installation.ts', 'application-runtime-process-protocol.ts'],
  'node:url': ['application-runtime-loader.ts'],
  'node:util': ['application-runtime-installation.ts', 'application-runtime-stdio.ts'],
  'node:util/types': ['application-runtime-channel.ts'],
};
const externals = Object.keys(builtinOwners).sort(), dynamicMembers = ['core/dist/index.mjs', 'release-sync/dist/index.mjs'];
const zodOwners = ['application-data-contract.ts', 'application-runtime-installation.ts', 'application-runtime-process-protocol.ts'];
const name = 'application-runtime.mjs', script = fileURLToPath(import.meta.url), requireBuild = createRequire(import.meta.url);
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const pin = (path, bytes) => ({ path, bytes: bytes.length, sha256: sha(bytes) });
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const decode = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
function fail(message) { throw Error('Application runtime build: ' + message); }
function physicalDirectory(path) {
  const absolute = resolve(path), stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(absolute) !== absolute) fail('physical directory required');
  return absolute;
}
function read(path) {
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 268_435_456n
    || realpathSync.native(path) !== path) fail('physical bounded single-link input required');
  const bytes = readFileSync(path), after = lstatSync(path, { bigint: true });
  if (!after.isFile() || after.nlink !== 1n || before.dev !== after.dev || before.ino !== after.ino
    || before.size !== after.size || before.mtimeNs !== after.mtimeNs || BigInt(bytes.length) !== after.size)
    fail('input changed while reading');
  return bytes;
}

/** Fixed trusted-source audit, not a proof of arbitrary JavaScript safety.
 * Metafiles omit import(variable), so inspect the emitted JavaScript as well. */
export function inspectApplicationRuntime(text, filename, { emitted = false, loader = false } = {}) {
  const parsed = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, emitted ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  if (parsed.parseDiagnostics.length) fail('invalid module syntax');
  const imports = [], dynamic = [], codegenSites = [];
  const visit = node => {
    if (ts.isImportDeclaration(node) && emitted) {
      if (!ts.isStringLiteral(node.moduleSpecifier) || !externals.includes(node.moduleSpecifier.text)) fail('unlisted emitted external');
      imports.push(node.moduleSpecifier.text);
    }
    if (ts.isExportDeclaration(node) && emitted && node.moduleSpecifier || ts.isImportEqualsDeclaration(node)) fail('runtime module resolver');
    if (ts.isIdentifier(node) && /^(?:require|__require\d*|createRequire|getBuiltinModule|mainModule)$/u.test(node.text)
      || ts.isStringLiteral(node) && ['getBuiltinModule', 'mainModule'].includes(node.text)
      || ts.isPropertyAccessExpression(node) && node.name.text === 'resolve' && ts.isMetaProperty(node.expression))
      fail('runtime module resolver');
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (!(emitted || loader) || node.arguments.length !== 1 || !argument || !ts.isCallExpression(argument)
        || !ts.isIdentifier(argument.expression) || argument.arguments.length !== 1
        || !ts.isStringLiteral(argument.arguments[0]) || !dynamicMembers.includes(argument.arguments[0].text))
        fail('unreviewed computed import');
      dynamic.push({ member: argument.arguments[0].text, resolver: argument.expression.text,
        line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1, expression: node.getText(parsed) });
    }
    if ((ts.isCallExpression(node) || ts.isNewExpression(node))
      && /^(?:Function|eval|globalThis\.Function|globalThis\.eval)$/u.test(node.expression.getText(parsed)))
      codegenSites.push({ expression: node.expression.getText(parsed), line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1 });
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  if ((emitted || loader) && (!same(dynamic.map(value => value.member).sort(), dynamicMembers)
    || new Set(dynamic.map(value => value.resolver)).size !== 1)) fail('both fixed vendor imports must use one resolver');
  if (emitted && !same([...new Set(imports)].sort(), externals)) fail('emitted builtin set differs');
  return { dynamic, codegenSites };
}

/** Fresh output only. repoRoot selects the repository containing the twelve
 * fixed sources; it cannot select an entry, source allowlist, resolver or plugin. */
export async function buildApplicationRuntime({ repoRoot = fileURLToPath(new URL('../../..', import.meta.url)), outputDirectory } = {}) {
  if (Object.keys(process.env).some(key => /^(?:ESBUILD_.*|NODE_OPTIONS|NODE_PATH|NODE_V8_COVERAGE)$/iu.test(key))) fail('ambient build loader configuration');
  repoRoot = physicalDirectory(repoRoot);
  if (!outputDirectory || !isAbsolute(outputDirectory)) fail('explicit new absolute output directory required');
  const directory = resolve(outputDirectory); physicalDirectory(dirname(directory));
  if (existsSync(directory)) fail('output directory already exists');
  mkdirSync(directory); // Exclusive, and deliberately retained after failure.
  const captured = new Map();
  const capture = path => { path = resolve(path); if (!captured.has(path)) captured.set(path, read(path)); return captured.get(path); };
  try {
    const sources = sourceNames.map(member => join(repoRoot, 'apps/artood/src', member)), local = new Set(sources), entry = sources[0];
    const compiler = requireBuild.resolve('typescript');
    if (ts.version !== '5.9.3' || sha(capture(compiler)) !== 'sha256:3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675'
      || esbuildVersion !== '0.28.2') fail('unreviewed packaging toolchain');
    const platformPackage = requireBuild.resolve(`@esbuild/${process.platform}-${process.arch}/package.json`);
    for (const file of [script, join(repoRoot, 'package.json'), join(repoRoot, 'package-lock.json'),
      requireBuild.resolve('typescript/package.json'), requireBuild.resolve('esbuild/package.json'), requireBuild.resolve('esbuild'),
      platformPackage, join(dirname(platformPackage), process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'), process.execPath]) capture(file);
    for (const file of sources) inspectApplicationRuntime(decode(capture(file)), file, { loader: basename(file) === 'application-runtime-loader.ts' });
    const zodRoot = physicalDirectory(join(repoRoot, 'node_modules/zod'));
    const zodMetadata = JSON.parse(decode(capture(join(zodRoot, 'package.json'))));
    if (zodMetadata.name !== 'zod' || zodMetadata.version !== '4.6.7' || zodMetadata.module !== './index.js') fail('unreviewed Zod package');
    const zodFile = file => {
      const member = relative(zodRoot, file);
      return !!member && !isAbsolute(member) && member !== '..' && !member.startsWith('..' + sep) && member.endsWith('.js');
    };
    const result = await build({ absWorkingDir: repoRoot, entryPoints: [entry],
      bundle: true, platform: 'node', target: 'es2023', format: 'esm', write: false, metafile: true,
      outfile: join(directory, name), logLevel: 'silent', legalComments: 'none',
      tsconfigRaw: { compilerOptions: { useDefineForClassFields: true } },
      plugins: [{ name: 'fixed-runtime-source-closure', setup(plugin) {
        plugin.onResolve({ filter: /./ }, args => {
          if (args.kind === 'entry-point') { if (resolve(args.path) !== entry) fail('fixed entry required'); return { path: entry }; }
          if (Object.hasOwn(builtinOwners, args.path)) {
            if (args.kind !== 'import-statement' || !local.has(args.importer) || !builtinOwners[args.path].includes(basename(args.importer)))
              fail('builtin imported outside its reviewed owner');
            return { path: args.path, external: true };
          }
          if (args.path === 'zod') {
            if (args.kind !== 'import-statement' || !local.has(args.importer) || !zodOwners.includes(basename(args.importer))) fail('unreviewed Zod importer');
            return { path: join(zodRoot, 'index.js') };
          }
          if (args.kind !== 'import-statement' || !/^\.\.?\//u.test(args.path) || /[\\?#%]/u.test(args.path)) fail('unlisted dependency');
          let target = resolve(dirname(args.importer), args.path);
          if (local.has(args.importer) && target.endsWith('.js')) target = target.slice(0, -3) + '.ts';
          if (local.has(args.importer) ? !local.has(target) : !zodFile(args.importer) || !zodFile(target)) fail('dependency escapes fixed source closure');
          return { path: target };
        });
        plugin.onLoad({ filter: /./ }, args => {
          if (!local.has(args.path) && !zodFile(args.path)) fail('unlisted source');
          return { contents: decode(capture(args.path)), loader: local.has(args.path) ? 'ts' : 'js' };
        });
      } }] });
    const records = Object.values(result.metafile.outputs), output = result.outputFiles[0];
    if (result.outputFiles.length !== 1 || records.length !== 1 || output.path !== join(directory, name)
      || records[0].exports.length || !records[0].imports.every(value => value.external && value.kind === 'import-statement')
      || !same([...new Set(records[0].imports.map(value => value.path))].sort(), externals)
      || sources.some(file => !Object.keys(result.metafile.inputs).some(member => resolve(repoRoot, member) === file))
      || Object.keys(result.metafile.inputs).some(file => !captured.has(resolve(repoRoot, file)))) fail('unexpected input/output graph');
    const inspection = inspectApplicationRuntime(output.text, name, { emitted: true });
    if (output.contents.length > 8 * 1024 * 1024) fail('runtime entry exceeds byte bound');
    for (const [file, bytes] of captured) if (!read(file).equals(bytes)) fail('original build input changed');
    const inputs = [...captured].map(([file, bytes]) => pin(file, bytes)).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const entryPin = pin(output.path, output.contents);
    const manifest = { version: 1, format: 'artoo.application-runtime-entry-build.v1', qualified_for_product: false,
      scope: 'Fixed trusted runtime entry packaging only; no output, vendor, Wasm, native helper or product executed',
      entry: entryPin, runtime_externals: externals, permitted_computed_imports: inspection.dynamic,
      direct_codegen_sites: inspection.codegenSites, codegen_scan_is_not_a_proof: true,
      inputs, input_digest: sha(JSON.stringify(inputs)), esbuild_version: esbuildVersion, typescript_version: ts.version,
      node_version: process.version, metafile: result.metafile };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), manifestPath = join(directory, 'build.json');
    writeFileSync(entryPin.path, output.contents, { flag: 'wx' });
    if (!read(entryPin.path).equals(Buffer.from(output.contents))) fail('written entry differs');
    writeFileSync(manifestPath, manifestBytes, { flag: 'wx' });
    if (!read(manifestPath).equals(manifestBytes)) fail('written manifest differs');
    return { entry: entryPin, manifest: pin(manifestPath, manifestBytes), qualifiedForProduct: false };
  } catch (error) { throw Error(`Application runtime build failed; output retained (${directory}): ${error.message}`, { cause: error }); }
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--out-dir') fail('usage: build-application-runtime.mjs --out-dir <new absolute directory>');
    process.stdout.write(JSON.stringify(await buildApplicationRuntime({ outputDirectory: process.argv[3] })) + '\n');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { stop(); }
}
