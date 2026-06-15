import { useQueries, useQuery } from "@tanstack/react-query";

import { CAPABILITIES, PERMISSION_CATEGORIES, SKILL_API_VERSION } from "@artoo/domain";

import { useApi } from "../app/ApiContext.js";
import { queryKeys } from "../app/queryKeys.js";

function list(values: readonly string[] | undefined): string {
  return values !== undefined && values.length > 0 ? values.join(", ") : "none";
}

function value(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined || value === "") return "none";
  return String(value);
}

/** Read-only computer inventory from bootstrap plus heartbeat-backed runtime rows. */
export function ComputersPage(): React.ReactNode {
  const api = useApi();
  const bootstrap = useQuery({ queryKey: queryKeys.bootstrap, queryFn: () => api.bootstrap() });
  const computers = bootstrap.data?.computers ?? [];
  const runtimeQueries = useQueries({
    queries: computers.map((computer) => ({
      queryKey: queryKeys.computerRuntimes(computer.id),
      queryFn: () => api.listComputerRuntimes(computer.id),
      enabled: bootstrap.data !== undefined,
    })),
  });

  if (bootstrap.isLoading) return <p role="status">Loading computers…</p>;
  if (bootstrap.isError || bootstrap.data === undefined) {
    return <p role="alert">Failed to load computers.</p>;
  }

  return (
    <section className="inventory-page" aria-label="Computers">
      <header>
        <h1>Computers</h1>
      </header>
      {computers.length === 0 ? <p>No computers registered.</p> : null}
      <div className="inventory-list">
        {computers.map((computer, index) => {
          const runtimes = runtimeQueries[index]?.data?.runtimes ?? [];
          return (
            <article key={computer.id} aria-label={computer.display_name} className="inventory-item">
              <h2>{computer.display_name}</h2>
              <dl>
                <dt>Status</dt>
                <dd>{computer.status}</dd>
                <dt>Host</dt>
                <dd>{computer.hostname}</dd>
                <dt>Platform</dt>
                <dd>
                  {computer.os} / {computer.arch}
                </dd>
                <dt>Last heartbeat</dt>
                <dd>{value(computer.last_heartbeat_at)}</dd>
                <dt>Capabilities</dt>
                <dd>{list(computer.capabilities)}</dd>
              </dl>
              <section aria-label={`${computer.display_name} runtimes`}>
                <h3>Runtimes</h3>
                {runtimeQueries[index]?.isLoading ? <p role="status">Loading runtimes…</p> : null}
                {runtimeQueries[index]?.isError ? (
                  <p role="alert">Failed to load runtimes.</p>
                ) : null}
                {!runtimeQueries[index]?.isLoading && runtimes.length === 0 ? (
                  <p>No runtime heartbeat rows.</p>
                ) : null}
                <ul>
                  {runtimes.map((runtime) => (
                    <li key={runtime.id}>
                      <strong>{runtime.runtime}</strong> · {runtime.status} ·{" "}
                      {value(runtime.version)} · last seen {value(runtime.last_seen_at)}
                      <br />
                      capabilities: {list(runtime.capabilities)}
                    </li>
                  ))}
                </ul>
              </section>
            </article>
          );
        })}
      </div>
    </section>
  );
}

/** Read-only agent inventory joined client-side from bootstrap read models. */
export function AgentsPage(): React.ReactNode {
  const api = useApi();
  const bootstrap = useQuery({ queryKey: queryKeys.bootstrap, queryFn: () => api.bootstrap() });

  if (bootstrap.isLoading) return <p role="status">Loading agents…</p>;
  if (bootstrap.isError || bootstrap.data === undefined) {
    return <p role="alert">Failed to load agents.</p>;
  }

  const agents = new Map(bootstrap.data.agents.map((agent) => [agent.id, agent]));
  const computers = new Map(bootstrap.data.computers.map((computer) => [computer.id, computer]));
  const models = new Map(bootstrap.data.model_profiles.map((profile) => [profile.id, profile]));
  const efforts = new Map(bootstrap.data.effort_profiles.map((profile) => [profile.id, profile]));

  return (
    <section className="inventory-page" aria-label="Agents">
      <header>
        <h1>Agents</h1>
      </header>
      {bootstrap.data.agent_instances.length === 0 ? <p>No agent instances registered.</p> : null}
      <div className="inventory-list">
        {bootstrap.data.agent_instances.map((instance) => {
          const agent = agents.get(instance.agent_id);
          const computer = computers.get(instance.computer_id);
          const model = models.get(instance.model_profile_id ?? "");
          const effort = efforts.get(instance.effort_profile_id ?? "");
          return (
            <article key={instance.id} aria-label={agent?.display_name ?? instance.id}>
              <h2>{agent?.display_name ?? instance.id}</h2>
              <dl>
                <dt>Instance</dt>
                <dd>{instance.id}</dd>
                <dt>Status</dt>
                <dd>{instance.status}</dd>
                <dt>Runtime</dt>
                <dd>{instance.runtime}</dd>
                <dt>Computer</dt>
                <dd>{computer?.display_name ?? instance.computer_id}</dd>
                <dt>Model profile</dt>
                <dd>{model !== undefined ? `${model.name} (${model.provider}/${model.model})` : "none"}</dd>
                <dt>Effort profile</dt>
                <dd>
                  {effort !== undefined
                    ? `${effort.name} (${effort.effort}, ${effort.max_runtime_minutes}m)`
                    : "none"}
                </dd>
                <dt>Workspace root</dt>
                <dd>{value(instance.workspace_root)}</dd>
                <dt>Capabilities</dt>
                <dd>{list(agent?.capabilities)}</dd>
              </dl>
            </article>
          );
        })}
      </div>
    </section>
  );
}

/** Read-only skill contract surface; install/storage APIs are not present in Phase A. */
export function SkillsPage(): React.ReactNode {
  return (
    <section className="inventory-page" aria-label="Skills">
      <header>
        <h1>Skills</h1>
      </header>
      <section aria-label="Skill manifest contract">
        <h2>Manifest Contract</h2>
        <dl>
          <dt>API version</dt>
          <dd>{SKILL_API_VERSION}</dd>
          <dt>Capability source</dt>
          <dd>manifest capabilities plus compatible_runtimes</dd>
          <dt>Storage/API status</dt>
          <dd>Phase B</dd>
        </dl>
      </section>
      <section aria-label="Permission categories">
        <h2>Permission Categories</h2>
        <ul>
          {PERMISSION_CATEGORIES.map((category) => (
            <li key={category}>{category}</li>
          ))}
        </ul>
      </section>
      <section aria-label="Known capabilities">
        <h2>Known Capabilities</h2>
        <ul>
          {CAPABILITIES.map((capability) => (
            <li key={capability}>{capability}</li>
          ))}
        </ul>
      </section>
    </section>
  );
}
