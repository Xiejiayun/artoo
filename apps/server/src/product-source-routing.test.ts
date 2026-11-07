import { ProductSourceRoutingV1Schema } from "@artoo/domain";
import type { NodeTransport } from "@artoo/protocol";
import { describe, expect } from "vitest";
import { settledServerFixture } from "./test-fixtures/settled-server-fixture.js";
import { buildTestServer, type TestServer } from "./test-support.js";
import { attachNodeBinding } from "./node-binding.js";
import { releaseAcceptanceFixture } from "./test-fixtures/release-acceptance.js";

describe("paired prepared source route discovery", () => {
  const lifecycle = settledServerFixture<{ server?: TestServer }>(() => ({}));
  const it = lifecycle.it, server = () => lifecycle.current().server!;
  lifecycle.beforeEach(async state => { state.server = await lifecycle.acquire(buildTestServer({ onResourceAcquired: resource => lifecycle.own(resource) })); });
  lifecycle.afterEach();
  it("requires a current qualified paired session and returns isolated snapshots matching the live profile", () => {
    const fixture = releaseAcceptanceFixture("research"), release = fixture.release, scope = release.binding;
    const routes = ProductSourceRoutingV1Schema.parse({ version: 1, source_exports: [release], destination_mappings: [] });
    let current = true, receipts = false;
    const transport: NodeTransport = { async send() {}, async close() {}, subscribe() { return () => {}; } };
    const features = ["run-verification.v1", "verification-capabilities.v1", "product-release.static.v1", "product-release.acceptance.v1",
      "product-source-transfer.v2", "product-source-transfer.measurement-v2.v1", "product-source-operations.v1"];
    const profiles = [{ profile_id: scope.verification_profile_id, project_id: scope.project_id, workspace_root: scope.workspace_root, capabilities: fixture.capabilities }];
    const releases = [{ profile_id: scope.release_profile_id, project_id: scope.project_id, workspace_root: scope.workspace_root,
      verification_profile_id: scope.verification_profile_id, target_kind: "static_site" as const, capabilities: release }];
    const binding = attachNodeBinding(server().ctx, transport, "paired-node", features, () => current, profiles, releases, [], () => false, "windows",
      { identity: { deviceId: "device", computerId: "paired-node", tokenLookup: "controlled" }, sessionId: "session", artifactDir: "controlled",
        qualifiedRunEventReceiptsReady: () => receipts }, routes);
    try {
      expect(binding.getProductSourceRouting!()).toBeUndefined(); receipts = true;
      const observed = binding.getProductSourceRouting!()!; expect(observed).toEqual(routes);
      observed.source_exports.length = 0; routes.source_exports.length = 0;
      expect(binding.getProductSourceRouting!()!.source_exports).toHaveLength(1);
      current = false; expect(binding.getProductSourceRouting!()).toBeUndefined(); current = true;
      binding.close(); expect(binding.getProductSourceRouting!()).toBeUndefined();
    } finally { binding.close(); }
    const unpaired = attachNodeBinding(server().ctx, transport, "legacy", features, () => true, profiles, releases, [], () => false, "windows", undefined,
      { version: 1, source_exports: [release], destination_mappings: [] });
    try { expect(unpaired.getProductSourceRouting!()).toBeUndefined(); } finally { unpaired.close(); }
  });
  it("does not return a route whose prepared release no longer matches the accepted hello", () => {
    const f = releaseAcceptanceFixture(), release = structuredClone(f.release);
    const changed = structuredClone(release); changed.binding.release_profile_digest = "sha256:" + "f".repeat(64);
    const binding = attachNodeBinding(server().ctx, { async send() {}, async close() {}, subscribe() { return () => {}; } }, "paired", [
      "run-verification.v1", "verification-capabilities.v1", "product-release.static.v1", "product-release.acceptance.v1",
      "product-source-transfer.v2", "product-source-transfer.measurement-v2.v1", "product-source-operations.v1"], () => true,
      [{ profile_id: "default", project_id: "proj_artoo", workspace_root: "/workspace/product", capabilities: f.capabilities }],
      [{ profile_id: "site", project_id: "proj_artoo", workspace_root: "/workspace/product", verification_profile_id: "default", target_kind: "static_site", capabilities: release }],
      [], () => false, "windows", { identity: { computerId: "paired", deviceId: "device", tokenLookup: "controlled" }, sessionId: "session", artifactDir: "controlled",
        qualifiedRunEventReceiptsReady: () => true }, { version: 1, source_exports: [changed], destination_mappings: [] });
    try { expect(binding.getProductSourceRouting!()).toBeUndefined(); } finally { binding.close(); }
  });
});
