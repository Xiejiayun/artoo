import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const controlledRuntimes = ["codex", "claude-code"];

export function devicePlatform(platform = process.platform) {
  const value = { win32: "windows", darwin: "macos", linux: "linux" }[platform];
  assert.ok(value, `Unsupported smoke platform: ${platform}`);
  return value;
}

export function prepareControlledCli({ evidenceDirectory, workspace, env }) {
  const bin = join(evidenceDirectory, "controlled-cli"); mkdirSync(bin);
  writeFileSync(join(bin, "package.json"), '{"private":true,"type":"module"}\n', { flag: "wx" });
  const fixture = fileURLToPath(new URL("./fixtures/controlled-cli.mjs", import.meta.url));
  for (const command of ["codex", "claude"]) {
    const entry = join(bin, process.platform === "win32" ? `${command}.mjs` : command);
    copyFileSync(fixture, entry);
    if (process.platform === "win32") {
      // Same entrypoint convention as npm's Windows shim; the production CLI
      // resolver resolves the JS entry directly instead of executing a shell.
      writeFileSync(join(bin, `${command}.cmd`), `@echo off\r\nnode "%dp0%\\${command}.mjs" %*\r\n`, { flag: "wx" });
    } else chmodSync(entry, 0o755);
  }
  if (process.platform !== "win32") symlinkSync(process.execPath, join(bin, "node"));
  const result = { ...env };
  for (const key of Object.keys(result)) if (/^(?:PATH|NODE_OPTIONS|NODE_PATH)$/i.test(key)
    || /(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i.test(key)) delete result[key];
  // No fallback to a real provider CLI installed elsewhere on the host. Node is
  // the only dependency needed by these fixture executables.
  result.PATH = bin;
  result.ARTOO_NPM_SMOKE_NONCE = randomUUID();
  result.ARTOO_NPM_SMOKE_WORKSPACE_ROOT = realpathSync(workspace);
  return result;
}

function processGone(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === "ESRCH") return true; throw error; }
}

export async function runControlledCliTasks({ request, computerId, workspace, env, waitFor }) {
  const results = [];
  for (const runtime of controlledRuntimes) for (const outcome of ["success", "failure"]) {
    const root = join(workspace, `${runtime}-${outcome}`); mkdirSync(root);
    const instance = (await request(`/api/v1/computers/${computerId}/instances`, {
      runtime, workspace_root: root, display_name: `Controlled npm fixture ${runtime} ${outcome}`, capabilities: ["code.modify"],
    })).agent_instance;
    const created = await request("/api/v1/tasks", {
      project_id: "proj_artoo", title: `Controlled npm CLI fixture: ${runtime} ${outcome}`,
      description: JSON.stringify({ fixture: "artoo.npm-controlled-cli.v1", runtime, outcome, nonce: env.ARTOO_NPM_SMOKE_NONCE }),
      acceptance_criteria: ["Exercise the installed daemon and a real local fixture process; no model is invoked"],
      required_capabilities: ["code.modify"],
    });
    const taskId = created.task.id;
    await request(`/api/v1/tasks/${taskId}/ready`, {});
    const assigned = await request(`/api/v1/tasks/${taskId}/assign`, {
      mode: "manual", agent_instance_id: instance.id, write_paths: ["fixture-output.txt"],
    });
    assert.equal(assigned.run.computer_id, computerId); assert.equal(assigned.run.runtime_id, runtime);
    let run;
    await waitFor(async () => {
      run = (await request(`/api/v1/runs/${assigned.run.id}`)).run;
      return ["completed", "failed", "cancelled"].includes(run.status);
    }, `${runtime} ${outcome} task terminal state`, 30_000);
    assert.equal(run.status, outcome === "success" ? "completed" : "failed", run.failure_reason ?? "Unexpected terminal state");
    const started = JSON.parse(readFileSync(join(root, "fixture-start.json"), "utf8"));
    const exited = JSON.parse(readFileSync(join(root, "fixture-exit.json"), "utf8"));
    assert.deepEqual(exited, { ...started, exitCode: outcome === "success" ? 0 : 23 });
    assert.equal(started.taskId, taskId); assert.equal(started.runtime, runtime); assert.equal(started.outcome, outcome);
    assert.equal(started.marker, `ARTOO_NPM_FIXTURE:${runtime}:${outcome}:${env.ARTOO_NPM_SMOKE_NONCE}`);
    assert.equal(started.platform, process.platform); assert.equal(started.arch, process.arch);
    await waitFor(() => processGone(started.pid), `${runtime} ${outcome} fixture process absence`);
    const bundle = (await request(`/api/v1/tasks/${taskId}/audit-bundle`)).bundle;
    assert.equal(bundle.task.status, outcome === "success" ? "review" : "blocked");
    assert.ok(bundle.events.some(event => event.type === "run.started" && event.run_id === run.id));
    const terminalType = outcome === "success" ? "run.completed" : "run.failed";
    assert.equal(bundle.events.filter(event => event.type === terminalType && event.run_id === run.id).length, 1);
    assert.ok(bundle.events.some(event => event.type === "run.output" && event.run_id === run.id && event.payload.text?.includes(started.marker)));
    const answers = bundle.messages.filter(message => message.kind === "text" && message.run_id === run.id && message.actor_type === "agent");
    if (outcome === "success") {
      assert.equal(readFileSync(join(root, "fixture-output.txt"), "utf8"), `${started.marker}\n`);
      assert.equal(answers.length, 1); assert.equal(answers[0].body, started.marker);
      const patchSha256 = createHash("sha256").update(readFileSync(join(root, "changes.patch"))).digest("hex");
      assert.ok(bundle.artifacts.some(artifact => artifact.run_id === run.id && artifact.type === "patch"
        && artifact.checksum === `sha256:${patchSha256}`), "The actual fixture patch must reach the server with its digest");
    } else {
      assert.equal(existsSync(join(root, "fixture-output.txt")), false);
      assert.equal(answers.length, 0); assert.equal(bundle.artifacts.length, 0);
      assert.ok(run.failure_reason.includes(`Controlled fixture failure: ${started.marker}`));
    }
    const leases = (await request("/api/v1/projects/proj_artoo/leases")).leases.filter(lease => lease.run_id === run.id);
    assert.ok(leases.length > 0, "Assignment must acquire a real write lease");
    assert.ok(leases.every(lease => lease.status === "released"), "Terminal fixture runs must release their write leases");
    results.push({ runtime, outcome, taskId, runId: run.id, runStatus: run.status, fixturePid: started.pid,
      fixtureExitCode: exited.exitCode, fixtureExitCodeSource: "fixture-process-exit-handler", fixtureProcessAbsent: true,
      structuredAnswerPersisted: answers.length === 1, artifactCount: bundle.artifacts.length, leasesReleased: true,
      modelInvoked: false });
  }
  return results;
}
