import { createContext, createElement, useContext, useState, type ReactNode } from "react";

declare const brand: unique symbol;

// One visit to a workspace: from the moment the shell mounts for it until it
// unmounts. DesktopRoot keys the shell by workspace id, so leaving A for B and
// coming back to A makes a new session even though A's id is the same. A
// workspace query belongs to one session and is retired with it.
//
// The brand keeps an ad hoc object from standing in for a session.
export type WorkspaceSession = { readonly [brand]: true };

const WorkspaceSessionContext = createContext<WorkspaceSession | null>(null);

export function WorkspaceSessionProvider(props: { children?: ReactNode }) {
  const [session] = useState(() => Object.freeze({}) as WorkspaceSession);
  return createElement(WorkspaceSessionContext.Provider, { value: session }, props.children);
}

export function useWorkspaceSession(): WorkspaceSession {
  const session = useContext(WorkspaceSessionContext);
  if (!session) throw new Error("useWorkspaceSession must be used inside the workspace shell's WorkspaceSessionProvider.");
  return session;
}
