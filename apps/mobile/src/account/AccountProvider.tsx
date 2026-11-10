import { fetch } from "expo/fetch";
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { View } from "react-native";
import { createAccount, type Account, type AccountState, type SignIn } from "../server/account";
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
  chooseWorkspace(workspaceId: string): void;
  reloadWorkspaces(): void;
  setShowOnPhone(workspaceId: string, showOnPhone: boolean): void;
}

const Context = createContext<AccountValue | null>(null);

const LOADING: WorkspaceList = { status: "loading" };
const noList = { subscribe: () => () => undefined, state: () => LOADING };

// A build without sample data: the phone's sign-in, and the account's workspaces, for every screen. Requests go
// through expo/fetch, which honours the client's `credentials: "omit"` and `redirect: "error"` whatever the global
// fetch is.
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

  const value = useMemo<AccountValue>(() => ({
    account, state, workspaces, chosenWorkspaceId, chooseWorkspace,
    reloadWorkspaces: () => list?.reload(),
    setShowOnPhone: (workspaceId, showOnPhone) => list?.setShowOnPhone(workspaceId, showOnPhone),
  }), [account, state, workspaces, chosenWorkspaceId, list]);
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
