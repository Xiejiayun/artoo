export type BrowserFailurePhase = "profile-create" | "browser-launch" | "browser-close" | "profile-remove";
export interface BrowserFailureFacts {
  profile_path: string | null;
  process_close_observed: boolean;
  close_checks_completed: boolean;
}
type FailureMark = BrowserFailureFacts & { phase: BrowserFailurePhase };
const marks = new WeakMap<object, Readonly<FailureMark>>();
const objectValue = (value: unknown): value is object => (typeof value === "object" && value !== null) || typeof value === "function";

/** Diagnostic facts only: never replace an error or confer process-closure authority. */
export function markBrowserFailure<T>(error: T, phase: BrowserFailurePhase, facts: BrowserFailureFacts): T {
  if (objectValue(error) && !marks.has(error)) marks.set(error, Object.freeze({ ...facts, phase }));
  return error;
}

// Read whitelisted data properties only. Error getters/proxies must not replace the original failure.
function descriptor(value: object, key: PropertyKey): PropertyDescriptor | undefined {
  try { return Object.getOwnPropertyDescriptor(value, key); }
  catch { return undefined; }
}
function own(value: object, key: PropertyKey): unknown {
  const field = descriptor(value, key);
  return field && "value" in field ? field.value : undefined;
}
function redact(text: string): string {
  for (const [key, value] of Object.entries(process.env)) {
    if (value && value.length >= 6 && /key|token|secret|password|credential/i.test(key)) text = text.replaceAll(value, "[redacted]");
  }
  return text.replace(/(authorization\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:bearer|basic)\s+[^\s"']+)/gi, "$1[redacted]")
    .replace(/((?:--)?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|credential|authorization)\b["']?\s*(?:[:=]\s*|\s+))(?:("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|[^\s"'&,;]+)/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@");
}
function shorten(text: string, maximum: number): string {
  if (text.length <= maximum) return text;
  return text.slice(0, Math.max(0, maximum - 1)).replace(/[\uD800-\uDBFF]$/, "") + "…";
}
function strings(budget: number) {
  return (value: unknown, maximum: number): string | null => {
    if (typeof value !== "string") return null;
    let text = shorten(redact(value), maximum);
    // Account for JSON escaping as well as text length; truncate only after redaction.
    while (JSON.stringify(text).length > budget && text.length > 1) text = shorten(text, Math.floor(text.length / 2));
    if (JSON.stringify(text).length > budget) return null;
    budget -= JSON.stringify(text).length;
    return text;
  };
}
interface ErrorDiagnostic {
  relation: string;
  phase: BrowserFailurePhase | null;
  code: string | null;
  errno: number | string | null;
  syscall: string | null;
  profile_path: string | null;
  process_close_observed: boolean | null;
  close_checks_completed: boolean | null;
  path: string | null;
  name: string | null;
  message: string | null;
  stack: string | null;
  stack_accessor_omitted: boolean;
}

/** Bounded, redacted failure-only output. Does not enumerate argv, environment, or arbitrary error fields. */
export function formatBrowserFailure(error: unknown): string {
  try {
    const text = strings(5600), seen = new WeakSet<object>(), records: ErrorDiagnostic[] = [];
    let omitted = false;
    let selected: Pick<ErrorDiagnostic, "phase" | "code" | "errno" | "syscall" | "profile_path" | "process_close_observed" | "close_checks_completed"> | undefined;
    let selectedScore = -1;
    function visit(value: unknown, relation: string, depth: number, inherited?: Readonly<FailureMark>): void {
      if (records.length >= 6 || depth > 3) { omitted = true; return; }
      if (objectValue(value) && seen.has(value)) { omitted = true; return; }
      if (objectValue(value)) seen.add(value);
      const read = (key: string) => objectValue(value) ? own(value, key) : undefined;
      const mark = (objectValue(value) ? marks.get(value) : undefined) ?? inherited;
      const errno = read("errno"), code = read("code"), syscall = read("syscall");
      const score = (typeof syscall === "string" && syscall ? 8 : 0) + (typeof code === "string" && code ? 4 : 0) + (mark ? 2 : 0);
      if (score > selectedScore) {
        // Keep summary selection independent from the detailed text budget.
        selectedScore = score;
        selected = { phase: mark?.phase ?? null, code: typeof code === "string" ? code : null,
          errno: typeof errno === "number" && Number.isFinite(errno) ? errno : typeof errno === "string" ? errno : null,
          syscall: typeof syscall === "string" ? syscall : null, profile_path: mark?.profile_path ?? null,
          process_close_observed: mark?.process_close_observed ?? null, close_checks_completed: mark?.close_checks_completed ?? null };
      }
      const record: ErrorDiagnostic = {
        relation, phase: mark?.phase ?? null, code: text(code, 60),
        errno: typeof errno === "number" && Number.isFinite(errno) ? errno : text(errno, 60),
        syscall: text(syscall, 100), profile_path: text(mark?.profile_path, 1200),
        process_close_observed: mark?.process_close_observed ?? null, close_checks_completed: mark?.close_checks_completed ?? null,
        path: text(read("path"), 1200), name: text(read("name"), 80),
        message: text(read("message") ?? (typeof value === "string" ? value : undefined), 1000), stack: null,
        stack_accessor_omitted: false,
      };
      const index = records.push(record) - 1;
      const cause = read("cause");
      if (cause !== undefined) visit(cause, `${index}.cause`, depth + 1, mark);
      const errors = read("errors");
      if (Array.isArray(errors)) {
        const length = own(errors, "length");
        if (typeof length === "number" && length > 3) omitted = true;
        for (let item = 0; item < Math.min(typeof length === "number" ? length : 0, 3); item++) visit(own(errors, item), `${index}.errors[${item}]`, depth + 1, mark);
      }
      // Node 26 also exposes the native lazy stack through an accessor. Invoking it can
      // call user-defined Error.prepareStackTrace/name/message hooks, so omit it explicitly.
      const stack = objectValue(value) ? descriptor(value, "stack") : undefined;
      record.stack_accessor_omitted = stack !== undefined && !("value" in stack);
      record.stack = text(stack && "value" in stack ? stack.value : undefined, 1800);
    }
    visit(error, "root", 0);
    // Prefer an actual OS error; a wrapping launch/cleanup error must not hide its syscall.
    const focus = selected!;
    const compact = strings(370);
    const summary = {
      phase: focus.phase, code: compact(focus.code, 40), errno: typeof focus.errno === "number" ? focus.errno : compact(focus.errno, 40),
      syscall: compact(focus.syscall, 60), profile_path: compact(focus.profile_path, 320),
      process_close_observed: focus.process_close_observed, close_checks_completed: focus.close_checks_completed,
    };
    // The verifier retains only the last 700 stderr characters. Keep this final line below that bound.
    const tail = `browser_failure_summary ${JSON.stringify(summary)}`;
    return `${JSON.stringify({ event: "browser_acceptance_failed", version: 1, errors: records, omitted })}\n${tail}`;
  } catch {
    // Diagnostic formatting cannot mask the existing nonzero exit or invoke an untrusted error getter.
    return "Browser acceptance failed; diagnostic formatting unavailable";
  }
}
