// Actual CLI and H4 child binding with real domain inspection. Private-file ACL/SHA,
// filesystem identity, capability snapshot admission, Job and browser are controlled seams.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importedDesignReviewRequestDigestV1, importedDesignReviewVerificationEchoV1 } from "@artoo/domain";
import { importedDesignReviewRequestFixture, fixtureSha as sha } from "./test-fixtures/imported-design-review-request.js";
const state = vi.hoisted(() => ({ order: [] as string[], outer: {} as Record<string, any>, root: "",
  researchBytes: new Uint8Array(), designBytes: new Uint8Array(), configured: {} as Record<string, any>,
  bound: {} as Record<string, any>, backend: Object.freeze({ controlled: "original backend" }), backendAvailable: true,
  allowPublicRead: false, privateRead: vi.fn(), prepareBackend: vi.fn(), productRead: vi.fn(), h3Bind: vi.fn(), run: vi.fn() }));
const configPath = "C:\\controlled-h4-private\\config.json", contextPath = "C:\\controlled-h4-private\\context.json";
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, realpathSync: Object.assign((path: string) => path, { native: (path: string) => path }),
    lstatSync: () => ({ dev: 1, ino: 2, isDirectory: () => true, isFile: () => true, isSymbolicLink: () => false, nlink: 1, size: 100 }),
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]) === "C:\\controlled-h4-private\\config.json") { state.order.push("config"); return JSON.stringify(state.configured); }
      if (String(args[0]) === "C:\\controlled-h4-private\\context.json") {
        if (!state.allowPublicRead) throw Error("H4 private reader bypassed");
        state.order.push("public-read"); return JSON.stringify(state.outer);
      }
      return fs.readFileSync(...args);
    } };
});
vi.mock("./windows-browser-private-context.js", () => ({ readWindowsBrowserPrivateContext: (...args: unknown[]) => state.privateRead(...args) }));
vi.mock("./windows-browser-process-authority.js", () => ({ prepareWindowsBrowserProcessFromDescriptor: (...args: unknown[]) => state.prepareBackend(...args) }));
vi.mock("./owned/windows-owned-process.js", () => ({ assertWindowsProcessBackend: (value: unknown) => {
  if (value !== state.backend || !state.backendAvailable) throw Error("Controlled original Job backend unavailable");
} }));
vi.mock("./product-stage.js", () => ({ readProductFile: (...args: unknown[]) => state.productRead(...args) }));
vi.mock("./imported-design-verifier-context.js", () => ({ bindImportedDesignVerifierContext: (...args: unknown[]) => state.h3Bind(...args) }));
vi.mock("./web-acceptance.js", () => ({ validateStaticWebCapabilitySnapshot: (input: unknown) => input,
  runWebAcceptance: (...args: unknown[]) => state.run(...args) }));
const savedArgv = [...process.argv], savedContext = process.env.ARTOO_VERIFICATION_CONTEXT_FILE,
  savedSha = process.env.ARTOO_WINDOWS_BROWSER_CONTEXT_SHA256, savedExitCode = process.exitCode;
let logs: ReturnType<typeof vi.spyOn>, errors: ReturnType<typeof vi.spyOn>;
function setup(phase: "before" | "after" = "before") {
  const { request, bytes } = importedDesignReviewRequestFixture(), start = phase === "before" ? request.before_start : request.after_start;
  const destination = request.continuation_request.review_request.operation.intent.request.byte_request.destination, check = destination.capabilities.checks[0]!;
  state.root = start.workspace.root; state.researchBytes = bytes; state.designBytes = Buffer.from("controlled design bytes");
  state.configured = { windows_browser_process: { version: 1 }, design_capture_cases: true,
    browser_program: { version: 3, viewports: [{ id: "compact", width: 390, height: 844 }] } };
  state.bound = structuredClone(state.configured);
  state.outer = { version: 1, request_id: start.verification!.request_id, profile_id: destination.profile_id,
    profile_digest: destination.capabilities.profile_digest, subject_digest: start.verification!.expected_subject_digest,
    scope: "final", context: start.context_pack.payload, windows_browser_process: { controlled: "private descriptor" },
    static_web_capabilities: { version: 1, binding: { version: 1, profile_digest: destination.capabilities.profile_digest,
      command_id: check.command_id, config_digest: check.config_digest, contract_digest: check.contract_digest }, options: state.bound },
    product_source_design_review_verification: { version: 1, request, request_digest: importedDesignReviewRequestDigestV1(request, sha), phase,
      run_id: start.run_id, verification_request_id: start.verification!.request_id, scope: "final", subject_digest: start.verification!.expected_subject_digest } };
}
beforeEach(() => {
  vi.resetModules(); state.order = []; state.backendAvailable = true; state.allowPublicRead = false; setup();
  state.privateRead.mockReset().mockImplementation(() => { state.order.push("private-read"); return Buffer.from(JSON.stringify(state.outer)); });
  state.prepareBackend.mockReset().mockImplementation((_descriptor: unknown, _binding: unknown, required: boolean) => {
    state.order.push("backend"); return required && state.backendAvailable ? state.backend : undefined;
  });
  state.productRead.mockReset().mockImplementation((root: string, path: string) => {
    if (root !== state.root) throw Error("Unexpected product workspace");
    if (path === ".artoo/product/research.json") { state.order.push("research"); return Buffer.from(state.researchBytes); }
    if (path === ".artoo/product/design.json") { state.order.push("design"); return Buffer.from(state.designBytes); }
    throw Error("Unexpected product file");
  });
  state.h3Bind.mockReset().mockImplementation(() => { throw Error("H4 must not consult the H3 binding"); });
  state.run.mockReset().mockImplementation(async () => { state.order.push("browser"); return { stage: "design", cases: [], controlled_report: true }; });
  vi.spyOn(process, "cwd").mockImplementation(() => state.root);
  logs = vi.spyOn(console, "log").mockImplementation(() => {}); errors = vi.spyOn(console, "error").mockImplementation(() => {});
  process.argv = [savedArgv[0]!, "controlled-cli", configPath]; process.exitCode = savedExitCode;
  process.env.ARTOO_VERIFICATION_CONTEXT_FILE = contextPath; process.env.ARTOO_WINDOWS_BROWSER_CONTEXT_SHA256 = sha("private bytes controlled seam");
});
afterEach(() => {
  process.argv = [...savedArgv]; process.exitCode = savedExitCode;
  if (savedContext === undefined) delete process.env.ARTOO_VERIFICATION_CONTEXT_FILE; else process.env.ARTOO_VERIFICATION_CONTEXT_FILE = savedContext;
  if (savedSha === undefined) delete process.env.ARTOO_WINDOWS_BROWSER_CONTEXT_SHA256; else process.env.ARTOO_WINDOWS_BROWSER_CONTEXT_SHA256 = savedSha;
  vi.restoreAllMocks();
});
async function execute() { await import("./web-acceptance-cli.js"); await vi.waitFor(() => expect(logs.mock.calls.length + errors.mock.calls.length).toBeGreaterThan(0)); }
function rejected() { expect(errors).toHaveBeenCalledOnce(); expect(process.exitCode).toBe(1); expect(logs).not.toHaveBeenCalled(); }
function expectedEcho() { return importedDesignReviewVerificationEchoV1(state.outer.product_source_design_review_verification,
  state.outer.static_web_capabilities.binding.command_id, sha); }
describe("H4 CLI with controlled private/native/browser seams", () => {
  it.each(["before", "after"] as const)("requires private input and rechecks raw files before emitting the %s echo", async phase => {
    setup(phase); await execute(); expect(errors).not.toHaveBeenCalled(); expect(logs).toHaveBeenCalledOnce();
    expect(state.order).toEqual(["config", "private-read", "backend", "research", "design", "browser", "research", "design"]);
    expect(state.privateRead).toHaveBeenCalledWith(contextPath, sha("private bytes controlled seam"));
    expect(state.prepareBackend.mock.calls[0]).toEqual([state.outer.windows_browser_process, { request_id: state.outer.request_id,
      command_id: state.outer.static_web_capabilities.binding.command_id, profile_digest: state.outer.profile_digest,
      subject_digest: state.outer.subject_digest, workspace_root: state.root }, true]);
    expect(state.run.mock.calls[0]?.[2]).toEqual(state.bound); expect(state.run.mock.calls[0]?.[5].windowsProcessBackend).toBe(state.backend);
    const report = JSON.parse(String(logs.mock.calls[0]?.[0])); expect(report.product_source_design_review_mapping).toEqual(expectedEcho());
    expect(report.product_source_design_mapping).toBeUndefined(); expect(state.h3Bind).not.toHaveBeenCalled();
  });
  it("uses bound all-case options when argv options differ", async () => {
    state.configured.design_capture_cases = false; await execute(); expect(errors).not.toHaveBeenCalled();
    expect(state.run.mock.calls[0]?.[2]).toEqual(state.bound);
  });
  it.each(["missing-private-sha", "private-reader-rejected", "missing-backend", "missing-snapshot", "prototype-only", "v2", "missing-envelope", "missing-subject",
    "h2-envelope", "h3-envelope", "local-revision", "phase", "request", "subject", "profile", "command", "config", "contract", "design-pin"])(
    "rejects %s before browser execution", async change => {
      if (change === "missing-private-sha") delete process.env.ARTOO_WINDOWS_BROWSER_CONTEXT_SHA256;
      if (change === "private-reader-rejected") state.privateRead.mockImplementation(() => { throw Error("Controlled private SHA/ACL rejection"); });
      if (change === "missing-backend") state.backendAvailable = false;
      if (change === "missing-snapshot") delete state.outer.static_web_capabilities;
      if (change === "prototype-only") state.bound.design_capture_cases = false;
      if (change === "v2") state.bound.browser_program.version = 2;
      if (change === "missing-envelope") delete state.outer.product_source_design_review_verification;
      if (change === "missing-subject") delete state.outer.context.imported_design_review_subject;
      if (change === "h2-envelope") state.outer.product_source_verification = {};
      if (change === "h3-envelope") state.outer.product_source_design_verification = {};
      if (change === "local-revision") state.outer.context.product_design_revision = {};
      if (change === "phase") state.outer.product_source_design_review_verification.phase = "after";
      if (change === "request") state.outer.request_id = "other";
      if (change === "subject") state.outer.subject_digest = sha("other");
      if (change === "profile") state.outer.profile_id = "other";
      if (change === "command") state.outer.static_web_capabilities.binding.command_id = "other";
      if (change === "config") state.outer.static_web_capabilities.binding.config_digest = sha("other");
      if (change === "contract") state.outer.static_web_capabilities.binding.contract_digest = sha("other");
      if (change === "design-pin") state.designBytes = Buffer.from("wrong design bytes");
      await execute(); rejected(); expect(state.run).not.toHaveBeenCalled(); expect(state.h3Bind).not.toHaveBeenCalled();
    });
  it("rejects public envelope admission without independent private SHA or Job binding", async () => {
    state.allowPublicRead = true; state.configured = {}; state.bound = {};
    state.outer.static_web_capabilities.options = state.bound; delete state.outer.windows_browser_process;
    delete process.env.ARTOO_WINDOWS_BROWSER_CONTEXT_SHA256; await execute(); rejected();
    expect(state.privateRead).not.toHaveBeenCalled(); expect(state.run).not.toHaveBeenCalled();
  });
  it.each(["research", "design", "context", "options", "backend", "browser-failure", "wrong-stage"])("emits no evidence after %s changes or fails", async change => {
    state.run.mockImplementation(async (_root, context, options) => {
      if (change === "research") state.researchBytes = Buffer.concat([state.researchBytes, Buffer.from(" ")]);
      if (change === "design") state.designBytes = Buffer.concat([state.designBytes, Buffer.from(" ")]);
      if (change === "context") context.task.title = "changed during browser";
      if (change === "options") options.design_capture_cases = false;
      if (change === "backend") state.backendAvailable = false;
      if (change === "browser-failure") throw Error("Controlled browser close uncertain");
      return { stage: change === "wrong-stage" ? "research" : "design", cases: [] };
    });
    await execute(); rejected(); expect(state.run).toHaveBeenCalledOnce();
  });
  it("recomputes the phase echo independently of unsolicited browser fields", async () => {
    state.run.mockResolvedValue({ stage: "design", cases: [], product_source_design_review_mapping: { forged: true } });
    await execute(); expect(errors).not.toHaveBeenCalled();
    expect(JSON.parse(String(logs.mock.calls[0]?.[0])).product_source_design_review_mapping).toEqual(expectedEcho());
  });
});
