import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { prepareApplicationBrokerProcess, startApplicationBrokerProcess } from '../dist/application-broker-process.js';
import { ApplicationWireEncoder, ApplicationWireDecoder } from '../dist/application-wire-v1.js';

const [nativeArgument, brokerArgument, outputArgument] = process.argv.slice(2);
assert.equal(process.platform, 'win32');
for (const value of [nativeArgument, brokerArgument, outputArgument]) assert.ok(value && path.isAbsolute(value));
const nativeDirectory = fs.realpathSync.native(nativeArgument), brokerDirectory = fs.realpathSync.native(brokerArgument);
fs.mkdirSync(outputArgument); const output = fs.realpathSync.native(outputArgument);
const pin = file => { const absolute = fs.realpathSync.native(file), bytes = fs.readFileSync(absolute);
  return { path: absolute, bytes: bytes.length, sha256: 'sha256:' + createHash('sha256').update(bytes).digest('hex') }; };
const nativeManifest = pin(path.join(nativeDirectory, 'manifest.json'));
const node = pin(process.execPath), entry = pin(path.join(brokerDirectory, 'application-broker.mjs'));
const schemaJson = JSON.stringify({ version: 1, tables: [{ name: 'items', columns: [{ name: 'title', type: 'text', nullable: false, max_bytes: 64 }] }] });
const scope = { product_id: 'p', data_generation: 'd', service_generation: 1, artifact_digest: 'sha256:' + 'a'.repeat(64) };
const databasePath = path.join(output, 'data.sqlite');
const receipts = [];
const start = (name, maximumAccess, mode, selectedEntry = entry) => {
  const config = { version: 1, protocol: 'artoo.application-broker.v1', databasePath, schemaJson, scope, maximumAccess, mode };
  const file = path.join(output, name + '.json'); fs.writeFileSync(file, JSON.stringify(config), { flag: 'wx' });
  const configuration = pin(file), measured = [node, selectedEntry, configuration, nativeManifest];
  fs.writeFileSync(path.join(output, name + '-input-pins.json'), JSON.stringify(measured, null, 2), { flag: 'wx' });
  // Explicit controlled development admission. This only remeasures this fixture's
  // inputs; it is NOT production installation/storage-ACL qualification.
  const recheck = () => { for (const before of measured) assert.deepEqual(pin(before.path), before); };
  const prepared = prepareApplicationBrokerProcess({ native: { directory: nativeDirectory, manifestSha256: nativeManifest.sha256,
    assertLocalInstallation: recheck }, node, entry: selectedEntry, configuration, assertLocalAdmission: recheck });
  const owner = startApplicationBrokerProcess(prepared);
  assert.throws(() => startApplicationBrokerProcess(prepared), /unused/);
  owner.closed.then(receipt => { receipts.push({ name, receipt }); fs.writeFileSync(path.join(output, name + '-closure.json'), JSON.stringify(receipt, null, 2)); });
  return owner;
};
const input = new ApplicationWireEncoder('application-to-host'), outputWire = new ApplicationWireDecoder('host-to-application');
const decode = encoded => outputWire.push(Buffer.from(encoded, 'base64'))[0];
let current;
try {
  current = start('writable', 'write', 'create'); await current.ready;
  // More than one native input chunk, without any generated code executing.
  const begun = await current.command({ kind: 'begin', invocation: 'original-1', purpose: 'application', access: 'write', lifetimeMs: 30000,
    requestJson: JSON.stringify({ request_id: 'request-1', method: 'POST', path: '/items', query: {}, body: { padding: 'x'.repeat(20000) } }) });
  const invocation = decode(begun.frames[0]); assert.equal(invocation.kind, 'invoke');
  const transaction = { version: 1, kind: 'transaction', idempotency_key: 'original-key', operations: [{ kind: 'insert', table: 'items', id: 'one', values: { title: 'persisted' } }] };
  const data = await current.command({ kind: 'receive', data: input.encode(JSON.stringify({ kind: 'data-call', call_id: invocation.call_id,
    data_call_id: 'data-1', request_json: JSON.stringify(transaction) })).toString('base64') });
  const committed = decode(data.frames[0]); assert.equal(committed.kind, 'data-result'); assert.equal(JSON.parse(committed.reply_json).result.kind, 'committed');
  const response = await current.command({ kind: 'receive', data: input.encode(JSON.stringify({ kind: 'response', call_id: invocation.call_id,
    response: { status: 201, body: { saved: true } } })).toString('base64') });
  assert.deepEqual(response.responses, [{ invocation: 'original-1', response: { status: 201, body: { saved: true } } }]);
  const batchCalls = [];
  for (let index = 0; index < 2; index++) {
    const batch = await current.command({ kind: 'begin', invocation: `batch-${index}`, purpose: 'application', access: 'write', lifetimeMs: 30000,
      requestJson: JSON.stringify({ request_id: `batch-${index}`, method: 'POST', path: '/items', query: {}, body: null }) });
    batchCalls.push(decode(batch.frames[0]).call_id);
  }
  const batchFrames = [];
  for (let index = 0; index < 33; index++) batchFrames.push(input.encode(JSON.stringify({ kind: 'data-call', call_id: batchCalls[index < 32 ? 0 : 1],
    data_call_id: `batch-data-${index}`, request_json: JSON.stringify({ version: 1, kind: 'transaction', idempotency_key: `batch-key-${index}`,
      operations: [{ kind: 'insert', table: 'items', id: `batch-${index}`, values: { title: 'persisted' } }] }) })));
  const batchInput = Buffer.concat(batchFrames); assert.ok(batchInput.length <= 65536);
  const batchReply = await current.command({ kind: 'receive', data: batchInput.toString('base64') }); assert.equal(batchReply.frames.length, 33);
  for (const encoded of batchReply.frames) { const result = decode(encoded); assert.equal(result.kind, 'data-result'); assert.equal(JSON.parse(result.reply_json).result.kind, 'committed'); }
  const normal = await current.stop(); assert.equal(normal.normalShutdown, true); assert.ok(normal.inputChunksWritten > 4); current = undefined;

  // An actually different broker process/channel receives maximum read authority.
  current = start('readonly', 'read', 'open'); await current.ready;
  const readOutput = new ApplicationWireDecoder('host-to-application'), readInput = new ApplicationWireEncoder('application-to-host');
  const health = await current.command({ kind: 'begin', invocation: 'health-1', purpose: 'health', access: 'read', lifetimeMs: 30000,
    requestJson: JSON.stringify({ request_id: 'health', method: 'GET', path: '/health', query: {}, body: null }) });
  const healthCall = readOutput.push(Buffer.from(health.frames[0], 'base64'))[0];
  const denied = await current.command({ kind: 'receive', data: readInput.encode(JSON.stringify({ kind: 'data-call', call_id: healthCall.call_id,
    data_call_id: 'write-denied', request_json: JSON.stringify({ ...transaction, idempotency_key: 'denied', operations: [{ ...transaction.operations[0], id: 'two' }] }) })).toString('base64') });
  assert.equal(readOutput.push(Buffer.from(denied.frames[0], 'base64'))[0].code, 'unauthorized');
  const read = await current.command({ kind: 'receive', data: readInput.encode(JSON.stringify({ kind: 'data-call', call_id: healthCall.call_id,
    data_call_id: 'read', request_json: JSON.stringify({ version: 1, kind: 'read', query: { kind: 'query', table: 'items', columns: ['id', 'title'], limit: 100 } }) })).toString('base64') });
  const rows = JSON.parse(readOutput.push(Buffer.from(read.frames[0], 'base64'))[0].reply_json).result.rows;
  assert.deepEqual(rows, [...Array.from({ length: 33 }, (_, index) => ({ id: `batch-${index}`, title: 'persisted' })), { id: 'one', title: 'persisted' }]
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  await current.command({ kind: 'receive', data: readInput.encode(JSON.stringify({ kind: 'response', call_id: healthCall.call_id, response: { status: 200, body: null } })).toString('base64') });
  assert.equal((await current.stop()).normalShutdown, true); current = undefined;

  current = start('cancelled', 'read', 'open'); await current.ready;
  const cancelled = await current.cancel(); assert.equal(cancelled.normalShutdown, false); assert.equal(cancelled.failure, 'cancelled');
  assert.equal(cancelled.helper.closed, true); assert.equal(cancelled.helper.stdoutEof, true); assert.equal(cancelled.helper.stderrEof, true);
  assert.equal(cancelled.terminal.facts.lifetimeClosure.cleanupConfirmed, true);
  assert.equal(cancelled.terminal.facts.lifetimeClosure.jobEmptyObserved, true); current = undefined;

  // Explicit developer-authored fault fixture: it never reads stdin and contains
  // no generated product code. Retain the exact source and its launch pin.
  const heldDirectory = path.join(output, 'held-input-fixture'); fs.mkdirSync(heldDirectory);
  const heldEntry = path.join(heldDirectory, 'application-broker.mjs');
  fs.writeFileSync(heldEntry, 'process.stdout.write(JSON.stringify({version:1,kind:"ready",protocol:"artoo.application-broker.v1",maximumAccess:"read"})+"\\n");\nsetInterval(()=>{},1000);\n', { flag: 'wx' });
  current = start('pending-input-cancelled', 'read', 'open', pin(heldEntry)); await current.ready;
  let delivered = false;
  const pending = current.command({ kind: 'begin', invocation: 'held', purpose: 'health', access: 'read', lifetimeMs: 30000,
    requestJson: JSON.stringify({ request_id: 'held', method: 'GET', path: '/health', query: {}, body: { padding: 'x'.repeat(60000) } }) })
    .then(() => { delivered = true; }, () => {});
  await new Promise(resolve => setTimeout(resolve, 250)); assert.equal(delivered, false);
  const held = await current.cancel(); await pending;
  assert.equal(held.failure, 'cancelled'); assert.equal(held.normalShutdown, false); assert.equal(held.inputChunksWritten, 0);
  assert.equal(held.helper.closed, true); assert.equal(held.helper.stdoutEof, true); assert.equal(held.helper.stderrEof, true);
  assert.equal(held.terminal.facts.lifetimeClosure.cleanupConfirmed, true); assert.equal(held.terminal.facts.lifetimeClosure.jobEmptyObserved, true);
  current = undefined;
  fs.writeFileSync(path.join(output, 'RESULT.json'), JSON.stringify({ passed: true, cases: 4, receipts,
    generated_code_executed: false, production_admission_qualified: false }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ passed: true, cases: 4, output }));
} catch (error) {
  if (current) await current.cancel();
  fs.writeFileSync(path.join(output, 'RESULT.json'), JSON.stringify({ passed: false, error: String(error), receipts,
    generated_code_executed: false, production_admission_qualified: false }, null, 2), { flag: 'wx' });
  throw error;
}
