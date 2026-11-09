import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { CreateAutonomousGoalRequest, PreparedGoalEntryV1 } from "@artoo/domain";
import { ApiClientError } from "../api/client.js";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { preparedGoalBody, preparedGoalDraftKey, readPreparedGoalDraft, removePreparedGoalDraft,
  writePreparedGoalDraft, type BrowserGoalEntry } from "../app/goalEntryDraft.js";
import { Button, Textarea } from "../ui/index.js";
import { ActionError } from "./ActionError.js";

interface Props { entry: PreparedGoalEntryV1; organizationId: string; userId: string; onCreated(id: string): void }
export function PreparedGoalRequest(props: Props): React.ReactNode {
  const { entry } = props;
  if (entry.goal_id) return <p role="status">This session has received your product request. Its progress appears below.</p>;
  if (entry.submission_owner === "console") return <p role="status">This session uses the request entered in the launcher. Its progress will appear here.</p>;
  return <PreparedBrowserGoalForm {...props} entry={entry} />;
}

function PreparedBrowserGoalForm({ entry, organizationId, userId, onCreated }: Props & { entry: BrowserGoalEntry }): React.ReactNode {
  const api = useApi(), query = useQueryClient();
  const draftKey = preparedGoalDraftKey(api.getStorageScope(), organizationId, userId, entry);
  const [initial] = useState(() => {
    try { return { body: readPreparedGoalDraft(draftKey, entry), error: null as unknown }; }
    catch (error) { return { body: null, error }; }
  });
  const [objective, setObjective] = useState(initial.body?.objective ?? "");
  const [submission, setSubmission] = useState(initial.body);
  const [storageError, setStorageError] = useState<unknown>(initial.error);
  const recovered = useRef(false);
  const mutation = useMutation({
    mutationFn: (body: CreateAutonomousGoalRequest) => api.createAutonomousGoal(body, entry.request_key),
    retry: (count, error) => count < 3 && error instanceof ApiClientError && error.code === "network_error",
    retryDelay: (count) => Math.min(1000 * 2 ** count, 8000),
    onSuccess: async ({ goal }) => {
      removePreparedGoalDraft(draftKey); onCreated(goal.id);
      await Promise.all([query.invalidateQueries({ queryKey: ["goals", entry.project_id] }), query.invalidateQueries({ queryKey: queryKeys.bootstrap })]);
    },
  });
  // A refresh replays only the previously saved body and the same server-bound key.
  useEffect(() => {
    if (initial.body && !recovered.current) { recovered.current = true; mutation.mutate(initial.body); }
  }, [initial.body, mutation.mutate]);
  return <form className="product-card u-stack" aria-label="Start product" onSubmit={(event) => {
    event.preventDefault();
    if (mutation.isPending || storageError) return;
    try {
      const body = submission ?? preparedGoalBody(entry, objective);
      writePreparedGoalDraft(draftKey, entry, body); setSubmission(body); mutation.mutate(body);
    } catch (error) { setStorageError(error); }
  }}>
    <h2>Describe your product</h2>
    <p>{entry.request.app_publication
      ? "Your team handles research, design, implementation, tests, independent review and publication on the prepared computer. The application runs within the configured time and request limits. You can stop it from the goal, including after development finishes."
      : entry.request.app_delivery
        ? "Your team handles research, design, implementation, tests and independent review. This session delivers a verified application workspace. You can pause or cancel from the goal."
        : "Your team handles research, design, implementation, tests, independent review and publication to the configured destination. You can pause or cancel from the goal."}</p>
    <Textarea label="Objective" required maxLength={10000} value={objective} disabled={!!submission || mutation.isPending}
      placeholder="Describe the result you need." onChange={(event) => setObjective(event.target.value)} />
    {submission && <p role="status">This request is saved. Reconnecting uses the same request and cannot create another goal.</p>}
    <ActionError error={storageError ?? mutation.error} />
    <Button type="submit" variant="primary" loading={mutation.isPending}
      disabled={!objective.trim() || !!storageError || mutation.isSuccess}>{submission ? "Retry submission" : "Start product"}</Button>
  </form>;
}
