import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { StaticWebAcceptanceReportSchema, BrowserOperationTraceV2Schema, BrowserOperationTraceV3Schema, MAX_BROWSER_OPERATION_TRACE_BYTES,
  storageFaultReportFromTraceV1, storagePreconditionReportFromTraceV1, type StaticWebAcceptanceReport, type StorageFaultModeV1, type StorageFaultBaselinePhaseV1,
  type BrowserOperationV2, type BrowserOperationTraceV2, type BrowserOperationV3, type BrowserOperationTraceV3, type BrowserCaptureTimingV3 } from "@artoo/domain";
import type { ExpectedStoragePreconditionV1 } from "./web-acceptance-precondition.js";

const MAX_JSON = 1024 * 1024, MAX_IMAGE = 4 * MAX_JSON, MAX_BUNDLE = 64 * MAX_JSON, MAX_TRACE = MAX_BROWSER_OPERATION_TRACE_BYTES;
export const MAX_BROWSER_EVIDENCE_PAGE_BYTES = 16 * 1024;
const sha = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const inside = (path: string, root: string) => { const tail = relative(root, path); return tail === "" || (tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail)); };
const opaque = /^[A-Za-z0-9_-]{1,160}$/;
export interface BrowserEvidenceBinding {
  requestId: string; profileId: string; profileDigest: string; subjectDigest: string; checkId: string; scope: "preview" | "final";
}
interface Entry { reference: string; filename: string; checksum: string; size: number; case_id: string; viewport: number }
type ReportV1 = Extract<StaticWebAcceptanceReport, { version: 1 }>;
type ReportV2 = Extract<StaticWebAcceptanceReport, { version: 2 }>;
type ReportV3 = Extract<StaticWebAcceptanceReport, { version: 3 }>;
interface Manifest { version: 1; binding: BrowserEvidenceBinding; report: ReportV1; report_checksum: string; entries: Entry[] }
interface EntryV2 { kind: "trace" | "image"; reference: string; filename: string; checksum: string; size: number;
  case_id: string; viewport: { id: string; width: number; height: number }; page_id?: "main" }
interface ManifestV2 { version: 2; binding: BrowserEvidenceBinding; report: ReportV2; report_checksum: string; entries: EntryV2[] }
type EntryV3 = { reference: string; filename: string; checksum: string; size: number;
  case_id: string; viewport: { id: string; width: number; height: number } }
  & ({ kind: "trace" } | { kind: "image"; page_id: string; timing: BrowserCaptureTimingV3 });
interface ManifestV3 { version: 3; binding: BrowserEvidenceBinding; report: ReportV3; report_checksum: string; entries: EntryV3[] }
export interface BrowserEvidenceBundle { bundle_id: string; manifest_digest: string }
export interface BrowserEvidenceGrant extends BrowserEvidenceBinding, BrowserEvidenceBundle { evidenceRoot: string }
export interface BrowserEvidenceReadOptions { offset?: number; limit?: number; expected_checksum?: string }
export interface ExpectedBrowserProgramV2 {
  case_id: string;
  viewport: { id: string; width: number; height: number };
  program_digest: string;
  steps: { index: number; action: BrowserOperationV2["action"]; page_id: "main"; planned_step_digest: string;
    expected_observation: { kind: "navigation" } | Exclude<BrowserOperationV2["observation"], { kind: "navigation" }> }[];
  captures: { page_id: "main" }[];
}
export interface ExpectedBrowserProgramV3 {
  case_id: string;
  viewport: { id: string; width: number; height: number };
  program_digest: string;
  steps: { index: number; action: BrowserOperationV3["action"]; page_id: string; planned_step_digest: string;
    expected_observation: { kind: "navigation" | "page-opened" }
      | Exclude<BrowserOperationV3["observation"], { kind: "navigation" | "page-opened" }> }[];
  captures: { page_id: string; timing: BrowserCaptureTimingV3 }[];
  storage_precondition?: ExpectedStoragePreconditionV1;
  storage_fault?: {
    version: 1; checks_digest: string; installation_script_digest: string;
    windows: {
      id: string; page_id: "main"; mode: StorageFaultModeV1; arm_before_step: number; settle_after_step: number;
      start_step_digest: string; end_step_digest: string;
      requirement_criteria: { requirement_id: string; criterion_index: number }[]; ui_assertion_steps: number[];
      min_hits: 1; native_storage: { scope: "all"; comparison: "sampled-equal" };
      baseline_phase: StorageFaultBaselinePhaseV1; document_epoch: number;
    }[];
  };
}
export interface SealedBrowserEvidenceV1 extends BrowserEvidenceBundle {
  case_refs: { case_id: string; viewport: number; screenshot_ref: string }[];
}
export interface SealedBrowserEvidenceV2 extends BrowserEvidenceBundle {
  version: 2;
  case_refs: { case_id: string; viewport_id: string; trace_ref: string; captures: { page_id: "main"; screenshot_ref: string }[] }[];
}
export interface SealedBrowserEvidenceV3 extends BrowserEvidenceBundle {
  version: 3;
  case_refs: { case_id: string; viewport_id: string; trace_ref: string; captures: { page_id: string; screenshot_ref: string }[] }[];
}
export const browserTraceV2Filename = (caseId: string, viewportId: string): string => `trace-${sha(JSON.stringify([caseId, viewportId])).slice(7)}.json`;
export const browserCaptureV2Filename = (caseId: string, viewportId: string, pageId = "main"): string => `capture-${sha(JSON.stringify([caseId, viewportId, pageId])).slice(7)}.png`;
export const browserTraceV3Filename = (caseId: string, viewportId: string): string => `trace-${sha(JSON.stringify([3, caseId, viewportId])).slice(7)}.json`;
export const browserCaptureV3Filename = (caseId: string, viewportId: string, pageId: string): string => `capture-${sha(JSON.stringify([3, caseId, viewportId, pageId])).slice(7)}.png`;
export type BrowserEvidenceContent = { reference: string; provenance: BrowserEvidenceBinding & BrowserEvidenceBundle;
  mime_type: "application/json"; text: string; checksum?: string; size?: number; offset?: number; next_offset?: number | null; eof?: boolean } | { reference: string; provenance: BrowserEvidenceBinding & BrowserEvidenceBundle;
  mime_type: "image/png"; data: string; checksum: string; size: number; case_id: string;
  viewport: number | { id: string; width: number; height: number }; page_id?: string; timing?: BrowserCaptureTimingV3 };

export function validateBrowserEvidenceRoot(root: string, workspaceRoots: readonly string[]): string {
  if (!isAbsolute(root)) throw new Error("Browser evidence root must be absolute");
  const physical = realpathSync.native(root), stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || physical !== root) throw new Error("Browser evidence root must be a physical directory");
  if (workspaceRoots.some((workspace) => { const path = realpathSync.native(workspace); return inside(physical, path) || inside(path, physical); })) {
    throw new Error("Browser evidence must be outside every coding workspace");
  }
  return physical;
}
function directory(root: string, requestId: string): string {
  validateBrowserEvidenceRoot(root, []);
  const path = join(root, sha(requestId).slice(7)), stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(path) !== path) throw new Error("Invalid browser evidence request directory");
  return path;
}
function readRegular(path: string, maximum: number): Buffer {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size <= 0 || before.size > maximum) throw new Error("Invalid bounded browser evidence file");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd), buffer = Buffer.alloc(maximum + 1); let length = 0;
    while (length < buffer.length) { const count = readSync(fd, buffer, length, buffer.length - length, length); if (!count) break; length += count; }
    const bytes = buffer.subarray(0, length), after = fstatSync(fd), named = lstatSync(path);
    // Metadata-only ctime changes from Windows scanners do not change the pinned bytes.
    // Every caller also checks these bytes against a protected report or manifest digest.
    if ([opened, after, named].some((value) => !value.isFile() || value.nlink !== 1 || value.dev !== before.dev || value.ino !== before.ino
      || value.size !== before.size || value.mtimeMs !== before.mtimeMs) || bytes.length !== before.size || bytes.length > maximum) {
      throw new Error("Browser evidence changed while reading");
    }
    return bytes;
  } finally { closeSync(fd); }
}
function pngDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString("ascii", 12, 16) !== "IHDR") throw new Error("Expected a PNG browser screenshot");
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > 8192 || height > 32768 || width * height > 32_000_000) throw new Error("Browser screenshot dimensions exceed limits");
  return { width, height };
}
const png = (bytes: Buffer) => pngDimensions(bytes).width;
const manifestName = (checkId: string) => `sealed-${sha(checkId).slice(7)}.json`;
function readOptions(options: BrowserEvidenceReadOptions | undefined): BrowserEvidenceReadOptions {
  if (options === undefined) return {};
  if (!options || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).some(key => !["offset", "limit", "expected_checksum"].includes(key))
    || (options.offset !== undefined && (!Number.isInteger(options.offset) || options.offset < 0 || options.offset > MAX_JSON))
    || (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 4 || options.limit > MAX_BROWSER_EVIDENCE_PAGE_BYTES))
    || (options.expected_checksum !== undefined && (typeof options.expected_checksum !== "string" || !/^sha256:[a-f0-9]{64}$/.test(options.expected_checksum)))) throw new Error("Invalid browser evidence pagination");
  return options;
}
function jsonEvidence(reference: string, provenance: BrowserEvidenceBinding & BrowserEvidenceBundle, text: string,
  options: BrowserEvidenceReadOptions): BrowserEvidenceContent {
  const bytes = Buffer.from(text, "utf8"), checksum = sha(bytes);
  if (options.expected_checksum !== undefined && options.expected_checksum !== checksum) throw new Error("Browser evidence checksum changed between pages");
  if (options.offset === undefined && options.limit === undefined) return { reference, provenance, mime_type: "application/json", text };
  const offset = options.offset ?? 0;
  if (offset > 0 && options.expected_checksum === undefined) throw new Error("A nonzero evidence offset requires expected_checksum");
  if (offset > bytes.length) throw new Error("Evidence offset is beyond the end of the JSON");
  if (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) throw new Error("Evidence offset must be a UTF-8 character boundary");
  let end = Math.min(bytes.length, offset + (options.limit ?? MAX_BROWSER_EVIDENCE_PAGE_BYTES));
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  const eof = end === bytes.length;
  return { reference, provenance, mime_type: "application/json", text: bytes.subarray(offset, end).toString("utf8"), checksum,
    size: bytes.length, offset, next_offset: eof ? null : end, eof };
}
/** Called only after real verifier closure and successful source/profile revalidation. */
export function sealBrowserEvidence(input: BrowserEvidenceBinding & { evidenceRoot: string; report: ReportV1 }): SealedBrowserEvidenceV1;
export function sealBrowserEvidence(input: BrowserEvidenceBinding & { evidenceRoot: string; report: ReportV2; expectedPrograms: readonly ExpectedBrowserProgramV2[] }): SealedBrowserEvidenceV2;
export function sealBrowserEvidence(input: BrowserEvidenceBinding & { evidenceRoot: string; report: ReportV3; expectedPrograms: readonly ExpectedBrowserProgramV3[] }): SealedBrowserEvidenceV3;
export function sealBrowserEvidence(input: BrowserEvidenceBinding & { evidenceRoot: string; report: StaticWebAcceptanceReport; expectedPrograms?: readonly ExpectedBrowserProgramV2[] | readonly ExpectedBrowserProgramV3[] }): SealedBrowserEvidenceV1 | SealedBrowserEvidenceV2 | SealedBrowserEvidenceV3;
export function sealBrowserEvidence(input: BrowserEvidenceBinding & { evidenceRoot: string; report: StaticWebAcceptanceReport; expectedPrograms?: readonly ExpectedBrowserProgramV2[] | readonly ExpectedBrowserProgramV3[] }): SealedBrowserEvidenceV1 | SealedBrowserEvidenceV2 | SealedBrowserEvidenceV3 {
  const { expectedPrograms, ...base } = input;
  // Each branch validates the exact expected capture/step shape against its strict report and trace.
  if (input.report.version === 3) return sealV3({ ...base, report: input.report }, expectedPrograms as readonly ExpectedBrowserProgramV3[] | undefined);
  if (input.report.version === 2) return sealV2({ ...base, report: input.report }, expectedPrograms as readonly ExpectedBrowserProgramV2[] | undefined);
  if (expectedPrograms !== undefined) throw new Error("Legacy browser evidence cannot adopt a version-2 plan");
  return sealV1({ ...base, report: input.report });
}
function sealV1(input: BrowserEvidenceBinding & { evidenceRoot: string; report: ReportV1 }): SealedBrowserEvidenceV1 {
  const { evidenceRoot, report: rawReport, ...binding } = input;
  const report = StaticWebAcceptanceReportSchema.parse(rawReport), root = directory(evidenceRoot, binding.requestId);
  if (report.version !== 1) throw new Error("Expected legacy browser report");
  const reportBytes = readRegular(join(root, "result.json"), MAX_JSON);
  if (!isDeepStrictEqual(JSON.parse(reportBytes.toString("utf8")), report)) throw new Error("Stored browser report differs from the measured output");
  let total = reportBytes.length;
  const entries = report.cases.map((item): Entry => {
    const filename = `${item.case_id}-${item.viewport}.png`, bytes = readRegular(join(root, filename), MAX_IMAGE);
    if (png(bytes) !== item.viewport) throw new Error("Browser screenshot width differs from the measured viewport");
    if ((total += bytes.length) > MAX_BUNDLE || sha(bytes) !== item.screenshot_digest) throw new Error("Browser screenshot integrity or bundle limit failed");
    return { reference: `image_${sha(`${binding.requestId}\0${binding.checkId}\0${item.case_id}\0${item.viewport}`).slice(7)}`,
      filename, checksum: item.screenshot_digest, size: bytes.length, case_id: item.case_id, viewport: item.viewport };
  });
  const manifest: Manifest = { version: 1, binding, report, report_checksum: sha(reportBytes), entries };
  const digest = writeManifest(root, binding.checkId, manifest);
  return { bundle_id: `browser_${digest.slice(7)}`, manifest_digest: digest,
    case_refs: entries.map(({ case_id, viewport, reference }) => ({ case_id, viewport, screenshot_ref: reference })) };
}
function writeManifest(root: string, checkId: string, manifest: Manifest | ManifestV2 | ManifestV3): string {
  const bytes = Buffer.from(JSON.stringify(manifest));
  if (bytes.length > MAX_JSON) throw new Error("Browser evidence manifest exceeds size limit");
  const path = join(root, manifestName(checkId));
  const fd = openSync(path, "wx", 0o400);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  if (process.platform !== "win32") { const dir = openSync(root, "r"); try { fsyncSync(dir); } finally { closeSync(dir); } }
  return sha(bytes);
}

const caseKey = (caseId: string, viewportId: string) => JSON.stringify([caseId, viewportId]);
function v2Reference(kind: "trace" | "image", binding: BrowserEvidenceBinding, caseId: string, viewportId: string, pageId?: string): string {
  return `${kind}_${sha(JSON.stringify([2, binding.requestId, binding.profileId, binding.profileDigest, binding.subjectDigest,
    binding.checkId, binding.scope, caseId, viewportId, ...(pageId === undefined ? [] : [pageId])])).slice(7)}`;
}
function traceForCase(bytes: Buffer, item: ReportV2["cases"][number]): BrowserOperationTraceV2 {
  if (bytes.length !== item.trace_size || sha(bytes) !== item.trace_digest) throw new Error("Browser trace integrity differs from the measured report");
  const trace = BrowserOperationTraceV2Schema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  if (trace.case_id !== item.case_id || trace.page_id !== "main" || !isDeepStrictEqual(trace.viewport, item.viewport)
    || trace.device_scale_factor !== 1 || trace.program_digest !== item.program_digest
    || trace.operations.length !== item.operation_count
    || trace.operations.filter(operation => operation.action.startsWith("assert_")).length !== item.assertions) {
    throw new Error("Browser trace case, viewport, program or measured counts differ");
  }
  return trace;
}
function assertExpectedTrace(trace: BrowserOperationTraceV2, expected: ExpectedBrowserProgramV2): void {
  if (trace.program_digest !== expected.program_digest || trace.case_id !== expected.case_id || !isDeepStrictEqual(trace.viewport, expected.viewport)
    || trace.operations.length !== expected.steps.length) throw new Error("Browser trace differs from the independently derived program");
  for (let index = 0; index < expected.steps.length; index++) {
    const planned = expected.steps[index]!, operation = trace.operations[index]!;
    if (planned.index !== index || operation.index !== index || operation.action !== planned.action || operation.page_id !== planned.page_id
      || planned.page_id !== "main" || operation.planned_step_digest !== planned.planned_step_digest) throw new Error("Browser trace steps are missing, reordered or substituted");
    if (planned.expected_observation.kind === "navigation") {
      if (operation.observation.kind !== "navigation") throw new Error("Browser trace observation differs from the planned action");
    } else if (!isDeepStrictEqual(operation.observation, planned.expected_observation)) throw new Error("Browser trace observation differs from the planned action");
  }
}
function sealV2(input: BrowserEvidenceBinding & { evidenceRoot: string; report: ReportV2 }, expectedPrograms: readonly ExpectedBrowserProgramV2[] | undefined): SealedBrowserEvidenceV2 {
  const { evidenceRoot, report: rawReport, ...binding } = input;
  const report = StaticWebAcceptanceReportSchema.parse(rawReport);
  if (report.version !== 2 || report.capability_binding.profile_digest !== binding.profileDigest || report.capability_binding.command_id !== binding.checkId) {
    throw new Error("Version-2 browser report differs from the protected command binding");
  }
  if (!Array.isArray(expectedPrograms) || expectedPrograms.length > 400 || expectedPrograms.length !== report.cases.length) {
    throw new Error("Version-2 browser evidence requires the complete independently derived program set");
  }
  const expected = new Map(expectedPrograms.map(program => [caseKey(program.case_id, program.viewport.id), program]));
  if (expected.size !== expectedPrograms.length) throw new Error("Duplicate independently derived browser program");
  const root = directory(evidenceRoot, binding.requestId), reportBytes = readRegular(join(root, "result.json"), MAX_JSON);
  if (!isDeepStrictEqual(JSON.parse(reportBytes.toString("utf8")), report)) throw new Error("Stored browser report differs from the measured output");
  let total = reportBytes.length;
  const entries: EntryV2[] = [], case_refs: SealedBrowserEvidenceV2["case_refs"] = [];
  for (const item of report.cases) {
    const planned = expected.get(caseKey(item.case_id, item.viewport.id));
    if (!planned || !isDeepStrictEqual(planned.viewport, item.viewport) || planned.program_digest !== item.program_digest
      || !isDeepStrictEqual(item.captures.map(({ page_id }) => ({ page_id })), planned.captures)) throw new Error("Browser report differs from the expected case, viewport, program or pages");
    const filename = browserTraceV2Filename(item.case_id, item.viewport.id), bytes = readRegular(join(root, filename), MAX_TRACE);
    const trace = traceForCase(bytes, item); assertExpectedTrace(trace, planned);
    if ((total += bytes.length) > MAX_BUNDLE) throw new Error("Browser evidence exceeds the bundle limit");
    const traceRef = v2Reference("trace", binding, item.case_id, item.viewport.id);
    entries.push({ kind: "trace", reference: traceRef, filename, checksum: item.trace_digest, size: bytes.length,
      case_id: item.case_id, viewport: { ...item.viewport } });
    const captures: SealedBrowserEvidenceV2["case_refs"][number]["captures"] = [];
    for (const capture of item.captures) {
      const filename = browserCaptureV2Filename(item.case_id, item.viewport.id, capture.page_id), bytes = readRegular(join(root, filename), MAX_IMAGE);
      const dimensions = pngDimensions(bytes);
      if (dimensions.width !== item.viewport.width || dimensions.height !== item.viewport.height) throw new Error("Browser screenshot width or height differs from the measured viewport");
      if ((total += bytes.length) > MAX_BUNDLE || sha(bytes) !== capture.screenshot_digest) throw new Error("Browser screenshot integrity or bundle limit failed");
      const reference = v2Reference("image", binding, item.case_id, item.viewport.id, capture.page_id);
      entries.push({ kind: "image", reference, filename, checksum: capture.screenshot_digest, size: bytes.length,
        case_id: item.case_id, viewport: { ...item.viewport }, page_id: capture.page_id });
      captures.push({ page_id: capture.page_id, screenshot_ref: reference });
    }
    case_refs.push({ case_id: item.case_id, viewport_id: item.viewport.id, trace_ref: traceRef, captures });
  }
  const manifest: ManifestV2 = { version: 2, binding, report, report_checksum: sha(reportBytes), entries };
  const digest = writeManifest(root, binding.checkId, manifest);
  return { version: 2, bundle_id: `browser_${digest.slice(7)}`, manifest_digest: digest, case_refs };
}

function v3Reference(kind: "trace" | "image", binding: BrowserEvidenceBinding, caseId: string, viewportId: string, pageId?: string): string {
  return `${kind}_${sha(JSON.stringify([3, binding.requestId, binding.profileId, binding.profileDigest, binding.subjectDigest,
    binding.checkId, binding.scope, caseId, viewportId, ...(pageId === undefined ? [] : [pageId])])).slice(7)}`;
}
function traceForCaseV3(bytes: Buffer, item: ReportV3["cases"][number]): BrowserOperationTraceV3 {
  if (bytes.length !== item.trace_size || sha(bytes) !== item.trace_digest) throw new Error("Browser trace integrity differs from the measured report");
  // The strict v3 trace also validates the full page lifetime and capture/close positions.
  const trace = BrowserOperationTraceV3Schema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  if (trace.case_id !== item.case_id || !isDeepStrictEqual(trace.viewport, item.viewport)
    || trace.device_scale_factor !== 1 || trace.program_digest !== item.program_digest
    || trace.operations.length !== item.operation_count
    || trace.operations.filter(operation => operation.action.startsWith("assert_")).length !== item.assertions
    || !isDeepStrictEqual(trace.captures, item.captures)) {
    throw new Error("Browser trace case, viewport, program, captures or measured counts differ");
  }
  const storageReport = trace.storage_fault === undefined ? undefined : storageFaultReportFromTraceV1(trace.storage_fault);
  if (!isDeepStrictEqual(storageReport, item.storage_fault)) throw new Error("Browser storage fault report differs from the actual trace projection");
  const preconditionReport = trace.storage_precondition === undefined ? undefined : storagePreconditionReportFromTraceV1(trace.storage_precondition);
  if (!isDeepStrictEqual(preconditionReport, item.storage_precondition)) throw new Error("Browser storage precondition report differs from the actual trace projection");
  return trace;
}
function assertExpectedTraceV3(trace: BrowserOperationTraceV3, expected: ExpectedBrowserProgramV3): void {
  if (trace.program_digest !== expected.program_digest || trace.case_id !== expected.case_id || !isDeepStrictEqual(trace.viewport, expected.viewport)
    || trace.operations.length !== expected.steps.length
    || !isDeepStrictEqual(trace.captures.map(({ page_id, timing }) => ({ page_id, timing })), expected.captures)) {
    throw new Error("Browser trace differs from the independently derived page lifecycle");
  }
  for (let index = 0; index < expected.steps.length; index++) {
    const planned = expected.steps[index]!, operation = trace.operations[index]!;
    if (planned.index !== index || operation.index !== index || operation.action !== planned.action || operation.page_id !== planned.page_id
      || operation.planned_step_digest !== planned.planned_step_digest) throw new Error("Browser trace steps or pages are missing, reordered or substituted");
    if (planned.expected_observation.kind === "navigation" || planned.expected_observation.kind === "page-opened") {
      if (operation.observation.kind !== planned.expected_observation.kind) throw new Error("Browser trace observation differs from the planned action");
    } else if (!isDeepStrictEqual(operation.observation, planned.expected_observation)) throw new Error("Browser trace observation differs from the planned action");
  }
  const actualPrecondition = trace.storage_precondition, plannedPrecondition = expected.storage_precondition;
  if (actualPrecondition !== undefined || plannedPrecondition !== undefined) {
    if (actualPrecondition === undefined || plannedPrecondition === undefined) {
      throw new Error("Browser storage precondition evidence requires the independently derived sidecar");
    }
    // These are actual validated native readbacks. The source-derived expectation cannot supply missing observations.
    // The product server's ephemeral origin is checked by the protected native controller and retained in trace/report.
    const { origin: _origin, installation, sequence: _sequence, ...observed } = actualPrecondition;
    const measured: ExpectedStoragePreconditionV1 = { ...observed, installation_script_digest: installation.script_digest };
    if (!isDeepStrictEqual(measured, plannedPrecondition)) {
      throw new Error("Browser storage precondition source, fixture, native snapshots or checkpoints differ from the independently derived plan");
    }
  }
  const actual = trace.storage_fault, planned = expected.storage_fault;
  if (actual === undefined && planned === undefined) return;
  if (actual === undefined || planned === undefined) throw new Error("Browser storage fault evidence requires the independently derived sidecar");
  // Only plan fields are compared here. Installation, counters and native snapshots must come from the validated trace.
  const measuredPlan: ExpectedBrowserProgramV3["storage_fault"] = {
    version: actual.version, checks_digest: actual.checks_digest, installation_script_digest: planned.installation_script_digest,
    windows: actual.windows.map(window => ({ id: window.id, page_id: window.page_id, mode: window.mode,
      arm_before_step: window.arm_before_step, settle_after_step: window.settle_after_step,
      start_step_digest: window.start_step_digest, end_step_digest: window.end_step_digest,
      requirement_criteria: window.requirement_criteria, ui_assertion_steps: window.ui_assertion_steps,
      min_hits: 1, native_storage: { scope: window.native_storage.scope, comparison: window.native_storage.comparison },
      baseline_phase: window.baseline_phase, document_epoch: window.document_epoch })),
  };
  if (!isDeepStrictEqual(measuredPlan, planned)
    || actual.windows.some(window => window.installation.script_digest !== planned.installation_script_digest)) {
    throw new Error("Browser storage fault windows or installation differ from the independently derived plan");
  }
}
function sealV3(input: BrowserEvidenceBinding & { evidenceRoot: string; report: ReportV3 }, expectedPrograms: readonly ExpectedBrowserProgramV3[] | undefined): SealedBrowserEvidenceV3 {
  const { evidenceRoot, report: rawReport, ...binding } = input;
  const report = StaticWebAcceptanceReportSchema.parse(rawReport);
  if (report.version !== 3 || report.capability_binding.profile_digest !== binding.profileDigest || report.capability_binding.command_id !== binding.checkId) {
    throw new Error("Version-3 browser report differs from the protected command binding");
  }
  if (!Array.isArray(expectedPrograms) || expectedPrograms.length > 400 || expectedPrograms.length !== report.cases.length) {
    throw new Error("Version-3 browser evidence requires the complete independently derived program set");
  }
  const expected = new Map(expectedPrograms.map(program => [caseKey(program.case_id, program.viewport.id), program]));
  if (expected.size !== expectedPrograms.length) throw new Error("Duplicate independently derived browser program");
  const root = directory(evidenceRoot, binding.requestId), reportBytes = readRegular(join(root, "result.json"), MAX_JSON);
  if (!isDeepStrictEqual(JSON.parse(reportBytes.toString("utf8")), report)) throw new Error("Stored browser report differs from the measured output");
  let total = reportBytes.length;
  const entries: EntryV3[] = [], case_refs: SealedBrowserEvidenceV3["case_refs"] = [];
  for (const item of report.cases) {
    const planned = expected.get(caseKey(item.case_id, item.viewport.id));
    if (!planned || !isDeepStrictEqual(planned.viewport, item.viewport) || planned.program_digest !== item.program_digest
      || !isDeepStrictEqual(item.captures.map(({ page_id, timing }) => ({ page_id, timing })), planned.captures)) {
      throw new Error("Browser report differs from the expected case, viewport, program or page capture positions");
    }
    const filename = browserTraceV3Filename(item.case_id, item.viewport.id), bytes = readRegular(join(root, filename), MAX_TRACE);
    const trace = traceForCaseV3(bytes, item); assertExpectedTraceV3(trace, planned);
    if ((total += bytes.length) > MAX_BUNDLE) throw new Error("Browser evidence exceeds the bundle limit");
    const traceRef = v3Reference("trace", binding, item.case_id, item.viewport.id);
    entries.push({ kind: "trace", reference: traceRef, filename, checksum: item.trace_digest, size: bytes.length,
      case_id: item.case_id, viewport: { ...item.viewport } });
    const captures: SealedBrowserEvidenceV3["case_refs"][number]["captures"] = [];
    for (const capture of trace.captures) {
      const filename = browserCaptureV3Filename(item.case_id, item.viewport.id, capture.page_id), bytes = readRegular(join(root, filename), MAX_IMAGE);
      const dimensions = pngDimensions(bytes);
      if (dimensions.width !== item.viewport.width || dimensions.height !== item.viewport.height) throw new Error("Browser screenshot width or height differs from the measured viewport");
      if ((total += bytes.length) > MAX_BUNDLE || sha(bytes) !== capture.screenshot_digest) throw new Error("Browser screenshot integrity or bundle limit failed");
      const reference = v3Reference("image", binding, item.case_id, item.viewport.id, capture.page_id);
      entries.push({ kind: "image", reference, filename, checksum: capture.screenshot_digest, size: bytes.length,
        case_id: item.case_id, viewport: { ...item.viewport }, page_id: capture.page_id, timing: capture.timing });
      captures.push({ page_id: capture.page_id, screenshot_ref: reference });
    }
    case_refs.push({ case_id: item.case_id, viewport_id: item.viewport.id, trace_ref: traceRef, captures });
  }
  const manifest: ManifestV3 = { version: 3, binding, report, report_checksum: sha(reportBytes), entries };
  const digest = writeManifest(root, binding.checkId, manifest);
  return { version: 3, bundle_id: `browser_${digest.slice(7)}`, manifest_digest: digest, case_refs };
}

/** A grant is installed by the admitted node session; callers never select a host path. */
export function readBrowserEvidence(grant: BrowserEvidenceGrant, reference: string, pagination?: BrowserEvidenceReadOptions): BrowserEvidenceContent {
  const options = readOptions(pagination);
  if (!opaque.test(reference)) throw new Error("Invalid browser evidence reference");
  const { evidenceRoot, bundle_id, manifest_digest, ...binding } = grant;
  const root = directory(evidenceRoot, binding.requestId), bytes = readRegular(join(root, manifestName(binding.checkId)), MAX_JSON);
  if (sha(bytes) !== manifest_digest || bundle_id !== `browser_${manifest_digest.slice(7)}`) throw new Error("Browser evidence manifest checksum differs");
  const manifest = JSON.parse(bytes.toString("utf8")) as Manifest | ManifestV2 | ManifestV3;
  if ((manifest.version !== 1 && manifest.version !== 2 && manifest.version !== 3) || !isDeepStrictEqual(manifest.binding, binding)) throw new Error("Browser evidence request/source binding differs");
  const report = StaticWebAcceptanceReportSchema.parse(manifest.report);
  if (report.version !== manifest.version) throw new Error("Browser evidence manifest/report versions differ");
  if (report.version === 2 && (report.capability_binding.profile_digest !== binding.profileDigest || report.capability_binding.command_id !== binding.checkId)) {
    throw new Error("Version-2 browser report differs from the protected command binding");
  }
  if (report.version === 3 && (report.capability_binding.profile_digest !== binding.profileDigest || report.capability_binding.command_id !== binding.checkId)) {
    throw new Error("Version-3 browser report differs from the protected command binding");
  }
  if (sha(readRegular(join(root, "result.json"), MAX_JSON)) !== manifest.report_checksum) throw new Error("Browser report changed after sealing");
  const provenance = { ...binding, bundle_id, manifest_digest };
  if (reference === bundle_id) return jsonEvidence(reference, provenance, JSON.stringify({ ...manifest, report }), options);
  if (manifest.version === 3) {
    if (report.version !== 3) throw new Error("Expected a version-3 browser report");
    return readV3Entry(root, { ...manifest, report }, reference, provenance, options);
  }
  if (manifest.version === 2) {
    if (report.version !== 2) throw new Error("Expected a version-2 browser report");
    return readV2Entry(root, { ...manifest, report }, reference, provenance, options);
  }
  if (report.version !== 1) throw new Error("Expected a legacy browser report");
  if (Object.keys(options).length) throw new Error("Browser evidence pagination is supported only for JSON references");
  const entry = manifest.entries.find((item) => item.reference === reference);
  if (!entry || !report.cases.some((item) => item.case_id === entry.case_id && item.viewport === entry.viewport && item.screenshot_digest === entry.checksum)
    || entry.filename !== `${entry.case_id}-${entry.viewport}.png`) throw new Error("Evidence reference is not granted by this manifest");
  const image = readRegular(join(root, entry.filename), MAX_IMAGE);
  if (png(image) !== entry.viewport) throw new Error("Browser screenshot viewport changed after sealing");
  if (image.length !== entry.size || sha(image) !== entry.checksum) throw new Error("Browser screenshot changed after sealing");
  return { reference, provenance, mime_type: "image/png", data: image.toString("base64"), checksum: entry.checksum,
    size: entry.size, case_id: entry.case_id, viewport: entry.viewport };
}

function readV2Entry(root: string, manifest: ManifestV2, reference: string, provenance: BrowserEvidenceBinding & BrowserEvidenceBundle,
  options: BrowserEvidenceReadOptions): BrowserEvidenceContent {
  const entry = manifest.entries.find(item => item.reference === reference);
  const measured = entry && manifest.report.cases.find(item => item.case_id === entry.case_id && isDeepStrictEqual(item.viewport, entry.viewport));
  if (!entry || !measured) throw new Error("Evidence reference is not granted by this manifest");
  if (entry.kind === "trace") {
    if (entry.filename !== browserTraceV2Filename(entry.case_id, entry.viewport.id) || entry.checksum !== measured.trace_digest
      || entry.size !== measured.trace_size || entry.page_id !== undefined
      || reference !== v2Reference("trace", manifest.binding, entry.case_id, entry.viewport.id)) throw new Error("Trace reference differs from its measured case");
    const bytes = readRegular(join(root, entry.filename), MAX_TRACE);
    traceForCase(bytes, measured);
    return jsonEvidence(reference, provenance, new TextDecoder("utf-8", { fatal: true }).decode(bytes), options);
  }
  if (Object.keys(options).length) throw new Error("Browser evidence pagination is supported only for JSON references");
  if (entry.kind !== "image" || entry.page_id !== "main" || entry.filename !== browserCaptureV2Filename(entry.case_id, entry.viewport.id, entry.page_id)
    || !measured.captures.some(capture => capture.page_id === entry.page_id && capture.screenshot_digest === entry.checksum)
    || reference !== v2Reference("image", manifest.binding, entry.case_id, entry.viewport.id, entry.page_id)) throw new Error("Image reference differs from its measured page");
  const bytes = readRegular(join(root, entry.filename), MAX_IMAGE), dimensions = pngDimensions(bytes);
  if (dimensions.width !== entry.viewport.width || dimensions.height !== entry.viewport.height) throw new Error("Browser screenshot viewport changed after sealing");
  if (bytes.length !== entry.size || sha(bytes) !== entry.checksum) throw new Error("Browser screenshot changed after sealing");
  return { reference, provenance, mime_type: "image/png", data: bytes.toString("base64"), checksum: entry.checksum,
    size: entry.size, case_id: entry.case_id, viewport: entry.viewport, page_id: entry.page_id };
}

function readV3Entry(root: string, manifest: ManifestV3, reference: string, provenance: BrowserEvidenceBinding & BrowserEvidenceBundle,
  options: BrowserEvidenceReadOptions): BrowserEvidenceContent {
  const entry = manifest.entries.find(item => item.reference === reference);
  const measured = entry && manifest.report.cases.find(item => item.case_id === entry.case_id && isDeepStrictEqual(item.viewport, entry.viewport));
  if (!entry || !measured) throw new Error("Evidence reference is not granted by this manifest");
  if (entry.kind === "trace") {
    if (entry.filename !== browserTraceV3Filename(entry.case_id, entry.viewport.id) || entry.checksum !== measured.trace_digest
      || entry.size !== measured.trace_size || "page_id" in entry || "timing" in entry
      || reference !== v3Reference("trace", manifest.binding, entry.case_id, entry.viewport.id)) throw new Error("Trace reference differs from its measured case");
    const bytes = readRegular(join(root, entry.filename), MAX_TRACE);
    traceForCaseV3(bytes, measured);
    return jsonEvidence(reference, provenance, new TextDecoder("utf-8", { fatal: true }).decode(bytes), options);
  }
  if (Object.keys(options).length) throw new Error("Browser evidence pagination is supported only for JSON references");
  if (entry.kind !== "image" || entry.filename !== browserCaptureV3Filename(entry.case_id, entry.viewport.id, entry.page_id)
    || !measured.captures.some(capture => capture.page_id === entry.page_id && capture.screenshot_digest === entry.checksum && isDeepStrictEqual(capture.timing, entry.timing))
    || reference !== v3Reference("image", manifest.binding, entry.case_id, entry.viewport.id, entry.page_id)) throw new Error("Image reference differs from its measured page capture");
  // A v3 image also promises a capture position in the actual trace, including a confirmed close.
  traceForCaseV3(readRegular(join(root, browserTraceV3Filename(entry.case_id, entry.viewport.id)), MAX_TRACE), measured);
  const bytes = readRegular(join(root, entry.filename), MAX_IMAGE), dimensions = pngDimensions(bytes);
  if (dimensions.width !== entry.viewport.width || dimensions.height !== entry.viewport.height) throw new Error("Browser screenshot viewport changed after sealing");
  if (bytes.length !== entry.size || sha(bytes) !== entry.checksum) throw new Error("Browser screenshot changed after sealing");
  return { reference, provenance, mime_type: "image/png", data: bytes.toString("base64"), checksum: entry.checksum,
    size: entry.size, case_id: entry.case_id, viewport: entry.viewport, page_id: entry.page_id, timing: entry.timing };
}
