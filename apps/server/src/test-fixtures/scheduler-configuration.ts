import type { InjectOptions } from "fastify";

const instance = "/api/v1/agent-instances/instance_mock_coder";
const skill = {
  manifest: {
    api_version: "v1alpha1",
    id: "configuration-fixture",
    name: "Configuration fixture",
    version: "1.0.0",
    capabilities: ["code.read"],
    compatible_runtimes: ["mock"],
    permissions: {},
  },
  enabled: true,
};

/** Real configuration entry points; deletion comes last so successes can run in order. */
export const schedulerConfigurationMutations: { name: string; request: InjectOptions; status: number }[] = [
  {
    name: "project insertion",
    request: { method: "POST", url: "/api/v1/projects", payload: { name: "New project" } },
    status: 201,
  },
  {
    name: "project workspace",
    request: { method: "PATCH", url: "/api/v1/projects/proj_artoo", payload: { default_workspace: "C:/changed" } },
    status: 200,
  },
  {
    name: "Agent pool insertion",
    request: {
      method: "POST",
      url: "/api/v1/computers/computer_local_mock/instances",
      payload: { runtime: "mock", workspace_root: "C:/new-instance", agent_id: "agent_mock_coder" },
    },
    status: 201,
  },
  {
    name: "new Agent and instance",
    request: {
      method: "POST",
      url: "/api/v1/computers/computer_local_mock/instances",
      payload: { runtime: "mock", workspace_root: "C:/new-agent", display_name: "New Agent" },
    },
    status: 201,
  },
  {
    name: "instance project",
    request: { method: "PATCH", url: `${instance}/project`, payload: { project_id: null } },
    status: 200,
  },
  {
    name: "worktree configuration",
    request: {
      method: "PATCH",
      url: `${instance}/worktree-workspace-base`,
      payload: { version: 1, strategy: "per-run", basePath: "C:/runs" },
    },
    status: 200,
  },
  { name: "worktree removal", request: { method: "DELETE", url: `${instance}/worktree-workspace-base` }, status: 200 },
  { name: "instance disable", request: { method: "PATCH", url: instance, payload: { enabled: false } }, status: 200 },
  { name: "instance enable", request: { method: "PATCH", url: instance, payload: { enabled: true } }, status: 200 },
  {
    name: "project policy",
    request: {
      method: "PUT",
      url: "/api/v1/projects/proj_artoo/scheduling-policy",
      payload: { version: 1, repo_url: null, default_branch: "main", max_concurrent_runs: 2 },
    },
    status: 200,
  },
  {
    name: "Agent policy",
    request: {
      method: "PUT",
      url: "/api/v1/agents/agent_mock_coder/scheduling-policy",
      payload: {
        version: 1,
        pinned_computer_id: null,
        max_concurrent_runs: 2,
        required_runtimes: [],
        required_labels: [],
      },
    },
    status: 200,
  },
  {
    name: "computer policy",
    request: {
      method: "PUT",
      url: "/api/v1/computers/computer_local_mock/scheduling-policy",
      payload: { version: 1, max_concurrent_runs: 2, labels: [] },
    },
    status: 200,
  },
  {
    name: "pin import",
    request: { method: "POST", url: "/api/v1/scheduler/agent-pin-import", payload: { apply: true } },
    status: 200,
  },
  {
    name: "global skill insertion",
    request: { method: "POST", url: "/api/v1/skills/install", payload: skill },
    status: 201,
  },
  {
    name: "project skill insertion",
    request: { method: "POST", url: "/api/v1/skills/install", payload: { ...skill, project_id: "proj_artoo" } },
    status: 201,
  },
  { name: "instance tombstone", request: { method: "DELETE", url: instance }, status: 200 },
  { name: "Agent tombstone", request: { method: "DELETE", url: "/api/v1/agents/agent_mock_coder" }, status: 200 },
  {
    name: "computer tombstone",
    request: { method: "DELETE", url: "/api/v1/computers/computer_local_mock" },
    status: 200,
  },
];
