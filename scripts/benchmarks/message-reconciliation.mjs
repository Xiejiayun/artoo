import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { messages } from '@artoo/db';
import { buildTestServer } from '../../apps/server/dist/test-support.js';
import { createSession } from '../../apps/server/dist/auth/auth-service.js';

// Controlled local HTTP benchmark: migrated in-memory PGlite, real bearer
// authentication and loopback TCP. Never reads DATABASE_URL or user credentials.
if (process.argv.length > 3) throw new Error('Usage: node scripts/benchmarks/message-reconciliation.mjs [report-directory]');
const root = resolve(process.argv[2] ?? 'artifacts/performance');
mkdirSync(root, { recursive: true });
const output = mkdtempSync(join(root, 'message-reconciliation-'));
console.log(`Reports: ${output}`);
const resources = [];
try {
  const server = await buildTestServer({ authConfig: { enforceApiAuth: true }, onResourceAcquired: resource => resources.push(resource) });
  const token = (await createSession(server.ctx, { ttlMs: 3600000 }, { userId: 'user_owner' })).raw;
  const origin = await server.app.listen({ host: '127.0.0.1', port: 0 });
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const request = async (path, body, sample) => {
    const response = await fetch(`${origin}/api/v1${path}`, { method: body === undefined ? 'GET' : 'POST', headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
    const text = await response.text();
    assert.equal(response.status, path === '/channels' ? 201 : 200);
    if (sample) { sample.requests++; sample.response_body_bytes += Buffer.byteLength(text); }
    return JSON.parse(text);
  };
  const { channel } = await request('/channels', { project_id: 'proj_artoo', name: 'compact-state-benchmark' });
  const fixture = Array.from({ length: 250 }, (_, index) => ({ id: `bench_${String(index).padStart(3, '0')}`,
    organizationId: server.ctx.organizationId, roomId: channel.id, actorType: 'user', actorId: 'user_owner', kind: 'text',
    body: index === 0 ? 'This message was removed by a team administrator.' : 'Controlled benchmark content. '.repeat(140),
    replyCount: index === 249 ? 7 : 0, createdAt: server.ctx.clock.nowIso(),
    ...(index === 0 ? { moderatedAt: server.ctx.clock.nowIso(), moderatedByUserId: 'user_owner' } : {}),
  }));
  await server.db.db.insert(messages).values(fixture);
  const page = await request(`/rooms/${channel.id}/messages?limit=50`);
  assert.ok(page.next_after);
  const ids = fixture.map(item => item.id);
  const expected = ids.map((id, index) => ({ id, removed: index === 0, reply_count: index === 249 ? 7 : 0 }));
  const variants = ['legacy-100-snapshot', 'batch-500-snapshot', 'compact-500'];
  const samples = Object.fromEntries(variants.map(name => [name, []]));
  async function refresh(name) {
    const sample = { requests: 0, response_body_bytes: 0, elapsed_ms: 0 };
    const counts = new Map(), removed = new Set();
    const started = performance.now();
    const delta = await request(`/rooms/${channel.id}/messages?limit=50&after=${encodeURIComponent(page.next_after)}`, undefined, sample);
    assert.equal(delta.messages.length, 0);
    if (name === 'compact-500') {
      const state = await request(`/rooms/${channel.id}/messages/reconcile`, { version: 1, message_ids: ids }, sample);
      assert.equal(state.version, 1);
      assert.deepEqual(state.states.map(item => item.id), ids);
      for (const item of state.states) {
        assert.ok(item.status === 'visible' || item.status === 'removed');
        counts.set(item.id, item.reply_count);
        if (item.status === 'removed') removed.add(item.id);
      }
    } else {
      const snapshot = await request(`/rooms/${channel.id}/messages?limit=50`, undefined, sample);
      for (const item of snapshot.messages) counts.set(item.id, item.reply_count);
      const limit = name === 'legacy-100-snapshot' ? 100 : 500;
      for (let start = 0; start < ids.length; start += limit) {
        const visibility = await request(`/rooms/${channel.id}/messages/visibility`, { message_ids: ids.slice(start, start + limit) }, sample);
        for (const id of visibility.removed_message_ids) removed.add(id);
      }
    }
    assert.deepEqual(ids.map(id => ({ id, removed: removed.has(id), reply_count: counts.get(id) ?? 0 })), expected);
    sample.elapsed_ms = performance.now() - started;
    return sample;
  }
  for (let round = 0; round < 35; round++) {
    for (let offset = 0; offset < variants.length; offset++) {
      const name = variants[(round + offset) % variants.length];
      const sample = await refresh(name);
      if (round >= 5) samples[name].push(sample);
    }
  }
  const summary = Object.fromEntries(variants.map(name => {
    const ordered = samples[name].map(item => item.elapsed_ms).sort((a, b) => a - b);
    return [name, { samples: ordered.length, requests_per_refresh: samples[name][0].requests,
      response_body_bytes: samples[name][0].response_body_bytes, p50_ms: ordered[14], p95_ms: ordered[28] }];
  }));
  const report = { scope: 'Controlled loopback HTTP; not production latency or live Provider acceptance',
    node: process.version, platform: process.platform, git_sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    tracked_source_dirty: execFileSync('git', ['diff', '--name-only'], { encoding: 'utf8' }).trim().length > 0,
    fixture: { cached_messages: 250, message_body_characters: fixture[1].body.length, missed_replies: 7, missed_removals: 1, warmup_rounds: 5, measured_rounds: 30 }, summary, samples };
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(summary, null, 2));
} finally {
  // Reverse ownership order also covers a failure partway through setup.
  const errors = [];
  for (const resource of resources.reverse()) try { await resource.close(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'Benchmark resource closure failed');
}
