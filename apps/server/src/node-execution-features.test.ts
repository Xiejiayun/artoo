import type { NodeTransport } from "@artoo/protocol";
import type { VerificationProfileAdvertisement } from "@artoo/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServerContext } from "./context.js";
import { attachNodeBinding, type NodeBinding } from "./node-binding.js";
import { createNodeRegistry } from "./ws/node-registry.js";

const feature = "workspace-allocation.per-run-v1";
const context = new Proxy({} as ServerContext, {
  get() { throw new Error("Session feature queries must not access server dependencies"); },
});

describe("current binding execution-feature snapshots", () => {
  const bindings: NodeBinding[] = [];
  const transports: { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[] = [];
  // This predicate models an explicitly qualified current session. Actual
  // WebSocket negotiation is exercised by the separate managed transport gate.
  function bind(computerId = "computer_one", features?: readonly string[], registry = createNodeRegistry(),
    qualification: { state: "hello" | "ready" | "active" } = { state: "active" },
    profiles?: readonly VerificationProfileAdvertisement[], nodeOs?: string): NodeBinding {
    const transport: NodeTransport = {
      send: vi.fn(async () => { throw new Error("Feature queries must not dispatch commands"); }),
      subscribe: vi.fn(() => vi.fn()),
      close: vi.fn(async () => {}),
    };
    const binding: NodeBinding = attachNodeBinding(context, transport, computerId, features,
      () => qualification.state === "active" && registry.get(computerId) === binding, profiles, undefined, undefined, undefined, nodeOs);
    registry.register(computerId, binding);
    bindings.push(binding);
    transports.push({ send: transport.send as ReturnType<typeof vi.fn>, close: transport.close as ReturnType<typeof vi.fn> });
    return binding;
  }
  afterEach(() => {
    for (const binding of bindings.splice(0)) binding.close();
    for (const transport of transports.splice(0)) {
      expect(transport.send).not.toHaveBeenCalled();
      expect(transport.close).not.toHaveBeenCalled();
    }
  });

  it("denies missing and empty feature snapshots", () => {
    expect(bind().supportsExecutionFeature(feature)).toBe(false);
    expect(bind("computer_empty", []).supportsExecutionFeature(feature)).toBe(false);
  });

  it("requires an exact immutable profile binding on the active current session", () => {
    const registry = createNodeRegistry(), qualification: { state: "hello" | "ready" | "active" } = { state: "hello" };
    const profiles = [{ profile_id: "default", project_id: "project_1", workspace_root: "/work/product" }];
    const current = bind("computer_one", ["run-verification.v1"], registry, qualification, profiles);
    const supported = () => current.supportsVerificationProfile("default", "project_1", "/work/product");
    expect(supported()).toBe(false);
    qualification.state = "active"; expect(supported()).toBe(true);
    profiles[0]!.workspace_root = "/changed"; profiles.push({ profile_id: "new", project_id: "project_1", workspace_root: "/new" });
    expect(supported()).toBe(true);
    for (const [profile, project, root] of [["new", "project_1", "/new"], ["default", "other", "/work/product"],
      ["default", "project_1", "/work/product/child"], ["default", "project_1", "/work/Product"]]) {
      expect(current.supportsVerificationProfile(profile!, project!, root!)).toBe(false);
    }
    expect(bind("without_feature", [], registry, qualification, profiles).supportsVerificationProfile("default", "project_1", "/changed")).toBe(false);
    const replacement = bind("computer_one", ["run-verification.v1"], registry);
    expect(supported()).toBe(false);
    expect(replacement.supportsVerificationProfile("default", "project_1", "/work/product")).toBe(false);
    const restored = bind("computer_one", ["run-verification.v1"], registry, qualification,
      [{ profile_id: "default", project_id: "project_1", workspace_root: "/work/product" }]);
    expect(restored.supportsVerificationProfile("default", "project_1", "/work/product")).toBe(true);
    restored.close(); expect(restored.supportsVerificationProfile("default", "project_1", "/work/product")).toBe(false);
  });

  it("matches exact advertised strings and does not infer related support", () => {
    const binding = bind("computer_one", [feature, "future-feature.v2"]);
    expect(binding.supportsExecutionFeature(feature)).toBe(true);
    expect(binding.supportsExecutionFeature("future-feature.v2")).toBe(true);
    expect(binding.supportsExecutionFeature("workspace-allocation.per-run-v2")).toBe(false);
    expect(binding.supportsExecutionFeature(feature.toUpperCase())).toBe(false);
    expect(binding.supportsExecutionFeature("code.modify")).toBe(false);
  });

  it.each(["win32", "windows"])("resolves %s lexical variants to the exact immutable current advertised root", (os) => {
    const registry = createNodeRegistry(), qualification: { state: "hello" | "ready" | "active" } = { state: "hello" };
    const root = "C:\\Work Space\\产品", profiles = [{ profile_id: "default", project_id: "project_1", workspace_root: root }];
    const binding = bind("computer_one", ["run-verification.v1"], registry, qualification, profiles, os);
    const resolve = (path: string) => binding.getVerificationWorkspace("default", "project_1", path);
    expect(resolve(root)).toBeUndefined(); qualification.state = "active";
    for (const path of [root, "c:\\Work Space\\产品", "C:/WORK SPACE/产品/", "c:\\work space\\产品\\", "C:/Work Space/产品/."]) {
      expect(resolve(path)).toBe(root);
    }
    // Matching is routing only; exact run/profile checks still reject the alternate spelling.
    expect(binding.supportsVerificationProfile("default", "project_1", root)).toBe(true);
    expect(binding.supportsVerificationProfile("default", "project_1", "c:/work space/产品/")).toBe(false);
    profiles[0]!.workspace_root = "D:\\changed";
    expect(resolve(root)).toBe(root);
    for (const path of ["D:/Work Space/产品", "C:/Work Space/产品/child", "C:Work Space", "relative", "C:/Work\0Space"]) {
      expect(resolve(path)).toBeUndefined();
    }
    expect(binding.getVerificationWorkspace("other", "project_1", root)).toBeUndefined();
    expect(binding.getVerificationWorkspace("default", "other", root)).toBeUndefined();
    const replacement = bind("computer_one", ["run-verification.v1"], registry, qualification,
      [{ profile_id: "default", project_id: "project_1", workspace_root: "D:\\Other" }], os);
    expect(resolve(root)).toBeUndefined(); expect(replacement.getVerificationWorkspace("default", "project_1", root)).toBeUndefined();
    expect(replacement.getVerificationWorkspace("default", "project_1", "d:/other")).toBe("D:\\Other");
    replacement.close(); expect(replacement.getVerificationWorkspace("default", "project_1", "d:/other")).toBeUndefined();
    const unfeatured = bind("computer_missing_feature", [], registry, qualification,
      [{ profile_id: "default", project_id: "project_1", workspace_root: root }], os);
    expect(unfeatured.getVerificationWorkspace("default", "project_1", root)).toBeUndefined();
  });

  it.each(["project_1", "other_project"])("fails closed on colliding Windows advertisements, including %s", (project) => {
    const binding = bind("computer_one", ["run-verification.v1"], createNodeRegistry(), { state: "active" }, [
      { profile_id: "default", project_id: "project_1", workspace_root: "C:\\Work\\Product" },
      { profile_id: "different_profile", project_id: project, workspace_root: "c:/work/product/" },
    ], "win32");
    // Even an exact first match cannot disambiguate two claimed physical roots.
    expect(binding.getVerificationWorkspace("default", "project_1", "C:\\Work\\Product")).toBeUndefined();
    expect(binding.getVerificationWorkspace("different_profile", project, "c:/work/product/")).toBeUndefined();
    expect(binding.supportsVerificationProfile("default", "project_1", "C:\\Work\\Product")).toBe(false);
    expect(binding.supportsVerificationProfile("different_profile", project, "c:/work/product/")).toBe(false);
  });

  it.each(["linux", "darwin", undefined])("keeps exact advertised path matching for %s sessions", (os) => {
    const binding = bind("computer_one", ["run-verification.v1"], createNodeRegistry(), { state: "active" },
      [{ profile_id: "default", project_id: "project_1", workspace_root: "/Work/Product" }], os);
    expect(binding.getVerificationWorkspace("default", "project_1", "/Work/Product")).toBe("/Work/Product");
    for (const path of ["/work/product", "/Work/Product/", "/Work/./Product", "\\Work\\Product"]) {
      expect(binding.getVerificationWorkspace("default", "project_1", path)).toBeUndefined();
    }
  });

  it("copies the input list so later mutation cannot add or remove support", () => {
    const features = [feature];
    const binding = bind("computer_one", features);
    features.splice(0, 1, "later-feature.v1");
    expect(binding.supportsExecutionFeature(feature)).toBe(true);
    expect(binding.supportsExecutionFeature("later-feature.v1")).toBe(false);
  });

  it("denies support after close even while the registry still retains the binding", () => {
    const registry = createNodeRegistry();
    const binding = bind("computer_one", [feature], registry);
    registry.register("computer_one", binding);
    expect(registry.get("computer_one")?.supportsExecutionFeature(feature)).toBe(true);
    binding.close();
    expect(binding.supportsExecutionFeature(feature)).toBe(false);
    expect(registry.get("computer_one")?.supportsExecutionFeature(feature)).toBe(false);
  });

  it("does not inherit a replaced capable session's support on a legacy reconnect", () => {
    const registry = createNodeRegistry();
    const capable = bind("computer_one", [feature], registry);
    registry.register("computer_one", capable);
    const supports: NonNullable<ServerContext["supportsExecutionFeature"]> =
      (computerId, name) => registry.get(computerId)?.supportsExecutionFeature(name) ?? false;
    expect(supports("computer_one", feature)).toBe(true);
    const legacy = bind("computer_one", undefined, registry);
    registry.register("computer_one", legacy);
    expect(supports("computer_one", feature)).toBe(false);
    expect(capable.supportsExecutionFeature(feature)).toBe(false);
    capable.close();
    expect(registry.unregister("computer_one", capable)).toBe(false);
    expect(registry.get("computer_one")).toBe(legacy);
    expect(supports("computer_one", feature)).toBe(false);
  });

  it("denies after current-session unregister and never borrows another computer's support", () => {
    const registry = createNodeRegistry();
    const first = bind("computer_one", [feature], registry);
    const second = bind("computer_two", ["different-feature.v1"], registry);
    registry.register("computer_one", first);
    registry.register("computer_two", second);
    const supports = (computerId: string, name: string): boolean =>
      registry.get(computerId)?.supportsExecutionFeature(name) ?? false;
    expect(supports("computer_one", feature)).toBe(true);
    expect(supports("computer_two", feature)).toBe(false);
    expect(supports("computer_two", "different-feature.v1")).toBe(true);
    expect(supports("computer_missing", feature)).toBe(false);
    expect(registry.unregister("computer_one", first)).toBe(true);
    expect(first.supportsExecutionFeature(feature)).toBe(false);
    expect(supports("computer_one", feature)).toBe(false);
    expect(supports("computer_two", "different-feature.v1")).toBe(true);
  });

  it("denies managed hello and ready fixture states until active and current", () => {
    const registry = createNodeRegistry();
    const qualification: { state: "hello" | "ready" | "active" } = { state: "hello" };
    const binding = bind("computer_one", [feature], registry, qualification);
    expect(binding.supportsExecutionFeature(feature)).toBe(false);
    qualification.state = "ready";
    expect(binding.supportsExecutionFeature(feature)).toBe(false);
    qualification.state = "active";
    expect(binding.supportsExecutionFeature(feature)).toBe(true);
    qualification.state = "hello";
    expect(binding.supportsExecutionFeature(feature)).toBe(false);
    qualification.state = "active";
    expect(registry.unregister("computer_one", binding)).toBe(true);
    expect(binding.supportsExecutionFeature(feature)).toBe(false);
  });
});
