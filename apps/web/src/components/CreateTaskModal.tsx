import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";

import { CAPABILITIES, type Capability, type CreateTaskRequest, type Task } from "@artoo/domain";

import { newIdempotencyKey } from "../api/idempotency.js";
import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { Button, Input, Modal, Select, Textarea } from "../ui/index.js";
import { ListTodo, Plus } from "../ui/Icon.js";
import { CAPABILITY_LABELS, PRIORITY_LABELS } from "./taskPresentation.js";
import "../ui/work-management.css";

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
  const [priority, setPriority] = useState<Task["priority"]>("p2");
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const formId = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  const criteriaCount = criteria.split("\n").filter((line) => line.trim()).length;

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const mutation = useMutation({
    mutationFn: (request: CreateTaskRequest) => api.createTask(request, newIdempotencyKey()),
    onSuccess: async (response) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.tasks(projectId) });
      onCreated?.(response.task.id);
      onClose();
    },
  });
  const close = useCallback(() => {
    if (!mutation.isPending) onClose();
  }, [mutation.isPending, onClose]);

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    if (!title.trim() || mutation.isPending) return;
    const acceptance_criteria = criteria
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    mutation.mutate({
      project_id: projectId,
      title: title.trim(),
      description: description.trim(),
      priority,
      acceptance_criteria,
      required_capabilities: capabilities,
    });
  }

  return (
    <div className="work-create-dialog">
      <Modal open title="Create task" onClose={close} footer={<>
        <span className="work-create-dialog__shortcut">Ctrl / ⌘ + Enter</span>
        <Button onClick={close} disabled={mutation.isPending}>Cancel</Button>
        <Button type="submit" form={formId} variant="primary" iconLeft={Plus} loading={mutation.isPending} disabled={!title.trim()}>Create task</Button>
      </>}>
        <form id={formId} className="work-create-form" onSubmit={handleSubmit} onKeyDown={(event) => {
          if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            event.currentTarget.requestSubmit();
          }
        }}>
          <p className="work-create-form__intro">Describe the outcome and what a successful result looks like.</p>
          <Input ref={titleRef} label="Title" className="work-create-form__title" placeholder="What needs to get done?" value={title} onChange={(event) => setTitle(event.target.value)} required disabled={mutation.isPending} />
          <Textarea label="Description" placeholder="Add context, useful links, and any constraints…" rows={4} value={description} onChange={(event) => setDescription(event.target.value)} disabled={mutation.isPending} />
          <Textarea label="Acceptance criteria (one per line)" placeholder="The change works on desktop and mobile\nExisting tests pass" rows={3} value={criteria} onChange={(event) => setCriteria(event.target.value)} disabled={mutation.isPending} helperText={criteriaCount > 0 ? `${criteriaCount} ${criteriaCount === 1 ? "criterion" : "criteria"} added` : "Give the assignee a clear definition of done."} />
          <Select label="Priority" value={priority} onChange={(event) => setPriority(event.target.value as Task["priority"])} disabled={mutation.isPending}>
            {Object.entries(PRIORITY_LABELS).map(([value, label]) => <option key={value} value={value}>{value.toUpperCase()} · {label}</option>)}
          </Select>
          <details className="work-capabilities">
            <summary>Required capabilities <span>{capabilities.length > 0 ? `${capabilities.length} selected` : "Optional"}</span></summary>
            <p>Limit assignment to agents with these capabilities.</p>
            <div className="work-capabilities__grid">{CAPABILITIES.map((capability) => <label key={capability} title={capability}>
              <input type="checkbox" checked={capabilities.includes(capability)} disabled={mutation.isPending} onChange={(event) => setCapabilities(event.target.checked ? [...capabilities, capability] : capabilities.filter((value) => value !== capability))} />
              <span>{CAPABILITY_LABELS[capability]}</span>
            </label>)}</div>
          </details>
          <p className="work-create-form__destination"><ListTodo size={16} aria-hidden="true" />Created in Backlog. Assign an agent when the task is ready.</p>
          {mutation.isError ? <p role="alert" className="action-error">Failed to create task: {mutation.error.message}</p> : null}
        </form>
      </Modal>
    </div>
  );
}
