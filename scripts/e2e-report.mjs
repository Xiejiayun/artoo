import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";
import { release } from "node:os";
import { fileURLToPath } from "node:url";
import { hasCompletePNGPixelStream, MAX_PNG_BYTES } from "./png-evidence.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

// Reports never inspect process.env or retain HTTP headers, cookies or tokens.
// Keep a second boundary here for callers that include diagnostic objects.
export function redact(value, key = "") {
  if (/(?:token|secret|password|authorization|cookie|pairing.?code|api.?key)$/i.test(key)) return "[redacted]";
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  if (typeof value === "string") return value
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/([?&](?:token|code|key|secret|password|api_key|access_token|control_token)=)[^\s&#"']*/gi, "$1[redacted]");
  return value;
}

export function getE2EReportContext() {
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    return result.status === 0 ? result.stdout : null;
  };
  const status = git("status", "--porcelain", "--untracked-files=normal");
  const diff = git("diff", "HEAD", "--binary", "--no-ext-diff", "--no-textconv");
  const untracked = git("ls-files", "--others", "--exclude-standard", "-z");
  const paths = (untracked?.split("\0").filter(Boolean) ?? []).filter((path) => !/(^|\/)(artifacts|node_modules|dist|release|test-results(?:-auth)?|playwright-report|Artoo\.xcodeproj)(\/|$)/.test(path)).sort();
  const digest = createHash("sha256");
  let complete = untracked !== null;
  for (const path of paths) {
    try {
      const file = resolve(root, path);
      const bytes = lstatSync(file).isSymbolicLink() ? Buffer.from(readlinkSync(file)) : readFileSync(file);
      digest.update(path).update("\0").update(createHash("sha256").update(bytes).digest()).update("\0");
    } catch { complete = false; }
  }
  return {
    source: { commit: git("rev-parse", "HEAD")?.trim() ?? null, branch: git("branch", "--show-current")?.trim() ?? null, working_tree_dirty: status === null ? null : status.length > 0,
      tracked_diff_sha256: diff === null ? null : createHash("sha256").update(diff).digest("hex"),
      untracked_source_sha256: complete ? digest.digest("hex") : null, untracked_source_files: paths.length, untracked_source_complete: complete },
    environment: { platform: process.platform, architecture: process.arch, os_release: release(), node: process.version },
  };
}

// Xcode also exports failure screenshots and UI trees, which can contain
// onboarding codes. Only reviewed workflow image names enter shareable HTML.
// Raw xcresult/CI diagnostics inherit their storage/repository access rules.
const nativeCoreImages = [
  "Native real-server thread after foreground catch-up",
  "Native daemon offline after real disconnect grace",
  "Native daemon online after real reconnect",
  "Native suggested plan card before proposal",
  "Native suggested plan with original reply expanded",
  "Native planning instructions summarized before proposal",
  "Native original coordinator instruction expanded",
  "Native proposed plan before human acceptance",
  "Native accepted plan with dependent tasks",
  "Native needs-information approval restored after relaunch",
  "Native approval completed and removed from Inbox",
  "Native goal cancellation requires confirmation",
  "Native goal preserved after dismissing cancellation",
  "Native goal cancelled after explicit confirmation",
  "Native task awaiting execution approval",
  "Native assignment rejected with selection preserved",
  "Native executor options with readable details",
  "Native execution completed with uploaded artifact",
  "Native uploaded execution report in Quick Look",
  "Native task accepted after artifact review",
  "Native member device permissions without pairing inputs",
  "Native member restored after fresh pairing without pairing inputs",
];
const nativeAssistantImages = [
  "Native assistant readable agent selection",
  "Native assistant focused composer with visible controls",
  "Native assistant waiting with draft restored",
  "Native assistant failed request before retry",
  "Native assistant first completed answer",
  "Native assistant follow-up uses the actual first answer",
  "Native assistant linked execution task",
  "Native assistant cancelled with process stopped",
];
const nativeMentionsImages = [
  "Native mentions project A draft before publication",
  "Native mentions global unread across projects",
  "Native mentions historical reply with read failure",
  "Native mentions draft preserved after read retry",
  "Native mentions second historical reply",
  "Native mentions selected project B",
  "Native mentions one unread sentinel remains",
  "Native mentions project A draft restored",
  "Native mentions project B draft restored after relaunch",
];
const nativeCorrectionImages = [
  "Native correction initial artifact details",
  "Native correction initial patch in Quick Look",
  "Native correction feedback after relaunch",
  "Native correction failed run",
  "Native correction retained initial artifact after failure",
  "Native correction ready after explicit Retry",
  "Native correction original and corrected artifacts",
  "Native correction corrected patch in Quick Look",
  "Native correction second feedback",
  "Native correction exact Stop confirmation",
  "Native correction kept running",
  "Native correction cancelled task",
  "Native correction retained first review after Stop",
  "Native correction retained second review after Stop",
  "Native correction retained artifacts after Stop",
  "Native correction completed initial workspace retained",
  "Native correction initial workspace retained after relaunch",
  "Native correction failed workspace retained",
  "Native correction completed corrected workspace retained",
  "Native correction corrected workspace retained after relaunch",
  "Native correction cancelled workspace retained",
];
const nativeRetentionImages = [
  "Native retention task ready before approval",
  "Native retention completed execution",
  "Native retention no uploaded artifacts",
  "Native retention reported recovery details",
  "Native retention exact workspace path and branch",
  "Native retention recovery after cold relaunch",
  "Native retention no artifacts after relaunch",
];
export const nativeReleaseImages = Object.freeze([
  "Native release publisher links before pairing",
  "Native release public privacy website",
  "Native release public support website",
  "Native release publisher links landscape",
]);
const nativeWorkflowImages = [...nativeCoreImages, ...nativeAssistantImages, ...nativeMentionsImages, ...nativeCorrectionImages, ...nativeRetentionImages, ...nativeReleaseImages];
// These XCTest helpers explicitly refuse captures whenever onboarding or
// generated pairing-code controls exist. Retain their controlled failure
// scene for CI diagnosis, without accepting Xcode's automatic failure images
// or counting a diagnostic as a required successful workflow screenshot.
const nativeDiagnosticImages = ["Native assistant guarded failure diagnostics", "Native mentions guarded failure diagnostics", "Native correction guarded failure diagnostics", "Native retention guarded failure diagnostics"];
export function expectedNativeScreenshots(suite) {
  if (suite === "core") return [...nativeCoreImages];
  if (suite === "assistant") return [...nativeAssistantImages];
  if (suite === "mentions") return [...nativeMentionsImages];
  if (suite === "correction") return [...nativeCorrectionImages];
  if (suite === "retention") return [...nativeRetentionImages];
  throw new Error("Native screenshot scope must be core, assistant, mentions, correction or retention");
}
export function readXCTestScreenshots(directory) {
  let manifest, canonicalDirectory;
  try {
    canonicalDirectory = realpathSync(directory);
    manifest = JSON.parse(readFileSync(resolve(directory, "manifest.json"), "utf8"));
  }
  catch { return []; }
  const screenshots = [];
  function visit(value) {
    if (!value || typeof value !== "object") return;
    const name = value.suggestedHumanReadableName ?? value.name;
    const approved = typeof name === "string" && [...nativeWorkflowImages, ...nativeDiagnosticImages].some((title) => name === title || name.startsWith(`${title}_`) || name.startsWith(`${title}.`));
    if (typeof value.exportedFileName === "string" && approved) {
      const path = resolve(directory, value.exportedFileName);
      // Native XCTest exports PNG. Unsupported formats and invalid individual
      // files are omitted so the suite's required-capture gate fails closed,
      // while failure HTML can still retain other complete approved captures.
      if (path.startsWith(`${resolve(directory)}${sep}`) && /\.png$/i.test(path)) {
        try {
          const stat = lstatSync(path);
          if (stat.isFile() && stat.size <= MAX_PNG_BYTES && realpathSync(path).startsWith(`${canonicalDirectory}${sep}`)
              && hasCompletePNGPixelStream(readFileSync(path))) screenshots.push({ path, caption: name });
        } catch { /* Unreadable or replaced captures are not evidence. */ }
      }
    }
    for (const nested of Object.values(value)) {
      if (Array.isArray(nested)) nested.forEach(visit);
      else if (nested && typeof nested === "object") visit(nested);
    }
  }
  if (Array.isArray(manifest)) manifest.forEach(visit); else visit(manifest);
  return screenshots;
}

/** Write a self-contained, offline HTML report. Screenshots are embedded, so
 * later runs cannot change its evidence. Call from finally on success/failure.
 * Capture getE2EReportContext() at test start and spread it into report when
 * exact provenance across a long run matters. Returns the absolute file path.
 */
export function writeE2EReport({ outputPath, title, report, screenshots = [] }) {
  const context = getE2EReportContext();
  const safe = redact({ ...context, ...report });
  const status = safe.passed === true ? "Passed" : safe.finished_at ? "Failed" : "Running";
  const evidence = screenshots.map(({ path, caption }) => {
    try {
      const mime = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" })[extname(path).toLowerCase()];
      if (!mime) throw new Error("Unsupported screenshot format");
      const encoded = readFileSync(path).toString("base64");
      return `<figure><a href="data:${mime};base64,${encoded}" target="_blank" rel="noopener"><img src="data:${mime};base64,${encoded}" alt="${escape(caption)}" loading="lazy"></a><figcaption>${escape(caption)}</figcaption></figure>`;
    } catch {
      return `<p class="warning">Screenshot unavailable: ${escape(caption)}</p>`;
    }
  });
  const checks = (safe.checks ?? []).map((check) => {
    const item = typeof check === "string" ? { name: check, passed: true } : check;
    return `<li><span class="check ${item.passed === true ? "pass" : "fail"}">${item.passed === true ? "PASS" : "FAIL"}</span>${escape(item.name)}${typeof item.duration_ms === "number" ? ` <small>${(item.duration_ms / 1000).toFixed(1)}s</small>` : ""}</li>`;
  }).join("");
  const scope = safe.scope ?? safe.mode ?? safe.suite ?? "See checks for the verified scope.";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'"><title>${escape(title)}</title><style>
:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#f3f5f7;color:#17212b;font:16px/1.6 system-ui,-apple-system,sans-serif}main{max-width:1120px;margin:auto;padding:40px 24px}h1{font-size:clamp(28px,4vw,42px);line-height:1.2;margin:12px 0}h2{margin-top:32px;font-size:22px}.status,.check{display:inline-block;font-weight:700;border-radius:5px;padding:3px 10px;background:#fff}.Passed,.pass{color:#14643b;background:#def4e6}.Failed,.fail,.warning{color:#a32d28;background:#fff0ec}.Running{color:#755400;background:#fff3cb}.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;background:white;border:1px solid #dfe5e9;padding:20px;margin-top:24px;word-break:break-word}.meta strong{display:block;font-size:12px;text-transform:uppercase;color:#596979}ul{list-style:none;padding:0}li{margin:8px 0;padding:12px;background:white}.check{font-size:12px;margin-right:12px}small{color:#596979}figure{margin:20px 0;padding:16px;background:white;border:1px solid #dfe5e9}img{display:block;max-width:100%;max-height:900px;margin:auto;object-fit:contain}figcaption{padding:12px 0 0;color:#455563}.warning{padding:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;background:#e9eef2;padding:20px}footer{font-size:13px;color:#596979;margin-top:28px}</style></head><body><main>
<span class="status ${status}">${status}</span><h1>${escape(title)}</h1><p>${escape(scope)}</p>
${safe.model ? `<p>${escape(safe.model)}</p>` : ""}
<div class="meta"><div><strong>Source commit</strong>${escape(safe.source?.commit ?? "Unavailable")}${safe.source?.working_tree_dirty ? " (working tree changes)" : ""}</div><div><strong>Branch</strong>${escape(safe.source?.branch ?? "Unavailable")}</div><div><strong>Started / finished (UTC)</strong>${escape(safe.started_at ?? "Unavailable")}<br>${escape(safe.finished_at ?? "In progress")}</div><div><strong>Environment</strong>${escape(Object.entries(safe.environment ?? {}).map(([key, value]) => `${key}: ${value}`).join(" · "))}</div></div>
${safe.error ? `<p class="warning">${escape(safe.error)}</p>` : ""}<h2>Checks</h2>${checks ? `<ul>${checks}</ul>` : "<p>No checks completed.</p>"}
<h2>Screenshot evidence</h2>${safe.diagnostics_scope ? `<p>${escape(safe.diagnostics_scope)}</p>` : ""}${evidence.length ? evidence.join("\n") : "<p>No approved screenshots were captured before this run ended. This report does not claim visual verification.</p>"}
<details><summary>Structured result</summary><pre>${escape(JSON.stringify(safe, null, 2))}</pre></details><footer>Generated ${escape(new Date().toISOString())}. Results apply only to the scope and source above. Screenshots are embedded in this file.</footer>
</main></body></html>`;
  const destination = resolve(outputPath);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, html);
  return destination;
}
