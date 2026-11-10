import type { ServerProblemKind } from "@dohc/interface-words/account";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { View } from "react-native";
import { createAccount, type Account, type AccountState, type SignIn } from "../server/account";
import { listWorkspaces, setShowOnPhone as patchShowOnPhone, type AccountWorkspace } from "../server/api";
import { requestGenerations, shownProblem } from "../server/client";
import { useTheme } from "../theme";
import { Connect } from "./Connect";
import { secureSignInStore } from "./secureSignInStore";

/** The signed-in account's workspaces, as the server lists them. */
export type WorkspaceList =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly workspaces: readonly AccountWorkspace[]; readonly problem: ServerProblemKind | null }
  | { readonly status: "failed"; readonly problem: ServerProblemKind };

interface AccountValue {
  readonly account: Account;
  readonly state: AccountState;
  readonly workspaces: WorkspaceList;
  /** The workspace the person chose in the switcher; null opens the first that shows on the phone. */
  readonly chosenWorkspaceId: string | null;
  chooseWorkspace(workspaceId: string): void;
  reloadWorkspaces(): void;
  setShowOnPhone(workspaceId: string, showOnPhone: boolean): void;
}

const Context = createContext<AccountValue | null>(null);

// A build without sample data: the phone's sign-in, and the account's workspaces, for every screen.
export function AccountProvider({ children }: { children: ReactNode }) {
  const [account] = useState(() => createAccount({ store: secureSignInStore, fetch: (url, init) => fetch(url, init) }));
  const state = useSyncExternalStore(account.subscribe, account.state);
  useEffect(() => void account.restore(), [account]);
  const signIn = state.status === "signed-in" ? state.signIn : null;

  const [workspaces, setWorkspaces] = useState<WorkspaceList>({ status: "loading" });
  const [chosenWorkspaceId, chooseWorkspace] = useState<string | null>(null);
  const lists = useRef(requestGenerations());
  // One generation per workspace, so only the latest toggle of each lands.
  const toggles = useRef(new Map<string, number>());

  const load = useCallback((current: SignIn) => {
    const request = lists.current.next();
    setWorkspaces(previous => previous.status === "ready" ? previous : { status: "loading" });
    listWorkspaces(current.client).then(
      list => {
        if (!current.isCurrent() || !lists.current.isLatest(request)) return;
        setWorkspaces({ status: "ready", workspaces: list, problem: null });
      },
      (error: unknown) => {
        const problem = shownProblem(error);
        if (!current.isCurrent() || !lists.current.isLatest(request) || problem === null) return;
        setWorkspaces(previous => previous.status === "ready" ? { ...previous, problem } : { status: "failed", problem });
      },
    );
  }, []);

  useEffect(() => {
    lists.current.next();
    toggles.current.clear();
    setWorkspaces({ status: "loading" });
    chooseWorkspace(null);
    if (signIn) load(signIn);
  }, [signIn, load]);

  const reloadWorkspaces = useCallback(() => {
    if (signIn) load(signIn);
  }, [signIn, load]);

  const setShowOnPhone = useCallback((workspaceId: string, showOnPhone: boolean) => {
    if (!signIn) return;
    const request = (toggles.current.get(workspaceId) ?? 0) + 1;
    toggles.current.set(workspaceId, request);
    const apply = (value: boolean, problem: ServerProblemKind | null) => setWorkspaces(previous => previous.status !== "ready" ? previous : {
      status: "ready", problem,
      workspaces: previous.workspaces.map(entry => entry.workspaceId === workspaceId ? { ...entry, showOnPhone: value } : entry),
    });
    apply(showOnPhone, null);
    patchShowOnPhone(signIn.client, workspaceId, showOnPhone).then(
      stored => {
        if (signIn.isCurrent() && toggles.current.get(workspaceId) === request) apply(stored, null);
      },
      (error: unknown) => {
        if (!signIn.isCurrent() || toggles.current.get(workspaceId) !== request) return;
        const problem = shownProblem(error);
        if (problem !== null) apply(!showOnPhone, problem);
      },
    );
  }, [signIn]);

  const value = useMemo(() => ({ account, state, workspaces, chosenWorkspaceId, chooseWorkspace, reloadWorkspaces, setShowOnPhone }),
    [account, state, workspaces, chosenWorkspaceId, reloadWorkspaces, setShowOnPhone]);
  return <Context value={value}>{children}</Context>;
}

export function useAccount(): AccountValue {
  const value = useContext(Context);
  if (!value) throw new Error("useAccount needs AccountProvider");
  return value;
}

/** The signed-in account's sign-in; only screens past AccountGate use it. */
export function useSignIn(): SignIn {
  const { state } = useAccount();
  if (state.status !== "signed-in") throw new Error("useSignIn needs a signed-in account");
  return state.signIn;
}

// Connect until the phone is signed in. While the saved sign-in is read, at launch, only the paper shows.
export function AccountGate({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const { state } = useAccount();
  if (state.status === "loading") return <View style={{ flex: 1, backgroundColor: theme.bg }} />;
  if (state.status === "signed-out") return <Connect />;
  return children;
}
