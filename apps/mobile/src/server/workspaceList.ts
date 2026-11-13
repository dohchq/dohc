import type { ServerProblemKind } from "@dohc/interface-words/account";
import type { SignIn } from "./account";
import { listWorkspaces, setShowOnPhone, type AccountWorkspace } from "./api";
import { requestGenerations, shownProblem } from "./client";

/** The signed-in account's workspaces, as the server lists them. */
export type WorkspaceList =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly workspaces: readonly AccountWorkspace[];
      readonly problem: ServerProblemKind | null;
      /** Workspaces whose Show on phone change the server hasn't answered yet. */
      readonly pending: ReadonlySet<string>;
    }
  | { readonly status: "failed"; readonly problem: ServerProblemKind };

/**
 * Why no workspace is open, once the list says: it could not load, the account has none, none that shows on the phone
 * is synced yet, or none shows. Null while the list loads, or once a workspace is open.
 */
export type WorkspaceGap =
  | { readonly kind: "failed"; readonly problem: ServerProblemKind }
  | { readonly kind: "no-workspaces" | "none-synced" | "none-shown" };

export function workspaceGap(
  list: WorkspaceList,
  currentWorkspaceId: string | null,
): WorkspaceGap | null {
  if (list.status === "failed") return { kind: "failed", problem: list.problem };
  if (list.status !== "ready" || currentWorkspaceId !== null) return null;
  if (list.workspaces.length === 0) return { kind: "no-workspaces" };
  return {
    kind: list.workspaces.some((entry) => entry.showOnPhone) ? "none-synced" : "none-shown",
  };
}

/** The list as this phone saved it for one sign-in (src/server/workspaceData.ts, `ReadCache.savedList`). */
export interface SavedList {
  /** The list last saved, or null. It never rejects. */
  load(): Promise<readonly AccountWorkspace[] | null>;
  /** The list as the server answered it, or as a change on this phone left it: it's saved, and decides what the cache keeps. */
  listed(workspaces: readonly AccountWorkspace[]): void;
}

export interface WorkspaceListStore {
  state(): WorkspaceList;
  subscribe(listener: () => void): () => void;
  reload(): void;
  /** Changes Show on phone at once, then as the server answers. A workspace takes one change at a time. */
  setShowOnPhone(workspaceId: string, showOnPhone: boolean): void;
}

export function createWorkspaceList(
  signIn: Pick<SignIn, "client" | "isCurrent">,
  saved?: SavedList | null,
): WorkspaceListStore {
  let state: WorkspaceList = { status: "loading" };
  const listeners = new Set<() => void>();
  const reads = requestGenerations();
  const pending = new Set<string>();

  function set(next: WorkspaceList) {
    if (!signIn.isCurrent()) return;
    state = next;
    for (const listener of listeners) listener();
  }

  /** The list as the server or this phone has it now. */
  function settle(workspaces: readonly AccountWorkspace[], problem: ServerProblemKind | null) {
    if (!signIn.isCurrent()) return;
    saved?.listed(workspaces);
    set({ status: "ready", workspaces, problem, pending: new Set(pending) });
  }

  function setEntry(workspaceId: string, showOnPhone: boolean, problem: ServerProblemKind | null) {
    if (state.status !== "ready") return;
    settle(
      state.workspaces.map((entry) =>
        entry.workspaceId === workspaceId ? { ...entry, showOnPhone } : entry,
      ),
      problem,
    );
  }

  void saved?.load().then((found) => {
    if (found === null || state.status === "ready") return;
    set({
      status: "ready",
      workspaces: found,
      problem: state.status === "failed" ? state.problem : null,
      pending: new Set(),
    });
  });

  /** Reads the list. A read after changes keeps the problem a failed change showed. */
  function read(afterChanges: boolean) {
    const request = reads.next();
    listWorkspaces(signIn.client).then(
      (workspaces) => {
        if (!reads.isLatest(request) || pending.size > 0) return;
        settle(workspaces, afterChanges && state.status === "ready" ? state.problem : null);
      },
      (error: unknown) => {
        const problem = shownProblem(error);
        if (!reads.isLatest(request) || problem === null) return;
        set(state.status === "ready" ? { ...state, problem } : { status: "failed", problem });
      },
    );
  }

  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reload: () => read(false),
    setShowOnPhone(workspaceId, showOnPhone) {
      if (state.status !== "ready" || pending.has(workspaceId)) return;
      const confirmed = state.workspaces.find(
        (entry) => entry.workspaceId === workspaceId,
      )?.showOnPhone;
      if (confirmed === undefined || confirmed === showOnPhone) return;
      pending.add(workspaceId);
      reads.next();
      setEntry(workspaceId, showOnPhone, null);
      void setShowOnPhone(signIn.client, workspaceId, showOnPhone)
        .then(
          (stored) => {
            pending.delete(workspaceId);
            setEntry(workspaceId, stored, null);
          },
          (error: unknown) => {
            pending.delete(workspaceId);
            setEntry(workspaceId, confirmed, shownProblem(error));
          },
        )
        .then(() => {
          if (pending.size === 0 && signIn.isCurrent()) read(true);
        });
    },
  };
}
