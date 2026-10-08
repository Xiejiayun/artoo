const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const { createHash, randomUUID } = require("node:crypto");
const path = require("node:path");
const { normalizeServerUrl } = require("./connection-store.cjs");
const { atomicWriteJson, syncDirectory } = require("./atomic-store.cjs");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INCOMPLETE = "Managed workspace preparation is incomplete; its existing files have been retained";
const uuid = (value) => typeof value === "string" && UUID.test(value);

function identitySnapshot(identity) {
  const serverOrigin = normalizeServerUrl(identity?.serverOrigin);
  const nodeId = identity?.nodeId;
  if (typeof nodeId !== "string" || !nodeId || nodeId.length > 512 || !nodeId.isWellFormed() || /[\x00-\x1f\x7f]/u.test(nodeId)) {
    throw new Error("Managed workspace preparation requires a valid enrolled node ID");
  }
  return Object.freeze({ serverOrigin, nodeId });
}

// This is a trusted-main API. It accepts the application's user-data root once;
// no renderer-selected directory, namespace file, or SQLite data is consulted.
function createManagedProfileStore(userDataDirectory, options = {}) {
  const filesystem = options.filesystem ?? fs;
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") throw new Error("Managed workspaces are currently available only on macOS");
  if (typeof userDataDirectory !== "string" || !path.isAbsolute(userDataDirectory)) throw new Error("Managed profiles require an absolute desktop user-data directory");
  const io = { filesystem, platform };
  const failedProfiles = new Map();
  let rootWork;
  let pending = Promise.resolve();
  function serialized(work) {
    const result = pending.then(work);
    pending = result.catch(() => {});
    return result;
  }
  function unavailable(profile, error) {
    if (!failedProfiles.has(profile.key)) failedProfiles.set(profile.key, new Error("Managed profile persistence failed; its files are retained and this profile is unavailable until the app is reopened", { cause: error }));
    return failedProfiles.get(profile.key);
  }
  async function root() {
    if (!rootWork) rootWork = (async () => {
      const canonical = await filesystem.realpath(userDataDirectory);
      const stat = await filesystem.lstat(canonical);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error("Desktop user-data root must be an owned physical directory");
      return canonical;
    })();
    return rootWork;
  }
  async function select(identity) {
    const base = await root();
    const key = createHash("sha256").update(JSON.stringify([identity.serverOrigin, identity.nodeId])).digest("hex");
    const parents = [path.join(base, "managed-profiles"), path.join(base, "managed-profiles", "v1")];
    const directory = path.join(parents[1], key);
    const profile = { ...identity, key, parents, directory, filename: path.join(directory, "profile.json") };
    if (failedProfiles.has(key)) throw failedProfiles.get(key);
    return profile;
  }
  async function privateDirectory(directory) {
    let stat;
    try { stat = await filesystem.lstat(directory); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700
      || await filesystem.realpath(directory) !== directory) throw new Error("Managed profile directory must be owned, physical, and mode 0700");
    return true;
  }
  async function ensureParent(directory) {
    try { await filesystem.mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    if (!(await privateDirectory(directory))) throw new Error("Managed profile parent directory disappeared");
    // Also flush an existing parent: it may have been created by an earlier
    // interrupted preparation which failed before its mkdir became durable.
    await syncDirectory(path.dirname(directory), io);
  }
  function checkedRecord(value, profile) {
    const fields = ["version", "status", "serverOrigin", "nodeId", "controllerScope", "requestId", "journalLeaf"];
    if (value?.status === "ready") fields.push("expectedNamespace");
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length
      || !fields.every((key) => Object.hasOwn(value, key)) || value.version !== 1
      || !["incomplete", "ready"].includes(value.status) || value.serverOrigin !== profile.serverOrigin || value.nodeId !== profile.nodeId
      || !uuid(value.controllerScope) || !uuid(value.requestId) || typeof value.journalLeaf !== "string" || !value.journalLeaf.startsWith("journal-")
      || !uuid(value.journalLeaf.slice(8)) || (value.status === "ready" && !uuid(value.expectedNamespace))) {
      throw new Error("Saved managed profile is invalid; its existing files have been retained");
    }
    return value;
  }
  async function readRecord(profile) {
    for (const directory of [...profile.parents, profile.directory]) if (!(await privateDirectory(directory))) return { exists: false };
    let handle;
    try { handle = await filesystem.open(profile.filename, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (error.code === "ENOENT") return { exists: true }; throw error; }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size > 8192) {
        throw new Error("Saved managed profile must be an owned private single-link file");
      }
      const record = checkedRecord(JSON.parse(await handle.readFile("utf8")), profile);
      if (record.status === "ready") {
        try {
          // Reopening can accept a fully written completion only after its own
          // successful flush. It never reconstructs identity from the journal.
          await handle.sync();
          await syncDirectory(profile.directory, io);
        } catch (error) { throw unavailable(profile, error); }
      }
      return { exists: true, record };
    } finally { await handle.close(); }
  }
  function binding(profile, record) {
    return Object.freeze({ version: 1, serverOrigin: profile.serverOrigin, nodeId: profile.nodeId,
      directory: path.join(profile.directory, record.journalLeaf), controllerScope: record.controllerScope,
      expectedNamespace: record.expectedNamespace });
  }
  async function persist(profile, record) {
    try { await atomicWriteJson(profile.filename, record, io); }
    catch (error) { throw unavailable(profile, error); }
  }
  return Object.freeze({
    async inspect(identity) {
      const selected = identitySnapshot(identity);
      return serialized(async () => {
        const profile = await select(selected);
        const current = await readRecord(profile);
        if (!current.exists) return Object.freeze({ state: "unprepared" });
        if (current.record?.status !== "ready") return Object.freeze({ state: "incomplete" });
        return Object.freeze({ state: "ready", binding: binding(profile, current.record) });
      });
    },
    async beginPreparation(identity) {
      const selected = identitySnapshot(identity);
      return serialized(async () => {
        const profile = await select(selected);
        const current = await readRecord(profile);
        if (current.record?.status === "ready") return Object.freeze({ kind: "existing", binding: binding(profile, current.record) });
        if (current.exists) throw new Error(INCOMPLETE);
        try {
          for (const directory of profile.parents) await ensureParent(directory);
          // Claim once across store instances/processes. An empty claimed
          // directory after a crash is also incomplete and is never replaced.
          await filesystem.mkdir(profile.directory, { mode: 0o700 });
          await syncDirectory(path.dirname(profile.directory), io);
        } catch (error) {
          if (error.code === "EEXIST") throw new Error(INCOMPLETE);
          throw unavailable(profile, error);
        }
        const record = { version: 1, status: "incomplete", ...selected, controllerScope: randomUUID(),
          requestId: randomUUID(), journalLeaf: `journal-${randomUUID()}` };
        await persist(profile, record);
        return Object.freeze({ kind: "prepare", requestId: record.requestId,
          location: Object.freeze({ directory: path.join(profile.directory, record.journalLeaf), controllerScope: record.controllerScope, nodeId: record.nodeId }) });
      });
    },
    // The controller calls this only after an exact provisioned reply AND the
    // owned child's exit 0. The store cannot prove either child event itself.
    async completePreparation(identity, result) {
      const selected = identitySnapshot(identity);
      const requestId = result?.requestId, namespace = result?.namespace;
      if (!uuid(requestId) || !uuid(namespace)) throw new Error("Invalid managed workspace preparation reply");
      return serialized(async () => {
        const profile = await select(selected);
        const current = await readRecord(profile);
        const record = current.record;
        if (!record || record.requestId !== requestId) throw new Error("Managed workspace preparation reply does not match the retained request");
        if (record.status === "ready") {
          if (record.expectedNamespace !== namespace) throw new Error("Completed managed workspace binding is immutable");
          return binding(profile, record);
        }
        try {
          // A permanent, private completion claim prevents two store instances
          // from replacing an already completed binding with different bytes.
          await filesystem.mkdir(path.join(profile.directory, "completion"), { mode: 0o700 });
          await syncDirectory(profile.directory, io);
        } catch (error) {
          if (error.code === "EEXIST") throw new Error(INCOMPLETE);
          throw unavailable(profile, error);
        }
        const completed = { ...record, status: "ready", expectedNamespace: namespace };
        await persist(profile, completed);
        return binding(profile, completed);
      });
    },
  });
}

module.exports = { createManagedProfileStore };
