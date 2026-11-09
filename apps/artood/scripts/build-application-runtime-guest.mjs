import { build, stop, version as esbuildVersion } from 'esbuild';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.argv.length !== 4 || process.argv[2] !== '--out-dir')
  throw Error('Usage: build-application-runtime-guest.mjs --out-dir <new directory>');
if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)
  || Object.keys(process.env).some(key => /^(?:ESBUILD_.*|NODE_OPTIONS|NODE_PATH)$/iu.test(key)))
  throw Error('Unsupported or ambient packaging environment');

const directory = resolve(process.argv[3]), script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), '../../..'), requireBuild = createRequire(import.meta.url);
const source = join(root, 'apps/artood/src/application-runtime-guest.ts');
const name = 'application-runtime-guest-bootstrap.js', captured = new Map();
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const pin = (path, bytes) => ({ path, bytes: bytes.length, sha256: digest(bytes) });
const utf8 = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
async function capture(path) {
  path = resolve(path);
  if (!captured.has(path)) captured.set(path, await readFile(path));
  return captured.get(path);
}
function parse(text, filename, kind) {
  const parsed = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, kind);
  if (parsed.parseDiagnostics.length) throw Error('Invalid fixed bootstrap source');
  return parsed;
}
function noRuntimeResolver(parsed, typeImportsAllowed) {
  const visit = node => {
    if (ts.isImportDeclaration(node) && !(typeImportsAllowed && node.importClause?.isTypeOnly)
      || ts.isExportDeclaration(node) && node.moduleSpecifier
      || ts.isImportEqualsDeclaration(node)
      || ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || ts.isIdentifier(node.expression) && ['require', 'createRequire', 'eval', 'Function'].includes(node.expression.text))
      || ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Function')
      throw Error('Fixed bootstrap cannot resolve or evaluate host code');
    ts.forEachChild(node, visit);
  };
  visit(parsed);
}

// Exclusive output preserves an earlier package, including an incomplete attempt.
await mkdir(directory);
try {
  const compiler = requireBuild.resolve('typescript');
  const compilerBytes = await capture(compiler);
  if (ts.version !== '5.9.3' || digest(compilerBytes) !== 'sha256:3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675')
    throw Error('Unreviewed source-inspection compiler');
  const original = utf8(await capture(source));
  noRuntimeResolver(parse(original, source, ts.ScriptKind.TS), true);
  const platformPackage = requireBuild.resolve(`@esbuild/win32-${process.arch}/package.json`);
  for (const file of [script, join(root, 'package.json'), join(root, 'package-lock.json'),
    requireBuild.resolve('typescript/package.json'), requireBuild.resolve('esbuild/package.json'),
    requireBuild.resolve('esbuild'), platformPackage, join(dirname(platformPackage), 'esbuild.exe'), process.execPath])
    await capture(file);

  const result = await build({ absWorkingDir: root, entryPoints: [source], bundle: true, platform: 'neutral',
    target: 'es2023', format: 'iife', globalName: '__artooPrivateGuest', write: false, metafile: true,
    outfile: join(directory, name), logLevel: 'silent', legalComments: 'none',
    tsconfigRaw: { compilerOptions: { useDefineForClassFields: true } },
    plugins: [{ name: 'fixed-runtime-bootstrap', setup(plugin) {
      plugin.onLoad({ filter: /./, namespace: 'file' }, async args => {
        if (resolve(args.path) !== source) throw Error('Unexpected runtime bootstrap dependency');
        return { contents: original, loader: 'ts' };
      });
    } }] });
  if (result.outputFiles.length !== 1 || Object.keys(result.metafile.inputs).length !== 1
    || resolve(root, Object.keys(result.metafile.inputs)[0]) !== source
    || Object.values(result.metafile.outputs).some(output => output.imports.length))
    throw Error('Unexpected runtime bootstrap output or input');

  // The bundler's name is lexical inside this expression. Only the factory handle
  // escapes to the trusted QuickJS owner; product globals receive no owner API.
  const text = '(() => {\n' + result.outputFiles[0].text
    + '\nreturn __artooPrivateGuest.createApplicationRuntimeGuest;\n})()\n';
  const parsed = parse(text, name, ts.ScriptKind.JS);
  noRuntimeResolver(parsed, false);
  if (parsed.statements.length !== 1 || !ts.isExpressionStatement(parsed.statements[0]))
    throw Error('Bootstrap must be one private factory expression');
  const bytes = Buffer.from(text);
  if (bytes.length > 1_048_576) throw Error('Runtime bootstrap exceeds its fixed input bound');
  for (const [file, value] of captured) if (!(await readFile(file)).equals(value)) throw Error('Bootstrap input changed');
  const inputs = [...captured].map(([file, value]) => pin(file, value)).sort((a, b) => a.path.localeCompare(b.path));
  const entry = pin(join(directory, name), bytes);
  const manifest = { version: 1, format: 'artoo.application-runtime-guest-package.v1', qualified_for_product: false,
    scope: 'Fixed trusted guest bootstrap packaging only; no generated code, QuickJS, native owner or product executed',
    logical_id: name, entry, inputs, input_digest: digest(Buffer.from(JSON.stringify(inputs))),
    esbuild_version: esbuildVersion, inspection_typescript_version: ts.version, node_version: process.version,
    runtime_resolvers: [], guest_host_callbacks: [], metafile: result.metafile };
  await writeFile(entry.path, bytes, { flag: 'wx' });
  await writeFile(join(directory, 'build.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify({ entry, inputs: inputs.length, qualified_for_product: false }) + '\n');
} finally { stop(); }
