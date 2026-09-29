import { createContext, useContext, useState, type ReactNode } from "react";

interface Selection {
  selectedProjectId: string | null;
  setSelectedProjectId: (id: string) => void;
  selectedTaskId: string | null;
  setSelectedTaskId: (id: string | null) => void;
}

const SelectionContext = createContext<Selection | null>(null);

/**
 * Shared task selection lifted above the router so Board → card click and the
 * Workspace detail pane refer to the same selected task across routes.
 */
export function SelectionProvider({ children }: { children: ReactNode }): ReactNode {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedProjectId, setProject] = useState<string | null>(null);
  const setSelectedProjectId = (id: string): void => { setProject(id); setSelectedTaskId(null); };
  return (
    <SelectionContext.Provider value={{ selectedTaskId, setSelectedTaskId, selectedProjectId, setSelectedProjectId }}>
      {children}
    </SelectionContext.Provider>
  );
}

export function useSelection(): Selection {
  const ctx = useContext(SelectionContext);
  if (ctx === null) {
    throw new Error("useSelection must be used within a SelectionProvider");
  }
  return ctx;
}
