import { assistantTurns, discussions } from "@artoo/db";
import { DiscussionPlanOutputSchema, DiscussionPlanPreviewSchema, StartDiscussionRequestSchema, type DiscussionPlanPreview, type Message } from "@artoo/domain";
import type { DrizzleDb } from "@artoo/storage";
import { and, eq, inArray } from "drizzle-orm";
import type { ServerContext } from "../context.js";
import { AppError } from "../errors.js";
import { validatePlanTaskSpecs } from "./plan-service.js";

type PlanIssue = Extract<ReturnType<typeof DiscussionPlanOutputSchema.safeParse>, { success: false }>["error"]["issues"][number];
interface PlanDiagnostic { code: string; path: string; expected: string; position?: number; line?: number; column?: number }
const MAX_DIAGNOSTICS = 6;
const planFields = new Set(["rationale", "task_specs", "development_stage", "title", "description", "acceptance_criteria",
  "required_capabilities", "dependencies", "ref", "type", "approval_gates", "write_scopes", "expected_artifacts"]);

function schemaDiagnostic(issue: PlanIssue): PlanDiagnostic {
  // Only schema field names and array offsets belong in feedback. Never include
  // issue.message, received values or unknown property names from model output.
  const path = ("$" + issue.path.slice(0, 12).map((part) => typeof part === "number" ? `[${part}]`
    : planFields.has(part) ? `.${part}` : "[field]").join("")).slice(0, 96);
  let expected = "a value matching the task plan schema";
  if (issue.code === "invalid_type") expected = issue.expected;
  else if (issue.code === "invalid_enum_value") expected = `one of ${issue.options.slice(0, 12).map((option) => JSON.stringify(option)).join(", ")}`;
  else if (issue.code === "too_small" || issue.code === "too_big") {
    const limit = issue.code === "too_small" ? issue.minimum : issue.maximum;
    const relation = issue.exact ? "exactly" : issue.code === "too_small" ? issue.inclusive ? "at least" : "more than" : issue.inclusive ? "at most" : "less than";
    const unit = issue.type === "array" ? "item" : issue.type === "string" ? "character" : "";
    expected = `${issue.type} with ${relation} ${limit}${unit ? ` ${unit}${limit === 1 ? "" : "s"}` : ""}`;
  } else if (issue.code === "invalid_string") expected = "a string matching the required format";
  else if (issue.code === "unrecognized_keys") expected = "only schema-defined properties";
  return { code: issue.code, path, expected: expected.slice(0, 128) };
}

function syntaxDiagnostic(error: SyntaxError, text: string): PlanDiagnostic {
  // JSON.parse diagnostics can quote arbitrary input, including credentials.
  // Select static explanations and numeric locations instead of forwarding them.
  let expected = "valid JSON syntax";
  const message = error.message;
  if (/^Unexpected end of JSON input/.test(message)) expected = "a complete JSON value";
  else if (/^Expected (?:double-quoted )?property name/.test(message)) expected = "a double-quoted property name";
  else if (/^Expected ':'/.test(message)) expected = "a colon after the property name";
  else if (/^Expected ',' or '}'/.test(message)) expected = "a comma or closing brace after the property value";
  else if (/^Expected ',' or '\]'/.test(message)) expected = "a comma or closing bracket after the array item";
  else if (/^Unexpected non-whitespace character after JSON/.test(message)) expected = "one JSON value with no trailing content";
  else if (/^(?:Unterminated string|Bad control character|Bad escaped character|Bad Unicode escape)/.test(message)) expected = "a closed JSON string with valid escaping";
  const match = /at position (\d+)(?: \(line \d+ column \d+\))?$/.exec(message);
  const position = match ? Number(match[1]) : /^Unexpected end of JSON input/.test(message) ? text.length : undefined;
  if (position === undefined || !Number.isSafeInteger(position) || position < 0 || position > text.length) return { code: "invalid_json", path: "$", expected };
  const prefix = text.slice(0, position), line = prefix.split("\n").length, column = position - prefix.lastIndexOf("\n");
  return { code: "invalid_json", path: "$", expected, position, line, column };
}

function invalidPlan(diagnostics: PlanDiagnostic[], omittedIssues = 0): AppError {
  const summary = diagnostics.map((issue) => `${issue.path}: ${issue.code}; expected ${issue.expected}${issue.line === undefined ? "" : ` at line ${issue.line}, column ${issue.column} (position ${issue.position})`}.`).join(" ");
  return AppError.validation(`The final agent reply is not a valid task plan. ${summary}${omittedIssues ? ` ${omittedIssues} additional issues omitted.` : ""} Return one JSON object matching the task plan schema.`,
    { diagnostic_version: 1, diagnostics, omitted_issues: omittedIssues });
}

export function parseDiscussionPlan(body: string) {
  const text = body.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1");
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw invalidPlan([syntaxDiagnostic(error, text)]);
  }
  const parsed = DiscussionPlanOutputSchema.safeParse(value);
  if (!parsed.success) throw invalidPlan(parsed.error.issues.slice(0, MAX_DIAGNOSTICS).map(schemaDiagnostic), Math.max(0, parsed.error.issues.length - MAX_DIAGNOSTICS));
  return parsed.data;
}

function preview(body: string, discussionId: string, goalId: string): DiscussionPlanPreview | undefined {
  try {
    const output = parseDiscussionPlan(body);
    const specs = validatePlanTaskSpecs(output.task_specs);
    // Existing proposal APIs accept numeric refs using Number(). Normalize only
    // this presentation so Swift and JavaScript resolve exactly the same names.
    return DiscussionPlanPreviewSchema.parse({ version: 1, discussion_id: discussionId, goal_id: goalId,
      rationale: output.rationale, task_specs: specs.map((spec) => ({ ...spec,
        dependencies: spec.dependencies.map((dep) => ({ ...dep, ref: String(Number(dep.ref)) })),
      })) });
  } catch (error) {
    // Invalid model content stays visible as the original reply. Do not hide a
    // database/transport failure behind this best-effort presentation path.
    if (error instanceof AppError || (error instanceof Error && error.name === "ZodError")) return undefined;
    throw error;
  }
}

/** Attach before message.created: incremental clients may fetch the reply before
 * the discussion dispatcher advances finalMessageId to its completed state. */
export async function previewForActiveSynthesis(ctx: ServerContext, tx: DrizzleDb,
  turn: typeof assistantTurns.$inferSelect, body: string, agentInstanceId: string): Promise<DiscussionPlanPreview | undefined> {
  const [row] = await tx.select().from(discussions).where(and(eq(discussions.organizationId, ctx.organizationId),
    eq(discussions.activeTurnId, turn.id), eq(discussions.roomId, turn.roomId),
    eq(discussions.threadRootId, turn.threadRootId ?? ""), eq(discussions.taskId, turn.taskId)));
  if (!row || row.status !== "running") return undefined;
  const participants = StartDiscussionRequestSchema.shape.participants.safeParse(row.participants);
  if (!participants.success || row.currentStep !== row.rounds * participants.data.length ||
    participants.data[0]?.agent_instance_id !== agentInstanceId) return undefined;
  return preview(body, row.id, row.goalId);
}

/** Bounded read projection for replies written by older servers. Never infer
 * attribution from a user-supplied payload or from JSON-shaped message text. */
export async function withHistoricalDiscussionPreviews(ctx: ServerContext, items: Message[]): Promise<Message[]> {
  const candidates = items.filter((item) => item.actor_type === "agent" && item.kind === "text" &&
    !DiscussionPlanPreviewSchema.safeParse(item.payload["discussion_plan"]).success);
  if (!candidates.length) return items;
  const rows = await ctx.db.db.select({ discussion: discussions, turn: assistantTurns }).from(discussions)
    .innerJoin(assistantTurns, and(eq(assistantTurns.responseMessageId, discussions.finalMessageId),
      eq(assistantTurns.organizationId, discussions.organizationId)))
    .where(and(eq(discussions.organizationId, ctx.organizationId),
      inArray(discussions.finalMessageId, candidates.map((item) => item.id))));
  const additions = new Map<string, DiscussionPlanPreview>();
  for (const { discussion, turn } of rows) {
    const message = candidates.find((item) => item.id === discussion.finalMessageId)!;
    const participants = StartDiscussionRequestSchema.shape.participants.safeParse(discussion.participants);
    if (!participants.success || discussion.currentStep !== participants.data.length * discussion.rounds + 1 ||
      message.organization_id !== ctx.organizationId || message.room_id !== discussion.roomId ||
      message.thread_root_id !== discussion.threadRootId || message.task_id !== discussion.taskId ||
      message.actor_id !== participants.data[0]?.agent_instance_id || turn.agentInstanceId !== message.actor_id ||
      turn.roomId !== discussion.roomId || turn.threadRootId !== discussion.threadRootId || turn.taskId !== discussion.taskId ||
      turn.status !== "completed" || turn.runId !== message.run_id) continue;
    const value = preview(message.body, discussion.id, discussion.goalId);
    if (value) additions.set(message.id, value);
  }
  return items.map((item) => additions.has(item.id) ? { ...item, payload: { ...item.payload, discussion_plan: additions.get(item.id) } } : item);
}
