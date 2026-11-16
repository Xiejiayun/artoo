import type { ProjectSquadV1 } from "@artoo/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useApi } from "../app/ApiContext.js";
import { useProjectSquad } from "../app/useProjectSquad.js";
import { queryKeys } from "../app/queryKeys.js";
import type { BootstrapResponse } from "../api/types.js";
import { Badge, Button, Modal } from "../ui/index.js";
import { ActionError } from "./ActionError.js";

function SquadForm({
  squad,
  bootstrap,
  onSaved,
}: {
  squad: ProjectSquadV1;
  bootstrap: BootstrapResponse;
  onSaved: () => void;
}): React.ReactNode {
  const api = useApi(),
    query = useQueryClient();
  const [ids, setIds] = useState(squad.agent_ids);
  const [revision] = useState(squad.revision);
  const save = useMutation({
    mutationFn: () => api.putProjectSquad(squad.project_id, revision, ids),
    onSuccess: async (result) => {
      query.setQueryData(queryKeys.projectSquad(squad.project_id), result);
      await Promise.all([
        query.invalidateQueries({ queryKey: queryKeys.bootstrap }),
        query.invalidateQueries({ queryKey: queryKeys.projectControlView(squad.project_id) }),
      ]);
      onSaved();
    },
  });
  const options = [
    ...bootstrap.agents.map((agent) => ({ id: agent.id, name: agent.display_name })),
    ...squad.agent_ids
      .filter((id) => !bootstrap.agents.some((agent) => agent.id === id))
      .map((id) => ({ id, name: `${id} (unavailable)` })),
  ];
  return (
    <form
      className="cowork-resource-form u-stack"
      aria-label="Project Squad members"
      onSubmit={(event) => {
        event.preventDefault();
        if (!save.isPending) save.mutate();
      }}
    >
      <p>
        Choose logical Agents for this shared project. Eligible execution instances may belong to this project or be
        shared across the organization. Instances bound to other projects remain outside this squad.
      </p>
      <fieldset disabled={save.isPending} className="cowork-squad-options">
        <legend>Team members</legend>
        {options.map((agent) => (
          <label key={agent.id}>
            <input
              type="checkbox"
              checked={ids.includes(agent.id)}
              onChange={(event) =>
                setIds((current) =>
                  event.target.checked ? [...current, agent.id] : current.filter((id) => id !== agent.id),
                )
              }
            />
            <span>
              <strong>{agent.name}</strong>
              <small>
                {
                  bootstrap.agent_instances.filter(
                    (instance) =>
                      instance.agent_id === agent.id &&
                      (instance.project_id === squad.project_id || instance.project_id === null),
                  ).length
                }{" "}
                eligible scoped instances
              </small>
            </span>
          </label>
        ))}
      </fieldset>
      <ActionError error={save.error} />
      {save.isError && (
        <p>Your selection is retained. A conflicting edit requires reopening the latest squad before saving.</p>
      )}
      <Button type="submit" variant="primary" loading={save.isPending}>
        Save project Squad
      </Button>
    </form>
  );
}
export function ProjectSquadEditor({
  projectId,
  bootstrap,
}: {
  projectId: string;
  bootstrap: BootstrapResponse;
}): React.ReactNode {
  const squad = useProjectSquad(projectId, bootstrap);
  const [open, setOpen] = useState(false);
  const canManage = ["owner", "admin"].includes(bootstrap.user.role);
  return (
    <section className="cowork-squad-settings u-stack-sm" aria-label="Project logical Squad">
      <div className="action-row">
        <h3>Project Squad</h3>
        <Badge>
          {squad.squad?.source === "configured"
            ? "Explicit membership"
            : squad.squad
              ? "Derived from legacy instance bindings"
              : "Membership unknown"}
        </Badge>
        {canManage && (
          <Button size="sm" disabled={!squad.squad || squad.isError} onClick={() => setOpen(true)}>
            Configure project Squad
          </Button>
        )}
      </div>
      <p>
        {squad.squad
          ? `${squad.squad.agent_ids.length} logical Agents · ${squad.instances.length} scoped execution instances`
          : "Loading project membership…"}
      </p>
      <ActionError error={squad.error} />
      {squad.isError && (
        <Button size="sm" onClick={() => void squad.refetch()}>
          Reload project Squad
        </Button>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title="Configure project Squad">
        {open && squad.squad && <SquadForm squad={squad.squad} bootstrap={bootstrap} onSaved={() => setOpen(false)} />}
      </Modal>
    </section>
  );
}
