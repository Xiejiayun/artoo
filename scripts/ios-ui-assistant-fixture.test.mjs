import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureAssistantContext, readAssistantObservations } from "./ios-ui-assistant-fixture.mjs";
import { assistantFailureReceiptPath, assistantStartupReceiptPath } from "./fixtures/assistant-conversation.mjs";

function setup(t) {
  const temporary = mkdtempSync(join(tmpdir(), "artoo-assistant-observation-test-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  mkdirSync(join(temporary, "workspace")); mkdirSync(join(temporary, "receipts"));
  const configuration = { project_id: "project_1", room_id: "room_1", workspace_root: realpathSync(join(temporary, "workspace")),
    receipts_directory: realpathSync(join(temporary, "receipts")) };
  const receipt = { project_id: "project_1", room_id: "room_1", thread_root_id: null, workspace_root: configuration.workspace_root,
    run_id: "run_1", turn_id: "turn_1", task_id: "task_1", pid: 8123, mode: "hold" };
  const put = (value = receipt, file = assistantStartupReceiptPath(configuration.receipts_directory, value.run_id)) => writeFileSync(file, JSON.stringify(value));
  return { temporary, configuration, receipt, put };
}

test("independent context observation hashes exact bytes and binds the run header", (t) => {
  const { configuration } = setup(t), path = join(configuration.workspace_root, "context_pack.md");
  const bytes = Buffer.from("# Context Pack pack_1\ntask: task_1\nrun: run_1\n\n## Raw Payload\n{\"text\":\"保留 é\"}\n");
  writeFileSync(path, bytes);
  assert.deepEqual(captureAssistantContext(path, "run_1"), { run_id: "run_1", sha256: createHash("sha256").update(bytes).digest("hex") });
  assert.throws(() => captureAssistantContext(path, "another_run"), /actual run/);
  writeFileSync(path, "# Context Pack pack_1\nrun: run_1\nrun: forged_run\n\n## Raw Payload\n{}");
  assert.throws(() => captureAssistantContext(path, "run_1"), /actual run/);
});

test("observations probe only PIDs from owned receipts and retain fail-once evidence", (t) => {
  const { configuration, receipt, put } = setup(t); put();
  const failed = { project_id: "project_1", room_id: "room_1", thread_root_id: null, turn_id: "turn_2", initial_run_id: "run_failed" };
  put(failed, assistantFailureReceiptPath(configuration.receipts_directory, failed.turn_id));
  const probed = [], hashes = [{ run_id: "run_1", sha256: "a".repeat(64) }];
  const observed = readAssistantObservations({ configuration, contextHashes: hashes, probe: (pid) => { probed.push(pid); return true; } });
  assert.deepEqual(probed, [receipt.pid]); assert.deepEqual(observed.live_pids, [receipt.pid]);
  assert.deepEqual(observed.receipts, [receipt]); assert.deepEqual(observed.failed_once_receipts, [failed]);
  observed.context_hashes[0].sha256 = "changed";
  assert.equal(hashes[0].sha256, "a".repeat(64), "A report consumer must not alter retained observations");
  assert.deepEqual(readAssistantObservations({ configuration, probe: () => false }).live_pids, []);
});

test("foreign identity, invalid PID or substituted receipt name cannot reach process probing", (t) => {
  const { configuration, receipt, put } = setup(t);
  for (const patch of [{ project_id: "another_project" }, { room_id: "another_room" }, { thread_root_id: "another_thread" },
    { workspace_root: "/another/workspace" }, { pid: 1 }, { pid: "8123" }, { run_id: "another_run" }]) {
    put({ ...receipt, ...patch }, assistantStartupReceiptPath(configuration.receipts_directory, receipt.run_id));
    let probed = false;
    assert.throws(() => readAssistantObservations({ configuration, probe: () => { probed = true; return true; } }));
    assert.equal(probed, false);
  }
});

test("unknown files, symlinks and malformed JSON fail without exposing raw receipt content", (t) => {
  const { configuration, receipt, temporary } = setup(t), file = assistantStartupReceiptPath(configuration.receipts_directory, receipt.run_id);
  const outside = join(temporary, "outside.json"); writeFileSync(outside, JSON.stringify(receipt));
  symlinkSync(outside, file);
  assert.throws(() => readAssistantObservations({ configuration }), /^Error: Assistant fixture receipt is unreadable$/);
  rmSync(file); writeFileSync(file, '{"PRIVATE_FIXTURE_SECRET":');
  assert.throws(() => readAssistantObservations({ configuration }), (error) => !error.message.includes("PRIVATE_FIXTURE_SECRET") && error.cause === undefined);
  rmSync(file); writeFileSync(join(configuration.receipts_directory, "arbitrary-pid-123.json"), "{}");
  assert.throws(() => readAssistantObservations({ configuration }), /Unexpected fixture receipt name/);
});

test("context evidence cannot follow a symlink or read an unbounded file", (t) => {
  const { configuration, temporary } = setup(t), path = join(configuration.workspace_root, "context_pack.md"), outside = join(temporary, "outside.md");
  writeFileSync(outside, "# Context Pack pack_1\nrun: run_1\n\n## Raw Payload\n{}"); symlinkSync(outside, path);
  assert.throws(() => captureAssistantContext(path, "run_1"), /bounded regular file/);
  rmSync(path); writeFileSync(path, Buffer.alloc(1_000_001));
  assert.throws(() => captureAssistantContext(path, "run_1"), /bounded regular file/);
});

test("live observation identifies a partial receipt while final verification stays strict", (t) => {
  const { configuration, receipt, put } = setup(t), file = assistantStartupReceiptPath(configuration.receipts_directory, receipt.run_id);
  writeFileSync(file, '{"run_id":');
  let probed = false;
  const pending = readAssistantObservations({ configuration, allowIncomplete: true, probe: () => { probed = true; return true; } });
  assert.deepEqual(pending.receipts, []); assert.equal(pending.incomplete_receipts.length, 1); assert.equal(probed, false);
  assert.throws(() => readAssistantObservations({ configuration }), /receipt is incomplete/, "Final verification cannot skip permanent corruption");
  put();
  const finished = readAssistantObservations({ configuration, allowIncomplete: true, probe: () => false });
  assert.deepEqual(finished.incomplete_receipts, []); assert.deepEqual(finished.receipts, [receipt]);
});

test("only the atomic publisher's exact private temporary filename is ignored", (t) => {
  const { configuration, receipt, put } = setup(t); put();
  writeFileSync(join(configuration.receipts_directory, `.assistant-receipt-${"a".repeat(32)}.tmp`), '{"pid":99999');
  const probed = [];
  const result = readAssistantObservations({ configuration, probe: (pid) => { probed.push(pid); return false; } });
  assert.deepEqual(probed, [receipt.pid]); assert.equal(result.receipts.length, 1);
  writeFileSync(join(configuration.receipts_directory, ".assistant-receipt-unrecognized.tmp"), "{}");
  assert.throws(() => readAssistantObservations({ configuration }), /Unexpected fixture receipt name/);
});
