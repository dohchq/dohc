import { createContext, createElement, useContext, useState, type ReactNode } from "react";

declare const brand: unique symbol;

// One visit to a workspace: from the moment the provider shows it until the
// provider unmounts, shows another workspace id, or shows the same workspace
// again after a stop. Leaving A for B and coming back to A makes a new session
// even though A's id is the same, and so does a window that Forget stopped and
// the workspace's activation made able to edit it again, though the shell
// stays mounted. A workspace query belongs to one session and is retired with
// it.
//
// The brand keeps an ad hoc object from standing in for a session.
export type WorkspaceSession = { readonly [brand]: true };

const WorkspaceSessionContext = createContext<WorkspaceSession | null>(null);

const newSession = (workspaceId: string, stopped: boolean) => ({ workspaceId, stopped, session: Object.freeze({}) as WorkspaceSession });

// `stopped`: this window can't act on the workspace now, as after Forget.
export function WorkspaceSessionProvider(props: { workspaceId: string; stopped?: boolean; children?: ReactNode }) {
  const stopped = props.stopped ?? false;
  const [held, hold] = useState(() => newSession(props.workspaceId, stopped));
  let visit = held;
  if (visit.workspaceId !== props.workspaceId || (visit.stopped && !stopped)) {
    visit = newSession(props.workspaceId, stopped);
    hold(visit);
  } else if (visit.stopped !== stopped) {
    visit = { ...visit, stopped };
    hold(visit);
  }
  return createElement(WorkspaceSessionContext.Provider, { value: visit.session }, props.children);
}

export function useWorkspaceSession(): WorkspaceSession {
  const session = useContext(WorkspaceSessionContext);
  if (!session) throw new Error("useWorkspaceSession must be used inside the workspace shell's WorkspaceSessionProvider.");
  return session;
}
