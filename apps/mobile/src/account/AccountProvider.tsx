import { fetch } from "expo/fetch";
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { AppState, View } from "react-native";
import { nativeDurableFile } from "../../modules/durable-file";
import { createAccount, type Account, type AccountState, type SignIn } from "../server/account";
import { createCacheFiles } from "../server/cacheFiles";
import { createDurableFiles } from "../server/durableFiles";
import { createOpenWorkspace, type OpenWorkspaceState } from "../server/openWorkspace";
import { createOutbox, type Outbox } from "../server/outbox";
import { createReadCache, type WorkspaceData } from "../server/workspaceData";
import { createWorkspaceList, type WorkspaceList, type WorkspaceListStore } from "../server/workspaceList";
import { useTheme } from "../theme";
import { Connect } from "./Connect";
import { secureSignInStore } from "./secureSignInStore";

interface AccountValue {
  readonly account: Account;
  readonly state: AccountState;
  /** Chat writes waiting for the server. Nothing adds to it yet. */
  readonly outbox: Outbox;
  readonly workspaces: WorkspaceList;
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
const NONE: OpenWorkspaceState = { currentWorkspaceId: null, data: null };
const noOpen = { subscribe: () => () => undefined, state: () => NONE };

// A build without sample data: the phone's sign-in, the account's workspaces, and what the phone has read of the open
// one, for every screen. Requests go through expo/fetch, which honours the client's `credentials: "omit"` and
// `redirect: "error"` whatever the global fetch is.
//
// The open workspace's reads live in one store, made for its sign-in and workspace (src/server/openWorkspace.ts).
// Switching workspace, signing out and a new sign-in each make another and stop the last, so nothing the last one
// started can reach the screen. Its feed runs while the app is in the foreground. The read cache keeps a copy on disk,
// saved before the app goes to the background, so a relaunch shows what was read last. It empties, on disk too,
// whenever the sign-in changes or ends.
//
// The outbox (src/server/outbox.ts) is the account's too, beside the cache and outside any workspace's store. It sends
// only with its records' own account, keeps them through a 401, and deletes them at Sign out. A read that shows a saved
// write's result hands it off. An app-state change tries again whatever failed, and asks again at once.
export function AccountProvider({ children }: { children: ReactNode }) {
  // Sign out deletes the outbox: the sign-in ends, and its token goes, once that delete can't be lost.
  const [outbox] = useState(() => createOutbox({ files: createDurableFiles(nativeDurableFile()) }));
  const [account] = useState(() => createAccount({ store: secureSignInStore, fetch, onSignOut: leave => outbox.signOut(leave) }));
  const state = useSyncExternalStore(account.subscribe, account.state);
  useEffect(() => void account.restore(), [account]);
  const signIn = state.status === "signed-in" ? state.signIn : null;

  const [cache] = useState(() => createReadCache(createCacheFiles()));
  useEffect(() => cache.follow(account), [account, cache]);

  useEffect(() => outbox.follow(account), [account, outbox]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", () => outbox.wake());
    return () => subscription.remove();
  }, [outbox]);

  // The saved list shows until the server's answers, so a relaunch opens the last workspace from the cache.
  const list = useMemo<WorkspaceListStore | null>(() => signIn && createWorkspaceList(signIn, cache.savedList(signIn)), [signIn, cache]);
  const workspaces = useSyncExternalStore((list ?? noList).subscribe, (list ?? noList).state);
  useEffect(() => list?.reload(), [list]);
  // Made during render, so the first frame for a new workspace already reads from its own store. Making one starts
  // nothing: subscribing follows the list, and the effect runs the feed and stops it all once another replaces it.
  const open = useMemo(() => signIn && list ? createOpenWorkspace({
    signIn, list, cache, onMessages: (workspaceId, messages) => outbox.handoff(signIn, workspaceId, messages),
  }) : null, [signIn, list, cache, outbox]);
  const { currentWorkspaceId, data } = useSyncExternalStore((open ?? noOpen).subscribe, (open ?? noOpen).state);
  useEffect(() => {
    if (!open) return;
    // In the background, iOS would end a held request anyway. A launch can report "unknown" before "active".
    if (AppState.currentState !== "background") open.resume();
    const subscription = AppState.addEventListener("change", next => {
      if (next !== "background") return open.resume();
      open.pause();
      cache.flush();
    });
    return () => {
      subscription.remove();
      open.stop();
    };
  }, [open, cache]);

  const value = useMemo<AccountValue>(() => ({
    account, state, outbox, workspaces, currentWorkspaceId, data,
    chooseWorkspace: workspaceId => open?.choose(workspaceId),
    reloadWorkspaces: () => list?.reload(),
    setShowOnPhone: (workspaceId, showOnPhone) => open?.setShowOnPhone(workspaceId, showOnPhone),
  }), [account, state, outbox, workspaces, currentWorkspaceId, data, list, open]);
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
