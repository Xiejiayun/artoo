import { posix } from "node:path";
import type { ArtoodNode } from "../node-runner.js";
import { openLocalJournal } from "./journal.js";
import type { Journal } from "./journal-types.js";
import { createManagedNodeRunner, type ManagedNodeRunner, type ManagedNodeRunnerOptions } from "./managed-node-runner.js";
import { DeliveryCancelled } from "./managed-delivery.js";

/** Saved local profile identity, supplied separately from the live connection. */
export interface ManagedJournalBinding {
  readonly version: 1;
  readonly serverOrigin: string;
  readonly nodeId: string;
  readonly directory: string;
  readonly controllerScope: string;
  readonly expectedNamespace: string;
}
export type ManagedJournalPreparation = Omit<ManagedJournalBinding, "expectedNamespace">;

const bindingKeys = ["version", "serverOrigin", "nodeId", "directory", "controllerScope", "expectedNamespace"] as const;
const preparationKeys = ["version", "serverOrigin", "nodeId", "directory", "controllerScope"] as const;
function bindingText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 512
    || !value.isWellFormed() || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`Invalid managed journal ${field}`);
  return value;
}
function parsedUrl(value: string, field: string): URL {
  try { return new URL(value); } catch { throw new Error(`Invalid managed journal ${field}`); }
}
const loopback = (host: string) => ["localhost", "127.0.0.1", "[::1]"].includes(host);

function savedFields(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Managed journal binding must be a complete versioned object");
  const saved = input as Record<string, unknown>;
  if (!keys.every((key) => Object.hasOwn(saved, key)) || Object.keys(saved).some((key) => !keys.includes(key)) || saved.version !== 1) {
    throw new Error("Unsupported managed journal binding version or fields");
  }
  return saved;
}
function profileFields(saved: Record<string, unknown>): ManagedJournalPreparation {
  const serverOrigin = bindingText(saved.serverOrigin, "server origin"), nodeId = bindingText(saved.nodeId, "node ID");
  const directory = bindingText(saved.directory, "directory"), controllerScope = bindingText(saved.controllerScope, "controller scope");
  if (!posix.isAbsolute(directory) || directory === "/" || posix.resolve(directory) !== directory || directory.includes("\\")) {
    throw new Error("Managed journal directory must be a canonical absolute macOS path");
  }
  const origin = parsedUrl(serverOrigin, "server origin");
  if (origin.origin !== serverOrigin || origin.username || origin.password || origin.search || origin.hash
    || (origin.protocol !== "https:" && !(origin.protocol === "http:" && loopback(origin.hostname)))) {
    throw new Error("Managed journal server origin must be normalized HTTPS or loopback HTTP");
  }
  return Object.freeze({ version: 1, serverOrigin, nodeId, directory, controllerScope });
}
/** Explicit creation location only; it does not accept or adopt an existing namespace. */
export function validateManagedJournalPreparation(input: unknown): ManagedJournalPreparation {
  return profileFields(savedFields(input, preparationKeys));
}

/** Pure structural/profile check. Physical ancestry and marker checks belong to openLocalJournal. */
export function validateManagedJournalBinding(input: unknown, connection: { url: string; nodeId: string }): ManagedJournalBinding {
  const saved = savedFields(input, bindingKeys), profile = profileFields(saved);
  const expectedNamespace = bindingText(saved.expectedNamespace, "namespace"), endpoint = parsedUrl(connection.url, "connection URL");
  if (!["ws:", "wss:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash
    || endpoint.pathname !== "/api/v1/node" || (endpoint.protocol === "ws:" && !loopback(endpoint.hostname))) {
    throw new Error("Managed journal connection must use its qualified node WebSocket endpoint");
  }
  endpoint.protocol = endpoint.protocol === "wss:" ? "https:" : "http:";
  if (endpoint.origin !== profile.serverOrigin || profile.nodeId !== connection.nodeId) throw new Error("Managed journal binding differs from the connection origin or node ID");
  return Object.freeze({ ...profile, expectedNamespace });
}

export interface ManagedBootstrapOptions extends Omit<ManagedNodeRunnerOptions, "journal" | "mixed"> {
  binding: ManagedJournalBinding;
  allowNewAllocations: boolean;
}
export interface ManagedBootstrap extends ArtoodNode { readonly failed: Promise<Error> }

/** Lazy lifecycle owner. No worker, socket or journal is opened by construction. */
export function createManagedBootstrap(options: ManagedBootstrapOptions): ManagedBootstrap {
  const binding = validateManagedJournalBinding(options.binding, { url: options.url, nodeId: options.hello.node_id });
  if (typeof options.allowNewAllocations !== "boolean") throw new Error("Prepared journal requires an explicit new-allocation choice");
  const { binding: _binding, allowNewAllocations, ...input } = options;
  const runnerOptions = { ...input, hello: { ...input.hello, machine: { ...input.hello.machine } },
    workspace: input.workspace ? { ...input.workspace, allowedRoots: input.workspace.allowedRoots ? [...input.workspace.allowedRoots] : undefined } : undefined };
  const journalOptions = { directory: binding.directory, controllerScope: binding.controllerScope,
    nodeId: binding.nodeId, expectedNamespace: binding.expectedNamespace };
  let journal: Journal | undefined, runner: ManagedNodeRunner | undefined;
  let opening: Promise<Journal> | undefined, setupWork: Promise<void> | undefined;
  let starting: Promise<void> | undefined, stoppingWork: Promise<void> | undefined;
  let stopping = false, closed = false;
  const errors: Error[] = [];
  let resolveFailure!: (error: Error) => void;
  const failed = new Promise<Error>((resolve) => { resolveFailure = resolve; });
  function remember(cause: unknown): Error {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    if (!errors.includes(error)) {
      errors.push(error);
      if (errors.length === 1) resolveFailure(error);
    }
    return error;
  }
  function watch(source: Promise<Error>): void {
    const fail = (cause: unknown): void => {
      if (closed) return;
      remember(cause); // Resolve the first failure before initiating cleanup.
      void stop().catch(() => {}); // The public start/stop and failed owner join/report it.
    };
    void source.then(fail, fail);
  }
  function resultError(): Error {
    return errors.length === 1 ? errors[0]! : new AggregateError([...errors], `${errors[0]?.message}; additional managed startup or cleanup failures`, { cause: errors[0] });
  }
  function stop(): Promise<void> {
    if (stoppingWork) return stoppingWork;
    stopping = true; // A late open or ready may never create a new connection.
    stoppingWork = (async () => {
      if (opening) {
        try { journal ??= await opening; }
        catch (error) { remember(error); } // Open has no intentional-cancellation path.
      }
      if (runner) {
        try { await runner.stop(); }
        catch (error) { remember(error); }
      }
      // Join raw setup, not public start(), which itself joins this cleanup.
      if (setupWork) {
        try { await setupWork; }
        catch { /* An intentional stop rejects ready; actual failures were latched below or by their source. */ }
      }
      if (journal) {
        try { await journal.close(); }
        catch (error) { remember(error); }
      }
      closed = true;
      if (errors.length) throw resultError();
    })();
    void stoppingWork.catch(() => {});
    return stoppingWork;
  }
  function start(): Promise<void> {
    if (stopping) return Promise.reject(errors.length ? resultError() : new DeliveryCancelled("Managed node was stopped"));
    if (starting) return starting;
    setupWork = (async () => {
      try {
        opening = openLocalJournal(journalOptions);
        journal = await opening;
        watch(journal.failed);
        // Observe an already-failed opened resource before constructing its next owner.
        await Promise.resolve();
        if (stopping) return;
        runner = createManagedNodeRunner({ ...runnerOptions, journal, mixed: { allowNewAllocations } });
        watch(runner.failed);
        await Promise.resolve();
        if (stopping) return;
        await runner.start(); // Qualified ready and first matching pong.
      } catch (error) {
        if (!stopping || errors.length) remember(error);
        throw error;
      }
    })();
    starting = setupWork.then(async () => {
      if (stopping) { await stop(); throw new DeliveryCancelled("Managed startup was stopped"); }
    }, async (cause: unknown) => {
      if (!stopping) remember(cause);
      await stop();
      throw cause; // Intentional ready cancellation, after clean joined shutdown.
    });
    return starting;
  }
  return { start, stop, failed };
}
