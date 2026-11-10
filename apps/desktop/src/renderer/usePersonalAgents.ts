import { useCallback, useEffect, useRef, useState } from "react";
import type { PersonalAgent, PersonalAgentsAccount } from "../ipc/bridgeContract";
import { bridge } from "./bridge";
import { useRequestSequence } from "./useRequestSequence";

export type PersonalAgentsState =
  | { status: "loading" }
  | { status: "ready"; accounts: readonly PersonalAgentsAccount[] }
  | { status: "failed" };

const LOADING: PersonalAgentsState = { status: "loading" };

// The personal agents of the server accounts this computer is signed in to,
// as main caches them. Main pushes each change, and a push is newer than any
// read still in flight. An answer belongs to the workspace it was asked in,
// so a slow one never lands after the workspace changes.
// `refresh` asks the relay before answering, as Settings › Agents does when it opens.
export function usePersonalAgents(workspaceId: string, refresh: boolean): {
  state: PersonalAgentsState;
  // Reads the relay again. Answers, once the read ends, with what the hook
  // then holds: the read's answer, or main's push when one came since.
  reload(): Promise<PersonalAgentsState>;
} {
  const requests = useRequestSequence([workspaceId]);
  const [held, setHeld] = useState<{ workspaceId: string; state: PersonalAgentsState }>({ workspaceId, state: LOADING });
  // What the hook holds before React renders it, for a read's answer.
  const latest = useRef(held);
  const hold = useCallback((state: PersonalAgentsState) => {
    latest.current = { workspaceId, state };
    setHeld(latest.current);
  }, [workspaceId]);
  const read = useCallback(async (refreshFirst: boolean): Promise<PersonalAgentsState> => {
    const token = requests.next();
    try {
      const event = await bridge().readPersonalAgents({ refresh: refreshFirst });
      if (requests.isCurrent(token)) hold({ status: "ready", accounts: event.accounts });
    } catch {
      if (requests.isCurrent(token)) hold({ status: "failed" });
    }
    return latest.current.workspaceId === workspaceId ? latest.current.state : LOADING;
  }, [hold, requests, workspaceId]);
  useEffect(() => {
    const stop = bridge().onPersonalAgents((event) => {
      requests.next();
      hold({ status: "ready", accounts: event.accounts });
    });
    void read(refresh);
    return stop;
  }, [hold, read, refresh, requests]);
  const reload = useCallback(() => read(true), [read]);
  return { state: held.workspaceId === workspaceId ? held.state : LOADING, reload };
}

// Every account's agents, or null when no roster says which agents exist:
// before one arrives, when one can't be read, or when no account is signed
// in. A personal agent reads as removed only when its roster leaves it out.
export function knownPersonalAgents(state: PersonalAgentsState): readonly PersonalAgent[] | null {
  if (state.status !== "ready" || state.accounts.length === 0) return null;
  if (state.accounts.some((account) => account.roster === null)) return null;
  return state.accounts.flatMap((account) => account.roster?.agents ?? []);
}
