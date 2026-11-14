import { createHash } from "node:crypto";

/** Read-only fixture evidence. Count completed, authenticated history reads
 * from one native credential per run; omit peer reads, paging and credentials.
 * HTTP 200 establishes a successful read, never execution/review authority. */
export function observeNativeHistoryReads(server, { origin, agentId, peerToken }) {
  const base = new URL(origin);
  const address = server.address();
  if (
    base.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    !address ||
    typeof address === "string" ||
    !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address.address) ||
    Number(base.port || 80) !== address.port ||
    typeof agentId !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(agentId) ||
    typeof peerToken !== "string" ||
    !peerToken
  ) {
    throw new Error("Native history observation requires its exact local fixture server and agent");
  }
  const prefix = `/api/v1/agents/${agentId}/history/`;
  const peer = `Bearer ${peerToken}`;
  const records = new Map();
  const pending = new Set();
  let stopped = false,
    overflow = false;
  function onRequest(request, response) {
    if (stopped || request.method !== "GET") return;
    let url;
    try {
      url = new URL(request.url, base);
    } catch {
      return;
    }
    const credential = request.headers.authorization;
    if (
      url.origin !== base.origin ||
      !url.pathname.startsWith(prefix) ||
      url.searchParams.has("before") ||
      url.searchParams.getAll("limit").length !== 1 ||
      url.searchParams.get("limit") !== "50" ||
      typeof credential !== "string" ||
      !credential.startsWith("Bearer ") ||
      credential === peer
    )
      return;
    const runId = url.pathname.slice(prefix.length);
    if (!/^[A-Za-z0-9_-]+$/.test(runId)) return;
    const fingerprint = createHash("sha256").update(credential).digest("hex");
    const release = () => {
      response.removeListener("finish", finish);
      response.removeListener("close", release);
      pending.delete(release);
    };
    const finish = () => {
      release();
      if (stopped || response.statusCode !== 200) return;
      const old = records.get(runId);
      if (old && old.fingerprint !== fingerprint) return;
      if (!old && records.size >= 64) {
        overflow = true;
        return;
      }
      records.set(runId, { fingerprint, count: (old?.count ?? 0) + 1 });
    };
    pending.add(release);
    response.once("finish", finish);
    response.once("close", release);
  }
  server.on("request", onRequest);
  return {
    read(runId) {
      if (stopped || overflow) throw new Error("Native history read evidence is unavailable");
      if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error("Invalid history run identity");
      const record = records.get(runId);
      return { run_id: runId, successful_reads: record?.count ?? 0, session_bound: record !== undefined };
    },
    stop() {
      stopped = true;
      server.removeListener("request", onRequest);
      for (const release of [...pending]) release();
      records.clear();
    },
  };
}
