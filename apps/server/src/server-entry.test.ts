import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const developmentEntry = fileURLToPath(new URL("../scripts/dev-server.mjs", import.meta.url));
const directEntry = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const testPepper = "server-entry-test-pepper";
const readyLine = /^Artoo server ready on ([0-9]+); storage=persistent$/;

interface ObservedChild {
  child: ChildProcess;
  stdout: string;
  stderr: string;
  stdoutEnded: boolean;
  stderrEnded: boolean;
  exitSeen: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  closeSeen: boolean;
  closeCode: number | null;
  closeSignal: NodeJS.Signals | null;
  spawnError?: Error;
  ready: Promise<number | undefined>;
  closed: Promise<void>;
}

interface EntryCase {
  root: string;
  temporaryParent: string;
  processes: ObservedChild[];
  cleaningUp: boolean;
  signal?: AbortSignal;
}

function checkpoint(scope: EntryCase): void {
  scope.signal?.throwIfAborted();
  if (scope.cleaningUp) throw new Error("Server entry test has entered cleanup");
}

async function bounded<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

// Only OS runtime locations are inherited. In particular this excludes every
// spelling of ARTOO_*, GOOGLE_*, AUTH_*, NODE_OPTIONS and NODE_PATH, so a developer's
// configured database, provider, credentials or loaders cannot enter the child.
function environment(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(path|systemroot|windir|systemdrive|comspec|temp|tmp|userprofile|homedrive|homepath|appdata|localappdata|programfiles|programfiles\(x86\))$/i.test(key)));
  return { ...inherited, NODE_ENV: "development", AUTH_ENFORCE_API: "0",
    ARTOO_HOST: "127.0.0.1", ARTOO_PORT: "0", ARTOO_DATA_DIR: join(root, "data"),
    ARTOO_DB_DIR: join(root, "data", "db"), ARTOO_ARTIFACT_DIR: join(root, "data", "artifacts"),
    ARTOO_WORKSPACE_ROOT: join(root, "workspace"), ...extra };
}

describe("server command-line entrypoints", () => {
  let current: EntryCase;

  beforeEach(() => {
    const temporaryParent = realpathSync.native(tmpdir());
    current = { temporaryParent, root: realpathSync.native(mkdtempSync(join(temporaryParent, "artoo-server-entry-"))),
      processes: [], cleaningUp: false };
  });

  afterEach(async () => {
    const scope = current;
    scope.cleaningUp = true;
    const { root, temporaryParent, processes } = scope;
    const cleanupErrors: Error[] = [];
    for (const observed of processes) {
      if (!observed.closeSeen) {
        if (observed.child.connected) {
          // A test failure may still leave a healthy server listening. Prefer its
          // own graceful shutdown; forced cleanup below never satisfies assertions.
          observed.child.send({ type: "shutdown" }, () => {});
        }
        try { await bounded(observed.closed, 5000, "graceful cleanup timed out"); }
        catch {
          observed.child.kill("SIGKILL");
          try { await bounded(observed.closed, 5000, "forced cleanup did not close the child"); }
          catch (error) { cleanupErrors.push(error as Error); }
        }
      }
      if (!observed.closeSeen || (observed.child.pid !== undefined && !observed.exitSeen)
        || !observed.stdoutEnded || !observed.stderrEnded) {
        cleanupErrors.push(new Error("Child exit, close and both output EOFs must precede directory cleanup"));
      }
    }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, `Retained server test directory: ${root}`);
    // Never recursively remove a computed path without checking its physical
    // parent and generated prefix, even after all owned processes are closed.
    const physical = realpathSync.native(root), within = relative(temporaryParent, physical);
    if (dirname(physical) !== temporaryParent || !basename(physical).startsWith("artoo-server-entry-")
      || within === "" || within === ".." || within.startsWith(`..${sep}`) || resolve(temporaryParent, within) !== physical) {
      throw new Error(`Unexpected server test directory; retained: ${root}`);
    }
    rmSync(physical, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }, 20_000);

  function launch(scope: EntryCase, entry: string, extra: NodeJS.ProcessEnv = {}): ObservedChild {
    checkpoint(scope);
    const { root, processes } = scope;
    expect(existsSync(entry), `Build the server before running its entrypoint regression: ${entry}`).toBe(true);
    expect(existsSync(directEntry), "The real compiled server is required; this test never substitutes a mock server").toBe(true);
    let finishReady!: (port: number | undefined) => void, finishClose!: () => void;
    const ready = new Promise<number | undefined>(done => { finishReady = done; });
    const closed = new Promise<void>(done => { finishClose = done; });
    const child = spawn(process.execPath, [entry], { cwd: root, env: environment(root, extra),
      windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    const observed: ObservedChild = { child, stdout: "", stderr: "", stdoutEnded: false, stderrEnded: false,
      exitSeen: false, exitCode: null, exitSignal: null, closeSeen: false, closeCode: null, closeSignal: null,
      ready, closed };
    processes.push(observed);
    child.once("error", error => { observed.spawnError = error; finishReady(undefined); });
    child.once("exit", (code, signal) => { observed.exitSeen = true; observed.exitCode = code; observed.exitSignal = signal; });
    child.once("close", (code, signal) => {
      observed.closeSeen = true; observed.closeCode = code; observed.closeSignal = signal;
      finishReady(undefined); finishClose();
    });
    child.stdout!.on("data", (bytes: Buffer) => {
      observed.stdout += bytes.toString();
      for (const line of observed.stdout.split(/\r?\n/).slice(0, -1)) {
        const match = readyLine.exec(line);
        if (match) finishReady(Number(match[1]));
      }
    });
    child.stderr!.on("data", (bytes: Buffer) => { observed.stderr += bytes.toString(); });
    child.stdout!.once("end", () => { observed.stdoutEnded = true; });
    child.stderr!.once("end", () => { observed.stderrEnded = true; });
    return observed;
  }

  async function healthy(scope: EntryCase, observed: ObservedChild): Promise<void> {
    checkpoint(scope);
    const port = await bounded(observed.ready, 30_000, "Server did not emit readiness before its deadline");
    checkpoint(scope);
    expect(observed.spawnError).toBeUndefined();
    expect(port, `Server exited without listening: ${observed.stderr}`).toBeTypeOf("number");
    expect(port).toBeGreaterThan(0);
    expect(observed.closeSeen).toBe(false);
    for (const [path, status] of [["/health/live", "ok"], ["/health/ready", "ready"]] as const) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(5000) });
      checkpoint(scope);
      expect(response.status).toBe(200);
      const body = await response.json();
      checkpoint(scope);
      expect(body).toEqual({ status });
    }
  }

  function expectComplete(observed: ObservedChild, code: number): void {
    expect(observed.spawnError).toBeUndefined();
    expect(observed.exitSeen).toBe(true);
    expect(observed.exitCode).toBe(code);
    expect(observed.exitSignal).toBeNull();
    expect(observed.closeSeen).toBe(true);
    expect(observed.closeCode).toBe(code);
    expect(observed.closeSignal).toBeNull();
    expect(observed.stdoutEnded).toBe(true);
    expect(observed.stderrEnded).toBe(true);
  }

  async function stop(scope: EntryCase, observed: ObservedChild): Promise<void> {
    checkpoint(scope);
    await bounded((async () => {
      await new Promise<void>((done, reject) => {
        observed.child.send({ type: "shutdown" }, error => error ? reject(error) : done());
      });
      checkpoint(scope);
      await observed.closed;
    })(), 10_000, "Server did not send and close after its own IPC shutdown");
    checkpoint(scope);
    expectComplete(observed, 0);
    expect(observed.stdout.split(/\r?\n/).filter(line => readyLine.test(line))).toHaveLength(1);
  }

  it("starts through the development launcher, closes gracefully, and reopens its database through the direct entry", async ({ signal }) => {
    const scope = current;
    scope.signal = signal;
    const development = launch(scope, developmentEntry);
    await healthy(scope, development);
    await stop(scope, development);
    // Same physical database: this also catches a shutdown path that exits but
    // leaves durable database ownership in place. No user database is involved.
    const direct = launch(scope, directEntry, { ARTOO_PAIRING_PEPPER: testPepper });
    await healthy(scope, direct);
    await stop(scope, direct);
  }, 90_000);

  it("keeps the direct entry fail-closed without a pairing pepper before creating any data", async ({ signal }) => {
    const scope = current;
    scope.signal = signal;
    const direct = launch(scope, directEntry);
    await bounded(direct.closed, 15_000, "Invalid direct startup did not exit");
    checkpoint(scope);
    expectComplete(direct, 1);
    expect(direct.stdout).not.toContain("Artoo server ready");
    expect(direct.stderr.trim()).toBe("ARTOO_PAIRING_PEPPER is required (device pairing HMAC pepper); refusing to start without it");
    expect(existsSync(join(scope.root, "data"))).toBe(false);
  }, 20_000);
});
