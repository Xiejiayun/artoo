import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { canonicalProductSourceTransferValueV1, ProductResearchRevisionContextV1Schema,
  type ContextPack, type ProductResearchRevisionContextV1, type RunStartPayload } from "@artoo/domain";

const canonical = canonicalProductSourceTransferValueV1;
const hash = (value: unknown) => `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
const digest = (value: unknown): value is string => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
function fail(reason: string): never { throw new Error(`Research revision: ${reason}`); }

/** Context describes the request. Only the source runtime's retained bytes and closure grant admission. */
export function readProductResearchRevision(context: ContextPack | undefined): ProductResearchRevisionContextV1 | undefined {
  if (context?.product_research_revision === undefined) return undefined;
  const parsed = ProductResearchRevisionContextV1Schema.safeParse(context.product_research_revision);
  if (!parsed.success) fail("invalid versioned context");
  const revision = parsed.data, root = revision.baseline.workspace_root;
  if (context.transferred_product_input || context.imported_review_subject || context.imported_design_review_subject
    || context.imported_execution || context.imported_execution_review_subject || context.imported_execution_repair
    || context.imported_validation || context.imported_validation_review_subject || context.imported_recovery_validation
    || context.imported_recovery_validation_review_subject || context.imported_clean_validation || context.imported_clean_validation_review_subject
    || context.product_design_revision) fail("foreign or mixed continuation context");
  if (context.workspace.root !== root || context.goal_context?.goal_id !== revision.goal_id
    || context.goal_context.plan?.id !== revision.plan_id || revision.author_run_id === revision.baseline.source_run_id) {
    fail("workspace, goal, plan or author binding changed");
  }
  if (context.review_subject) {
    if (context.product_development || context.policy.execution_mode !== "discussion" || context.policy.filesystem_write_scope.length
      || context.review_subject.development_stage !== "research" || context.review_subject.run_id !== revision.author_run_id
      || context.review_subject.task_id === context.task.id) fail("independent review must bind the revised research author");
  } else if (context.product_development?.stage !== "research" || context.policy.execution_mode === "discussion"
    || !isDeepStrictEqual(context.policy.filesystem_write_scope, [root]) || context.task.id === revision.baseline.source_task_id) {
    fail("writer must own a distinct research revision task and the exact source workspace");
  }
  return revision;
}

export function assertProductResearchRevisionRun(payload: RunStartPayload, computerId: string | undefined): void {
  const context = payload.context_pack.payload, revision = readProductResearchRevision(context);
  if (!revision) return;
  if (!payload.verification || revision.baseline.computer_id !== computerId || context!.task.id !== payload.task_id
    || payload.workspace.root !== revision.baseline.workspace_root || payload.workspace.branch != null || payload.workspace_allocation
    || payload.verification.profile_id !== revision.baseline.profile_id
    || !isDeepStrictEqual(payload.policy_snapshot.filesystem_write_scope, context!.policy.filesystem_write_scope)
    || (context!.review_subject ? payload.run_id === revision.author_run_id || !payload.verification.expected_subject_digest
      : payload.run_id !== revision.author_run_id || payload.verification.expected_subject_digest !== undefined)) {
    fail("node, execution, profile or author/reviewer subject binding changed");
  }
}

type Author = { run_id: string; subject_digest: string; verified: boolean };
type Admission = { version: 1; index: number; previous: string | null; run_id: string; run_digest: string;
  project_id: string; task_id: string; mode: "author" | "review"; revision: ProductResearchRevisionContextV1; subject_digest: string };
type Closed = { version: 1; admission_digest: string; subject_digest: string; last_author: Author | null };
type Entry = { admission: Admission; closed?: Closed };

function identity(path: string) {
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink() || realpathSync.native(path) !== path || !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1n)) fail("journal physical identity is unsafe");
  return { dev: stat.dev, ino: stat.ino, size: stat.isFile() ? stat.size : 0n, mtime: stat.isFile() ? stat.mtimeNs : 0n };
}
function read(path: string): unknown {
  const before = identity(path);
  if (before.size > 65536n) fail("journal record exceeds its bound");
  const bytes = readFileSync(path);
  if (!isDeepStrictEqual(before, identity(path))) fail("journal changed during read");
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (canonical(value) !== bytes.toString("utf8")) fail("journal is not canonical");
  return value;
}
function write(path: string, value: unknown) {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, canonical(value)); fsyncSync(fd); } finally { closeSync(fd); }
  identity(path);
}
function pathFor(store: string, root: string) { return join(store, "attestations", `research-revision-${hash(root).slice(7)}`); }
function exactKeys(value: object, fields: string[]) { return isDeepStrictEqual(Object.keys(value).sort(), fields.sort()); }
function sameOwner(left: Admission, right: Admission) {
  const owner = (entry: Admission) => {
    const { author_run_id: _author, ...revision } = entry.revision;
    return { project: entry.project_id, task: entry.task_id, revision };
  };
  return canonical(owner(left)) === canonical(owner(right));
}
function entries(directory: string, root: string): Entry[] {
  if (!existsSync(directory)) return [];
  identity(directory);
  const names = readdirSync(directory).sort();
  if (names.length > 512) fail("revision journal capacity exhausted");
  const result: Entry[] = [], seen = new Set<string>();
  for (let index = 0, cursor = 0; cursor < names.length; index++) {
    const prefix = String(index).padStart(4, "0");
    if (names[cursor++] !== `${prefix}.admitted.json`) fail("revision journal sequence changed");
    const admission = read(join(directory, `${prefix}.admitted.json`)) as Admission;
    const revision = ProductResearchRevisionContextV1Schema.parse(admission.revision);
    if (!exactKeys(admission, ["version", "index", "previous", "run_id", "run_digest", "project_id", "task_id", "mode", "revision", "subject_digest"])
      || admission.version !== 1 || admission.index !== index || revision.baseline.workspace_root !== root
      || !admission.run_id || !admission.project_id || !admission.task_id || seen.has(admission.run_id)
      || !digest(admission.run_digest) || !digest(admission.subject_digest) || !["author", "review"].includes(admission.mode)
      || admission.previous !== (index ? hash(result[index - 1]!.closed) : null)) fail("revision journal binding changed");
    seen.add(admission.run_id);
    const entry: Entry = { admission }; result.push(entry);
    if (names[cursor] === `${prefix}.closed.json`) {
      cursor++;
      const closed = read(join(directory, `${prefix}.closed.json`)) as Closed;
      if (!exactKeys(closed, ["version", "admission_digest", "subject_digest", "last_author"])
        || closed.version !== 1 || closed.admission_digest !== hash(admission) || !digest(closed.subject_digest)
        || closed.last_author !== null && (!closed.last_author.run_id || !digest(closed.last_author.subject_digest)
          || typeof closed.last_author.verified !== "boolean" || !exactKeys(closed.last_author, ["run_id", "subject_digest", "verified"]))) fail("revision closure record changed");
      const previousAuthor = result[index - 1]?.closed?.last_author ?? null;
      if (admission.mode === "author" ? closed.last_author?.run_id !== admission.run_id || closed.last_author.subject_digest !== closed.subject_digest
        : closed.subject_digest !== admission.subject_digest || !isDeepStrictEqual(closed.last_author, previousAuthor)) fail("revision author lineage changed");
      entry.closed = closed;
    } else if (cursor !== names.length) fail("unclosed revision has later history");
  }
  return result;
}

/** A durable unclosed admission also fences ordinary runs after a node restart. */
export function assertResearchRevisionWorkspaceClosed(store: string, root: string): void {
  const latest = entries(pathFor(store, root), root).at(-1);
  if (latest && !latest.closed) fail("previous revision execution has no confirmed closure");
}

export function assertResearchRevisionWorkspaceBoundary(store: string, root: string): void {
  const directory = join(store, "attestations");
  const inside = (child: string, parent: string) => { const rest = relative(parent, child); return rest === "" || rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest); };
  for (const name of readdirSync(directory).filter(name => name.startsWith("research-revision-"))) {
    const journal = join(directory, name); identity(journal);
    const first = read(join(journal, "0000.admitted.json")) as Admission;
    const retainedRoot = ProductResearchRevisionContextV1Schema.parse(first.revision).baseline.workspace_root;
    if (pathFor(store, retainedRoot) !== journal) fail("revision journal workspace identity changed");
    if (inside(root, retainedRoot) || inside(retainedRoot, root)) assertResearchRevisionWorkspaceClosed(store, retainedRoot);
  }
}

export function admitProductResearchRevision(input: { store: string; start: RunStartPayload; subjectDigest: string; assertBaseline: () => void }): void {
  const context = input.start.context_pack.payload!, revision = readProductResearchRevision(context)!;
  if (!revision || !digest(input.subjectDigest)) fail("revision admission lacks a measured subject");
  const directory = pathFor(input.store, revision.baseline.workspace_root), history = entries(directory, revision.baseline.workspace_root), latest = history.at(-1);
  if (latest && !latest.closed) fail("previous revision execution has no confirmed closure");
  if (history.length >= 256) fail("revision journal capacity exhausted");
  if (history.some(entry => entry.admission.run_id === input.start.run_id)) fail("revision run identity was already consumed");
  const review = context.review_subject;
  const admission: Admission = { version: 1, index: history.length, previous: latest ? hash(latest.closed) : null,
    run_id: input.start.run_id, run_digest: hash(input.start), project_id: context.project.id,
    task_id: review?.task_id ?? context.task.id, mode: review ? "review" : "author", revision, subject_digest: input.subjectDigest };
  if (latest?.admission.revision.revision_id === revision.revision_id) {
    if (!sameOwner(latest.admission, admission) || latest.closed!.subject_digest !== input.subjectDigest) fail("revision ownership or retained closed subject changed");
  } else {
    if (review || history.some(entry => entry.admission.revision.revision_id === revision.revision_id)) fail("revision cannot reopen old ownership or start with a reviewer");
    input.assertBaseline();
  }
  if (review) {
    const author = latest?.closed?.last_author;
    if (!author?.verified || author.run_id !== revision.author_run_id || author.subject_digest !== input.subjectDigest
      || input.start.verification?.expected_subject_digest !== author.subject_digest) fail("review does not bind the last verified closed author subject");
  }
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  identity(directory);
  write(join(directory, `${String(history.length).padStart(4, "0")}.admitted.json`), admission);
}

/** assertClosed is supplied only by the source runtime's native admission/handle check. */
export function closeProductResearchRevision(input: { store: string; start: RunStartPayload; subjectDigest: string;
  authorVerified: boolean; assertClosed: () => void; unstarted?: boolean }): void {
  input.assertClosed();
  const revision = readProductResearchRevision(input.start.context_pack.payload)!;
  const directory = pathFor(input.store, revision.baseline.workspace_root), history = entries(directory, revision.baseline.workspace_root), latest = history.at(-1);
  if (!latest || latest.closed || latest.admission.run_id !== input.start.run_id || latest.admission.run_digest !== hash(input.start)
    || !digest(input.subjectDigest)) fail("closure lacks its exact original pending admission");
  if (input.unstarted && latest.admission.subject_digest !== input.subjectDigest) fail("unstarted execution changed the admitted source bytes");
  if (latest.admission.mode === "review" && latest.admission.subject_digest !== input.subjectDigest) fail("read-only reviewer changed the retained subject");
  const closed: Closed = { version: 1, admission_digest: hash(latest.admission), subject_digest: input.subjectDigest,
    last_author: latest.admission.mode === "author" ? { run_id: input.start.run_id, subject_digest: input.subjectDigest, verified: input.authorVerified }
      : history.at(-2)?.closed?.last_author ?? null };
  write(join(directory, `${String(latest.admission.index).padStart(4, "0")}.closed.json`), closed);
}
