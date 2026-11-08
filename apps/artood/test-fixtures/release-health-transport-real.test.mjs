// Actual TCP transport regression. Server-side socket destruction is an explicit fault injection;
// the fetch implementation, response status/headers/body and timeout remain real.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchReleaseHealthGet } from "../dist/release-health-transport.js";

const evidenceRoot = process.env.ARTOO_WINDOWS_RELEASE_FIXTURE_ROOT;
async function fixture(name, handle) {
  const observations = [], timers = new Set(); let requests = 0;
  const later = (callback, milliseconds) => {
    const timer = setTimeout(() => { timers.delete(timer); callback(); }, milliseconds); timers.add(timer);
  };
  const server = createServer((request, response) => {
    observations.push({ event: "actual-http-request", request: ++requests, method: request.method, at: performance.now() });
    handle(request, response, requests, later);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = new URL(`http://127.0.0.1:${server.address().port}/`), originalFetch = globalThis.fetch;
  const signals = [];
  globalThis.fetch = async (input, options) => {
    signals.push(options.signal); observations.push({ event: "actual-fetch-start", attempt: signals.length, at: performance.now() });
    try {
      const response = await originalFetch(input, options);
      observations.push({ event: "actual-fetch-response", attempt: signals.length, status: response.status, at: performance.now() }); return response;
    } catch (error) {
      observations.push({ event: "actual-fetch-error", attempt: signals.length, name: error.name, code: error.cause?.code, at: performance.now() }); throw error;
    }
  };
  return { url, observations, signals, get requests() { return requests; }, async close() {
    globalThis.fetch = originalFetch;
    for (const timer of timers) clearTimeout(timer);
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    writeFileSync(join(evidenceRoot, `${name}.json`), JSON.stringify({ observations, requests, attempts: signals.length,
      sameSignal: signals.every(signal => signal === signals[0]), closed: true }, null, 2));
  } };
}

test("one actual pre-response socket reset retries GET and reads the exact second response", { timeout: 15000 }, async () => {
  const f = await fixture("reset-then-response", (request, response, count) => {
    if (count === 1) { request.socket.destroy(); return; }
    response.writeHead(200, { "content-type": "text/plain", "x-artoo-release-id": "measured-release" }); response.end("actual healthy bytes");
  });
  try {
    const started = performance.now(), signal = AbortSignal.timeout(10000), deadline = started + 10000;
    const response = await fetchReleaseHealthGet(f.url, signal, deadline);
    assert.equal(response.status, 200); assert.equal(response.headers.get("x-artoo-release-id"), "measured-release");
    assert.equal(await response.text(), "actual healthy bytes"); assert.equal(f.requests, 2); assert.equal(f.signals.length, 2);
    assert.ok(f.signals.every(actual => actual === signal)); assert.ok(performance.now() < deadline);
    assert.equal(f.observations.filter(event => event.event === "actual-fetch-error").length, 1);
    assert.ok(f.observations.filter(event => event.event === "actual-http-request").every(event => event.method === "GET"));
  } finally { await f.close(); }
});

test("an actual HTTP 503 remains a single failed response without retry", { timeout: 15000 }, async () => {
  const f = await fixture("http-503", (_request, response) => { response.writeHead(503); response.end("actual unavailable"); });
  try {
    const response = await fetchReleaseHealthGet(f.url, AbortSignal.timeout(10000), performance.now() + 10000);
    assert.equal(response.status, 503); assert.equal(await response.text(), "actual unavailable"); assert.equal(f.requests, 1); assert.equal(f.signals.length, 1);
  } finally { await f.close(); }
});

test("a delayed retry is aborted by the original real deadline", { timeout: 15000 }, async () => {
  const f = await fixture("unchanged-deadline", (request, response, count, later) => {
    if (count === 1) { later(() => request.socket.destroy(), 600); return; }
    later(() => { response.writeHead(200); response.end("arrived too late"); }, 600);
  });
  try {
    const started = performance.now(), signal = AbortSignal.timeout(1000), deadline = started + 1000;
    await assert.rejects(fetchReleaseHealthGet(f.url, signal, deadline), { name: "TimeoutError" });
    assert.equal(f.requests, 2); assert.equal(f.signals.length, 2); assert.ok(f.signals.every(actual => actual === signal));
    assert.equal(signal.aborted, true); assert.ok(performance.now() - started < 1800, "the second request cannot receive a new one-second budget");
  } finally { await f.close(); }
});
