// Actual node verification and unmodified protected CLI, inside an outer native Job.
// Negative envelopes are new protected fixture files; no live input is edited.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { finished } from "node:stream/promises";
import {
  prepareWindowsProcessInstallation,
  describeWindowsProcessInstallation,
} from "../dist/windows-process-installation.js";
import {
  prepareVerificationProfiles,
  attachWindowsVerificationBackend,
  runVerification,
} from "../dist/verification.js";
import { prepareStaticWebCapabilities } from "../dist/web-acceptance.js";
import { writeWindowsBrowserPrivateContext } from "../dist/windows-browser-private-context.js";
import { isWindowsOwnedClosureReceipt, startWindowsOwnedProcess } from "../dist/owned/windows-owned-process.js";
import { createStorageVerificationFixture, inspectSealedStorageTrace } from "./browser-job-verification-workload.mjs";
import { observeActualVerificationCli } from "./browser-job-verification-observer.mjs";

if (process.platform !== "win32" || process.env.ARTOO_WINDOWS_BROWSER_VERIFICATION_NATIVE_WINDOW !== "1")
  throw new Error("Explicit native verification fixture window is required");
const inputFile = process.argv[2];
assert.ok(inputFile);
const input = JSON.parse(readFileSync(inputFile, "utf8"));
for (const name of ["root", "workspace", "browser", "directory"])
  assert.ok(typeof input[name] === "string" && isAbsolute(input[name]));
const root = realpathSync.native(input.root),
  workspace = realpathSync.native(input.workspace),
  browser = realpathSync.native(input.browser);
assert.deepEqual(input.writableWorkspaceRoots, [workspace], "Only the coding workspace may be an agent write root");
const installation = {
  directory: realpathSync.native(input.directory),
  manifestSha256: input.manifestSha256,
  writableWorkspaceRoots: [workspace],
};
const backend = prepareWindowsProcessInstallation(installation);
assert.deepEqual(describeWindowsProcessInstallation(backend), installation);
const helperManifest = JSON.parse(readFileSync(join(installation.directory, "manifest.json"), "utf8"));
const helperExecutable = join(installation.directory, helperManifest.executable);
const cli = realpathSync.native(fileURLToPath(new URL("../dist/web-acceptance-cli.js", import.meta.url)));
const sha = (bytes) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
/** @type {{version:number,claim:string,worker_pid:number,success:boolean,node_receipt:unknown,negative_cases:Record<string,unknown>[],authority_scope:string,error?:string,observer_cleanup_error?:string,sealed_measurement?:unknown}} */
const result = {
  version: 1,
  claim: "native-node-cli-job-browser-sealed-storage-fixture",
  worker_pid: process.pid,
  success: false,
  node_receipt: null,
  negative_cases: [],
  authority_scope:
    "Original outer/negative command Job receipts; internal browser receipt is not exposed by runVerification",
};
function save(name, value) {
  writeFileSync(join(root, name), JSON.stringify(value, null, 2) + String.fromCharCode(10), { flag: "wx" });
}
function assertOriginalClosed(receipt, pid) {
  assert.equal(isWindowsOwnedClosureReceipt(receipt), true);
  assert.equal(isWindowsOwnedClosureReceipt(JSON.parse(JSON.stringify(receipt))), false);
  assert.equal(receipt.rootPid, pid);
  assert.equal(receipt.helperExitCode, 0);
  assert.equal(receipt.helperSignal, null);
  for (const flag of [
    "rootCreated",
    "rootStarted",
    "atomicJobMember",
    "rootWaitObserved",
    "jobEmptyObserved",
    "stdoutEof",
    "stderrEof",
    "helperSpawnObserved",
    "helperExitObserved",
    "helperCloseObserved",
    "cleanupConfirmed",
  ])
    assert.equal(receipt[flag], true, flag);
  assert.ok(receipt.rootCreationTime);
  assert.equal(receipt.failureCode, null);
  assert.equal(receipt.nativeError, null);
  assert.equal(receipt.terminationReason, null);
  assert.equal(receipt.nativeTerminationReason, null);
}
async function rejectedCli(f, originalEnvelope, name, change, expectedMessage, digestMode = "normal") {
  const directory = join(root, "negative-" + name),
    temporary = join(directory, "temporary");
  mkdirSync(directory);
  mkdirSync(temporary);
  const envelope = structuredClone(originalEnvelope);
  change(envelope);
  const contextFile = join(directory, "private-context.json");
  // The production writer enforces complete-root separation, actual Windows ACLs,
  // stable file identity and its fixed deadline before a negative is dispatched.
  const correctDigest = writeWindowsBrowserPrivateContext(backend, contextFile, envelope, performance.now() + 30000);
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  assert.ok(systemRoot && isAbsolute(systemRoot));
  const env = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    PATH: join(systemRoot, "System32"),
    TEMP: temporary,
    TMP: temporary,
    ARTOO_VERIFICATION_CONTEXT_FILE: contextFile,
    ...(digestMode === "missing"
      ? {}
      : { ARTOO_WINDOWS_BROWSER_CONTEXT_SHA256: digestMode === "wrong" ? "sha256:" + "0".repeat(64) : correctDigest }),
  };
  const run = startWindowsOwnedProcess(backend, {
    executable: process.execPath,
    args: [cli, f.config],
    cwd: workspace,
    env,
    timeoutMs: 30000,
    cleanupTimeoutMs: 5000,
    normalExitPolicy: "require-empty",
    normalExitGraceMs: 250,
    maxOutputBytes: 1024 * 1024,
  });
  const stdout = [],
    stderr = [];
  run.stdout.on("data", (value) => stdout.push(Buffer.from(value)));
  run.stderr.on("data", (value) => stderr.push(Buffer.from(value)));
  const streams = Promise.all([finished(run.stdout, { cleanup: true }), finished(run.stderr, { cleanup: true })]);
  void streams.catch(() => {});
  let originalReceipt;
  try {
    const { pid } = await run.started;
    originalReceipt = await run.closed;
    await streams;
    assertOriginalClosed(originalReceipt, pid);
    assert.equal(originalReceipt.rootExitCode, 1, name + " must be rejected by the actual CLI");
    const error = Buffer.concat(stderr).toString("utf8");
    if (expectedMessage === "schema") {
      // The CLI intentionally omits Zod's message accessor. Check its safe
      // schema-failure record rather than requiring it to invoke that getter.
      const diagnostic = JSON.parse(error.split(/\r?\n/, 1)[0]);
      assert.equal(diagnostic.event, "browser_acceptance_failed");
      assert.equal(diagnostic.version, 1);
      assert.equal(diagnostic.omitted, false);
      assert.deepEqual(
        diagnostic.errors.map(({ relation, name, message }) => ({ relation, name, message })),
        [{ relation: "root", name: "ZodError", message: null }],
      );
    } else assert.match(error, expectedMessage);
    assert.equal(Buffer.concat(stdout).length, 0, "Rejected authority cannot emit acceptance measurements");
    assert.deepEqual(readdirSync(temporary), [], "Rejected authority cannot create an owned browser profile");
    const facts = {
      name,
      passed: true,
      cli_exit_code: 1,
      stderr: error.slice(0, 2000),
      temporary_empty: true,
      original_receipt_authenticated: true,
      serialized_copy_rejected: true,
      receipt: originalReceipt,
    };
    save("negative-" + name + ".json", facts);
    result.negative_cases.push(facts);
  } finally {
    if (!originalReceipt) {
      run.cancel();
      try {
        await run.closed;
        await streams;
      } catch {
        /* Retain this negative's files and fail the enclosing fixture. */
      }
    }
  }
}
let observer;
try {
  const f = createStorageVerificationFixture({ root, workspace, browser, backend, cli });
  const requestId = "native-job-storage-success";
  observer = observeActualVerificationCli({
    cli,
    config: f.config,
    workspace,
    requestId,
    profileDigest: f.profile.digest,
    subjectDigest: f.before,
    installation,
    helperExecutable,
  });
  const [unbound] = prepareVerificationProfiles([f.rawProfile], [workspace]);
  assert.ok(unbound);
  assert.throws(() => attachWindowsVerificationBackend(unbound, JSON.parse(JSON.stringify(backend))), {
    name: "Error",
    message: "Windows browser requires a locally qualified process installation",
  });
  observer.assertNoDispatch();
  const missingBackend = await runVerification(
    unbound,
    "missing-node-backend",
    new AbortController().signal,
    f.context,
  );
  assert.equal(missingBackend.outcome, "failed");
  assert.match(missingBackend.reason ?? "", /unsupported verification platform/);
  assert.deepEqual(missingBackend.checks, []);
  observer.assertNoDispatch();
  save("node-authority-rejections.json", {
    copied_backend_rejected: true,
    missing_backend: missingBackend,
    no_dispatch: true,
  });
  const nodeReceipt = await runVerification(f.profile, requestId, new AbortController().signal, f.context, f.before);
  result.node_receipt = nodeReceipt;
  save("node-verification.json", nodeReceipt);
  assert.equal(nodeReceipt.outcome, "passed", nodeReceipt.reason);
  observer.assertClosed();
  const observation = observer.snapshot(),
    envelope = observer.envelope();
  assert.ok(observation.context_directory);
  assert.equal(
    existsSync(observation.context_directory),
    false,
    "Verified command TEMP is removed only after real command closure",
  );
  save("actual-cli-handoff.json", observation);
  observer.dispose();
  observer = undefined;
  const trace = inspectSealedStorageTrace(f, nodeReceipt);
  f.assertUnchanged();
  assert.equal(trace.storage_precondition.seed_apply_count, 1);
  assert.equal(trace.storage_fault.windows[0].hits.delta, 1);
  const sealed = nodeReceipt.checks[0]?.observation;
  assert.ok(sealed?.version === 3);
  const measured = sealed.cases[0];
  assert.ok(measured);
  result.sealed_measurement = {
    outcome: nodeReceipt.outcome,
    evidence_bundle: sealed.evidence_bundle,
    trace_digest: measured.trace_digest,
    captures: measured.captures,
    seed_apply_count: 1,
    failed_write_hits: 1,
    source_unchanged: true,
    private_context_removed: true,
  };
  // Only copied, newly protected fixture envelopes are altered below. The success
  // envelope is gone, and no subsequent negative result enters node sealing.
  await rejectedCli(
    f,
    envelope,
    "missing-descriptor",
    (value) => {
      delete value.windows_browser_process;
    },
    "schema",
  );
  for (const field of ["request_id", "command_id", "profile_digest", "subject_digest", "workspace_root"]) {
    await rejectedCli(
      f,
      envelope,
      "wrong-" + field,
      (value) => {
        value.windows_browser_process[field] = field.endsWith("_digest")
          ? "sha256:" + "1".repeat(64)
          : field === "workspace_root"
            ? root
            : "wrong-fixture-binding";
      },
      new RegExp("Windows browser process " + field + " binding mismatch"),
    );
  }
  await rejectedCli(
    f,
    envelope,
    "serialized-backend",
    (value) => {
      value.windows_browser_process = JSON.parse(JSON.stringify(backend));
    },
    "schema",
  );
  await rejectedCli(
    f,
    envelope,
    "missing-private-digest",
    () => {},
    /missing independent context SHA-256 binding/,
    "missing",
  );
  await rejectedCli(
    f,
    envelope,
    "wrong-private-digest",
    () => {},
    /private context bytes differ from the parent binding/,
    "wrong",
  );
  await rejectedCli(
    f,
    envelope,
    "unsolicited-without-opt-in",
    (value) => {
      const options = { ...value.static_web_capabilities.options };
      delete options.windows_browser_process;
      const prepared = prepareStaticWebCapabilities(options);
      value.static_web_capabilities.options = prepared.options;
      value.static_web_capabilities.binding.config_digest = prepared.config_digest;
      value.static_web_capabilities.binding.contract_digest = prepared.contract_digest;
    },
    /Unsolicited Windows browser private context/,
  );
  f.assertUnchanged();
  result.success = true;
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  if (observer) {
    try {
      save("actual-cli-handoff-failed.json", observer.snapshot());
      observer.dispose();
    } catch (error) {
      result.observer_cleanup_error = error.message;
      result.success = false;
    }
  }
  save("integration-result.json", result);
}
if (!result.success) throw new Error(result.error ?? result.observer_cleanup_error ?? "Native integration failed");
