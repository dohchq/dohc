import { createContext, createElement, useContext, useState, type ReactNode } from "react";

declare const brand: unique symbol;

// One visit to a workspace: from the moment the provider shows it until the
// provider unmounts or shows another workspace id. Leaving A for B and coming
// back to A makes a new session even though A's id is the same. A workspace
// query belongs to one session and is retired with it.
//
// The brand keeps an ad hoc object from standing in for a session.
export type WorkspaceSession = { readonly [brand]: true };

const WorkspaceSessionContext = createContext<WorkspaceSession | null>(null);

const newSession = (workspaceId: string) => ({ workspaceId, session: Object.freeze({}) as WorkspaceSession });

export function WorkspaceSessionProvider(props: { workspaceId: string; children?: ReactNode }) {
  const [held, hold] = useState(() => newSession(props.workspaceId));
  let visit = held;
  if (visit.workspaceId !== props.workspaceId) {
    visit = newSession(props.workspaceId);
    hold(visit);
  }
  return createElement(WorkspaceSessionContext.Provider, { value: visit.session }, props.children);
}

export function useWorkspaceSession(): WorkspaceSession {
  const session = useContext(WorkspaceSessionContext);
  if (!session) throw new Error("useWorkspaceSession must be used inside the workspace shell's WorkspaceSessionProvider.");
  return session;
}
