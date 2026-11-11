import { artifacts } from "@artoo/db";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blobChecksum } from "./content-addressed-blob.js";
import { MemoryArtifactStore } from "./test-fixtures/memory-artifact-store.js";
import { buildTestServer, type TestServer } from "./test-support.js";

describe("artifact routes with injected durable object storage", () => {
  let server: TestServer | undefined;
  afterEach(async () => { vi.restoreAllMocks(); await server?.close(); server = undefined; });

  async function prepare(store: MemoryArtifactStore) {
    server = await buildTestServer({ artifactStore: store });
    const created = await server.app.inject({ method: "POST", url: "/api/v1/tasks", payload: {
      project_id: "proj_artoo", title: "Retain uploaded bytes", acceptance_criteria: ["downloadable"], required_capabilities: ["code.modify"],
    } });
    expect(created.statusCode).toBe(201);
    const taskId = created.json().task.id as string;
    await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/ready` });
    const assigned = await server.app.inject({ method: "POST", url: `/api/v1/tasks/${taskId}/assign`, payload: { mode: "auto", write_paths: ["src/**"] } });
    expect(assigned.statusCode).toBe(200);
    const runId = assigned.json().run.id as string, bytes = Buffer.from("retained patch bytes");
    const upload = () => server!.app.inject({ method: "PUT", url: `/api/v1/node/runs/${runId}/artifacts?type=patch&path=changes.patch`,
      headers: { authorization: "Bearer dev", "x-artoo-node-id": "computer_local_mock", "content-type": "application/octet-stream",
        "x-artoo-checksum": blobChecksum(bytes) }, payload: bytes });
    return { runId, bytes, upload };
  }

  it("uploads and downloads through the configured store without a local artifact directory", async () => {
    const store = new MemoryArtifactStore(), f = await prepare(store);
    expect(server!.ctx.productSourceArtifactDir).toBeUndefined();
    expect(server!.ctx.artifactStore).toBe(store);
    const response = await f.upload();
    expect(response.statusCode).toBe(201);
    const download = await server!.app.inject({ method: "GET", url: response.json().artifact.uri });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload).toEqual(f.bytes);
    expect(download.headers["cache-control"]).toBe("private, no-store");
    expect(store.writes).toEqual([blobChecksum(f.bytes)]);
    expect(store.reads).toEqual([blobChecksum(f.bytes)]);
  });

  it("does not persist available artifact metadata when the object upload fails", async () => {
    const store = new MemoryArtifactStore(), f = await prepare(store);
    vi.spyOn(store, "write").mockRejectedValue(new Error("Object store unavailable"));
    expect((await f.upload()).statusCode).toBe(500);
    expect(await server!.db.db.select().from(artifacts).where(eq(artifacts.runId, f.runId))).toEqual([]);
  });

  it("distinguishes missing content from storage failures and rejects corrupted retained bytes", async () => {
    const store = new MemoryArtifactStore(), f = await prepare(store);
    const uploaded = await f.upload(), uri = uploaded.json().artifact.uri as string;
    store.objects.clear();
    expect((await server!.app.inject({ method: "GET", url: uri })).statusCode).toBe(404);
    store.objects.set(blobChecksum(f.bytes), Buffer.alloc(f.bytes.length, 0));
    expect((await server!.app.inject({ method: "GET", url: uri })).statusCode).toBe(500);
    vi.spyOn(store, "read").mockRejectedValue(new Error("Object store access denied"));
    expect((await server!.app.inject({ method: "GET", url: uri })).statusCode).toBe(500);
  });
});
