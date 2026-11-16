import { fetch } from "expo/fetch";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { AppState, View } from "react-native";
import {
  appTeardown,
  createAppRunner,
  createWorkspaceApps,
  type AppRunner,
  type WorkspaceApps,
} from "../apps/appStore";
import { canOpenApps } from "../apps/canOpenApps";
import { createChatWakes, type ChatWakes } from "../conversation/chatWakeState";
import { createAccount, type Account, type AccountState, type SignIn } from "../server/account";
import { createCacheFiles } from "../server/cacheFiles";
import { createKeptDatabase } from "../server/keptDatabase";
import { createNoticeFiles } from "../server/noticeFiles";
import {
  clearNoticesOnSignInChange,
  createNoticeStore,
  type NoticeStore,
} from "../server/noticeStore";
import { createOpenWorkspace, type OpenWorkspaceState } from "../server/openWorkspace";
import { createOutbox, type Outbox, type OutboxState } from "../server/outbox";
import { phoneWrites } from "../server/phoneWrites";
import { createReadCache, type WorkspaceData } from "../server/workspaceData";
import {
  createWorkspaceList,
  type WorkspaceList,
  type WorkspaceListStore,
} from "../server/workspaceList";
import { useTheme } from "../theme";
import { Connect } from "./Connect";
import { secureSignInStore } from "./secureSignInStore";

interface AccountValue {
  readonly account: Account;
  readonly state: AccountState;
  /** Chat writes waiting for the server. Only the composer adds to it, while phone writes are on. */
  readonly outbox: Outbox;
  /** Whether a Sign out's delete of the outbox failed. */
  readonly deletion: OutboxState["deletion"];
  readonly workspaces: WorkspaceList;
  /** The workspace open on the phone: the one chosen, or the first that shows. Null when none shows. */
  readonly currentWorkspaceId: string | null;
  readonly data: WorkspaceData | null;
  /** The account's Notices, whichever workspace is open. */
  readonly notices: NoticeStore | null;
  /** The wakes of the conversations on screen, one sign-in's and open workspace's, in memory only. */
  readonly wakes: ChatWakes | null;
  /** The app running on the phone, in memory only. */
  readonly runner: AppRunner;
  /** The open workspace's published apps. */
  readonly apps: WorkspaceApps | null;
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
// The account's Notices live in their own store, beside the list, so they outlive the open workspace
// (src/server/noticeStore.ts). It reads while the app is in the foreground, and reads the whole list again on each
// return, when the account's workspace list is read again too. Its files empty whenever the sign-in changes or ends.
//
// The outbox (src/server/outbox.ts) is the account's too, beside the cache and outside any workspace's store. It sends
// only with its records' own account, keeps them through a 401, and deletes them at Sign out. A read that shows a saved
// write's result hands it off. An app-state change tries again whatever failed, and asks again at once. Only where its
// Sign out delete stands reaches the screen, so the rest of its changes render nothing.
//
// A running app (src/apps/appStore.ts) ends before anything else happens at Sign out, a sign-in change, a workspace
// switch and Show on phone off.
export function AccountProvider({ children }: { children: ReactNode }) {
  const [runner] = useState(createAppRunner);
  const [teardown] = useState(() => appTeardown(runner));
  // Sign out deletes the account's outbox rows: the sign-in ends, and its token goes, once that delete has committed.
  // With phone writes off it sends nothing, not even records an earlier build kept. kept.db opens once per install.
  const [outbox] = useState(() =>
    createOutbox({ store: createKeptDatabase(), sends: phoneWrites }),
  );
  const [account] = useState(() =>
    createAccount({
      store: secureSignInStore,
      fetch,
      onSignOut: teardown.signOut((leave) => outbox.signOut(leave)),
    }),
  );
  const state = useSyncExternalStore(account.subscribe, account.state);
  useEffect(() => void account.restore(), [account]);
  // Subscribed before the cache and the outbox follow the account, so it runs before either clears anything.
  useEffect(() => teardown.follow(account), [account, teardown]);
  const signIn = state.status === "signed-in" ? state.signIn : null;

  const [cache] = useState(() => createReadCache(createCacheFiles()));
  useEffect(() => cache.follow(account), [account, cache]);

  useEffect(() => outbox.follow(account), [account, outbox]);
  const deletion = useSyncExternalStore(outbox.subscribe, () => outbox.state().deletion);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", () => outbox.wake());
    return () => subscription.remove();
  }, [outbox]);

  // The saved list shows until the server's answers, so a relaunch opens the last workspace from the cache.
  const list = useMemo<WorkspaceListStore | null>(
    () => signIn && createWorkspaceList(signIn, cache.savedList(signIn)),
    [signIn, cache],
  );
  const workspaces = useSyncExternalStore((list ?? noList).subscribe, (list ?? noList).state);
  useEffect(() => list?.reload(), [list]);
  // Made during render, so the first frame for a new workspace already reads from its own store. Making one starts
  // nothing: subscribing follows the list, and the effect runs the feed and stops it all once another replaces it.
  const open = useMemo(
    () =>
      signIn && list
        ? createOpenWorkspace({
            signIn,
            list,
            cache,
            onMessages: (workspaceId, messages) => outbox.handoff(signIn, workspaceId, messages),
          })
        : null,
    [signIn, list, cache, outbox],
  );
  const { currentWorkspaceId, data } = useSyncExternalStore(
    (open ?? noOpen).subscribe,
    (open ?? noOpen).state,
  );
  // A workspace that stops being the open one, here or from another device, ends its app as the open store changes.
  useEffect(
    () => open?.subscribe(() => teardown.open(open.state().currentWorkspaceId)),
    [open, teardown],
  );
  const apps = useMemo(
    () =>
      signIn && currentWorkspaceId
        ? createWorkspaceApps({
            signIn,
            workspaceId: currentWorkspaceId,
            runner,
            fetch,
            canOpen: canOpenApps,
          })
        : null,
    [signIn, currentWorkspaceId, runner],
  );
  useEffect(() => () => apps?.stop(), [apps]);
  const [noticeFiles] = useState(() => createNoticeFiles());
  useEffect(() => clearNoticesOnSignInChange(account, noticeFiles), [account, noticeFiles]);
  // As the open workspace's store: making one starts nothing, and the effect runs it.
  const notices = useMemo(
    () => (signIn && list ? createNoticeStore({ signIn, list, files: noticeFiles }) : null),
    [signIn, list, noticeFiles],
  );
  useEffect(() => {
    if (!open || !list || !notices) return;
    // In the background, iOS would end a held request anyway. A launch can report "unknown" before "active".
    let away = AppState.currentState === "background";
    if (!away) {
      open.resume();
      notices.resume();
    }
    const subscription = AppState.addEventListener("change", (next) => {
      if (next !== "background") {
        open.resume();
        // A return from the background reads the workspace list again, for a change made on another device.
        if (away) list.reload();
        away = false;
        return notices.resume();
      }
      away = true;
      open.pause();
      notices.pause();
      cache.flush();
      void noticeFiles.flush();
    });
    return () => {
      subscription.remove();
      open.stop();
      notices.stop();
    };
  }, [open, list, notices, cache, noticeFiles]);

  // Wakes, one sign-in's and open workspace's store's: a sign-in change or a workspace switch stops every read and wait
  // the last one started, before any screen or Notice row wants its conversations again. A Notice row reads its own
  // workspace's wakes through it. Nothing reads in the background.
  const instance = data?.instance ?? null;
  const wakes = useMemo(
    () => (signIn && instance !== null ? createChatWakes({ signIn }) : null),
    [signIn, instance],
  );
  useEffect(() => {
    if (!wakes) return;
    if (AppState.currentState === "background") wakes.pause();
    const subscription = AppState.addEventListener("change", (next) =>
      next === "background" ? wakes.pause() : wakes.resume(),
    );
    return () => {
      subscription.remove();
      wakes.stop();
    };
  }, [wakes]);

  const value = useMemo<AccountValue>(
    () => ({
      account,
      state,
      outbox,
      deletion,
      workspaces,
      currentWorkspaceId,
      data,
      notices,
      wakes,
      runner,
      apps,
      chooseWorkspace: (workspaceId) => {
        teardown.open(workspaceId);
        open?.choose(workspaceId);
      },
      reloadWorkspaces: () => list?.reload(),
      setShowOnPhone: (workspaceId, showOnPhone) => {
        if (!showOnPhone) teardown.hide(workspaceId);
        open?.setShowOnPhone(workspaceId, showOnPhone);
      },
    }),
    [
      account,
      state,
      outbox,
      deletion,
      workspaces,
      currentWorkspaceId,
      data,
      notices,
      wakes,
      runner,
      teardown,
      apps,
      list,
      open,
    ],
  );
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

export function AccountGate({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const { state, deletion } = useAccount();
  // Once Connect shows, it stays while a Sign out's delete has failed, even if a sign-in finishes meanwhile, so the
  // failure and Try again stay in sight. A Sign out that fails while signed in stays in Settings.
  const [onConnect, setOnConnect] = useState(false);
  const showConnect = state.status === "signed-out" || (onConnect && deletion !== "none");
  if (showConnect !== onConnect) setOnConnect(showConnect);
  if (state.status === "loading") return <View style={{ flex: 1, backgroundColor: theme.bg }} />;
  if (showConnect) return <Connect />;
  return children;
}
