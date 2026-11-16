import type { Plan, TaskSpec } from "@artoo/domain";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useApi } from "../app/ApiContext.js";
import { newIdempotencyKey } from "../api/idempotency.js";
import { Button, Input, Modal, Textarea } from "../ui/index.js";
import { ActionError } from "./ActionError.js";

/** Revising text preserves every original dependency and execution constraint. */
export function PlanRevisionDialog({
  plan,
  onClose,
  onCreated,
}: {
  plan: Plan;
  onClose: () => void;
  onCreated: () => Promise<void>;
}): React.ReactNode {
  const api = useApi();
  const [rationale, setRationale] = useState(plan.rationale);
  const [tasks, setTasks] = useState(() =>
    plan.task_specs.map((spec) => ({
      title: spec.title,
      description: spec.description ?? "",
      criteria: spec.acceptance_criteria.join("\n"),
    })),
  );
  const mutation = useMutation({
    mutationFn: () =>
      api.proposePlan(
        plan.goal_id,
        {
          rationale,
          task_specs: plan.task_specs.map(
            (spec, index): TaskSpec => ({
              ...spec,
              title: tasks[index]!.title.trim(),
              description: tasks[index]!.description,
              acceptance_criteria: tasks[index]!.criteria.split("\n")
                .map((line) => line.trim())
                .filter(Boolean),
            }),
          ),
        },
        newIdempotencyKey(),
      ),
    onSuccess: onCreated,
  });
  const edit = (index: number, patch: Partial<(typeof tasks)[number]>): void =>
    setTasks((current) => current.map((task, position) => (position === index ? { ...task, ...patch } : task)));
  return (
    <Modal
      open
      onClose={() => {
        if (!mutation.isPending) onClose();
      }}
      title={`Revise plan ${plan.version}`}
    >
      <form
        className="cowork-plan-revision u-stack"
        aria-label="Plan revision"
        onSubmit={(event) => {
          event.preventDefault();
          if (!mutation.isPending) mutation.mutate();
        }}
      >
        <p>
          This saves a new proposal for review. Existing task dependencies, capabilities, stages and other execution
          constraints are preserved. No tasks are created until a plan is accepted.
        </p>
        <Textarea
          label="Revised plan rationale"
          value={rationale}
          disabled={mutation.isPending}
          onChange={(event) => setRationale(event.target.value)}
        />
        {tasks.map((task, index) => (
          <fieldset key={index} className="u-stack-sm" disabled={mutation.isPending}>
            <legend>Task {index + 1}</legend>
            <Input
              label={`Revised task ${index + 1} title`}
              required
              value={task.title}
              onChange={(event) => edit(index, { title: event.target.value })}
            />
            <Textarea
              label={`Revised task ${index + 1} description`}
              value={task.description}
              onChange={(event) => edit(index, { description: event.target.value })}
            />
            <Textarea
              label={`Revised task ${index + 1} acceptance criteria`}
              required
              value={task.criteria}
              onChange={(event) => edit(index, { criteria: event.target.value })}
            />
            {plan.task_specs[index]!.dependencies.length > 0 && (
              <p>
                Depends on:{" "}
                {plan.task_specs[index]!.dependencies.map(
                  (dependency) => plan.task_specs[Number(dependency.ref)]?.title ?? dependency.ref,
                ).join(", ")}
              </p>
            )}
          </fieldset>
        ))}
        <ActionError error={mutation.error} />
        <div className="action-row">
          <Button
            type="submit"
            variant="primary"
            loading={mutation.isPending}
            disabled={tasks.some((task) => !task.title.trim() || !task.criteria.trim())}
          >
            Save revised proposal
          </Button>
          <Button disabled={mutation.isPending} onClick={onClose}>
            Cancel revision
          </Button>
        </div>
      </form>
    </Modal>
  );
}
