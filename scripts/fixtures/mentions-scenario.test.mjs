import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { observeMentionPeer } from "./mentions-peer-diagnostics.mjs";
import { readMentionNotifications } from "./mentions-scenario.mjs";

test("notification evidence traverses actual cursors without losing global unread count", async () => {
  const routes = [],
    pages = [
      { notifications: [{ id: "new" }], unread_count: 3, has_more: true, next_before: "cursor value" },
      { notifications: [{ id: "old" }], unread_count: 3, has_more: false, next_before: "last" },
    ];
  const result = await readMentionNotifications(async (route) => {
    routes.push(route);
    return pages.shift();
  });
  assert.deepEqual(result, { notifications: [{ id: "new" }, { id: "old" }], unread_count: 3 });
  assert.deepEqual(routes, [
    "/api/v1/notifications?limit=100",
    "/api/v1/notifications?limit=100&before=cursor%20value",
  ]);
});

for (const [name, pages] of [
  ["duplicate IDs", [{ notifications: [{ id: "same" }, { id: "same" }], unread_count: 1, has_more: false }]],
  ["missing pagination cursor", [{ notifications: [], unread_count: 1, has_more: true }]],
  [
    "changing unread count",
    [
      { notifications: [], unread_count: 1, has_more: true, next_before: "next" },
      { notifications: [], unread_count: 2, has_more: false },
    ],
  ],
  ["invalid count", [{ notifications: [], unread_count: -1, has_more: false }]],
  ["missing pagination state", [{ notifications: [], unread_count: 0 }]],
  ["missing notification ID", [{ notifications: [{}], unread_count: 1, has_more: false }]],
  [
    "looping cursor",
    [
      { notifications: [], unread_count: 1, has_more: true, next_before: "same" },
      { notifications: [], unread_count: 1, has_more: true, next_before: "same" },
    ],
  ],
])
  test(`inventory refuses ${name}`, async () => {
    const queue = structuredClone(pages);
    await assert.rejects(readMentionNotifications(async () => queue.shift()));
  });

function page(body = async () => "Sender thread") {
  return Object.assign(new EventEmitter(), {
    url: () => "http://user:password@localhost:1234/channels?token=PRIVATE_TOKEN#PRIVATE_FRAGMENT",
    isClosed: () => false,
    locator(selector) {
      assert.equal(selector, "body");
      return {
        innerText(options) {
          assert.deepEqual(options, { timeout: 1000 });
          return body();
        },
      };
    },
  });
}
const request = {
  url: () => "http://user:password@localhost:1234/api/messages?token=PRIVATE_TOKEN",
  method: () => "GET",
  failure: () => ({ errorText: "PRIVATE_SESSION failed http://localhost:1234/path?PRIVATE_QUERY" }),
  headers() {
    assert.fail("Request headers must never be read");
  },
  postData() {
    assert.fail("Request bodies must never be read");
  },
};

test("captures failure timing and DOM while excluding credentials and network bodies", async () => {
  const peer = page(async () => "PRIVATE_SESSION http://localhost:1234/channels?PRIVATE_QUERY");
  const observer = observeMentionPeer(peer, ["PRIVATE_SESSION"]);
  peer.emit("request", request);
  peer.emit("response", {
    request: () => request,
    status: () => 503,
    body() {
      assert.fail("No response bodies");
    },
  });
  peer.emit("requestfinished", request);
  peer.emit("requestfailed", request);
  peer.emit("pageerror", new Error("PRIVATE_SESSION http://localhost:1234/error?PRIVATE_QUERY"));
  peer.emit("request", { ...request, url: () => "http://localhost:1234/PRIVATE_SESSION?PRIVATE_QUERY" });
  peer.emit("domcontentloaded");
  peer.emit("load");
  const snapshot = await observer.snapshot();
  assert.equal(snapshot.url, "http://localhost:1234/channels");
  assert.equal(snapshot.body_text, "[redacted] http://localhost:1234/channels");
  assert.deepEqual(
    snapshot.events.map((value) => value.event),
    ["request", "response", "requestfinished", "requestfailed", "pageerror", "request", "domcontentloaded", "load"],
  );
  assert.equal(snapshot.events[1].status, 503);
  assert.ok(snapshot.events.every((value) => Number.isFinite(value.elapsed_ms) && value.elapsed_ms >= 0));
  assert.equal(/PRIVATE_|password|user:/.test(JSON.stringify(snapshot)), false);
  observer.dispose();
});

test("bounds retained events and DOM, copies observations and removes only its own listeners", async () => {
  const peer = page(async () => "a".repeat(20_000));
  const original = () => {};
  peer.on("load", original);
  const observer = observeMentionPeer(peer);
  for (let index = 0; index < 537; index++) peer.emit("request", request);
  const snapshot = await observer.snapshot();
  assert.equal(snapshot.events.length, 500);
  assert.equal(snapshot.dropped_events, 37);
  assert.equal(snapshot.body_text.length, 16_000);
  snapshot.events[0].method = "MUTATED";
  assert.equal((await observer.snapshot()).events[0].method, "GET");
  observer.dispose();
  observer.dispose();
  assert.deepEqual(peer.eventNames(), ["load"]);
  assert.deepEqual(peer.listeners("load"), [original]);
});

test("records a rejected bounded DOM read without replacing the snapshot with a rejection", async () => {
  const peer = page(async () => {
    throw new Error("PRIVATE_SESSION locator timed out");
  });
  const observer = observeMentionPeer(peer, ["PRIVATE_SESSION"]);
  const snapshot = await observer.snapshot();
  assert.equal(snapshot.body_error, "[redacted] locator timed out");
  assert.equal(snapshot.body_text, undefined);
  observer.dispose();
});

for (const state of ["closed", "crashed"])
  test(`does not request DOM from a ${state} page`, async () => {
    const peer = page(() => assert.fail("No DOM request after close or crash"));
    const observer = observeMentionPeer(peer);
    if (state === "closed") {
      peer.isClosed = () => true;
      peer.emit("close");
    } else peer.emit("crash");
    const snapshot = await observer.snapshot();
    assert.equal(snapshot[state], true);
    assert.equal(snapshot.body_error, "Page is closed or crashed");
    assert.equal(snapshot.events[0].event, state === "closed" ? "close" : "crash");
    observer.dispose();
  });

test("retains requests observed while the bounded DOM read settles and refuses opaque URLs", async () => {
  let release;
  const peer = page(
    () =>
      new Promise((done) => {
        release = done;
      }),
  );
  peer.url = () => "data:text/html,PRIVATE_SESSION";
  const observer = observeMentionPeer(peer);
  const pending = observer.snapshot();
  peer.emit("request", { ...request, url: () => "not a URL PRIVATE_TOKEN" });
  release("Rendered thread");
  const snapshot = await pending;
  assert.equal(snapshot.url, "non-http-url");
  assert.equal(snapshot.events[0].url, "invalid-url");
  assert.equal(snapshot.body_text, "Rendered thread");
  observer.dispose();
});
