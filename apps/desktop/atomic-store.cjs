const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const { randomUUID } = require("node:crypto");
const path = require("node:path");

async function syncDirectory(directory, options = {}) {
  const filesystem = options.filesystem ?? fs;
  const platform = options.platform ?? process.platform;
  let handle;
  try {
    handle = await filesystem.open(directory, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    await handle.sync();
  } catch (error) {
    // Windows may reject opening or flushing a directory. This exception is
    // permitted only for ordinary connection settings, never managed profiles.
    if (!(options.allowUnsupportedWindowsDirectorySync && platform === "win32"
      && ["EISDIR", "EINVAL", "ENOTSUP", "ENOSYS", "EPERM", "EACCES"].includes(error.code))) throw error;
  } finally {
    if (handle) await handle.close();
  }
}

async function atomicWriteJson(filename, value, options = {}) {
  const filesystem = options.filesystem ?? fs;
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const handle = await filesystem.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value) + "\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await filesystem.rename(temporary, filename);
  await syncDirectory(path.dirname(filename), options);
  // Failed writes deliberately retain uncertain temporary/final bytes. The
  // caller must not publish new state until the entire operation succeeds.
}

module.exports = { atomicWriteJson, syncDirectory };
