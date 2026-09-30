const MAX_CLAIM_BYTES = 64 * 1024;

/** Test-fixture observation of the existing HTTP claim response. It never
 * changes a product route or exposes the credential through its public API.
 * Only private byte copies are wiped; temporary JavaScript strings are released
 * for garbage collection, not claimed to be securely erased. */
export function observeMemberClaim(server, { origin, displayName, memberUserId }) {
  let base;
  try { base = new URL(origin); } catch { throw new Error("Member claim observation requires the local fixture origin"); }
  const address = server.address();
  if (!["http:", "https:"].includes(base.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
      || base.username || base.password || base.pathname !== "/" || base.search || base.hash
      || !address || typeof address === "string" || Number(base.port || (base.protocol === "http:" ? 80 : 443)) !== address.port) {
    throw new Error("Member claim observation requires the local fixture origin");
  }
  let credential;
  let captureFailure;
  let stopped = false;
  const pending = new Set();
  const clearCredential = () => { credential?.secret.fill(0); credential = undefined; };
  const stop = () => {
    stopped = true;
    server.removeListener("request", onRequest);
    for (const release of [...pending]) release();
    clearCredential();
  };

  function onRequest(request, response) {
    if (stopped || request.method !== "POST" || request.url?.split("?")[0] !== "/api/v1/devices/claim") return;
    const originalWrite = response.write, originalEnd = response.end;
    const chunks = [];
    let total = 0, discarded = false, released = false;
    const clearChunks = () => { for (const chunk of chunks) chunk.fill(0); chunks.length = 0; };
    const copyChunk = (chunk, encoding) => {
      if (discarded || released || (typeof chunk !== "string" && !(chunk instanceof Uint8Array))) return;
      try {
        const size = typeof chunk === "string" ? Buffer.byteLength(chunk, encoding) : chunk.byteLength;
        if (size > MAX_CLAIM_BYTES - total) { discarded = true; clearChunks(); return; }
        // Buffer.from(Uint8Array) copies; never share the product's ArrayBuffer.
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk, encoding) : Buffer.from(chunk));
        total += size;
      } catch { discarded = true; clearChunks(); }
    };
    const write = function (...args) {
      copyChunk(args[0], typeof args[1] === "string" ? args[1] : undefined);
      try { return Reflect.apply(originalWrite, this, args); } catch (error) { release(); throw error; }
    };
    const end = function (...args) {
      copyChunk(args[0], typeof args[1] === "string" ? args[1] : undefined);
      try { return Reflect.apply(originalEnd, this, args); } catch (error) { release(); throw error; }
    };
    const release = () => {
      if (released) return;
      released = true; clearChunks(); pending.delete(release);
      response.removeListener("finish", finish); response.removeListener("close", release);
      if (response.write === write) response.write = originalWrite;
      if (response.end === end) response.end = originalEnd;
    };
    const finish = () => {
      let bytes;
      try {
        if (stopped || discarded || response.statusCode < 200 || response.statusCode >= 300) return;
        // writeHead(status, headers) does not always expose its headers through
        // getHeader(). Validate the actual JSON body of this exact route.
        bytes = Buffer.concat(chunks);
        const value = JSON.parse(bytes.toString("utf8"));
        const device = value?.device;
        if (device?.display_name !== displayName || device?.enrolled_by_user_id !== memberUserId
            || device?.platform !== "ios" || device?.computer_id !== null) return;
        if (credential) { captureFailure = "Matching native member claims are ambiguous"; stop(); return; }
        if (typeof device.id !== "string" || !device.id || typeof value.control_token !== "string" || !value.control_token) return;
        credential = { deviceId: device.id, secret: Buffer.from(value.control_token), activeVerified: false };
      } catch {
        // JSON parse errors can contain raw response snippets. Never emit them
        // or interfere with delivery of the original product response.
      } finally { bytes?.fill(0); release(); }
    };
    pending.add(release);
    response.once("finish", finish); response.once("close", release);
    response.write = write; response.end = end;
  }
  server.prependListener("request", onRequest);

  const selected = (deviceId) => {
    if (captureFailure) throw new Error(captureFailure);
    if (!credential) throw new Error("No matching native member credential was observed");
    if (credential.deviceId !== deviceId) throw new Error("Observed native credential does not match the selected phone");
    return credential;
  };
  const session = async (current, readIdentity) => {
    try {
      const response = await fetch(new URL("/auth/session", base), {
        method: "GET", headers: { Authorization: `Bearer ${current.secret.toString("utf8")}` },
        credentials: "omit", redirect: "error", signal: AbortSignal.timeout(15_000),
      });
      if (readIdentity && response.status === 200) return { status: response.status, identity: await response.json() };
      await response.body?.cancel();
      return { status: response.status };
    } catch { throw new Error("Native member credential session check failed"); }
  };
  return Object.freeze({
    async verifyActive(deviceId) {
      try {
        const current = selected(deviceId);
        const result = await session(current, true);
        if (selected(deviceId) !== current) throw new Error("Observed native credential changed during its session check");
        if (result.status !== 200) throw new Error(`Native member credential expected HTTP 200 before revocation; received HTTP ${result.status}`);
        if (result.identity?.device_id !== deviceId || result.identity?.user?.id !== memberUserId || result.identity?.user?.role !== "member") {
          throw new Error("Native credential must identify the same member and device before revocation");
        }
        current.activeVerified = true;
        return { device_id: deviceId, member_user_id: memberUserId, status: 200 };
      } catch (error) {
        // An absent claim can still arrive later; a failed proof of a captured
        // credential must release it and cannot be retried under another token.
        if (credential) stop();
        throw error;
      }
    },
    async verifyRevoked(deviceId) {
      try {
        const current = selected(deviceId);
        if (!current.activeVerified) throw new Error("Native credential requires a successful active-session check before revocation");
        const result = await session(current, false);
        if (selected(deviceId) !== current) throw new Error("Observed native credential changed during its session check");
        if (result.status !== 401) throw new Error(`Revoked native credential must receive HTTP 401; received HTTP ${result.status}`);
        return { device_id: deviceId, status: 401 };
      } finally { stop(); }
    },
    stop,
  });
}
