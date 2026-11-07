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
const reopenCaptures = new WeakMap();
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

// Reopening consumes retained local evidence only. It never opens the old
// database, submits a goal, reads a provider credential or repairs a journal.
export function validateStoppedProductRecords(result, published, binding, sessionRoot) {
  assert.ok(result?.version === 1 && result.scope === 'windows-local-single-goal', 'Unsupported original daily result');
  assert.ok(result.status === 'stopped-after-publication' && result.product_published === true
    && result.shutdown_confirmed === true && result.server_closed === true && result.inputs_unchanged === true
    && Array.isArray(result.errors) && result.errors.length === 0, 'Only a successfully published, normally closed daily product can reopen');
  same(result.shutdown_control, { version: 1, mode: 'stdin', commands: 1, complete: true },
    'This daily result has no confirmed original stdin shutdown');
  assert.ok(result.publisher_ownership, 'This older daily result has no shared publisher ownership evidence');
  const ownership = result.publisher_ownership;
  exact(ownership, ['version', 'session_root', 'mode', 'owner_id', 'acquired_at', 'released_at', 'lock_removed']);
  assert.ok(ownership.version === 1 && ownership.session_root === sessionRoot && ownership.mode === 'daily'
    && typeof ownership.owner_id === 'string' && ownership.owner_id.length > 0 && ownership.lock_removed === true
    && Number.isFinite(Date.parse(ownership.acquired_at)) && Number.isFinite(Date.parse(ownership.released_at))
    && Date.parse(ownership.acquired_at) <= Date.parse(ownership.released_at), 'Original publisher ownership was not normally released');
  assert.equal(result.output, sessionRoot, 'Original daily result belongs to another session');
  assert.ok(typeof result.goal_id === 'string' && result.goal_id.length > 0, 'Missing original goal identity');
  assert.ok(['browser', 'console'].includes(result.submission_owner)
    && result.goal_posts === (result.submission_owner === 'browser' ? 0 : 1)
    && result.logical_goals_created === 1, 'Original request identity is incomplete');
  assert.ok(Number.isFinite(Date.parse(result.stop_requested_at)) && Number.isFinite(Date.parse(result.finished_at))
    && Date.parse(result.stop_requested_at) <= Date.parse(result.finished_at), 'Original stop timing is incomplete');
  assert.ok(published?.version === 1 && published.retained === true && published.session_root === sessionRoot
    && published.goal_id === result.goal_id, 'Published record belongs to another product');
  same(published.publication, result.publication, 'Published identity differs from the original final result');
  const publication = result.publication;
  for (const key of ['release_id', 'run_id', 'evidence_id'])
    assert.ok(typeof publication?.[key] === 'string' && publication[key].length > 0 && publication[key].length <= 256,
      'Incomplete publication identity');
  assert.match(publication.artifact_digest, /^sha256:[a-f0-9]{64}$/u, 'Invalid immutable product digest');
  for (const key of ['request_sha256', 'receipt_sha256']) assert.match(publication[key], /^[a-f0-9]{64}$/u, 'Invalid publication record digest');
  assert.ok(publication.request && typeof publication.request === 'object' && !Array.isArray(publication.request)
    && publication.receipt && typeof publication.receipt === 'object' && !Array.isArray(publication.receipt),
    'This product has no retained immutable publication request and receipt');
  assert.equal(sha(JSON.stringify(publication.request)), publication.request_sha256, 'Original publication request changed');
  assert.equal(sha(JSON.stringify(publication.receipt)), publication.receipt_sha256, 'Original publication receipt changed');
  assert.ok(publication.request.release_id === publication.release_id && publication.request.run_id === publication.run_id
    && publication.request.goal_id === result.goal_id && publication.request.subject_digest === publication.artifact_digest
    && publication.receipt.outcome === 'published' && publication.receipt.endpoint === publication.url
    && publication.receipt.artifact_digest === publication.artifact_digest, 'Original publication fields disagree');
  same(publication.receipt.request, publication.request, 'Original receipt does not bind the same request');
  const url = new URL(publication.url);
  assert.ok(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && url.origin === publication.url
    && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password,
    'Reopening requires the exact original loopback origin');
  if (result.last_publication_observation) {
    for (const key of ['release_id', 'run_id', 'evidence_id', 'artifact_digest', 'url', 'request_sha256', 'receipt_sha256'])
      assert.equal(result.last_publication_observation[key], publication[key], 'Last publication observation changed product identity');
  }
  assert.ok(binding?.version === 1 && Array.isArray(binding.nodes) && Array.isArray(binding.files), 'Missing original configuration binding');
  assert.ok(Array.isArray(result.nodes) && result.nodes.length === 2 && binding.nodes.length === 2, 'Expected both original nodes');
  same(result.nodes.map(node => node.role).sort(), ['destination', 'source'], 'Unexpected original node roles');
  same(binding.nodes.map(node => node.role).sort(), ['destination', 'source'], 'Unexpected configured node roles');
  for (const node of result.nodes) {
    const configured = binding.nodes.find(item => item.role === node.role), cli = node.cli;
    assert.ok(node.registry_disconnected === true && node.discovery?.started === true && node.discovery.stopped === true
      && node.discovery.registry_disconnected === true, 'An original node has no confirmed disconnect');
    same(node.identity, configured.identity, 'Original node identity changed');
    same(node.registration, configured.registration, 'Original node registration changed');
    assert.equal(cli?.pid, configured.cli?.pid, 'Original CLI identity changed');
    assert.ok(Number.isSafeInteger(cli.pid) && cli.pid > 0 && cli.spawned === true && cli.shutdown_written === true
      && cli.forced_root_kill === false && cli.stdout_eof === true && cli.stderr_eof === true,
      'An original CLI has incomplete process closure');
    for (const event of [cli.exit, cli.close]) same(event, { code: 0, signal: null }, 'Original CLI did not close normally');
    same(cli.stopped, { kind: 'artoo.supervised.stopped', cleanupConfirmed: true }, 'Original CLI cleanup was not confirmed');
    same(cli.ready, configured.cli.ready, 'Original CLI readiness identity changed');
    assert.ok(node.identity?.project_id === 'proj_artoo' && typeof node.identity.computer_id === 'string'
      && node.identity.computer_id.length > 0 && typeof node.identity.device_id === 'string'
      && node.identity.device_id.length > 0, 'Missing original destination identity');
    assert.equal(node.identity.workspace, path.join(sessionRoot, node.role, 'workspace'), 'Original workspace is outside its session');
    // Two absent values can compare equal; require the actual readiness and
    // registration observations as well as equality with the live binding.
    same(cli.ready, { kind: 'artoo.supervised.ready', generation: 0, node_id: node.identity.computer_id },
      'Original CLI readiness was not confirmed');
    const registration = node.registration;
    assert.ok(registration && typeof registration === 'object' && !Array.isArray(registration)
      && ['id', 'session_id', 'epoch_id'].every(key => typeof registration[key] === 'string' && registration[key].length > 0)
      && registration.computer_id === node.identity.computer_id && registration.device_id === node.identity.device_id
      && registration.generation === 0 && registration.workspace === node.identity.workspace,
      'Original node registration was not confirmed');
  }
  assert.notEqual(result.nodes[0].identity.computer_id, result.nodes[1].identity.computer_id, 'Original nodes must be distinct');
  return result.nodes.find(node => node.role === 'destination');
}

function productSessionPath(selected) {
  assert.ok(typeof selected === 'string' && path.isAbsolute(selected), 'Choose an absolute product session or retained record path');
  const candidate = path.resolve(selected), stat = fs.lstatSync(candidate);
  if (stat.isDirectory()) return physical(candidate, true);
  physical(candidate);
  assert.ok(['RESULT.json', 'PUBLISHED.json'].includes(path.basename(candidate)), 'Choose the original RESULT.json, PUBLISHED.json or session directory');
  return physical(path.dirname(candidate), true);
}

export async function captureReopen({ product_path, configuration_file }) {
  assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64');
  const sessionRoot = productSessionPath(product_path);
  const record = name => {
    const pin = reference(path.join(sessionRoot, name));
    assert.ok(pin.bytes <= 8 * 1024 * 1024, 'Retained product record exceeds its limit');
    return { pin, value: read(pin.path) };
  };
  const original = record('RESULT.json'), published = record('PUBLISHED.json'), binding = record('CONFIG-BINDING.json');
  const destination = validateStoppedProductRecords(original.value, published.value, binding.value, sessionRoot);
  const configurationPin = check(original.value.configuration);
  if (configuration_file !== undefined) assert.equal(physical(path.resolve(configuration_file)), configurationPin.path,
    'Use the original product installation configuration');
  const local = configuration(configurationPin.path), installed = installation(local.value.installation);
  same(local.pin, configurationPin, 'Original product configuration changed');
  same(installed.installation_manifest, original.value.installation_manifest, 'Original product installation changed');
  const parent = local.value.runtime.private_parent;
  assert.ok(path.dirname(sessionRoot) === parent && path.basename(sessionRoot).startsWith('session-'),
    'The selected product must be an original session in its installed private parent');
  const protectedRoots = [toolsRoot, installed.bundle, installed.server.root, ...installed.dependencies.packages.map(item => item.directory),
    ...(installed.web ? [installed.web.root] : [])];
  assert.ok(protectedRoots.every(root => !inside(root, parent)), 'Product observations must be outside installation code');
  same(binding.value.programs, installed.programs, 'Original executable bindings changed');
  const bundle = physical(path.join(sessionRoot, 'bundle'), true), bundleTree = tree(bundle);
  same(bundleTree, installed.bundle_tree, 'Retained private bundle differs from its installation');
  const bundleManifest = check(binding.value.bundle_manifest), nativeManifest = check(binding.value.native_manifest);
  assert.equal(bundleManifest.path, path.join(bundle, 'bundle-manifest.json'), 'Unexpected private bundle manifest');
  assert.equal(nativeManifest.path, path.join(bundle, 'native', 'windows-process', 'manifest.json'), 'Unexpected native manifest');
  assert.equal(bundleManifest.sha256, installed.bundle_manifest.sha256, 'Private bundle manifest differs');
  const expectedFiles = ['source', 'destination'].flatMap(role => ['browser.json', 'verifiers.json', 'releases.json', 'discovered-capabilities.json', 'source.json']
    .map(name => path.join(sessionRoot, role, 'config', name))).sort();
  same(binding.value.files.map(pin => pin.path).sort(), expectedFiles, 'Original configuration file set differs');
  for (const pin of binding.value.files) check(pin);
  const verificationProfilesFile = path.join(sessionRoot, 'destination', 'config', 'verifiers.json');
  const releaseProfilesFile = path.join(sessionRoot, 'destination', 'config', 'releases.json');
  const verifier = read(verificationProfilesFile), releases = read(releaseProfilesFile);
  assert.ok(Array.isArray(verifier) && verifier.length === 1 && Array.isArray(releases) && releases.length === 1,
    'Expected the original single verifier and publisher profiles');
  const workspace = physical(destination.identity.workspace, true), storage = physical(path.join(sessionRoot, 'destination', 'release'), true);
  assert.ok(verifier[0].id === 'native-web' && verifier[0].project_id === destination.identity.project_id
    && verifier[0].workspace_root === workspace, 'Original verifier identity changed');
  const release = releases[0];
  assert.ok(release.id === 'native-publish' && release.project_id === destination.identity.project_id
    && release.verification_profile_id === verifier[0].id && release.storage_root === storage
    && release.public_url === original.value.publication.url && release.listen_host === '127.0.0.1'
    && release.listen_port === Number(new URL(original.value.publication.url).port), 'Original publisher origin or storage changed');
  const output = path.join(parent, 'reopen-' + new Date().toISOString().replaceAll(/[-:.]/gu, '') + '-' + randomUUID());
  assert.equal(fs.existsSync(output), false, 'A reopen observation directory must be fresh');
  const records = [original.pin, published.pin, binding.pin];
  for (const pin of records) check(pin);
  const inputs = freeze({ version: 1, session_root: sessionRoot, output, configuration: local.pin,
    installation_manifest: installed.installation_manifest, original_result: original.pin, published_record: published.pin,
    config_binding: binding.pin, bundle, bundle_manifest: bundleManifest, native_manifest: nativeManifest,
    verification_profiles_file: verificationProfilesFile, release_profiles_file: releaseProfilesFile,
    release_profile_id: release.id, workspace, storage_root: storage, publication: original.value.publication,
    original_ownership: original.value.publisher_ownership,
    windows_process_installation: { directory: path.dirname(nativeManifest.path), manifestSha256: 'sha256:' + nativeManifest.sha256,
      writableWorkspaceRoots: [workspace] } });
  reopenCaptures.set(inputs, { local: local.pin, installed, records, configFiles: binding.value.files, bundleTree, parent });
  return inputs;
}

export async function recheckReopen(inputs) {
  const captured = reopenCaptures.get(inputs); assert.ok(captured, 'Expected the original reopen capture');
  for (const pin of [captured.local, ...captured.records, ...captured.configFiles]) check(pin);
  physical(captured.parent, true);
  same(installation(captured.installed.installation_manifest), captured.installed, 'Original installation changed while reopening');
  same(tree(inputs.bundle), captured.bundleTree, 'Retained private bundle changed while reopening');
  // Release health journals may change under the exclusively held publisher.
  // The backend verifies immutable release request/receipt/artifact identities.
}
