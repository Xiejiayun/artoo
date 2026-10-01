import assert from "node:assert/strict";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

/** Abort the peer scenario before waiting for its control request, then close
 * the exact owned browser and server. A stuck cleanup must still leave time
 * for the parent to finalize failure HTML before its aggregate kills it. */
export async function closeNativeMentionsResources({ scenario, fixture, browser, server, timeouts = {} }) {
  const steps = {};
  for (const [name, operation, fallback] of [["scenario", scenario, 3000], ["fixture", fixture, 3000], ["browser", browser, 4000], ["server", server, 3000]]) {
    if (!operation) { steps[name] = { closed: true, not_started: true }; continue; }
    const timeoutMs = timeouts[name] ?? fallback;
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= fallback);
    let timer;
    try {
      steps[name] = await Promise.race([
        Promise.resolve().then(operation).then(() => ({ closed: true }), () => ({ closed: false, error: "Cleanup rejected" })),
        new Promise((done) => { timer = setTimeout(() => done({ closed: false, error: "Cleanup timed out" }), timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  return { closed: Object.values(steps).every((step) => step.closed), steps };
}

/** Native-only transport for the shared peer scenario. It never reads a caller
 * supplied device identity or writes notification state. The parent owns the
 * scenario, browser and production server, and closes them independently. */
export async function createNativeMentionsFixture({ scenario }) {
  assert.equal(typeof scenario?.publish, "function");
  assert.equal(typeof scenario?.observe, "function");
  const token = randomBytes(32).toString("hex");
  const expected = Buffer.from(`Bearer ${token}`);
  let closing = false, publication, closePromise;
  const operations = new Set();
  const track = (operation) => {
    operations.add(operation);
    void operation.finally(() => operations.delete(operation)).catch(() => {});
    return operation;
  };
  const control = createServer((req, res) => {
    const reply = (status, body) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    const supplied = Buffer.from(req.headers.authorization ?? "");
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)
        || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      req.resume(); reply(401, { error: "Authenticated loopback fixture control required" }); return;
    }
    if (closing) { req.resume(); reply(503, { error: "Fixture closing" }); return; }
    if (req.method === "GET" && req.url === "/observations") {
      req.resume();
      void track(Promise.resolve().then(() => scenario.observe())).then(
        (value) => reply(200, value), () => reply(503, { error: "Mentions observation unavailable" }));
      return;
    }
    if (req.method !== "POST" || req.url !== "/publish") {
      req.resume(); reply(404, { error: "Unknown fixture operation" }); return;
    }
    let bytes = 0, body = "", rejected = false;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 4096) { rejected = true; reply(413, { error: "Fixture request too large" }); return; }
      body += chunk;
    });
    req.on("end", () => {
      if (rejected || closing) { if (closing) reply(503, { error: "Fixture closing" }); return; }
      try {
        const value = JSON.parse(body);
        assert.ok(value && !Array.isArray(value) && typeof value === "object" && Object.keys(value).length === 0);
      } catch { reply(400, { error: "Publish accepts only an empty JSON object" }); return; }
      // Share one in-flight result. An HTTP retry must not create more peer
      // messages, even if the first caller loses its response or setup fails.
      publication ??= track(Promise.resolve().then(() => scenario.publish({})));
      void publication.then((value) => reply(200, value), () => reply(500, { error: "Mentions publication failed" }));
    });
  });
  control.requestTimeout = 15_000;
  control.headersTimeout = 10_000;
  const close = () => closePromise ??= (async () => {
    closing = true;
    const stopped = control.listening ? new Promise((done, reject) => {
      control.close((error) => error ? reject(error) : done());
      control.closeAllConnections();
    }) : Promise.resolve();
    await Promise.allSettled([...operations]);
    await stopped;
  })();
  try {
    await new Promise((done, reject) => { control.once("error", reject); control.listen(0, "127.0.0.1", done); });
    const address = control.address(); assert.ok(address && typeof address === "object");
    return { fields: { fixture_control_url: `http://127.0.0.1:${address.port}`, fixture_control_token: token }, close };
  } catch (error) { await close(); throw error; }
}
