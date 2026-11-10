import { accountWords } from "@dohc/interface-words/account";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useAccount } from "../account/AccountProvider";
import type { AccountWorkspace } from "../server/api";
import { sampleBuild } from "../sampleBuild";
import { workspaceMarkFills } from "../theme";
import type { PhoneWorkspace } from "./sample";

// The sample's workspaces, in a sample build only (src/sampleBuild.ts).
const sampleWorkspaces: readonly PhoneWorkspace[] = __DEV__ || process.env.EXPO_PUBLIC_DOHC_SAMPLE === "1" ? (require("./sample") as typeof import("./sample")).sampleWorkspaces : [];

interface WorkspacesState {
  readonly current: PhoneWorkspace | null;
  /** The workspaces this phone lists, in order. */
  readonly workspaces: readonly PhoneWorkspace[];
  /** Opens a workspace from the switcher. */
  choose(workspaceId: string): void;
  /**
   * Sample builds only: drops the workspace from this phone's list and opens the next one; returns how to put it back.
   * A signed-in build has Show on phone, in Settings, instead.
   */
  readonly forget: ((workspace: PhoneWorkspace) => () => void) | null;
}

const State = createContext<WorkspacesState | null>(null);

export function WorkspacesProvider({ children }: { children: ReactNode }) {
  return sampleBuild ? <SampleWorkspaces>{children}</SampleWorkspaces> : <ServerWorkspaces>{children}</ServerWorkspaces>;
}

// This phone's list of workspaces. Forget only removes the phone's entry; the workspace stays on the server,
// so putting it back restores the entry where it was and opens it again.
function SampleWorkspaces({ children }: { children: ReactNode }) {
  const [list, setList] = useState<readonly PhoneWorkspace[]>(sampleWorkspaces);
  const [currentId, setCurrentId] = useState<string | null>(sampleWorkspaces[0]?.id ?? null);
  const forget = useCallback((workspace: PhoneWorkspace) => {
    const index = list.indexOf(workspace);
    const rest = list.filter(entry => entry !== workspace);
    setList(rest);
    setCurrentId(rest[0]?.id ?? null);
    return () => {
      setList(previous => [...previous.slice(0, index), workspace, ...previous.slice(index)]);
      setCurrentId(workspace.id);
    };
  }, [list]);
  const value = useMemo(() => ({ current: list.find(entry => entry.id === currentId) ?? null, workspaces: list, choose: setCurrentId, forget }),
    [list, currentId, forget]);
  return <State value={value}>{children}</State>;
}

function ServerWorkspaces({ children }: { children: ReactNode }) {
  const value = useShownWorkspaces();
  return <State value={value}>{children}</State>;
}

/**
 * The account's workspaces that show on this phone, as the server lists them, and the one open. The switcher sheet,
 * outside the tabs, reads them here too.
 */
export function useShownWorkspaces(): WorkspacesState {
  const { workspaces: list, currentWorkspaceId, chooseWorkspace } = useAccount();
  const workspaces = useMemo(() => list.status === "ready"
    ? list.workspaces.filter(entry => entry.showOnPhone).map(phoneWorkspace)
    : [], [list]);
  return useMemo(() => ({
    current: workspaces.find(entry => entry.id === currentWorkspaceId) ?? null, workspaces, choose: chooseWorkspace, forget: null,
  }), [workspaces, currentWorkspaceId, chooseWorkspace]);
}

/** The name a workspace shows under: its own, or the fallback before its computer sent one. */
export function workspaceName(workspace: AccountWorkspace): string {
  return workspace.name ?? accountWords.unnamedWorkspace;
}

// The server keeps no colour for a workspace, so its mark takes a fill by its ID: the same one on every launch.
function phoneWorkspace(workspace: AccountWorkspace): PhoneWorkspace {
  const hash = [...workspace.workspaceId].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 0);
  const name = workspaceName(workspace);
  return { id: workspace.workspaceId, name, initial: [...name][0]?.toUpperCase() ?? "", color: workspaceMarkFills[hash % workspaceMarkFills.length]!,
    canOpen: workspace.canOpen, sections: [] };
}

export function useWorkspaces(): WorkspacesState {
  const state = useContext(State);
  if (!state) throw new Error("useWorkspaces needs WorkspacesProvider");
  return state;
}
