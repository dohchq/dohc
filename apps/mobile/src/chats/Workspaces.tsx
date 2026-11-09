import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { sampleWorkspaces, type SampleWorkspace } from "./sample";

interface WorkspacesState {
  readonly current: SampleWorkspace | null;
  /** Drops the workspace from this phone's list and opens the next one; returns how to put it back. */
  forget(workspace: SampleWorkspace): () => void;
}

const State = createContext<WorkspacesState | null>(null);

// This phone's list of workspaces. Forget only removes the phone's entry; the workspace stays on the server,
// so putting it back restores the entry where it was and opens it again.
export function WorkspacesProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<readonly SampleWorkspace[]>(sampleWorkspaces);
  const [currentId, setCurrentId] = useState<string | null>(sampleWorkspaces[0]?.id ?? null);
  const forget = useCallback((workspace: SampleWorkspace) => {
    const index = list.indexOf(workspace);
    const rest = list.filter(entry => entry !== workspace);
    setList(rest);
    setCurrentId(rest[0]?.id ?? null);
    return () => {
      setList(previous => [...previous.slice(0, index), workspace, ...previous.slice(index)]);
      setCurrentId(workspace.id);
    };
  }, [list]);
  const value = useMemo(() => ({ current: list.find(entry => entry.id === currentId) ?? null, forget }), [list, currentId, forget]);
  return <State value={value}>{children}</State>;
}

export function useWorkspaces(): WorkspacesState {
  const state = useContext(State);
  if (!state) throw new Error("useWorkspaces needs WorkspacesProvider");
  return state;
}
