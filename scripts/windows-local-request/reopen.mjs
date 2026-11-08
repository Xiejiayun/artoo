// Serve an already published, normally closed local product without opening its
// old database, goal, agents, provider, source-recovery or clean workflow.
// The original protected publisher's health monitoring and withdrawal policies
// remain active; a withdrawn or changed product selection must fail reopening.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { captureReopen, recheckReopen, physical, save } from './inputs.mjs';

export function reopenOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    assert.ok(['--product', '--config', '--stdin-control'].includes(name), 'Unknown product-open option');
    assert.equal(Object.hasOwn(options, name), false, 'Duplicate product-open option');
    if (name === '--stdin-control') { options[name] = true; continue; }
    assert.ok(index + 1 < args.length && !args[index + 1].startsWith('--'), 'Product-open option needs a value');
    options[name] = args[++index];
  }
  assert.ok(options['--product']?.trim() && options['--stdin-control'] === true,
    'Use --product <original session or record> with --stdin-control');
  return options;
}

async function main() {
  const options = reopenOptions(process.argv.slice(2));
  // Do not inspect or forward an inherited Aerial credential to admission code.
  // The PowerShell caller's environment remains untouched.
  for (const key of Object.keys(process.env)) if (key.toUpperCase() === 'ARTOO_CODEX_PROVIDER_KEY') delete process.env[key];
  const inputs = await captureReopen({ product_path: options['--product'], configuration_file: options['--config'] });
  fs.mkdirSync(inputs.output); physical(inputs.output, true);
  save(path.join(inputs.output, 'INPUTS.json'), inputs);
  const result = { version: 1, scope: 'windows-published-product-open', session_root: inputs.session_root,
    output: inputs.output, original_result: inputs.original_result, published_record: inputs.published_record,
    config_binding: inputs.config_binding, installation_manifest: inputs.installation_manifest,
    product_url: inputs.publication.url, release_id: inputs.publication.release_id,
    artifact_digest: inputs.publication.artifact_digest, started_at: new Date().toISOString(), status: 'starting',
    errors: [], retained: true, publisher_started: false, publisher_stopped: false, inputs_unchanged: false,
    shutdown_confirmed: false, old_database_opened: false, goal_submitted: false, provider_executed: false };
  save(path.join(inputs.output, 'STARTED.json'), result);
  const note = error => result.errors.push(String(error?.message ?? error).slice(0, 2000));
  let publisher, ownership, stopping = false, controlPending = '', controlCommands = 0, controlAccepted = false;
  const requestStop = () => { if (!stopping) result.stop_requested_at = new Date().toISOString(); stopping = true; };
  const signalStop = () => { note(Error('Product open was interrupted; use the original stdin shutdown command for normal closure')); requestStop(); };
  const controlData = bytes => {
    try {
      controlPending += bytes.toString('utf8');
      assert.ok(Buffer.byteLength(controlPending) <= 4096, 'Product shutdown control exceeded its bound');
      for (let end; (end = controlPending.indexOf('\n')) >= 0;) {
        const line = controlPending.slice(0, end); controlPending = controlPending.slice(end + 1);
        assert.equal(++controlCommands, 1, 'Only one product shutdown command is permitted');
        let value;
        try { value = JSON.parse(line); } catch { throw Error('Invalid product shutdown command'); }
        assert.ok(value && !Array.isArray(value) && value.version === 1 && value.kind === 'shutdown'
          && Object.keys(value).length === 2, 'Invalid product shutdown command');
        controlAccepted = true; requestStop();
      }
    } catch (error) { note(error); requestStop(); }
  };
  const controlEnd = () => {
    if (!controlAccepted || controlCommands !== 1 || controlPending.length) note(Error('Product control closed without one complete shutdown command'));
    requestStop();
  };
  const controlError = () => { note(Error('Original product control stream failed')); requestStop(); };
  process.stdin.on('data', controlData); process.stdin.once('end', controlEnd); process.stdin.once('error', controlError);
  process.on('SIGINT', signalStop); process.on('SIGTERM', signalStop);
  try {
    const daemon = await import(pathToFileURL(path.join(inputs.bundle, 'artood.mjs')).href);
    assert.equal(typeof daemon.acquirePublishedProductOwnership, 'function', 'This installed bundle does not support product opening');
    assert.equal(typeof daemon.createPublishedProduct, 'function', 'This installed bundle does not support product opening');
    assert.equal(stopping, false, 'Shutdown arrived before the product was opened');
    ownership = daemon.acquirePublishedProductOwnership({ sessionRoot: inputs.session_root, mode: 'reopen' });
    result.publisher_ownership = ownership.descriptor;
    await recheckReopen(inputs); ownership.assertHeld();
    if (!stopping) {
      publisher = daemon.createPublishedProduct({ version: 1, closedSessionResult: inputs.original_result,
        verificationProfilesFile: inputs.verification_profiles_file, releaseProfilesFile: inputs.release_profiles_file,
        releaseProfileId: inputs.release_profile_id, windowsProcessInstallation: inputs.windows_process_installation,
        publication: Object.fromEntries(['release_id', 'run_id', 'evidence_id', 'artifact_digest', 'url', 'request_sha256', 'receipt_sha256', 'request', 'receipt']
          .map(key => [key, inputs.publication[key]])), exclusive: ownership });
      result.initial_observation = await publisher.start(); result.publisher_started = true;
      result.last_observation = result.initial_observation; result.status = 'serving';
      save(path.join(inputs.output, 'READY.json'), { version: 1, product_url: result.product_url,
        observation: result.initial_observation, original_session: inputs.session_root, observation_root: inputs.output });
      console.log(JSON.stringify({ kind: 'local-product.ready', product_url: result.product_url,
        release_id: result.release_id, observation_root: inputs.output,
        message: 'Keep this process running. Send one shutdown JSON line on this stdin to stop.' }));
      let nextCheck = Date.now() + 5000;
      while (!stopping) {
        ownership.assertHeld();
        if (Date.now() >= nextCheck) { result.last_observation = await publisher.observe(); nextCheck = Date.now() + 5000; }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    } else note(Error('Shutdown arrived before publisher startup completed'));
  } catch (error) { note(error); }
  finally {
    if (publisher) {
      const deadline = setTimeout(() => note(Error('Publisher stop exceeded 75 seconds; closure is still unconfirmed and ownership is retained')), 75000);
      try {
        const stopped = await publisher.stop();
        assert.equal(stopped?.cleanupConfirmed, true, 'Publisher did not confirm closure');
        result.publisher_stopped = true;
      } catch (error) { note(error); }
      finally { clearTimeout(deadline); }
    }
    try { await recheckReopen(inputs); result.inputs_unchanged = true; } catch (error) { note(error); }
    result.shutdown_control = { version: 1, mode: 'stdin', commands: controlCommands,
      complete: controlAccepted && controlCommands === 1 && controlPending.length === 0 };
    if (!result.shutdown_control.complete) note(Error('Product did not receive exactly one complete original stdin shutdown command'));
    if (ownership && !result.errors.length && result.publisher_started && result.publisher_stopped
        && result.inputs_unchanged && result.shutdown_control.complete) {
      try { result.publisher_ownership = ownership.release(); } catch (error) { note(error); }
    }
    result.shutdown_confirmed = result.errors.length === 0 && result.publisher_started && result.publisher_stopped
      && result.inputs_unchanged && result.shutdown_control.complete && result.publisher_ownership?.lock_removed === true;
    result.status = result.shutdown_confirmed ? 'stopped' : 'failed';
    result.finished_at = new Date().toISOString();
    process.stdin.off('data', controlData); process.stdin.off('end', controlEnd); process.stdin.off('error', controlError); process.stdin.pause();
    process.off('SIGINT', signalStop); process.off('SIGTERM', signalStop);
    save(path.join(inputs.output, 'RESULT.json'), result);
    console.log(JSON.stringify({ kind: 'local-product.stopped', status: result.status, product_url: result.product_url,
      shutdown_confirmed: result.shutdown_confirmed, observation_root: inputs.output, errors: result.errors }));
    process.exitCode = result.shutdown_confirmed ? 0 : 1;
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]), ownFile = fileURLToPath(import.meta.url);
if (invoked && (process.platform === 'win32' ? invoked.toLowerCase() === ownFile.toLowerCase() : invoked === ownFile)) await main();
