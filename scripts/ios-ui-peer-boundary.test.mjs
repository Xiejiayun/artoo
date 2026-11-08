import assert from "node:assert/strict";
import test from "node:test";
import { remainingPeerBudget, waitForNativeThreadReply } from "./ios-ui-peer-boundary.mjs";

const reply = { id: "native-reply", body: "Native reply", thread_root_id: "root" };
function fixture(read) {
  let time = 0;
  const controller = new AbortController();
  return { controller, advance: ms => { time += ms; }, options: {
    rootId: "root", body: reply.body, deadline: 180_000, signal: controller.signal,
    now: () => time, wait: async ms => { time += ms; }, readMessages: read,
  } };
}

test("native UI may finish after 120 seconds without resetting the original parent deadline", async () => {
  let reads = 0;
  const f = fixture(async () => {
    reads++;
    if (reads === 1) { f.advance(125_000); return { messages: [] }; }
    return { messages: [reply] };
  });
  assert.equal(await waitForNativeThreadReply(f.options), reply.id);
  assert.equal(reads, 2);
  assert.equal(remainingPeerBudget(f.options.deadline, f.options.now), 54_850);
});

test("a delayed response after the parent deadline cannot be accepted", async () => {
  const f = fixture(async () => { f.advance(180_001); return { messages: [reply] }; });
  await assert.rejects(waitForNativeThreadReply(f.options), /original parent deadline/);
});

test("an already exhausted budget never starts a server read or returns Playwright timeout zero", async () => {
  let reads = 0;
  const f = fixture(async () => { reads++; return { messages: [reply] }; });
  f.advance(180_000);
  assert.throws(() => remainingPeerBudget(f.options.deadline, f.options.now), /original parent deadline/);
  await assert.rejects(waitForNativeThreadReply(f.options), /original parent deadline/);
  assert.equal(reads, 0);
});

for (const [name, messages, error] of [
  ["duplicate reply", [reply, { ...reply, id: "duplicate" }], /exactly once/],
  ["another thread", [{ ...reply, thread_root_id: "other" }], /observed root/],
  ["missing identity", [{ ...reply, id: "" }], /observed root/],
  ["malformed response", null, /contain messages/],
]) test(`rejects ${name} instead of certifying the sender`, async () => {
  const f = fixture(async () => ({ messages }));
  await assert.rejects(waitForNativeThreadReply(f.options), error);
});

test("shutdown cancels an outstanding server read", async () => {
  const f = fixture(signal => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    f.controller.abort(new Error("original native stopped"));
  }));
  await assert.rejects(waitForNativeThreadReply(f.options), /original native stopped/);
});

test("the original deadline cancels a server read that never returns", async () => {
  const f = fixture(signal => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  f.options.deadline = 20;
  // Keep the test alive independently of the helper's unref'ed deadline timer.
  const keepAlive = setTimeout(() => {}, 1_000);
  try { await assert.rejects(waitForNativeThreadReply(f.options), /original parent deadline/); }
  finally { clearTimeout(keepAlive); }
});
