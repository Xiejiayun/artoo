import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importedDesignRequestFixture } from "./test-fixtures/imported-design-request.js";

const fixtureState = vi.hoisted(() => ({ order: [] as string[], outer: {} as Record<string, unknown>, root: "", bytes: new Uint8Array(),
  options: { windows_browser_process: { version: 1 } }, backend: Object.freeze({}), stage: "design",
  privateRead: vi.fn(), bind: vi.fn(), run: vi.fn() }));
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, realpathSync: Object.assign((path: string) => path, { native: (path: string) => path }),
    lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, nlink: 1, size: 100 }),
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]) === "C:\\controlled-private\\config.json") { fixtureState.order.push("config"); return JSON.stringify(fixtureState.options); }
      if (String(args[0]) === "C:\\controlled-private\\context.json") throw Error("Private context bypassed its checked reader");
      return fs.readFileSync(...args);
    } };
});
vi.mock("./windows-browser-private-context.js", () => ({ readWindowsBrowserPrivateContext: (...args: unknown[]) => fixtureState.privateRead(...args) }));
vi.mock("./windows-browser-process-authority.js", () => ({ prepareWindowsBrowserProcessFromDescriptor: () => {
  fixtureState.order.push("backend"); return fixtureState.backend;
} }));
vi.mock("./product-stage.js", () => ({ readProductFile: () => Buffer.from(fixtureState.bytes) }));
vi.mock("./imported-design-verifier-context.js", () => ({ bindImportedDesignVerifierContext: (...args: unknown[]) => fixtureState.bind(...args) }));
vi.mock("./web-acceptance.js", () => ({ validateStaticWebCapabilitySnapshot: (input: unknown) => input,
  runWebAcceptance: (...args: unknown[]) => fixtureState.run(...args) }));

const savedArgv = [...process.argv], savedContext = process.env.ARTOO_VERIFICATION_CONTEXT_FILE;
const savedSha = process.env.ARTOO_WINDOWS_BROWSER_CONTEXT_SHA256;
const savedExitCode = process.exitCode;
let logs: ReturnType<typeof vi.spyOn>, errors: ReturnType<typeof vi.spyOn>;
function setup(kind: "design" | "research" = "design") {
  const { request, bytes } = importedDesignRequestFixture(); fixtureState.bytes = bytes;
  const admission = request.review_request.result.outcome === "verified" ? request.review_request.result.admission : undefined;
  if (!admission) throw Error("Expected controlled imported research admission");
  const start = kind === "design" ? request.run_start : admission.run_start;
  const destination = request.review_request.operation.intent.request.byte_request.destination, check = destination.capabilities.checks[0]!;
  fixtureState.root = start.workspace.root; fixtureState.stage = kind;
  fixtureState.outer = { version: 1, request_id: start.verification!.request_id, profile_id: destination.profile_id,
    profile_digest: destination.capabilities.profile_digest, subject_digest: admission.ready.destination.subject_digest,
    scope: "final", context: start.context_pack.payload, windows_browser_process: { controlled: true },
    static_web_capabilities: { version: 1, binding: { version: 1, profile_digest: destination.capabilities.profile_digest,
      command_id: check.command_id, config_digest: check.config_digest, contract_digest: check.contract_digest }, options: fixtureState.options },
    ...(kind === "design" ? { product_source_design_verification: { controlled: true } } : { product_source_verification: admission }) };
}
beforeEach(() => {
  vi.resetModules(); fixtureState.order = []; setup();
  fixtureState.privateRead.mockReset().mockImplementation(() => { fixtureState.order.push("private-read"); return Buffer.from(JSON.stringify(fixtureState.outer)); });
  fixtureState.bind.mockReset().mockImplementation(() => { fixtureState.order.push("design-bind"); return { version: 1, controlled_echo: true }; });
  fixtureState.run.mockReset().mockImplementation(async () => { fixtureState.order.push("browser"); return { stage: fixtureState.stage, cases: [] }; });
  vi.spyOn(process, "cwd").mockImplementation(() => fixtureState.root);
  logs = vi.spyOn(console, "log").mockImplementation(() => {}); errors = vi.spyOn(console, "error").mockImplementation(() => {});
  process.argv = [savedArgv[0]!, "controlled-cli", "C:\\controlled-private\\config.json"];
  process.env.ARTOO_VERIFICATION_CONTEXT_FILE = "C:\\controlled-private\\context.json";
  process.env.ARTOO_WINDOWS_BROWSER_CONTEXT_SHA256 = "sha256:" + "a".repeat(64);
});
afterEach(() => {
  process.argv = [...savedArgv]; process.exitCode = savedExitCode;
  if (savedContext === undefined) delete process.env.ARTOO_VERIFICATION_CONTEXT_FILE; else process.env.ARTOO_VERIFICATION_CONTEXT_FILE = savedContext;
  if (savedSha === undefined) delete process.env.ARTOO_WINDOWS_BROWSER_CONTEXT_SHA256; else process.env.ARTOO_WINDOWS_BROWSER_CONTEXT_SHA256 = savedSha;
  vi.restoreAllMocks();
});
async function execute() { await import("./web-acceptance-cli.js"); await vi.waitFor(() => expect(logs.mock.calls.length + errors.mock.calls.length).toBeGreaterThan(0)); }
describe("CLI integration ordering with controlled private reader, Job backend and browser", () => {
  it("checks private input before parsing and preserves the original backend for admitted design", async () => {
    await execute(); expect(errors).not.toHaveBeenCalled();
    expect(fixtureState.order).toEqual(["config", "private-read", "backend", "design-bind", "browser"]);
    expect(fixtureState.run.mock.calls[0]?.[5]).toEqual({ windowsProcessBackend: fixtureState.backend });
    expect(JSON.parse(String(logs.mock.calls[0]?.[0])).product_source_design_mapping).toEqual({ version: 1, controlled_echo: true });
  });
  it("retains foreign-research mapping and the Job backend together", async () => {
    setup("research"); await execute(); expect(errors).not.toHaveBeenCalled(); expect(fixtureState.bind).not.toHaveBeenCalled();
    expect(fixtureState.run.mock.calls[0]?.[5]).toEqual({ windowsProcessBackend: fixtureState.backend });
    expect(JSON.parse(String(logs.mock.calls[0]?.[0])).product_source_mapping).toHaveProperty("mapping_digest");
  });
  it.each(["private-reader", "design-mapping", "research-mapping", "mixed-envelope", "missing-envelope"])("rejects %s before browser execution", async change => {
    if (change === "private-reader") fixtureState.privateRead.mockImplementation(() => { throw Error("Controlled private binding mismatch"); });
    if (change === "design-mapping") fixtureState.bind.mockImplementation(() => { throw Error("Controlled design mapping mismatch"); });
    if (change === "research-mapping") { setup("research"); fixtureState.outer.subject_digest = "sha256:" + "b".repeat(64); }
    if (change === "mixed-envelope") fixtureState.outer.product_source_verification = {};
    if (change === "missing-envelope") delete fixtureState.outer.product_source_design_verification;
    await execute(); expect(errors).toHaveBeenCalledOnce(); expect(process.exitCode).toBe(1);
    expect(fixtureState.run).not.toHaveBeenCalled(); expect(logs).not.toHaveBeenCalled();
  });
});
