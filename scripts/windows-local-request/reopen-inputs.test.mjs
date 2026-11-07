// Pure retained-record and argument tests. Every identity, receipt and process
// observation below is synthetic fixture data, not native/product acceptance.
// No publisher, database, subprocess, browser, provider or installation is run.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { captureReopen, validateStoppedProductRecords } from './inputs.mjs';
import { reopenOptions } from './reopen.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
const publicationKeys = ['release_id', 'run_id', 'evidence_id', 'artifact_digest', 'url', 'request_sha256', 'receipt_sha256'];

function fixture(sessionRoot = path.resolve(os.tmpdir(), 'artoo-reopen-record-fixture', 'session-original')) {
  const artifact = 'sha256:' + 'a'.repeat(64), url = 'http://127.0.0.1:49152';
  // Deliberate insertion order: retained hashes are of JSON.stringify output,
  // not a sorted/canonical projection of a request or receipt.
  const request = { version: 1, release_id: 'fixture-release', run_id: 'fixture-run', goal_id: 'fixture-goal',
    project_id: 'proj_artoo', subject_digest: artifact, release_profile_id: 'native-publish', verification_profile_id: 'native-web' };
  const receipt = { version: 1, outcome: 'published', endpoint: url, artifact_digest: artifact, request: clone(request) };
  const publication = { release_id: request.release_id, run_id: request.run_id, evidence_id: 'fixture-evidence', artifact_digest: artifact,
    url, request_sha256: digest(request), receipt_sha256: digest(receipt), request, receipt };
  const nodes = ['source', 'destination'].map((role, index) => ({
    role,
    identity: { project_id: 'proj_artoo', computer_id: `fixture-${role}-computer`, device_id: `fixture-${role}-device`,
      workspace: path.join(sessionRoot, role, 'workspace') },
    registration: { id: `fixture-${role}-computer`, computer_id: `fixture-${role}-computer`, device_id: `fixture-${role}-device`,
      session_id: `fixture-${role}-session`, epoch_id: `fixture-${role}-epoch`, generation: 0,
      workspace: path.join(sessionRoot, role, 'workspace') },
    discovery: { started: true, stopped: true, registry_disconnected: true },
    registry_disconnected: true,
    cli: { pid: 40000 + index, spawned: true, shutdown_written: true, forced_root_kill: false, stdout_eof: true, stderr_eof: true,
      exit: { code: 0, signal: null }, close: { code: 0, signal: null },
      ready: { kind: 'artoo.supervised.ready', generation: 0, node_id: `fixture-${role}-computer` },
      stopped: { kind: 'artoo.supervised.stopped', cleanupConfirmed: true } },
  }));
  const result = { version: 1, scope: 'windows-local-single-goal', output: sessionRoot,
    status: 'stopped-after-publication', product_published: true, shutdown_confirmed: true,
    server_closed: true, inputs_unchanged: true, errors: [],
    shutdown_control: { version: 1, mode: 'stdin', commands: 1, complete: true },
    publisher_ownership: { version: 1, session_root: sessionRoot, mode: 'daily', owner_id: 'fixture-owner',
      acquired_at: '2026-11-07T08:00:00.000Z', released_at: '2026-11-07T08:02:00.000Z', lock_removed: true },
    goal_id: request.goal_id, submission_owner: 'browser', goal_posts: 0, logical_goals_created: 1,
    stop_requested_at: '2026-11-07T08:01:00.000Z', finished_at: '2026-11-07T08:02:00.000Z',
    publication, last_publication_observation: Object.fromEntries(publicationKeys.map(key => [key, publication[key]])), nodes };
  const published = { version: 1, retained: true, session_root: sessionRoot, goal_id: result.goal_id, publication: clone(publication) };
  // CONFIG-BINDING was recorded while the CLIs were live. Its lifecycle fields
  // cannot substitute for the final result's actual closure observations.
  const configured = clone(nodes);
  for (const node of configured) {
    node.registry_disconnected = false; node.discovery.stopped = false; node.discovery.registry_disconnected = false;
    Object.assign(node.cli, { shutdown_written: false, stdout_eof: false, stderr_eof: false, exit: null, close: null, stopped: null });
  }
  return { result, published, binding: { version: 1, nodes: configured, files: [] }, sessionRoot };
}
const validate = f => validateStoppedProductRecords(f.result, f.published, f.binding, f.sessionRoot);
function syncPublication(f, rehash = false) {
  const publication = f.result.publication;
  if (rehash) {
    publication.request_sha256 = digest(publication.request);
    publication.receipt_sha256 = digest(publication.receipt);
  }
  f.published.publication = clone(publication);
  f.result.last_publication_observation = Object.fromEntries(publicationKeys.map(key => [key, publication[key]]));
}
function rejects(label, mutate, message) {
  test(label, () => {
    const f = fixture(); mutate(f);
    assert.throws(() => validate(f), { name: 'AssertionError', message });
  });
}

for (const owner of ['browser', 'console']) test(`accepts complete synthetic ${owner} single-goal closure and selects the destination`, () => {
  const f = fixture(); f.result.submission_owner = owner; f.result.goal_posts = owner === 'browser' ? 0 : 1;
  assert.equal(validate(f), f.result.nodes[1]);
  assert.equal(f.binding.nodes[1].cli.close, null, 'Live configuration binding is not closure evidence');
});
rejects('rejects an older result without publisher ownership', f => { delete f.result.publisher_ownership; }, /no shared publisher ownership evidence/u);
for (const [name, change] of [
  ['wrong session', item => { item.session_root += '-other'; }],
  ['wrong mode', item => { item.mode = 'reopen'; }],
  ['empty owner', item => { item.owner_id = ''; }],
  ['unremoved lock', item => { item.lock_removed = false; }],
  ['invalid acquisition time', item => { item.acquired_at = 'unknown'; }],
  ['release before acquisition', item => { item.released_at = '2026-11-07T07:59:59.000Z'; }],
]) rejects(`rejects publisher ownership with ${name}`, f => change(f.result.publisher_ownership), /not normally released/u);
for (const [name, change] of [
  ['absent evidence', f => { delete f.result.shutdown_control; }],
  ['signal stop', f => { f.result.shutdown_control.mode = 'signal'; }],
  ['no command', f => { f.result.shutdown_control.commands = 0; }],
  ['two commands', f => { f.result.shutdown_control.commands = 2; }],
  ['incomplete line', f => { f.result.shutdown_control.complete = false; }],
]) rejects(`rejects original stdin shutdown with ${name}`, change, /no confirmed original stdin shutdown/u);
for (const [name, change] of [
  ['failed status', f => { f.result.status = 'failed'; }],
  ['unconfirmed shutdown', f => { f.result.shutdown_confirmed = false; }],
  ['open server', f => { f.result.server_closed = false; }],
  ['changed inputs', f => { f.result.inputs_unchanged = false; }],
  ['recorded error', f => { f.result.errors.push('fixture failure'); }],
]) rejects(`rejects ${name} despite published metadata`, change, /normally closed daily product/u);
for (const [name, change] of [
  ['multiple goals', f => { f.result.logical_goals_created = 2; }],
  ['launcher post in browser mode', f => { f.result.goal_posts = 1; }],
  ['missing console post', f => { f.result.submission_owner = 'console'; }],
]) rejects(`rejects ${name}`, change, /Original request identity is incomplete/u);

const closureChanges = [
  ['missing spawn', node => { node.cli.spawned = false; }, /incomplete process closure/u],
  ['unwritten shutdown', node => { node.cli.shutdown_written = false; }, /incomplete process closure/u],
  ['forced root kill', node => { node.cli.forced_root_kill = true; }, /incomplete process closure/u],
  ['missing stdout EOF', node => { node.cli.stdout_eof = false; }, /incomplete process closure/u],
  ['missing stderr EOF', node => { node.cli.stderr_eof = false; }, /incomplete process closure/u],
  ['missing exit', node => { node.cli.exit = null; }, /did not close normally/u],
  ['failed exit', node => { node.cli.exit.code = 1; }, /did not close normally/u],
  ['signalled exit', node => { node.cli.exit.signal = 'SIGTERM'; }, /did not close normally/u],
  ['missing close', node => { node.cli.close = null; }, /did not close normally/u],
  ['failed close', node => { node.cli.close.code = 1; }, /did not close normally/u],
  ['signalled close', node => { node.cli.close.signal = 'SIGTERM'; }, /did not close normally/u],
  ['missing stopped record', node => { node.cli.stopped = null; }, /cleanup was not confirmed/u],
  ['unconfirmed cleanup', node => { node.cli.stopped.cleanupConfirmed = false; }, /cleanup was not confirmed/u],
  ['missing final disconnect', node => { node.registry_disconnected = false; }, /no confirmed disconnect/u],
  ['missing discovery start', node => { node.discovery.started = false; }, /no confirmed disconnect/u],
  ['missing discovery stop', node => { node.discovery.stopped = false; }, /no confirmed disconnect/u],
  ['missing discovery disconnect', node => { node.discovery.registry_disconnected = false; }, /no confirmed disconnect/u],
];
for (const role of ['source', 'destination']) {
  for (const [name, change, message] of closureChanges)
    rejects(`rejects ${role} ${name} even when the other node closed`, f => change(f.result.nodes.find(node => node.role === role)), message);
  for (const [name, change, message] of [
    ['identity', node => { node.identity.computer_id += '-substitute'; }, /node identity changed/u],
    ['registration', node => { node.registration.session_id += '-substitute'; }, /node registration changed/u],
    ['PID', node => { node.cli.pid++; }, /CLI identity changed/u],
    ['ready identity', node => { node.cli.ready.node_id += '-substitute'; }, /readiness identity changed/u],
  ]) rejects(`rejects ${role} ${name} substituted after configuration binding`, f => change(f.result.nodes.find(node => node.role === role)), message);
  for (const member of ['ready', 'registration']) {
    for (const absence of ['missing', 'null']) test(`rejects ${role} ${member} ${absence} in both result and binding`, () => {
      const f = fixture();
      for (const record of [f.result, f.binding]) {
        const node = record.nodes.find(item => item.role === role), owner = member === 'ready' ? node.cli : node;
        if (absence === 'missing') delete owner[member]; else owner[member] = null;
      }
      // Equality between two absent values cannot qualify either live identity.
      assert.throws(() => validate(f), { name: 'AssertionError' });
    });
  }
}
rejects('rejects an incomplete pair of original nodes', f => { f.result.nodes.pop(); }, /Expected both original nodes/u);
rejects('rejects a workspace outside the bound original session', f => {
  f.result.nodes[1].identity.workspace = f.binding.nodes[1].identity.workspace = path.join(f.sessionRoot, 'outside');
}, /workspace is outside its session/u);

for (const member of ['request', 'receipt']) {
  rejects(`rejects a missing retained publication ${member}`, f => {
    delete f.result.publication[member]; syncPublication(f);
  }, /no retained immutable publication request and receipt/u);
  rejects(`rejects changed ${member} bytes with the original digest`, f => {
    f.result.publication[member].extra_fixture_value = true; syncPublication(f);
  }, new RegExp(`Original publication ${member} changed`, 'u'));
  rejects(`rejects ${member} key reordering without changing its retained digest`, f => {
    f.result.publication[member] = Object.fromEntries(Object.entries(f.result.publication[member]).reverse()); syncPublication(f);
  }, new RegExp(`Original publication ${member} changed`, 'u'));
}
for (const [name, change] of [
  ['request release', publication => { publication.request.release_id += '-substitute'; }],
  ['request run', publication => { publication.request.run_id += '-substitute'; }],
  ['request goal', publication => { publication.request.goal_id += '-substitute'; }],
  ['request artifact', publication => { publication.request.subject_digest = 'sha256:' + 'b'.repeat(64); }],
  ['receipt outcome', publication => { publication.receipt.outcome = 'failed'; }],
  ['receipt endpoint', publication => { publication.receipt.endpoint = 'http://127.0.0.1:49153'; }],
  ['receipt artifact', publication => { publication.receipt.artifact_digest = 'sha256:' + 'b'.repeat(64); }],
]) rejects(`rejects ${name} substitution even with recomputed hashes`, f => {
  change(f.result.publication); syncPublication(f, true);
}, /Original publication fields disagree/u);
rejects('rejects a rehashed receipt that binds a different request', f => {
  f.result.publication.receipt.request.goal_id += '-substitute'; syncPublication(f, true);
}, /receipt does not bind the same request/u);
for (const url of ['https://127.0.0.1:49152', 'http://localhost:49152', 'http://192.0.2.1:49152', 'http://127.0.0.1',
  'http://127.0.0.1:49152/', 'http://127.0.0.1:49152/product', 'http://127.0.0.1:49152?other=1', 'http://127.0.0.1:49152#other'])
  rejects(`rejects nonexact loopback publication origin ${url}`, f => {
    f.result.publication.url = f.result.publication.receipt.endpoint = url; syncPublication(f, true);
  }, /exact original loopback origin/u);
rejects('rejects a different publication in PUBLISHED.json', f => { f.published.publication.release_id += '-substitute'; }, /Published identity differs/u);
rejects('rejects a PUBLISHED.json from another session', f => { f.published.session_root += '-other'; }, /belongs to another product/u);
for (const key of publicationKeys) rejects(`rejects last-observed ${key} replacement`, f => {
  f.result.last_publication_observation[key] += '-substitute';
}, /Last publication observation changed product identity/u);

test('reopen options preserve the selected product and optional original configuration', () => {
  const selected = path.resolve(os.tmpdir(), 'original session', 'PUBLISHED.json');
  const config = path.resolve(os.tmpdir(), 'original configuration.json');
  assert.deepEqual(reopenOptions(['--product', selected, '--stdin-control']), { '--product': selected, '--stdin-control': true });
  assert.deepEqual(reopenOptions(['--config', config, '--stdin-control', '--product', selected]),
    { '--config': config, '--stdin-control': true, '--product': selected });
});
for (const option of ['--objective', '--objective-file', '--browser-input']) test(`reopen options reject mixed ${option}`, () => {
  assert.throws(() => reopenOptions(['--product', 'fixture-session', '--stdin-control', option, 'fixture-value']), /Unknown product-open option/u);
});
for (const option of ['--product', '--config', '--stdin-control']) test(`reopen options reject duplicate ${option}`, () => {
  const args = ['--product', 'fixture-session', '--config', 'fixture-config', '--stdin-control', option];
  if (option !== '--stdin-control') args.push('second-value');
  assert.throws(() => reopenOptions(args), /Duplicate product-open option/u);
});
for (const [name, args] of [['stdin', ['--product', 'fixture-session']], ['product', ['--stdin-control']],
  ['empty product', ['--product', '  ', '--stdin-control']]]) test(`reopen options require ${name}`, () => {
  assert.throws(() => reopenOptions(args), /Use --product .* with --stdin-control/u);
});
for (const args of [['--product'], ['--product', '--stdin-control'], ['--product', 'fixture-session', '--stdin-control', '--config']])
  test(`reopen options reject missing value in ${JSON.stringify(args)}`, () => {
    assert.throws(() => reopenOptions(args), /Product-open option needs a value/u);
  });

const nativeWindows = process.platform === 'win32' && process.arch === 'x64';
async function withMetadataDirectory(work) {
  const parent = fs.realpathSync.native(os.tmpdir());
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, 'artoo-reopen-inputs-')));
  try { await work(root); }
  finally {
    const current = fs.realpathSync.native(root);
    assert.equal(current, root); assert.equal(path.dirname(current), parent);
    assert.match(path.basename(current), /^artoo-reopen-inputs-[^\\/]+$/u);
    fs.rmSync(current, { recursive: true, force: true });
  }
}
test('capture rejects an unsupported record path before reading installation metadata', { skip: !nativeWindows }, async () => {
  await withMetadataDirectory(async root => {
    const selected = path.join(root, 'GOAL.json'); fs.writeFileSync(selected, '{}');
    await assert.rejects(captureReopen({ product_path: selected }), /Choose the original RESULT\.json, PUBLISHED\.json or session directory/u);
    assert.deepEqual(fs.readdirSync(root), ['GOAL.json']);
  });
});
test('capture rejects failed RESULT before a deliberately nonexistent configuration or application can load', { skip: !nativeWindows }, async () => {
  await withMetadataDirectory(async root => {
    const f = fixture(root); f.result.status = 'failed';
    f.result.configuration = { path: path.join(root, 'MISSING-INSTALLATION-CONFIG.json'), bytes: 0, sha256: '0'.repeat(64) };
    for (const [name, value] of [['RESULT.json', f.result], ['PUBLISHED.json', f.published], ['CONFIG-BINDING.json', f.binding]])
      fs.writeFileSync(path.join(root, name), JSON.stringify(value));
    await assert.rejects(captureReopen({ product_path: root }), /normally closed daily product/u);
    assert.deepEqual(fs.readdirSync(root).sort(), ['CONFIG-BINDING.json', 'PUBLISHED.json', 'RESULT.json']);
  });
});
