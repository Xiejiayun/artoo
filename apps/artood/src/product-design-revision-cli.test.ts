// Actual CLI main orchestration and raw revision comparison. Private-file ACL/SHA
// admission, native backend construction, product-file I/O and browser execution
// are controlled seams; this suite starts no provider, browser or native helper.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalProductDesignRevisionContextV1 } from "@artoo/domain";
import { designRevisionFixture, revisionReviewContext, revisionSha } from "./test-fixtures/design-revision.js";

const state = vi.hoisted(() => ({ order: [] as string[], outer: {} as Record<string, unknown>, root: "",
  researchBytes: new Uint8Array(), designBytes: new Uint8Array(), configured: {} as Record<string, unknown>,
  bound: {} as Record<string, unknown>, backend: Object.freeze({ controlled: "original backend" }), backendAvailable: true,
  allowPublicRead: false, privateRead: vi.fn(), prepareBackend: vi.fn(), productRead: vi.fn(), importedBind: vi.fn(), run: vi.fn() }));
const configPath = "C:\\controlled-design-private\\config.json", contextPath = "C:\\controlled-design-private\\context.json";
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs,
    realpathSync: Object.assign((path: string) => path, { native: (path: string) => path }),
    lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, nlink: 1, size: 100 }),
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]) === "C:\\controlled-design-private\\config.json") {
        state.order.push("config"); return JSON.stringify(state.configured);
      }
      if (String(args[0]) === "C:\\controlled-design-private\\context.json") {
        if (!state.allowPublicRead) throw Error("Private verification context bypassed its checked reader");
        state.order.push("public-read"); return JSON.stringify(state.outer);
      }
      return fs.readFileSync(...args);
    } };
});
vi.mock("./windows-browser-private-context.js", () => ({ readWindowsBrowserPrivateContext: (...args: unknown[]) => state.privateRead(...args) }));
vi.mock("./windows-browser-process-authority.js", () => ({ prepareWindowsBrowserProcessFromDescriptor: (...args: unknown[]) => state.prepareBackend(...args) }));
vi.mock("./product-stage.js", () => ({ readProductFile: (...args: unknown[]) => state.productRead(...args) }));
vi.mock("./imported-design-verifier-context.js", () => ({ bindImportedDesignVerifierContext: (...args: unknown[]) => state.importedBind(...args) }));
vi.mock("./web-acceptance.js", () => ({ validateStaticWebCapabilitySnapshot: (input: unknown) => input,
  runWebAcceptance: (...args: unknown[]) => state.run(...args) }));

const savedArgv = [...process.argv], savedContext = process.env.ARTOO_VERIFICATION_CONTEXT_FILE;
const savedSha = process.env.ARTOO_WINDOWS_BROWSER_CONTEXT_SHA256, savedExitCode = process.exitCode;
let logs: ReturnType<typeof vi.spyOn>, errors: ReturnType<typeof vi.spyOn>;
let fixture: ReturnType<typeof designRevisionFixture>;
function setup(review = false) {
  fixture = designRevisionFixture(); state.root = fixture.workspace;
  state.researchBytes = fixture.researchBytes; state.designBytes = fixture.revisedBytes;
  state.configured = { windows_browser_process: { version: 1 }, design_capture_cases: true };
  state.bound = structuredClone(state.configured);
  const digest = revisionSha("controlled profile");
  state.outer = { version: 1, request_id: review ? "review-verification" : fixture.start.verification!.request_id,
    profile_id: "checks", profile_digest: digest, subject_digest: revisionSha("controlled subject"), scope: "final",
    context: review ? revisionReviewContext(fixture.context) : fixture.context,
    windows_browser_process: { controlled: "private descriptor" },
    static_web_capabilities: { version: 1, binding: { version: 1, profile_digest: digest, command_id: "browser",
      config_digest: digest, contract_digest: digest }, options: state.bound } };
}
beforeEach(() => {
  vi.resetModules(); state.order = []; state.backendAvailable = true; state.allowPublicRead = false; setup();
  state.privateRead.mockReset().mockImplementation(() => {
    state.order.push("private-read"); return Buffer.from(JSON.stringify(state.outer));
  });
  state.prepareBackend.mockReset().mockImplementation((_descriptor: unknown, _binding: unknown, required: boolean) => {
    state.order.push("backend"); return required && state.backendAvailable ? state.backend : undefined;
  });
  state.productRead.mockReset().mockImplementation((root: string, path: string) => {
    if (root !== state.root) throw Error("Product I/O used another workspace");
    if (path === ".artoo/product/research.json") { state.order.push("research"); return Buffer.from(state.researchBytes); }
    if (path === ".artoo/product/design.json") { state.order.push("design"); return Buffer.from(state.designBytes); }
    throw Error("CLI attempted an unexpected product file");
  });
  state.importedBind.mockReset().mockImplementation(() => { throw Error("Revision CLI must not enter imported-design binding"); });
  state.run.mockReset().mockImplementation(async () => {
    state.order.push("browser"); return { stage: "design", cases: [{ case_id: "original" }, { case_id: "literal-separator" }], controlled_report: true };
  });
  vi.spyOn(process, "cwd").mockImplementation(() => state.root);
  logs = vi.spyOn(console, "log").mockImplementation(() => {}); errors = vi.spyOn(console, "error").mockImplementation(() => {});
  process.argv = [savedArgv[0]!, "controlled-cli", configPath]; process.exitCode = savedExitCode;
  process.env.ARTOO_VERIFICATION_CONTEXT_FILE = contextPath;
  process.env.ARTOO_WINDOWS_BROWSER_CONTEXT_SHA256 = "sha256:" + "a".repeat(64);
});
afterEach(() => {
  process.argv = [...savedArgv]; process.exitCode = savedExitCode;
  if (savedContext === undefined) delete process.env.ARTOO_VERIFICATION_CONTEXT_FILE; else process.env.ARTOO_VERIFICATION_CONTEXT_FILE = savedContext;
  if (savedSha === undefined) delete process.env.ARTOO_WINDOWS_BROWSER_CONTEXT_SHA256; else process.env.ARTOO_WINDOWS_BROWSER_CONTEXT_SHA256 = savedSha;
  vi.restoreAllMocks();
});
async function execute() {
  await import("./web-acceptance-cli.js");
  await vi.waitFor(() => expect(logs.mock.calls.length + errors.mock.calls.length).toBeGreaterThan(0));
}
function expectRejectedBeforeBrowser() {
  expect(errors).toHaveBeenCalledOnce(); expect(process.exitCode).toBe(1);
  expect(logs).not.toHaveBeenCalled(); expect(state.run).not.toHaveBeenCalled();
}
function expectedEcho() {
  return { version: 1, revision_id: fixture.revision.revision_id, scope: "all-declared-workspace-design-cases",
    descriptor_digest: revisionSha(canonicalProductDesignRevisionContextV1(fixture.revision)),
    baseline_checksum: revisionSha(fixture.baselineBytes), revised_design: { path: ".artoo/product/design.json",
      checksum: revisionSha(fixture.revisedBytes), size: fixture.revisedBytes.length } };
}

describe("design revision CLI entrypoint with controlled private/native/browser seams", () => {
  it.each(["author", "independent reviewer"])("checks private input and raw files before %s browser execution and recomputes its exact echo", async role => {
    if (role === "independent reviewer") setup(true);
    await execute(); expect(errors).not.toHaveBeenCalled(); expect(logs).toHaveBeenCalledOnce();
    expect(state.order).toEqual(["config", "private-read", "backend", "research", "design", "browser", "research", "design"]);
    expect(state.privateRead).toHaveBeenCalledWith(contextPath, "sha256:" + "a".repeat(64));
    expect(state.prepareBackend.mock.calls[0]).toEqual([state.outer.windows_browser_process, {
      request_id: state.outer.request_id, command_id: "browser", profile_digest: state.outer.profile_digest,
      subject_digest: state.outer.subject_digest, workspace_root: fixture.workspace,
    }, true]);
    expect(state.run.mock.calls[0]?.[0]).toBe(fixture.workspace);
    expect(state.run.mock.calls[0]?.[1]).toEqual(state.outer.context);
    expect(state.run.mock.calls[0]?.[2]).toEqual(state.bound);
    expect(state.run.mock.calls[0]?.[3]).toBe(state.outer.request_id);
    expect(state.run.mock.calls[0]?.[5]).toEqual({ verificationScope: "final", windowsProcessBackend: state.backend });
    expect(state.run.mock.calls[0]?.[5].windowsProcessBackend).toBe(state.backend);
    expect(JSON.parse(String(logs.mock.calls[0]?.[0])).product_design_revision).toEqual(expectedEcho());
    expect(state.importedBind).not.toHaveBeenCalled();
  });
  it("uses the bound full-case options even when the separately parsed argv configuration differs", async () => {
    state.configured.design_capture_cases = false;
    await execute(); expect(errors).not.toHaveBeenCalled();
    expect(state.run.mock.calls[0]?.[2]).toEqual(state.bound);
    expect(JSON.parse(String(logs.mock.calls[0]?.[0])).product_design_revision).toEqual(expectedEcho());
  });
  it.each(["missing-context", "missing-private-sha", "private-reader-rejected", "missing-backend", "missing-snapshot", "prototype-only"])(
    "rejects %s before browser execution", async change => {
      if (change === "missing-context") delete process.env.ARTOO_VERIFICATION_CONTEXT_FILE;
      if (change === "missing-private-sha") delete process.env.ARTOO_WINDOWS_BROWSER_CONTEXT_SHA256;
      if (change === "private-reader-rejected") state.privateRead.mockImplementation(() => { throw Error("Controlled private SHA/ACL rejection"); });
      if (change === "missing-backend") state.backendAvailable = false;
      if (change === "missing-snapshot") delete state.outer.static_web_capabilities;
      if (change === "prototype-only") state.bound.design_capture_cases = false;
      await execute(); expectRejectedBeforeBrowser(); expect(state.productRead).not.toHaveBeenCalled();
    });
  it("rejects revision data sent through a public context without the private native binding", async () => {
    state.configured = {}; state.bound = {}; state.allowPublicRead = true;
    (state.outer.static_web_capabilities as { options: unknown }).options = state.bound;
    delete process.env.ARTOO_WINDOWS_BROWSER_CONTEXT_SHA256; delete state.outer.windows_browser_process;
    await execute(); expectRejectedBeforeBrowser(); expect(state.privateRead).not.toHaveBeenCalled();
    expect(state.order).toContain("public-read");
  });
  it.each(["product_source_design_verification", "product_source_verification"])("rejects a mixed %s envelope before entering either verifier flow", async field => {
    state.outer[field] = { controlled: "foreign authority" };
    await execute(); expectRejectedBeforeBrowser(); expect(state.importedBind).not.toHaveBeenCalled();
    expect(state.productRead).not.toHaveBeenCalled();
  });
  it("does not launch a browser when the product file is still the accepted baseline", async () => {
    state.designBytes = fixture.baselineBytes;
    await execute(); expectRejectedBeforeBrowser(); expect(String(errors.mock.calls[0]?.[0])).toContain("append");
    expect(state.order).toEqual(["config", "private-read", "backend", "research", "design"]);
  });
  it("passes raw design bytes to the comparison before schema normalization can discard retained fields", async () => {
    const parsed = JSON.parse(fixture.revisedBytes.toString("utf8")); delete parsed.screens[0].retained_extension;
    state.designBytes = Buffer.from(JSON.stringify(parsed));
    await execute(); expectRejectedBeforeBrowser(); expect(String(errors.mock.calls[0]?.[0])).toContain("non-case field");
  });
  it.each(["design", "research"])("re-reads %s after browser completion and emits no stale revision evidence", async file => {
    state.run.mockImplementation(async () => {
      state.order.push("browser");
      if (file === "design") state.designBytes = Buffer.concat([fixture.revisedBytes, Buffer.from(" ")]);
      else state.researchBytes = Buffer.concat([fixture.researchBytes, Buffer.from(" ")]);
      return { stage: "design", cases: [] };
    });
    await execute(); expect(state.run).toHaveBeenCalledOnce(); expect(errors).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1); expect(logs).not.toHaveBeenCalled();
    expect(state.order).toEqual(["config", "private-read", "backend", "research", "design", "browser", "research", "design"]);
    expect(String(errors.mock.calls[0]?.[0])).toMatch(file === "design" ? /changed during its protected browser/ : /research bytes changed/);
  });
  it.each(["browser-failure", "wrong-stage"])("does not emit revision evidence after %s", async change => {
    state.run.mockImplementation(async () => {
      if (change === "browser-failure") throw Error("Controlled browser execution failure");
      return { stage: "research", cases: [] };
    });
    await execute(); expect(state.run).toHaveBeenCalledOnce(); expect(errors).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1); expect(logs).not.toHaveBeenCalled();
  });
  it("overwrites an unsolicited report echo with the independently recomputed raw-file evidence", async () => {
    state.run.mockResolvedValue({ stage: "design", cases: [{ case_id: "original" }, { case_id: "literal-separator" }],
      product_design_revision: { controlled: "forged browser echo" } });
    await execute(); expect(errors).not.toHaveBeenCalled();
    expect(JSON.parse(String(logs.mock.calls[0]?.[0])).product_design_revision).toEqual(expectedEcho());
  });
  it.each(["native ordinary", "legacy ordinary"])("keeps %s CLI output compatible without requiring revision data", async mode => {
    delete fixture.context.product_design_revision;
    if (mode === "legacy ordinary") {
      state.configured = {}; state.allowPublicRead = true;
      delete state.outer.static_web_capabilities; delete state.outer.windows_browser_process;
      delete process.env.ARTOO_WINDOWS_BROWSER_CONTEXT_SHA256;
    }
    await execute(); expect(errors).not.toHaveBeenCalled(); expect(state.productRead).not.toHaveBeenCalled();
    const report = JSON.parse(String(logs.mock.calls[0]?.[0]));
    expect(report.controlled_report).toBe(true); expect(report).not.toHaveProperty("product_design_revision");
    expect(report).not.toHaveProperty("product_source_design_mapping"); expect(report).not.toHaveProperty("product_source_mapping");
    expect(state.run.mock.calls[0]?.[5]).toEqual(mode === "native ordinary"
      ? { verificationScope: "final", windowsProcessBackend: state.backend } : { verificationScope: "final" });
  });
});
