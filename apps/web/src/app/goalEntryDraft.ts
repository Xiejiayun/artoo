import { CreateAutonomousGoalRequestSchema, type CreateAutonomousGoalRequest, type PreparedGoalEntryV1 } from "@artoo/domain";

export type BrowserGoalEntry = Extract<PreparedGoalEntryV1, { submission_owner: "browser" }>;
const PREFIX = "artoo:prepared-goal:v1:";
export function preparedGoalDraftKey(server: string, organization: string, user: string, entry: PreparedGoalEntryV1): string {
  return PREFIX + JSON.stringify([server, organization, user, entry.project_id, entry.session_id]);
}
export function preparedGoalBody(entry: BrowserGoalEntry, objective: string): CreateAutonomousGoalRequest {
  return CreateAutonomousGoalRequestSchema.parse({ project_id: entry.project_id, objective, ...entry.request });
}
export function readPreparedGoalDraft(key: string, entry: BrowserGoalEntry): CreateAutonomousGoalRequest | null {
  const raw = sessionStorage.getItem(key);
  if (raw === null) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("The saved product request is unreadable. Its request identity has been retained."); }
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1
    || !("request_key" in value) || value.request_key !== entry.request_key || !("body" in value)) {
    throw new Error("The saved product request does not match this session.");
  }
  const result = CreateAutonomousGoalRequestSchema.safeParse(value.body);
  if (!result.success || JSON.stringify(result.data) !== JSON.stringify(preparedGoalBody(entry, result.data.objective))) {
    throw new Error("The saved product request differs from the prepared configuration.");
  }
  return result.data;
}
/** Save before POST; storage failure must not silently create an unrecoverable request. */
export function writePreparedGoalDraft(key: string, entry: BrowserGoalEntry, body: CreateAutonomousGoalRequest): void {
  const value = JSON.stringify({ version: 1, request_key: entry.request_key, body });
  try {
    sessionStorage.setItem(key, value);
    if (sessionStorage.getItem(key) !== value) throw new Error("Session storage did not retain the request");
  } catch { throw new Error("The browser could not save this request for connection recovery. No new request was sent."); }
}
export function removePreparedGoalDraft(key: string): void {
  try { sessionStorage.removeItem(key); } catch { /* The committed server result remains authoritative. */ }
}
/** Invoked by the existing account/logout draft cleanup. Contains no credentials. */
export function clearPreparedGoalDrafts(): void {
  try { for (const key of Object.keys(sessionStorage)) if (key.startsWith(PREFIX)) sessionStorage.removeItem(key); }
  catch { /* A closed or unavailable session store cannot be read by this page. */ }
}
