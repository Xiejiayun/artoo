import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStartPayloadSchema } from "@artoo/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDependencyArtifactInputLoader, takeDependencyArtifactInputs, type DependencyArtifactInputs } from "./dependency-artifact-inputs.js";

const checksum = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const loaders: Array<ReturnType<typeof createDependencyArtifactInputLoader>> = [];
const taken: DependencyArtifactInputs[] = [];
function fixture(bytes = Buffer.from("upstream result")) {
  const runId = randomUUID(), artifactId = randomUUID();
  const session = { namespace: randomUUID(), nodeId: "node", sessionId: randomUUID(), generation: 1, helloNonce: randomUUID() };
  const payload = RunStartPayloadSchema.parse({
    run_id: runId, task_id: "task", agent_instance_id: "instance", runtime: "codex",
    workspace: { root: join(tmpdir(), `artoo-recipient-${runId}`), branch: "work" },
    workspace_allocation: { version: 1, strategy: "per-run", base_path: tmpdir() },
    context_pack: { id: "context", payload: {
      task: { id: "task", title: "Task", description: "", acceptance_criteria: [] },
      project: { id: "project", name: "Project", default_workspace: null },
      workspace: { root: join(tmpdir(), `artoo-recipient-${runId}`), file_scope: [] },
      policy: { filesystem_write_scope: [], requires_approval: [] },
      memory: { task_summary: null, project_notes: [] }, artifacts: { expected: [] },
      dependency_context: { version: 1, truncated: false, entries: [{
        task_id: "upstream-task", title: "Upstream", dependency_type: "blocks", status: "done",
        acceptance_criteria: [], run_id: "source-run", workspace_root: "https://untrusted.invalid/workspace",
        artifacts_truncated: false, artifacts: [{ id: artifactId, run_id: "source-run", type: "file", checksum: checksum(bytes), content_path: "https://untrusted.invalid/secret" }],
      }] },
    } }, policy_snapshot: { filesystem_write_scope: [], requires_approval: [] }, artifact_rules: { paths: [] },
  });
  const loader = createDependencyArtifactInputLoader("wss://paired.example/node?token=private-node-token", "node");
  loaders.push(loader);
  const headers = { "content-type": "application/octet-stream", "content-length": String(bytes.length),
    "x-artoo-checksum": checksum(bytes), "x-artoo-artifact-id": artifactId, "x-artoo-source-run-id": "source-run" };
  return { payload, session, loader, bytes, headers, artifactId };
}
function take(payload: Parameters<typeof takeDependencyArtifactInputs>[0]) {
  const inputs = takeDependencyArtifactInputs(payload);
  if (!inputs) throw new Error("Expected prepared dependency inputs");
  taken.push(inputs); return inputs;
}
function files(inputs: DependencyArtifactInputs): Array<{ path: string; encoding: string }> {
  return JSON.parse(inputs.contextText.slice(inputs.contextText.lastIndexOf("\n[") + 1));
}
afterEach(() => {
  for (const input of taken.splice(0)) input.close();
  for (const loader of loaders.splice(0)) loader.close();
  vi.unstubAllGlobals();
});

describe("paired-node frozen dependency artifact inputs", () => {
  it("uses the same immutable one-use snapshot binding for an explicit Agent review of a still-review source", async () => {
    const f = fixture(Buffer.from("review this exact source result")), context = f.payload.context_pack.payload!;
    const entry = context.dependency_context!.entries[0]!;
    entry.dependency_type = "user_requested_review"; entry.status = "review"; entry.workspace_root = null;
    context.agent_review_subject = { version: 1, review_id: "explicit-review", source_task_id: entry.task_id,
      source_run_id: entry.run_id!, reviewer_agent_id: "different-logical-agent",
      artifacts: entry.artifacts.map(({ id, type, run_id, checksum }) => ({ id, type, run_id: run_id!, checksum: checksum! })) };
    const request = vi.fn(async (_url: URL) => new Response(f.bytes, { headers: f.headers })); vi.stubGlobal("fetch", request);
    await f.loader(f.payload, f.session, new AbortController().signal);
    const changed = structuredClone(f.payload); changed.context_pack.payload!.agent_review_subject!.source_run_id = "other-run";
    expect(() => takeDependencyArtifactInputs(changed)).toThrow("immutable Run payload");
    const inputs = take(f.payload), [file] = files(inputs);
    expect(readFileSync(file!.path)).toEqual(f.bytes);
    expect(String(request.mock.calls[0]![0])).toContain(`/runs/${f.payload.run_id}/dependency-artifacts/${f.artifactId}/content`);
    expect(inputs.contextText).not.toContain("private-node-token");
    expect(takeDependencyArtifactInputs(f.payload)).toBeUndefined();
    expect(f.payload.verification).toBeUndefined(); expect(context.review_subject).toBeUndefined();
    inputs.close(); expect(existsSync(file!.path)).toBe(false);
  });
  it("uses only the fixed paired origin and original session, preserves bytes and consumes once", async () => {
    const f = fixture(Buffer.from([0, 255, 128, 13, 10]));
    const request = vi.fn(async () => new Response(f.bytes, { headers: f.headers }));
    vi.stubGlobal("fetch", request);
    await f.loader(f.payload, f.session, new AbortController().signal);
    const [url, options] = request.mock.calls[0]! as unknown as [URL, RequestInit];
    expect(url.toString()).toBe(`https://paired.example/api/v1/node/runs/${f.payload.run_id}/dependency-artifacts/${f.artifactId}/content`);
    expect(options).toMatchObject({ redirect: "error", cache: "no-store", headers: {
      authorization: "Bearer private-node-token", "x-artoo-session-id": f.session.sessionId,
    } });
    const inputs = take(f.payload), [file] = files(inputs);
    expect(file!.encoding).toBe("binary");
    expect(readFileSync(file!.path)).toEqual(f.bytes);
    expect(inputs.contextText).not.toContain("private-node-token");
    expect(inputs.contextText).not.toContain("untrusted.invalid");
    expect(takeDependencyArtifactInputs(f.payload)).toBeUndefined();
    inputs.close(); expect(existsSync(file!.path)).toBe(false);
  });

  it.each(["x-artoo-checksum", "x-artoo-artifact-id", "x-artoo-source-run-id"])("rejects changed provenance %s before handing inputs to a producer", async (header) => {
    const f = fixture();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(f.bytes, { headers: { ...f.headers, [header]: "different" } })));
    await expect(f.loader(f.payload, f.session, new AbortController().signal)).rejects.toThrow("provenance");
    expect(takeDependencyArtifactInputs(f.payload)).toBeUndefined();
  });

  it("rejects bytes differing from the original frozen checksum", async () => {
    const f = fixture();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(Buffer.from("modified result"), { headers: f.headers })));
    await expect(f.loader(f.payload, f.session, new AbortController().signal)).rejects.toThrow("checksum or length");
  });

  it("binds snapshots to the immutable launch payload and cleans untaken inputs on abort", async () => {
    const f = fixture(), controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(f.bytes, { headers: f.headers })));
    await f.loader(f.payload, f.session, controller.signal);
    expect(() => takeDependencyArtifactInputs({ ...f.payload, task_id: "other" })).toThrow("immutable Run payload");
    controller.abort(new Error("Original generation closed"));
    expect(takeDependencyArtifactInputs(f.payload)).toBeUndefined();
  });

  it("keeps taken inputs alive until the genuine physical owner closes them", async () => {
    const f = fixture(), controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(f.bytes, { headers: f.headers })));
    await f.loader(f.payload, f.session, controller.signal);
    const inputs = take(f.payload), [file] = files(inputs);
    controller.abort(); f.loader.close();
    expect(readFileSync(file!.path)).toEqual(f.bytes);
    expect(() => inputs.assertCurrent()).toThrow();
    inputs.close(); expect(existsSync(file!.path)).toBe(false);
  });

  it("rejects a response exceeding the aggregate bound", async () => {
    const bytes = Buffer.alloc(6 * 1024 * 1024), f = fixture(bytes);
    const entry = f.payload.context_pack.payload!.dependency_context!.entries[0]!;
    const second = { ...entry.artifacts[0]!, id: randomUUID() }; entry.artifacts.push(second);
    vi.stubGlobal("fetch", vi.fn(async (url: URL) => new Response(bytes, { headers: {
      ...f.headers, "x-artoo-artifact-id": url.pathname.includes(second.id) ? second.id : f.artifactId,
    } })));
    await expect(f.loader(f.payload, f.session, new AbortController().signal)).rejects.toThrow("10 MiB aggregate");
  });

  it("rejects the wrong node session and unsafe configured origins without a network request", async () => {
    const f = fixture(), request = vi.fn(); vi.stubGlobal("fetch", request);
    await expect(f.loader(f.payload, { ...f.session, nodeId: "other" }, new AbortController().signal)).rejects.toThrow("original paired node");
    expect(request).not.toHaveBeenCalled();
    expect(() => createDependencyArtifactInputLoader("ws://remote.example/node?token=secret", "node")).toThrow("TLS or loopback");
  });
  it("preserves descriptive legacy dependencies without inventing a source Run or reading content_path", async () => {
    const f = fixture(), request = vi.fn(); vi.stubGlobal("fetch", request);
    f.payload.context_pack.payload!.dependency_context!.entries[0]!.run_id = null;
    await f.loader(f.payload, f.session, new AbortController().signal);
    expect(request).not.toHaveBeenCalled();
    expect(takeDependencyArtifactInputs(f.payload)).toBeUndefined();
  });
});
