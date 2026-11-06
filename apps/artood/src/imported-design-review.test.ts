import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalProductSourceTransferValueV1 as canonical, importedDesignReviewRequestDigestV1 } from "@artoo/domain";
import type { ImportedDesignReviewCommand, NodeSideTransport, NodeToServerMessage } from "@artoo/protocol";
import { importedDesignReviewRequestFixture, fixtureSha as sha } from "./test-fixtures/imported-design-review-request.js";
const mocks = vi.hoisted(() => ({ reserve: vi.fn(() => ({})), run: vi.fn(), persist: vi.fn(), readAccepted: vi.fn() }));
vi.mock("./product-source-runtime.js", () => ({ reserveImportedDesignReview: mocks.reserve, runImportedDesignReview: mocks.run,
  persistImportedDesignReviewResult: mocks.persist, readCompletedAcceptedImportedDesignReview: mocks.readAccepted }));
import { createImportedDesignReviewClient } from "./imported-design-review.js";
beforeEach(() => vi.clearAllMocks());
function fixture() {
  const { request, result } = importedDesignReviewRequestFixture(), sent: NodeToServerMessage[] = [];
  const original = vi.fn(() => request.continuation_result); let current = true;
  const transport: NodeSideTransport = { acknowledgesRunEvents: true, send: vi.fn(async message => { sent.push(message); }), subscribe: () => () => {} };
  const options = { nodeId: request.continuation_request.review_request.operation.intent.request.byte_request.destination.node_id, runtime: {} as never,
    designs: { readCompletedVerifiedDesign: original } as never, resolveAdapter: () => ({ runtimeId: request.review_start.runtime }) as never,
    transport, isCurrent: () => current };
  const control = { version: 1 as const, review_id: request.review_id, request_digest: importedDesignReviewRequestDigestV1(request, sha) };
  const command: ImportedDesignReviewCommand = { kind: "command", id: "h4-start", idempotency_key: "h4-start", type: "product.source.design-review.v1", payload: request };
  mocks.run.mockResolvedValue(result);
  return { request, result, options, transport, original, control, command, sent, invalidate: () => { current = false; } };
}
describe("H4 controller with explicitly controlled runtime and original completion accessor", () => {
  it("starts once using the original H3 object and replays only its persisted result", async () => {
    const f = fixture(), client = createImportedDesignReviewClient(f.options);
    await client.handle(f.command); await client.handle({ ...f.command, id: "replay" });
    expect(mocks.run).toHaveBeenCalledTimes(1); expect(mocks.run.mock.calls[0]![2]).toBe(f.request.continuation_result);
    expect(mocks.persist).toHaveBeenCalledTimes(1); expect(f.original).toHaveBeenCalledTimes(1);
    expect(f.sent.filter(message => message.kind === "product.source.design-review.result.v1")).toHaveLength(2);
  });
  it("does not reserve or dispatch when H3 has no current-session completion authority", async () => {
    const f = fixture(), client = createImportedDesignReviewClient(f.options); f.original.mockImplementation(() => { throw Error("H3 receipt unavailable"); });
    await expect(client.handle(f.command)).rejects.toThrow("H3 receipt unavailable"); expect(mocks.reserve).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
  });
  it("persists stop before start and never consults H3 on subsequent start/status replay", async () => {
    const f = fixture(), client = createImportedDesignReviewClient(f.options);
    await client.handle({ kind: "command", id: "stop", idempotency_key: "stop", type: "product.source.design-review.stop.v1", payload: f.control });
    await client.handle(f.command);
    await client.handle({ kind: "command", id: "status", idempotency_key: "status", type: "product.source.design-review.status.v1", payload: f.control });
    expect(mocks.persist).toHaveBeenCalledTimes(1); expect(mocks.run).not.toHaveBeenCalled(); expect(f.original).not.toHaveBeenCalled();
    expect(f.sent.at(-1)).toMatchObject({ payload: { outcome: "cancelled_before_start", execution_authorized: false } });
  });
  it("rejects changed request digests and unknown status after restart", async () => {
    const f = fixture(), client = createImportedDesignReviewClient(f.options);
    await client.handle(f.command);
    const status = { kind: "command" as const, id: "status", idempotency_key: "status", type: "product.source.design-review.status.v1" as const, payload: f.control };
    await expect(client.handle({ ...status, payload: { ...f.control, request_digest: sha("changed") } })).rejects.toThrow("original request");
    await expect(createImportedDesignReviewClient(f.options).handle(status)).rejects.toThrow("recovery required");
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });
  it("requires the exact persisted accepted receipt before consulting original H4 completion", async () => {
    const f = fixture(), client = createImportedDesignReviewClient(f.options); await client.handle(f.command);
    const receipt = { kind: "command" as const, id: "receipt", idempotency_key: "receipt", type: "product.source.design-review.receipt.v1" as const,
      payload: f.control, result_digest: sha(canonical(f.result)), status: "accepted" as const };
    await expect(client.handle({ ...receipt, result_digest: sha("other result") })).rejects.toThrow("persisted result");
    expect(() => client.readCompletedAcceptedDesignReview(f.control.review_id, f.control.request_digest)).toThrow("current-session accepted receipt");
    await client.handle(receipt);
    expect(client.readCompletedAcceptedDesignReview(f.control.review_id, f.control.request_digest)).toBe(f.result);
    expect(mocks.readAccepted).toHaveBeenCalledWith(f.options.runtime, f.result);
    expect(Object.keys(client)).toEqual(["handle", "invalidate", "readCompletedAcceptedDesignReview", "settled"]);
    await client.handle({ ...receipt, status: "rejected" });
    expect(() => client.readCompletedAcceptedDesignReview(f.control.review_id, f.control.request_digest)).toThrow("current-session accepted receipt");
    await expect(createImportedDesignReviewClient(f.options).handle(receipt)).rejects.toThrow("Original H4 result");
  });
  it("does not reconstruct accepted H4 authority in a new session or after subject drift", async () => {
    const f = fixture(), client = createImportedDesignReviewClient(f.options); await client.handle(f.command);
    await client.handle({ kind: "command", id: "receipt", idempotency_key: "receipt", type: "product.source.design-review.receipt.v1",
      payload: f.control, result_digest: sha(canonical(f.result)), status: "accepted" });
    expect(() => createImportedDesignReviewClient(f.options).readCompletedAcceptedDesignReview(f.control.review_id, f.control.request_digest)).toThrow("original persisted H4");
    mocks.readAccepted.mockImplementationOnce(() => { throw Error("original measured subject changed"); });
    expect(() => client.readCompletedAcceptedDesignReview(f.control.review_id, f.control.request_digest)).toThrow("original measured subject changed");
    client.invalidate(); expect(() => client.readCompletedAcceptedDesignReview(f.control.review_id, f.control.request_digest)).toThrow("session invalidated");
  });
  it("waits for persisted result before delivery and does not repeat execution after delivery failure", async () => {
    const f = fixture(); let fail = true;
    f.transport.send = vi.fn(async message => { if (message.kind === "product.source.design-review.result.v1" && fail) { fail = false; throw Error("delivery failed"); } f.sent.push(message); });
    const client = createImportedDesignReviewClient(f.options);
    await expect(client.handle(f.command)).rejects.toThrow("delivery failed"); await client.handle({ ...f.command, id: "retry" });
    expect(mocks.run).toHaveBeenCalledTimes(1); expect(mocks.persist).toHaveBeenCalledTimes(1);
  });
  it("aborts its exact running H4 on session invalidation and retains uncertainty", async () => {
    const f = fixture(); mocks.run.mockImplementationOnce((_r, _p, _o, _q, _a, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(Error("current session invalidated")), { once: true });
    }));
    const client = createImportedDesignReviewClient(f.options), pending = client.handle(f.command);
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalled()); client.invalidate(); await pending;
    expect(mocks.persist).toHaveBeenCalledWith(f.options.runtime, expect.anything(), expect.objectContaining({ outcome: "uncertain", closed: false }));
    await expect(client.handle(f.command)).rejects.toThrow("invalidated");
  });
});
