import type { TaskSpec } from "@artoo/domain";
import { newIdempotencyKey } from "../api/idempotency.js";

const PREFIX = "artoo:plan-draft:v1:";
export interface PlanDraftTask {
  id: string;
  title: string;
  description: string;
  criteria: string;
  capabilities: string[];
  dependencies: string[];
}
export interface PlanDraft { version: 1; rationale: string; tasks: PlanDraftTask[] }
export function newPlanTask(): PlanDraftTask {
  return { id: newIdempotencyKey(), title: "", description: "", criteria: "", capabilities: [], dependencies: [] };
}
export function newPlanDraft(): PlanDraft { return { version: 1, rationale: "", tasks: [newPlanTask()] }; }
export function planDraftKey(server: string, organization: string, user: string, goal: string): string {
  return PREFIX + JSON.stringify([server, organization, user, goal]);
}
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
function validDraft(value: unknown): value is PlanDraft {
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1
    || !("rationale" in value) || typeof value.rationale !== "string" || !("tasks" in value) || !Array.isArray(value.tasks) || !value.tasks.length) return false;
  if (!value.tasks.every(task => task && typeof task === "object" && typeof task.id === "string" && task.id
    && typeof task.title === "string" && typeof task.description === "string" && typeof task.criteria === "string"
    && strings(task.capabilities) && strings(task.dependencies))) return false;
  const tasks = value.tasks as PlanDraftTask[], ids = new Set(tasks.map(task => task.id));
  return ids.size === tasks.length && tasks.every(task => task.dependencies.every(id => ids.has(id) && id !== task.id));
}
export function loadPlanDraft(key: string): { draft: PlanDraft; notice: string; unreadable: boolean } {
  let raw: string | null;
  try { raw = localStorage.getItem(key); }
  catch { return { draft: newPlanDraft(), notice: "Draft storage is unavailable. Keep this editor open to retain your edits.", unreadable: false }; }
  if (raw === null) return { draft: newPlanDraft(), notice: "", unreadable: false };
  try {
    const value: unknown = JSON.parse(raw);
    if (validDraft(value)) return { draft: value, notice: "Restored your saved plan draft.", unreadable: false };
  } catch { /* Retain the unreadable copy until the user explicitly discards it. */ }
  return { draft: newPlanDraft(), notice: "Your saved plan draft could not be restored. Its saved copy has been kept. Discard it to start again.", unreadable: true };
}
export function savePlanDraft(key: string, draft: PlanDraft): boolean {
  try { localStorage.setItem(key, JSON.stringify(draft)); return true; } catch { return false; }
}
export function removePlanDraft(key: string): boolean {
  try { localStorage.removeItem(key); return true; } catch { return false; }
}
export function clearSubmittedPlanDraft(key: string, submitted: PlanDraft): "cleared" | "updated" | "unavailable" {
  try {
    const saved = localStorage.getItem(key);
    // A closed editor can be reopened and edited while the original request settles.
    if (saved !== null && saved !== JSON.stringify(submitted)) return "updated";
    localStorage.removeItem(key);
    return "cleared";
  } catch { return "unavailable"; }
}
export function clearPlanDrafts(): void {
  try { for (const key of Object.keys(localStorage)) if (key.startsWith(PREFIX)) localStorage.removeItem(key); }
  catch { /* Unavailable browser storage cannot be read by the next account. */ }
}
/** Local identities survive ordering; only the existing numeric-index contract leaves the browser. */
export function planTaskSpecs(draft: PlanDraft): TaskSpec[] {
  const positions = new Map(draft.tasks.map((task, index) => [task.id, String(index)]));
  return draft.tasks.map(task => ({ title: task.title.trim(), description: task.description,
    acceptance_criteria: task.criteria.split("\n").map(line => line.trim()).filter(Boolean),
    required_capabilities: task.capabilities, approval_gates: [], write_scopes: [], expected_artifacts: [],
    dependencies: task.dependencies.map(id => {
      const ref = positions.get(id);
      if (ref === undefined) throw new Error("A plan dependency is unavailable. Review the tasks before submitting.");
      return { ref, type: "blocks" as const };
    }),
  }));
}
