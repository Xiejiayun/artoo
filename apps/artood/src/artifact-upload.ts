import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { RunEvent } from "@artoo/protocol";
import { assertRealWorkspaceScope } from "./process-adapter.js";

export type ArtifactUploader = (runId: string, workspaceRoot: string, event: Extract<RunEvent, { type: "artifact.created" }>) => Promise<Extract<RunEvent, { type: "artifact.created" }>>;

export function createArtifactUploader(nodeUrl: string, nodeId: string): ArtifactUploader {
  const base = new URL(nodeUrl);
  const token = base.searchParams.get("token") ?? "";
  base.protocol = base.protocol === "wss:" ? "https:" : "http:";
  base.search = "";
  base.hash = "";
  return async (runId, workspaceRoot, event) => {
    if (!event.payload.uri.startsWith("file:")) return event;
    const localPath = fileURLToPath(event.payload.uri);
    assertRealWorkspaceScope(localPath, [workspaceRoot]);
    if ((await stat(localPath)).size > 10 * 1024 * 1024) throw new Error("artifact exceeds the 10 MiB preview upload limit; workspace retained");
    const bytes = await readFile(localPath);
    const checksum = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const url = new URL(`/api/v1/node/runs/${encodeURIComponent(runId)}/artifacts`, base);
    url.searchParams.set("path", typeof event.payload.metadata.path === "string" ? event.payload.metadata.path : localPath);
    url.searchParams.set("type", event.payload.type);
    const response = await fetch(url, {
      method: "PUT", headers: {
        authorization: `Bearer ${token}`, "content-type": "application/octet-stream",
        "x-artoo-node-id": nodeId, "x-artoo-checksum": checksum,
      }, body: bytes, signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`artifact upload failed (${response.status}); workspace retained`);
    const result = await response.json() as { artifact: { uri: string; checksum: string; metadata: Record<string, unknown> } };
    if (result.artifact.checksum !== checksum || !result.artifact.uri.startsWith("/api/v1/artifacts/")) throw new Error("artifact upload response failed integrity validation");
    return { type: "artifact.created", payload: { ...event.payload, ...result.artifact } };
  };
}
