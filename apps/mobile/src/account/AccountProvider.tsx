import { fetch } from "expo/fetch";
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { AppState, View } from "react-native";
import { createAccount, type Account, type AccountState, type SignIn } from "../server/account";
import { createReadCache, createWorkspaceData, type WorkspaceData } from "../server/workspaceData";
import { createWorkspaceList, type WorkspaceList, type WorkspaceListStore } from "../server/workspaceList";
import { useTheme } from "../theme";
import { Connect } from "./Connect";
import { secureSignInStore } from "./secureSignInStore";

interface AccountValue {
  readonly account: Account;
  readonly state: AccountState;
  readonly workspaces: WorkspaceList;
  /** The workspace the person chose in the switcher; null opens the first that shows on the phone. */
  readonly chosenWorkspaceId: string | null;
  /** The workspace open on the phone: the one chosen, or the first that shows. Null when none shows. */
  readonly currentWorkspaceId: string | null;
  /** What the phone has read of the open workspace. */
  readonly data: WorkspaceData | null;
  chooseWorkspace(workspaceId: string): void;
  reloadWorkspaces(): void;
  setShowOnPhone(workspaceId: string, showOnPhone: boolean): void;
}

const Context = createContext<AccountValue | null>(null);

const LOADING: WorkspaceList = { status: "loading" };
const noList = { subscribe: () => () => undefined, state: () => LOADING };

// A build without sample data: the phone's sign-in, the account's workspaces, and what the phone has read of the open
// one, for every screen. Requests go through expo/fetch, which honours the client's `credentials: "omit"` and
// `redirect: "error"` whatever the global fetch is.
//
// The open workspace's reads live in one store, made for its sign-in and workspace. Switching workspace, signing out
// and a new sign-in each make another and stop the last, so nothing the last one started can reach the screen. Its
// feed runs while the app is in the foreground. The read cache empties whenever the sign-in changes or ends.
export function AccountProvider({ children }: { children: ReactNode }) {
  const [account] = useState(() => createAccount({ store: secureSignInStore, fetch }));
  const state = useSyncExternalStore(account.subscribe, account.state);
  useEffect(() => void account.restore(), [account]);
  const signIn = state.status === "signed-in" ? state.signIn : null;

  const list = useMemo<WorkspaceListStore | null>(() => signIn && createWorkspaceList(signIn), [signIn]);
  const workspaces = useSyncExternalStore((list ?? noList).subscribe, (list ?? noList).state);
  const [chosenWorkspaceId, chooseWorkspace] = useState<string | null>(null);
  useEffect(() => {
    chooseWorkspace(null);
    list?.reload();
  }, [list]);
  const currentWorkspaceId = useMemo(() => {
    const shown = workspaces.status === "ready" ? workspaces.workspaces.filter(entry => entry.showOnPhone).map(entry => entry.workspaceId) : [];
    return shown.find(id => id === chosenWorkspaceId) ?? shown[0] ?? null;
  }, [workspaces, chosenWorkspaceId]);

  const [cache] = useState(createReadCache);
  useEffect(() => cache.follow(account), [account, cache]);
  // Made during render, so the first frame for a new workspace already reads from its own store. Making one starts
  // nothing: the effect starts its feed, and stops it once another replaces it.
  const data = useMemo(() => signIn && currentWorkspaceId ? createWorkspaceData({ signIn, workspaceId: currentWorkspaceId, cache }) : null,
    [signIn, currentWorkspaceId, cache]);
  useEffect(() => {
    if (!data) return;
    // In the background, iOS would end a held request anyway. A launch can report "unknown" before "active".
    if (AppState.currentState !== "background") data.resume();
    const subscription = AppState.addEventListener("change", next => next === "background" ? data.pause() : data.resume());
    return () => {
      subscription.remove();
      data.stop();
    };
  }, [data]);

  const value = useMemo<AccountValue>(() => ({
    account, state, workspaces, chosenWorkspaceId, chooseWorkspace, currentWorkspaceId, data,
    reloadWorkspaces: () => list?.reload(),
    setShowOnPhone: (workspaceId, showOnPhone) => list?.setShowOnPhone(workspaceId, showOnPhone),
  }), [account, state, workspaces, chosenWorkspaceId, currentWorkspaceId, data, list]);
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
