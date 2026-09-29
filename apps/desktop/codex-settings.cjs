const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");

// Local settings only. Never include submitted values in validation errors.
async function validateCodexSettings(input, previous = {}) {
  const raw = input ?? { mode: "default" };
  if (!raw || !["default", "responses"].includes(raw.mode)) throw new Error("Choose a supported Codex connection");
  const text = (value, label) => {
    if (value === undefined || value === "") return undefined;
    if (typeof value !== "string" || value.length > 2000 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`Invalid ${label}`);
    return value.trim() || undefined;
  };
  const binaryPath = text(raw.binaryPath, "Codex program path");
  if (binaryPath) {
    if (!path.isAbsolute(binaryPath)) throw new Error("Choose an absolute Codex program path");
    try {
      if (!(await fs.stat(binaryPath)).isFile()) throw new Error();
      await fs.access(binaryPath, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      if (process.platform === "win32" && !/\.(exe|cmd)$/i.test(binaryPath)) throw new Error();
      if (/\.cmd$/i.test(binaryPath)) {
        const shim = await fs.readFile(binaryPath, "utf8");
        const script = /["']%dp0%[\\/]([^"'\r\n]+\.(?:c?js|mjs))["']/i.exec(shim)?.[1];
        if (!script || !(await fs.stat(path.resolve(path.dirname(binaryPath), script))).isFile()) throw new Error();
      }
    } catch { throw new Error("Codex program is missing, inaccessible, or uses an unsupported launcher"); }
  }
  const model = text(raw.model, "model name");
  const config = { mode: raw.mode, ...(binaryPath ? { binaryPath } : {}), ...(model ? { model } : {}), authMode: "none" };
  if (raw.mode === "default") return { config, keyUpdate: null };
  let url;
  try { url = new URL(text(raw.baseUrl, "model API address")); } catch { throw new Error("Enter a valid model API address"); }
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password || url.search || url.hash) {
    throw new Error("Use HTTPS for the model API, or HTTP on localhost, without credentials, query or fragment");
  }
  if (!model) throw new Error("Enter the model name advertised by your API");
  if (!["none", "api-key"].includes(raw.authMode)) throw new Error("Choose whether the model API requires a key");
  const baseUrl = url.toString().replace(/\/$/, "");
  Object.assign(config, { baseUrl, authMode: raw.authMode });
  if (raw.authMode === "none") return { config, keyUpdate: null };
  const apiKey = text(raw.apiKey, "API key");
  if (apiKey) return { config, keyUpdate: apiKey };
  const preserve = previous.mode === "responses" && previous.authMode === "api-key" && previous.baseUrl === baseUrl && previous.hasKey;
  if (!preserve) throw new Error("Enter an API key for this address, or select No API key");
  return { config, keyUpdate: undefined };
}

module.exports = { validateCodexSettings };
