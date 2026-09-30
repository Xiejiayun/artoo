import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { closeOwnedBrowser } from "./owned-browser.mjs";

async function liveChild() {
  const child = spawn(process.execPath, ["-e", "const timer=setInterval(()=>{},1000);process.on('message',m=>{if(m==='stop'){clearInterval(timer);process.disconnect();}});process.send('ready');"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  await once(child, "message");
  return child;
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
}

test("graceful cleanup waits for the owned browser process to exit", async () => {
  const child = await liveChild();
  try {
    const server = { process: () => child, close: async () => { const exited = once(child, "exit"); child.send("stop"); await exited; }, kill: () => { throw new Error("Forced cleanup should not run"); } };
    const result = await closeOwnedBrowser(server);
    assert.equal(result.closed, true);
    assert.equal(result.method, "graceful");
    assert.equal(result.forced, false);
    assert.equal(child.exitCode, 0); assert.equal(child.signalCode, null);
  } finally { await stop(child); }
});

test("a hanging close force-stops only its owned child and leaves an unrelated process alive", async () => {
  const child = await liveChild(); const unrelated = await liveChild();
  try {
    let kills = 0;
    const server = { process: () => child, close: () => new Promise(() => {}), kill: async () => { kills += 1; await stop(child); } };
    const result = await closeOwnedBrowser(server, { gracefulTimeoutMs: 25, forceTimeoutMs: 1000 });
    assert.equal(result.closed, true); assert.equal(result.method, "forced");
    assert.equal(result.forced, true); assert.equal(kills, 1);
    assert.equal(result.graceful_error, "close timed out");
    assert.equal(unrelated.exitCode, null); assert.equal(unrelated.signalCode, null);
    process.kill(unrelated.pid, 0);
  } finally { await stop(child); await stop(unrelated); }
});

test("a fulfilled kill without a process exit never reports cleanup complete", async () => {
  const child = await liveChild();
  try {
    const server = { process: () => child, close: async () => { throw new Error("Browser transport failed"); }, kill: async () => {} };
    const result = await closeOwnedBrowser(server, { gracefulTimeoutMs: 25, forceTimeoutMs: 25 });
    assert.equal(result.closed, false); assert.equal(result.method, "forced");
    assert.equal(result.graceful_error, "close rejected");
    assert.match(result.error, /not both confirmed/);
    assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
  } finally { await stop(child); }
});

test("releases inherited stderr after actual exit so the browser server can finish its cleanup", async () => {
  const child = spawn(process.execPath, ["-e", `
    const {spawn}=require('node:child_process');
    const logger=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','ignore',2]});
    logger.unref(); process.send(logger.pid);
    process.on('message',m=>{if(m==='stop')process.disconnect();});
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const [loggerPid] = await once(child, "message");
  let cleanupFinished = false;
  try {
    const server = { process: () => child, close: async () => {
      const closed = once(child, "close"); child.send("stop"); await closed;
      cleanupFinished = true;
    }, kill: () => { throw new Error("An exited browser must not need a kill"); } };
    const result = await closeOwnedBrowser(server, { gracefulTimeoutMs: 2000 });
    assert.equal(result.closed, true); assert.equal(result.method, "graceful");
    assert.equal(child.exitCode, 0); assert.equal(cleanupFinished, true);
    assert.ok(result.stdio_released_after_exit.includes(2));
    process.kill(loggerPid, 0);
  } finally {
    await stop(child);
    try { process.kill(loggerPid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
});
