// Source-only draft. This module reads installation metadata; it never starts a
// candidate, imports an application, creates a session, or reads provider keys.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const toolsRoot = path.dirname(fileURLToPath(import.meta.url));
export const sha = value => createHash('sha256').update(value).digest('hex');
export function read(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error instanceof SyntaxError) throw Error('Invalid JSON metadata'); throw error; }
}
const same = (actual, expected, message) => assert.ok(isDeepStrictEqual(actual, expected), message);
const captures = new WeakMap();
function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
// The existing user authorization is specific to this recipient. A loopback
// proxy is not a local model. Supporting another provider needs a new grant.
export const provider = freeze({ url: 'http://127.0.0.1:18181/v1', model: 'gpt-6.1-sol',
  disclosure: { mode: 'external', providers: [{ id: 'github-copilot', name: 'GitHub Copilot via local Aerial',
    privacy_url: 'https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement' }] } });

function exact(value, required, optional = []) {
  // Do not echo submitted configuration: an operator might have pasted a key.
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Expected configuration object');
  assert.ok(required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key)), 'Unexpected configuration fields');
}
export function physical(file, directory = false) {
  assert.ok(typeof file === 'string' && path.isAbsolute(file) && path.resolve(file) === file, 'Normalized absolute path required');
  for (let current = file;; current = path.dirname(current)) {
    const stat = fs.lstatSync(current); assert.equal(stat.isSymbolicLink(), false, 'Linked path: ' + current);
    assert.ok(current === file && !directory ? stat.isFile() && stat.nlink === 1 : stat.isDirectory(), current);
    if (path.dirname(current) === current) break;
  }
  assert.ok(fs.realpathSync.native(file) === file, 'Canonical physical path required'); return file;
}
export function reference(file) {
  physical(file); const before = fs.lstatSync(file), bytes = fs.readFileSync(file), after = fs.lstatSync(file);
  for (const key of ['ino', 'dev', 'size', 'mtimeMs']) assert.equal(after[key], before[key], 'Changed input: ' + file);
  assert.equal(bytes.length, after.size); return { path: file, bytes: bytes.length, sha256: sha(bytes) };
}
export function check(pin) {
  exact(pin, ['path', 'bytes', 'sha256']);
  assert.ok(Number.isSafeInteger(pin.bytes) && pin.bytes >= 0, 'Invalid pinned byte count');
  assert.ok(typeof pin.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(pin.sha256), 'Invalid pinned SHA-256');
  const actual = reference(pin.path);
  assert.ok(actual.bytes === pin.bytes && actual.sha256 === pin.sha256, 'Pinned file changed'); return actual;
}
export function save(file, value) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
export function member(value) {
  assert.ok(typeof value === 'string' && !path.isAbsolute(value) && !/[\\:\u0000-\u001f]/u.test(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..'), 'Invalid relative member'); return value;
}
export function tree(root) {
  physical(root, true); const files = [], directories = [], keys = new Set(); let total = 0;
  const visit = dir => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), local = member(path.relative(root, file).replaceAll('\\', '/'));
      assert.equal(keys.has(local.toLowerCase()), false); keys.add(local.toLowerCase()); assert.ok(keys.size <= 30000);
      const stat = fs.lstatSync(file); assert.equal(stat.isSymbolicLink(), false);
      if (stat.isDirectory()) { directories.push(local); visit(file); }
      else { assert.ok(stat.size <= 512 * 1024 * 1024); const pin = reference(file); total += pin.bytes;
        assert.ok(total <= 2 * 1024 * 1024 * 1024); files.push({ ...pin, path: local }); }
    }
  };
  visit(root); return { files: files.sort((a, b) => a.path.localeCompare(b.path)), directories: directories.sort(), links: [] };
}
export function copyTree(source, destination, expected) {
  same(tree(source), expected, 'Installed source tree changed'); fs.mkdirSync(destination);
  for (const directory of [...expected.directories].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)))
    fs.mkdirSync(path.join(destination, directory));
  for (const file of expected.files) fs.copyFileSync(path.join(source, file.path), path.join(destination, file.path), fs.constants.COPYFILE_EXCL);
  same(tree(source), expected, 'Installed source tree changed'); same(tree(destination), expected, 'Private bundle copy differs');
}

const workspacePackages = new Map([
  ['@artoo/server', 'apps/server'], ['@artoo/db', 'packages/db'], ['@artoo/domain', 'packages/domain'],
  ['@artoo/protocol', 'packages/protocol'], ['@artoo/storage', 'packages/storage'],
]);
export function serverDependencyClosure(snapshot) {
  const external = new Map(), visited = new Set(), workspaces = new Set(), missingOptional = [];
  const find = (name, from) => {
    const require = createRequire(path.join(from, 'package.json'));
    // Enumerate Node's actual package search order without importing a package.
    // A non-builtin probe also handles dependencies named like Node builtins.
    const searches = require.resolve.paths('__artoo_declared_npm_dependency_lookup__');
    assert.ok(Array.isArray(searches), 'Declared package lookup paths are unavailable');
    for (const search of searches) {
      const directory = path.join(search, name);
      if (fs.existsSync(path.join(directory, 'package.json'))) return physical(fs.realpathSync.native(directory), true);
    }
    const error = Error("Cannot find module '" + name + "'"); error.code = 'MODULE_NOT_FOUND'; throw error;
  };
  const visit = directory => {
    const key = directory.toLowerCase(); if (visited.has(key)) return; visited.add(key);
    const metadata = read(path.join(directory, 'package.json'));
    assert.equal(typeof metadata.name, 'string', 'Installed package has no name');
    if (metadata.name.startsWith('@artoo/')) {
      const relative = workspacePackages.get(metadata.name); assert.ok(relative, 'Unsupported runtime workspace package');
      assert.equal(directory.toLowerCase(), physical(path.join(snapshot, relative), true).toLowerCase(), 'Workspace dependency escaped the installation');
      workspaces.add(metadata.name);
    } else external.set(key, { directory, tree: tree(directory) });
    for (const name of Object.keys(metadata.dependencies ?? {}).sort())
      if (!Object.hasOwn(metadata.optionalDependencies ?? {}, name)) visit(find(name, directory));
    const optional = new Set(Object.keys(metadata.optionalDependencies ?? {}));
    for (const name of Object.keys(metadata.peerDependencies ?? {}).sort()) {
      if (metadata.peerDependenciesMeta?.[name]?.optional === true) optional.add(name); else visit(find(name, directory));
    }
    for (const name of [...optional].sort()) {
      let resolved;
      try { resolved = find(name, directory); }
      catch (error) {
        if (error.code !== 'MODULE_NOT_FOUND' || !String(error.message).startsWith("Cannot find module '" + name + "'")) throw error;
        missingOptional.push({ package: metadata.name, dependency: name }); continue;
      }
      visit(resolved);
    }
  };
  visit(path.join(snapshot, 'apps/server'));
  // These are direct imports in the installed Server in addition to its package
  // declarations. Bind their transitive trees too; never import them to inspect.
  for (const name of ['drizzle-orm', '@electric-sql/pglite', 'zod', 'ulid', 'ws']) visit(find(name, path.join(snapshot, 'apps/server')));
  same([...workspaces].sort(), [...workspacePackages.keys()].sort(), 'Installed runtime workspace graph differs');
  return { packages: [...external.values()].sort((a, b) => a.directory.localeCompare(b.directory)),
    missing_optional: missingOptional.sort((a, b) => (a.package + '/' + a.dependency).localeCompare(b.package + '/' + b.dependency)) };
}
// An installer can use this read-only inventory to prepare its local manifest.
// Only runtime package metadata, compiled modules, migrations and dependencies
// are required. No development build, test, or ancestor record is consulted.
export function serverInstallation(root) {
  physical(root, true);
  const packages = [...workspacePackages.values()].sort();
  const packageFiles = ['package.json', ...packages.map(directory => directory + '/package.json')].sort();
  const runtimeTrees = [...packages.map(directory => directory + '/dist'), 'packages/db/migrations'].sort();
  return { root, package_files: packageFiles.map(file => reference(path.join(root, file))),
    trees: runtimeTrees.map(local => ({ path: local, tree: tree(path.join(root, local)) })),
    dependencies: serverDependencyClosure(root) };
}
function installation(pin) {
  const manifestPin = check(pin), manifest = read(manifestPin.path);
  exact(manifest, ['format', 'daemon', 'server', 'programs'], ['web']);
  assert.ok(manifest.format === 'artoo.windows-single-goal-installation.v1', 'Unsupported installation manifest version');
  exact(manifest.daemon, ['root', 'manifest', 'tree']);
  const bundle = physical(manifest.daemon.root, true), bundleManifest = check(manifest.daemon.manifest);
  assert.ok(bundleManifest.path === path.join(bundle, 'bundle-manifest.json'), 'Unexpected daemon bundle manifest path');
  const inventory = tree(bundle); same(inventory, manifest.daemon.tree, 'Installed daemon tree differs');
  const productionManifest = read(bundleManifest.path);
  assert.ok(productionManifest.format === 'artoo.desktop-daemon.v1', 'Unsupported daemon bundle version');
  same(productionManifest.tree, { directories: inventory.directories,
    files: inventory.files.filter(item => item.path !== 'bundle-manifest.json')
      .map(item => ({ path: item.path, size: item.bytes, sha256: 'sha256:' + item.sha256 })) }, 'Production daemon manifest differs');
  for (const file of ['artood.mjs', 'web-acceptance-cli.js', 'native/windows-process/manifest.json'])
    assert.ok(inventory.files.some(item => item.path === file), 'Missing installed daemon entrypoint');
  exact(manifest.server, ['root', 'package_files', 'trees', 'dependencies']);
  const server = serverInstallation(manifest.server.root); same(server, manifest.server, 'Installed Server runtime differs');
  exact(manifest.programs, ['node', 'codex', 'git', 'browser']);
  const programs = Object.fromEntries(['node', 'codex', 'git', 'browser'].map(name => [name, check(manifest.programs[name])]));
  assert.ok(programs.node.path.toLowerCase() === process.execPath.toLowerCase(), 'Use the installed Node executable');
  for (const program of Object.values(programs)) assert.ok(/\.exe$/iu.test(program.path), 'Expected a native Windows executable');
  let web;
  if (manifest.web !== undefined) {
    exact(manifest.web, ['root', 'tree']); web = { root: physical(manifest.web.root, true), tree: tree(manifest.web.root) };
    same(web, manifest.web, 'Installed Web tree differs'); assert.ok(web.tree.files.some(file => file.path === 'index.html'), 'Missing compiled Web index');
  }
  check(manifestPin);
  return { installation_manifest: manifestPin, candidate: { snapshot: server.root },
    bundle, bundle_manifest: bundleManifest, bundle_tree: inventory, programs, dependencies: server.dependencies,
    server, ...(web ? { web, web_dist: web.root } : {}) };
}
function inside(root, target) {
  const relative = path.relative(root, target); return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}
function configuration(file) {
  const pin = reference(file); assert.ok(pin.bytes <= 64 * 1024, 'Local configuration is too large');
  const value = read(pin.path);
  exact(value, ['version', 'installation', 'runtime', 'authorization']);
  assert.ok(value.version === 1, 'Unsupported local configuration version');
  exact(value.runtime, ['private_parent', 'provider_key_env', 'timeout_minutes']);
  physical(value.runtime.private_parent, true);
  assert.ok(value.runtime.provider_key_env === 'ARTOO_CODEX_PROVIDER_KEY', 'Unsupported provider key environment name');
  assert.ok(Number.isSafeInteger(value.runtime.timeout_minutes) && value.runtime.timeout_minutes >= 5
    && value.runtime.timeout_minutes <= 180, 'Build timeout must be 5 to 180 minutes');
  exact(value.authorization, ['scope', 'policy_version']);
  assert.ok(value.authorization.scope === 'github-copilot-via-aerial', 'This configuration does not carry the existing provider authorization');
  assert.ok(typeof value.authorization.policy_version === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value.authorization.policy_version),
    'Expected the previously granted provider policy version');
  // The actual Server disclosure must match this exact previously granted
  // version before start.mjs calls the normal consent API. Never auto-upgrade.
  check(pin); return { pin, value };
}
export async function capture({ objective, submission_owner = 'console', configuration_file = path.join(toolsRoot, 'LOCAL-INSTALLATION.json') }) {
  assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64');
  assert.ok(submission_owner === 'console' || submission_owner === 'browser', 'Unsupported request input mode');
  if (submission_owner === 'browser') assert.equal(objective, undefined, 'Browser input cannot also receive a console objective');
  else assert.ok(typeof objective === 'string' && objective.trim().length > 0 && objective.length <= 10000
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(objective), 'Provide a nonempty objective of at most 10000 characters');
  const local = configuration(configuration_file), installed = installation(local.value.installation);
  if (submission_owner === 'browser') assert.ok(installed.web_dist, 'Browser input requires an installed and separately qualified local development Web build');
  const parent = local.value.runtime.private_parent;
  const protectedRoots = [toolsRoot, installed.bundle, installed.server.root, ...installed.dependencies.packages.map(item => item.directory),
    ...(installed.web ? [installed.web.root] : [])];
  assert.ok(protectedRoots.every(root => !inside(root, parent)), 'Session parent must be outside installation code');
  const output = path.join(parent, 'session-' + new Date().toISOString().replaceAll(/[-:.]/gu, '') + '-' + randomUUID());
  assert.equal(fs.existsSync(output), false, 'A session path must be fresh');
  check(local.pin);
  const result = freeze({ ...installed, configuration: local.pin, output, submission_owner, objective: objective?.trim() ?? null, provider,
    timeout_minutes: local.value.runtime.timeout_minutes, provider_key_env: local.value.runtime.provider_key_env,
    authorization_policy_version: local.value.authorization.policy_version });
  captures.set(result, { configuration: local.pin, installation: local.value.installation, installed, parent });
  return result;
}
export async function recheck(inputs) {
  const original = captures.get(inputs); assert.ok(original, 'Expected the original capture object');
  check(original.configuration); physical(original.parent, true);
  same(installation(original.installation), original.installed, 'Installed runtime changed during this session');
  check(original.configuration);
}
