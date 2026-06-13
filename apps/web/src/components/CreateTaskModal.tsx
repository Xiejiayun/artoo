import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import type { CreateTaskRequest } from "@artoo/domain";

import { newIdempotencyKey } from "../api/idempotency.js";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";

export interface CreateTaskModalProps {
  projectId: string;
  onClose: () => void;
  onCreated?: (taskId: string) => void;
}

/** Create-task dialog. Submits a CreateTaskRequest with a fresh idempotency key. */
export function CreateTaskModal({
  projectId,
  onClose,
  onCreated,
}: CreateTaskModalProps): React.ReactNode {
  const api = useApi();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [criteria, setCriteria] = useState("");

  const mutation = useMutation({
    mutationFn: (request: CreateTaskRequest) => api.createTask(request, newIdempotencyKey()),
    onSuccess: async (response) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.tasks(projectId) });
      onCreated?.(response.task.id);
      onClose();
    },
  });

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    const acceptance_criteria = criteria
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    mutation.mutate({
      project_id: projectId,
      title: title.trim(),
      description: description.trim(),
      priority: "p2",
      acceptance_criteria,
      required_capabilities: [],
    });
  }

  return (
    <div role="dialog" aria-label="Create task" className="modal">
      <form onSubmit={handleSubmit}>
        <label>
          Title
          <input value={title} onChange={(event) => setTitle(event.target.value)} required />
        </label>
        <label>
          Description
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <label>
          Acceptance criteria (one per line)
          <textarea value={criteria} onChange={(event) => setCriteria(event.target.value)} />
        </label>
        {mutation.isError ? <p role="alert">Failed to create task.</p> : null}
        <div className="actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={mutation.isPending || title.trim() === ""}>
            Create task
          </button>
        </div>
      </form>
    </div>
  );
}
