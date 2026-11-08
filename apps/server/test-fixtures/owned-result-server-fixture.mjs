// Real Fastify/PGlite routes and WebSocket binding for a native NodeClient test.
// Test-only local authentication is explicit; no event/evidence/ACK is fabricated.
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { and, asc, eq } from 'drizzle-orm';
import { agentInstances, agentRuntimes, computers, eventLog, runEvidence, runEventIngest, runs, tasks } from '@artoo/db';
import { buildTestServer } from '../dist/test-support.js';
import { qualifyRunEventMessage } from '../dist/services/run-event-receipt.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, label, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await read(); if (result) return result; await sleep(25); }
  throw new Error(`Timed out: ${label}`);
}
const NODE = 'computer_local_mock', PROJECT = 'proj_artoo', INSTANCE = 'ai_owned_result';
export async function createOwnedResultServerFixture({ workspaceRoot, allocationBase, runtime = 'fixture' }) {
  assert.ok(workspaceRoot?.startsWith('/') && allocationBase?.startsWith('/'), 'native paths required');
  const server = await buildTestServer({ workspaceRoot });
  const sockets = new Set(), outgoing = [], incoming = [];
  let baseUrl;
  try {
    const [seed] = await server.db.db.select().from(agentInstances).where(eq(agentInstances.id, 'instance_mock_coder'));
    assert.ok(seed);
    await server.db.db.update(agentInstances).set({ status: 'disabled' }).where(eq(agentInstances.id, seed.id));
    await server.db.db.update(agentRuntimes).set({ runtime }).where(eq(agentRuntimes.computerId, NODE));
    await server.db.db.update(computers).set({ os: process.platform, status: 'online' }).where(eq(computers.id, NODE));
    await server.db.db.insert(agentInstances).values({ ...seed, id: INSTANCE, runtime,
      config: { concurrency_limit: 2, worktree_workspace_base: { version: 1, strategy: 'per-run', basePath: allocationBase } } });
    baseUrl = await server.app.listen({ host: '127.0.0.1', port: 0 });
  } catch (error) { await server.close(); throw error; }
  const nodeUrl = new URL('/api/v1/node', baseUrl.replace('http:', 'ws:'));
  assert.equal(typeof server.ctx.deviceAuth.devNodeToken, 'string', 'explicit local test token must exist');
  nodeUrl.searchParams.set('token', server.ctx.deviceAuth.devNodeToken);

  class ObservedWebSocket extends WebSocket {
    constructor(...args) {
      super(...args); sockets.add(this);
      this.on('close', () => sockets.delete(this));
      this.on('message', data => {
        try { incoming.push({ socket: this, message: JSON.parse(data.toString()), at: performance.now() }); }
        catch { /* Non-JSON frames remain transport-owned and cannot satisfy an assertion. */ }
      });
    }
    send(data, ...args) {
      const encoded = typeof data === 'string' ? data : data.toString();
      try { outgoing.push({ socket: this, encoded, message: JSON.parse(encoded), at: performance.now() }); }
      catch { /* Recording is observational; the real transport still validates its frame. */ }
      return super.send(data, ...args);
    }
  }
  async function post(path, payload) {
    const response = await fetch(new URL(path, baseUrl), { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}) });
    const body = await response.json();
    assert.ok(response.ok, `${path}: HTTP ${response.status}: ${JSON.stringify(body)}`);
    return body;
  }
  async function readRun(runId) {
    const [run] = await server.db.db.select().from(runs).where(eq(runs.id, runId)); return run;
  }
  async function counts(runId) {
    return { evidence: (await server.db.db.select().from(runEvidence).where(eq(runEvidence.runId, runId))).length,
      receipts: (await server.db.db.select().from(runEventIngest).where(eq(runEventIngest.runId, runId))).length,
      events: (await server.db.db.select().from(eventLog).where(eq(eventLog.runId, runId))).length };
  }
  return {
    url: nodeUrl.toString(), baseUrl, nodeId: NODE, projectId: PROJECT, instanceId: INSTANCE,
    WebSocketImpl: ObservedWebSocket, server, outgoing, incoming,
    async assign({ profile, input = { kind: 'baseline' } }) {
      assert.equal(profile.node_id, NODE); assert.equal(profile.project_id, PROJECT);
      await until(() => server.ctx.getOwnedResultProfile?.(NODE, profile.result_profile.id, profile.verifier_template.id, PROJECT),
        'real managed handshake/profile registration', 20_000);
      const { task } = await post('/api/v1/tasks', { project_id: PROJECT, title: 'Native owned-result vertical fixture',
        acceptance_criteria: ['Author the exact fixed-input result and pass its protected verifier'], required_capabilities: ['code.modify'] });
      await post(`/api/v1/tasks/${task.id}/ready`);
      // The actual application onRunQueued hook dispatches the new command.
      const response = await post(`/api/v1/tasks/${task.id}/assign-owned-result`, { version: 1, agent_instance_id: INSTANCE,
        result_profile_id: profile.result_profile.id, verifier_template_id: profile.verifier_template.id, input });
      assert.equal(response.run.task_id, task.id);
      return { task, run: response.run };
    },
    async waitForCompleted(runId) {
      return until(async () => {
        const run = await readRun(runId);
        if (run?.status === 'failed' || run?.status === 'cancelled') throw new Error(`Real server run ${run.status}: ${run.failureReason}`);
        return run?.status === 'completed' ? run : undefined;
      }, `real server completed ${runId}`);
    },
    async assertReceiptChain(runId) {
      const run = await readRun(runId); assert.equal(run?.status, 'completed');
      assert.equal(run.requestedByUserId, 'user_owner'); assert.equal(run.verificationRequirement, null);
      const [task] = await server.db.db.select().from(tasks).where(eq(tasks.id, run.taskId)); assert.equal(task?.status, 'review');
      const evidenceRows = await server.db.db.select().from(runEvidence).where(eq(runEvidence.runId, runId)); assert.equal(evidenceRows.length, 1);
      const evidence = evidenceRows[0], frames = outgoing.filter(item => item.message.kind === 'run.event' && item.message.run_id === runId);
      const measured = frames.find(item => item.message.event.type === 'run.owned-result.verification'); assert.ok(measured, 'genuine NodeClient evidence frame');
      assert.deepEqual(measured.message.event.payload, evidence.payload);
      const sequence = measured.message.sequence;
      const retained = frames.find(item => item.message.sequence === sequence + 1), terminal = frames.find(item => item.message.sequence === sequence + 2);
      assert.equal(retained?.message.event.type, 'run.workspace.retained'); assert.equal(retained.message.event.payload.outcome, 'completed');
      assert.equal(terminal?.message.event.type, 'run.lifecycle'); assert.equal(terminal.message.event.payload.phase, 'completed');
      for (const item of [measured, retained, terminal]) {
        const [receipt] = await server.db.db.select().from(runEventIngest).where(and(eq(runEventIngest.runId, runId), eq(runEventIngest.sequence, item.message.sequence)));
        assert.ok(receipt?.bodyIdentity); assert.equal(receipt.bodyIdentity, qualifyRunEventMessage(item.message).bodyIdentity);
        await until(() => incoming.some(frame => frame.message.type === 'run.event.ack' && frame.message.payload.run_id === runId
          && frame.message.payload.sequence === item.message.sequence && frame.message.payload.status === 'accepted'), 'real accepted ACK', 15_000);
      }
      for (const earlier of [measured, retained]) {
        const ack = incoming.find(item => item.message.type === 'run.event.ack' && item.message.payload.run_id === runId
          && item.message.payload.sequence === earlier.message.sequence && item.message.payload.status === 'accepted');
        assert.ok(ack.at <= terminal.at, 'completed is sent only after real evidence and retention accepted ACKs');
      }
      const command = incoming.find(item => item.message.type === 'run.start.owned-result.v1' && item.message.payload.run_start.run_id === runId);
      assert.ok(command); assert.equal(command.message.idempotency_key, `${runId}:start`);
      assert.deepEqual(command.message.payload, run.ownedResultAssignment.request);
      const events = await server.db.db.select().from(eventLog).where(eq(eventLog.runId, runId)).orderBy(asc(eventLog.position));
      return { run_id: runId, task_status: task.status, evidence_id: evidence.id, sequence,
        receipt_sequences: [sequence, sequence + 1, sequence + 2], event_types: events.map(event => event.type),
        result: evidence.payload.result, verification: evidence.payload.verification.payload,
        scope: 'Real local NodeClient, author/verifier, managed WebSocket handshake, server persistence and ACKs; no live provider/product publication' };
    },
    async replayEvidence(runId) {
      const captured = outgoing.find(item => item.message.kind === 'run.event' && item.message.run_id === runId && item.message.event.type === 'run.owned-result.verification');
      assert.ok(captured); assert.equal(captured.socket.readyState, WebSocket.OPEN);
      const before = await counts(runId), offset = incoming.length;
      // Replay the original node-generated bytes, never a reconstructed assertion payload.
      captured.socket.send(captured.encoded);
      const ack = await until(() => incoming.slice(offset).find(item => item.message.type === 'run.event.ack'
        && item.message.payload.run_id === runId && item.message.payload.sequence === captured.message.sequence), 'replayed evidence ACK', 15_000);
      assert.equal(ack.message.payload.status, 'accepted'); assert.deepEqual(await counts(runId), before);
      return { run_id: runId, replay_status: ack.message.payload.status, unchanged_counts: before };
    },
    async close() {
      for (const socket of sockets) socket.terminate();
      await server.close();
    },
  };
}
