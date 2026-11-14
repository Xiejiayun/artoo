import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { observeNativeHistoryReads } from "./ios-ui-history-read-observer.mjs";

// Actual HTTP lifecycle, explicitly fake bearer values/statuses. This tests
// observer scoping and closure, not product authorization or native rendering.
async function fixture(check) {
  const server = createServer((request, response) => {
    if (request.headers["x-fixture-abort"] === "1") {
      response.destroy();
      return;
    }
    if (request.headers["x-fixture-hold"] === "1") {
      server.emit("fixture-held", response);
      return;
    }
    response.writeHead(Number(request.headers["x-fixture-status"] ?? 200));
    response.end("Original response body");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const originalListeners = server.listeners("request");
  const observer = observeNativeHistoryReads(server, { origin, agentId: "agent_fixture", peerToken: "private-peer" });
  const get = async (path, token = "private-native", status = 200) => {
    const response = await fetch(origin + path, {
      headers: { authorization: `Bearer ${token}`, "x-fixture-status": String(status) },
    });
    assert.equal(response.status, status);
    assert.equal(await response.text(), "Original response body");
  };
  try {
    await check({ server, observer, get, origin });
  } finally {
    observer.stop();
    assert.deepEqual(server.listeners("request"), originalListeners);
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}
const path = (run) => `/api/v1/agents/agent_fixture/history/${run}?limit=50`;

test("counts only completed native reads for the exact agent, latest page and bound session", async () => {
  await fixture(async ({ observer, get }) => {
    await get(path("run_one"));
    await get(path("run_one"));
    assert.deepEqual(observer.read("run_one"), { run_id: "run_one", successful_reads: 2, session_bound: true });
    for (const excluded of [
      path("run_one").replace("agent_fixture", "agent_other"),
      path("run_one") + "&before=10",
      path("run_one").replace("50", "20"),
      path("run_one") + "&limit=20",
      path("run_one").split("?")[0],
    ])
      await get(excluded);
    await get(path("run_one"), "private-peer");
    await get(path("run_one"), "other-native");
    for (const status of [401, 403, 500]) await get(path("run_one"), "private-native", status);
    assert.equal(observer.read("run_one").successful_reads, 2);
    assert.deepEqual(observer.read("run_new"), { run_id: "run_new", successful_reads: 0, session_bound: false });
    assert.throws(() => observer.read("../run_one"), /identity/);
    assert.ok(!JSON.stringify(observer.read("run_one")).includes("private"));
  });
});

test("separate runs bind independently and closing disables stale evidence without changing HTTP", async () => {
  await fixture(async ({ observer, get }) => {
    await get(path("run_one"));
    await get(path("run_two"), "another-native");
    assert.equal(observer.read("run_two").successful_reads, 1);
    observer.stop();
    assert.throws(() => observer.read("run_one"), /unavailable/);
    await get(path("run_one"));
  });
});

test("the harness localhost origin observes its actual loopback server and rejects a different server", async () => {
  await fixture(async ({ server, origin }) => {
    const alias = origin.replace("127.0.0.1", "localhost");
    const observer = observeNativeHistoryReads(server, {
      origin: alias,
      agentId: "agent_fixture",
      peerToken: "private-peer",
    });
    try {
      const response = await fetch(alias + path("run_localhost"), {
        headers: { authorization: "Bearer private-native" },
      });
      assert.equal(await response.text(), "Original response body");
      assert.deepEqual(observer.read("run_localhost"), {
        run_id: "run_localhost",
        successful_reads: 1,
        session_bound: true,
      });
      const wrong = new URL(alias);
      wrong.port = String(server.address().port === 65535 ? 65534 : server.address().port + 1);
      assert.throws(
        () => observeNativeHistoryReads(server, { origin: wrong.href, agentId: "agent_fixture", peerToken: "peer" }),
        /exact local fixture/,
      );
      // Explicit configuration double; a wildcard-bound listener is not local-only.
      assert.throws(
        () =>
          observeNativeHistoryReads(
            { address: () => ({ ...server.address(), address: "0.0.0.0" }) },
            {
              origin: alias,
              agentId: "agent_fixture",
              peerToken: "peer",
            },
          ),
        /exact local fixture/,
      );
    } finally {
      observer.stop();
    }
  });
});

test("bounded observation fails closed when its run inventory overflows", async () => {
  await fixture(async ({ observer, get }) => {
    for (let index = 0; index < 64; index++) await get(path(`run_${index}`));
    assert.equal(observer.read("run_63").successful_reads, 1);
    await get(path("run_64"));
    assert.throws(() => observer.read("run_0"), /unavailable/);
  });
});

test("rejects a mismatched origin or missing identity before adding a listener", async () => {
  await fixture(async ({ server, origin }) => {
    const listeners = server.listeners("request");
    for (const options of [
      { origin: "https://example.invalid", agentId: "agent_fixture", peerToken: "peer" },
      { origin, agentId: undefined, peerToken: "peer" },
      { origin, agentId: "../agent", peerToken: "peer" },
    ]) {
      assert.throws(() => observeNativeHistoryReads(server, options), /exact local fixture/);
    }
    assert.deepEqual(server.listeners("request"), listeners);
  });
});

test("an aborted response cannot count as a successful read and a genuine retry can", async () => {
  await fixture(async ({ observer, origin, get }) => {
    await assert.rejects(
      fetch(origin + path("run_aborted"), {
        headers: { authorization: "Bearer private-native", "x-fixture-abort": "1" },
      }),
    );
    assert.deepEqual(observer.read("run_aborted"), {
      run_id: "run_aborted",
      successful_reads: 0,
      session_bound: false,
    });
    await get(path("run_aborted"));
    assert.equal(observer.read("run_aborted").successful_reads, 1);
  });
});

test("stop releases an in-flight observer without aborting or replacing the product response", async () => {
  await fixture(async ({ server, observer, origin }) => {
    const held = new Promise((resolve) => server.once("fixture-held", resolve));
    const request = fetch(origin + path("run_pending"), {
      headers: { authorization: "Bearer private-native", "x-fixture-hold": "1" },
    });
    const response = await held;
    observer.stop();
    response.end("Original response body");
    assert.equal(await (await request).text(), "Original response body");
    assert.throws(() => observer.read("run_pending"), /unavailable/);
  });
});
