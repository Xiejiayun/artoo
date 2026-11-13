import { PreparedGoalEntryV1Schema } from "@artoo/domain";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { startTransition, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { useApi } from "../app/ApiContext.js";
import { useSubscription } from "../app/RealtimeContext.js";
import { useSelection } from "../app/SelectionContext.js";
import { queryKeys } from "../app/queryKeys.js";
import { useProject } from "../app/useProject.js";
import { Button, Input, Modal, Select } from "../ui/index.js";
import "../ui/command-palette.css";
import { CreateTaskModal } from "./CreateTaskModal.js";

const PAGES = [
  ["Workspace", "/"],
  ["Channels", "/channels"],
  ["Goals", "/goals"],
  ["Board", "/board"],
  ["Release", "/release"],
  ["Machines", "/computers"],
  ["Agent library", "/agents"],
  ["Skills", "/skills"],
  ["Memory", "/memory"],
  ["Run history", "/runs"],
  ["Settings", "/settings"],
] as const;
const RESULT_LIMIT = 50;
interface Command {
  id: string;
  category: string;
  label: string;
  run: () => void;
}

function anotherDialogIsOpen(): boolean {
  return Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"], dialog[open]')).some(
    (dialog) => !dialog.querySelector("[data-command-palette]"),
  );
}

/** Navigation uses the same authorized project lists and forms as the ordinary UI. */
export function CommandPalette({ blocked = false }: { blocked?: boolean }): React.ReactNode {
  const api = useApi();
  const navigate = useNavigate();
  const location = useLocation();
  const { bootstrap, projectId, setSelectedProjectId } = useProject();
  const { setSelectedTaskId } = useSelection();
  const [open, setOpen] = useState(false);
  const [scopeId, setScopeId] = useState("");
  const [search, setSearch] = useState("");
  const [active, setActive] = useState(0);
  const [creatingProjectId, setCreatingProjectId] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const committed = useRef({ locationKey: location.key, open: false });
  const listId = useId();
  const data = bootstrap.isError ? undefined : bootstrap.data;
  const scope = data?.projects.find((project) => project.id === scopeId);
  const enabled = open && !!scope;
  const tasks = useQuery({ queryKey: queryKeys.tasks(scopeId), queryFn: () => api.listTasks(scopeId), enabled });
  const goals = useQuery({ queryKey: queryKeys.goals(scopeId), queryFn: () => api.listGoals(scopeId), enabled });
  const channels = useQuery({
    queryKey: queryKeys.channels(scopeId),
    queryFn: () => api.listChannels(scopeId),
    enabled,
  });
  useSubscription(enabled ? [`project:${scopeId}`] : []);

  const show = useCallback(() => {
    if (blocked || anotherDialogIsOpen()) return;
    // Join any pending router transition. An urgent opening could appear on the
    // previous page and immediately disappear when that navigation commits.
    startTransition(() => {
      setScopeId(projectId ?? "");
      setSearch("");
      setActive(0);
      setOpen(true);
    });
  }, [blocked, projectId]);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent): void => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        composing.current ||
        event.altKey ||
        event.shiftKey ||
        !(event.ctrlKey || event.metaKey) ||
        event.key.toLowerCase() !== "k" ||
        blocked ||
        anotherDialogIsOpen()
      )
        return;
      event.preventDefault();
      if (event.repeat) return;
      if (open) setOpen(false);
      else show();
    };
    document.addEventListener("keydown", keyboard);
    return () => document.removeEventListener("keydown", keyboard);
  }, [open, blocked, show]);
  useLayoutEffect(() => {
    // A new opening may commit together with an earlier navigation. Dismiss
    // only a panel that was already open on the previously committed page.
    if (committed.current.locationKey !== location.key && committed.current.open) setOpen(false);
    committed.current = { locationKey: location.key, open };
  }, [location.key, open]);
  useEffect(() => {
    // The shortcut can arrive before bootstrap. Adopt the initial selection
    // once it exists, without changing an explicitly chosen/removed scope.
    if (open && !scopeId && projectId) setScopeId(projectId);
  }, [open, scopeId, projectId]);
  useEffect(() => {
    if (open) inputRef.current?.focus();
    else composing.current = false;
  }, [open]);

  function chooseProject(id: string): void {
    setSelectedProjectId(id);
  }
  const commands: Command[] = PAGES.map(([label, path]) => ({
    id: `page:${path}`,
    category: "Go to",
    label,
    run: () => navigate(path),
  }));
  for (const project of open ? (data?.projects ?? []) : [])
    commands.push({
      id: `project:${project.id}`,
      category: "Project",
      label: project.name,
      run: () => {
        chooseProject(project.id);
        navigate("/channels");
      },
    });
  if (open && scope && data) {
    commands.unshift({
      id: "new-task",
      category: "Create",
      label: "New task",
      run: () => {
        chooseProject(scope.id);
        setCreatingProjectId(scope.id);
      },
    });
    const entry = data.goal_entry === undefined ? undefined : PreparedGoalEntryV1Schema.safeParse(data.goal_entry);
    if (!entry || (entry.success && entry.data.project_id !== scope.id))
      commands.unshift({
        id: "new-goal",
        category: "Create",
        label: "New goal",
        run: () => {
          chooseProject(scope.id);
          navigate("/goals", { state: { createGoalProjectId: scope.id } });
        },
      });
    for (const task of tasks.isError ? [] : (tasks.data?.tasks ?? [])) {
      if (task.project_id !== scope.id || task.organization_id !== data.organization.id) continue;
      commands.push({
        id: `task:${task.id}`,
        category: "Task",
        label: task.title,
        run: () => {
          chooseProject(scope.id);
          setSelectedTaskId(task.id);
          navigate("/");
        },
      });
    }
    for (const goal of goals.isError ? [] : (goals.data?.goals ?? [])) {
      if (goal.project_id !== scope.id || goal.organization_id !== data.organization.id) continue;
      commands.push({
        id: `goal:${goal.id}`,
        category: "Goal",
        label: goal.title,
        run: () => {
          chooseProject(scope.id);
          navigate(`/goals?goal=${encodeURIComponent(goal.id)}`);
        },
      });
    }
    for (const channel of channels.isError ? [] : (channels.data?.channels ?? [])) {
      if (channel.project_id !== scope.id) continue;
      commands.push({
        id: `channel:${channel.id}`,
        category: "Channel",
        label: channel.name,
        run: () => {
          chooseProject(scope.id);
          navigate(`/channels?room=${encodeURIComponent(channel.id)}&project=${encodeURIComponent(scope.id)}`);
        },
      });
    }
  }
  for (const agent of open ? (data?.agents ?? []) : []) {
    if (agent.organization_id !== data?.organization.id) continue;
    commands.push({
      id: `agent:${agent.id}`,
      category: "Agent history",
      label: agent.display_name,
      run: () => navigate(`/agents/${encodeURIComponent(agent.id)}/history`),
    });
  }
  commands.push({
    id: "connect",
    category: "Connect",
    label: "Connect Local Node",
    run: () => navigate("/computers?connect=1"),
  });
  const query = search.trim().toLocaleLowerCase();
  const matches = commands.filter((command) =>
    `${command.category} ${command.label}`.toLocaleLowerCase().includes(query),
  );
  const results = matches.slice(0, RESULT_LIMIT);
  const selectedIndex = Math.min(active, Math.max(0, results.length - 1));
  const selectedId = results[selectedIndex]?.id;
  useEffect(() => {
    setActive(0);
  }, [search, scopeId]);
  useEffect(() => {
    if (open && selectedId) document.getElementById(`${listId}-${selectedId}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, listId, selectedId]);
  function execute(command: Command): void {
    setOpen(false);
    command.run();
  }
  const creatingProject = bootstrap.data?.projects.find((project) => project.id === creatingProjectId);
  const uncertain =
    bootstrap.isLoading ||
    bootstrap.isError ||
    (enabled && [tasks, goals, channels].some((state) => state.isLoading || state.isError));

  return (
    <>
      <button
        type="button"
        className="os-icon-button"
        aria-label="Open commands (Ctrl or Command + K)"
        title="Commands · Ctrl / ⌘ + K"
        disabled={blocked}
        onClick={show}
      >
        <Search size={16} aria-hidden="true" />
      </button>
      <Modal open={open} title="Commands" onClose={() => setOpen(false)}>
        <div className="command-palette" data-command-palette>
          <p className="command-palette__hint">
            Switch projects or search tasks, goals and channels in the project below.
          </p>
          <Select
            label="Search in project"
            value={scope?.id ?? ""}
            onChange={(event) => setScopeId(event.target.value)}
          >
            {!scope && <option value="">Choose a project</option>}
            {data?.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
          <Input
            ref={inputRef}
            label="Search commands"
            value={search}
            role="combobox"
            autoComplete="off"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={selectedId ? `${listId}-${selectedId}` : undefined}
            onChange={(event) => setSearch(event.target.value)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(event) => {
              if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
                event.stopPropagation();
                return;
              }
              if ((event.key === "ArrowDown" || event.key === "ArrowUp") && results.length) {
                event.preventDefault();
                setActive((selectedIndex + (event.key === "ArrowDown" ? 1 : results.length - 1)) % results.length);
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (!event.repeat && results[selectedIndex]) execute(results[selectedIndex]);
              }
            }}
          />
          {bootstrap.isError && (
            <p role="alert">
              Projects unavailable.{" "}
              <Button size="sm" onClick={() => void bootstrap.refetch()}>
                Retry projects
              </Button>
            </p>
          )}
          {bootstrap.isLoading && <p role="status">Loading projects…</p>}
          {enabled &&
            (
              [
                ["Tasks", tasks],
                ["Goals", goals],
                ["Channels", channels],
              ] as const
            ).map(([label, state]) =>
              state.isError ? (
                <p key={label} role="alert">
                  {label} unavailable.{" "}
                  <Button size="sm" onClick={() => void state.refetch()}>
                    Retry {label.toLowerCase()}
                  </Button>
                </p>
              ) : state.isLoading ? (
                <p key={label} role="status">
                  Loading {label.toLowerCase()}…
                </p>
              ) : null,
            )}
          <ul id={listId} role="listbox" aria-label="Matching commands" className="command-palette__results">
            {results.map((command, index) => (
              <li
                key={command.id}
                className="command-palette__option"
                role="option"
                id={`${listId}-${command.id}`}
                tabIndex={-1}
                aria-selected={index === selectedIndex}
                onPointerMove={() => setActive(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => execute(command)}
              >
                <small>{command.category}</small>
                <span>{command.label}</span>
              </li>
            ))}
          </ul>
          {results.length === 0 && !uncertain && <p role="status">No matching commands.</p>}
          {matches.length > RESULT_LIMIT && (
            <p role="status">Showing the first {RESULT_LIMIT} matches. Refine your search.</p>
          )}
          <p className="command-palette__hint">↑ ↓ to choose · Enter to open · Escape to close</p>
        </div>
      </Modal>
      {creatingProject && (
        <CreateTaskModal
          key={creatingProject.id}
          projectId={creatingProject.id}
          onClose={() => setCreatingProjectId(undefined)}
          onCreated={(id) => {
            chooseProject(creatingProject.id);
            setSelectedTaskId(id);
            navigate("/");
          }}
        />
      )}
    </>
  );
}
