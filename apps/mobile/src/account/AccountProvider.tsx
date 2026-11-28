import { accountWords } from "@dohc/interface-words/account";
import { fetch } from "expo/fetch";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { AppState, Platform, View } from "react-native";
import {
  appTeardown,
  createAppRunner,
  createWorkspaceApps,
  type AppRunner,
  type WorkspaceApps,
} from "../apps/appStore";
import { canOpenApps } from "../apps/canOpenApps";
import {
  createWorkspaceCollections,
  type WorkspaceCollections,
} from "../collections/collectionStore";
import { createChatWakes, type ChatWakes } from "../conversation/chatWakeState";
import { DamagedKept } from "../conversation/DamagedKept";
import { useOutboxState } from "../conversation/useOutbox";
import { createScopedEnds, type ScopedEnds } from "../pages/pageLive";
import { createAccount, type Account, type AccountState, type SignIn } from "../server/account";
import { clearBinaryCacheOnSignInChange, clearBinaryFileCache } from "../server/binaryFiles";
import { createCacheRows } from "../server/cacheRows";
import { createCaptureQueue, type CaptureQueue } from "../server/captureQueue";
import { createCacheDatabase, createKeptDatabase } from "../server/keptDatabase";
import { openNow } from "../server/keptStore";
import {
  clearNoticeListsOnSignInChange,
  createNoticeStore,
  type NoticeStore,
} from "../server/noticeStore";
import { createOpenWorkspace, type OpenWorkspaceState } from "../server/openWorkspace";
import { createOutbox, type Outbox, type OutboxState } from "../server/outbox";
import { phoneWrites } from "../server/phoneWrites";
import { pendingSignOuts } from "../server/pushRegistration";
import { createAlerts, type Alerts } from "../push/alerts";
import { clearAlertsAtSignOut, nativeAlerts } from "../push/nativeAlerts";
import { cacheScope, createReadCache, views, type WorkspaceData } from "../server/workspaceData";
import { pageTimings } from "../pages/pageTimings";
import {
  createWorkspaceList,
  type WorkspaceList,
  type WorkspaceListStore,
} from "../server/workspaceList";
import { launchTimings } from "../startup";
import { useTheme } from "../theme";
import { Connect } from "./Connect";
import { ProblemLine } from "./ProblemLine";
import { secureSignInStore } from "./secureSignInStore";

interface AccountValue {
  readonly account: Account;
  readonly state: AccountState;
  /** Chat writes waiting for the server. Only the composer adds to it, while phone writes are on. */
  readonly outbox: Outbox;
  readonly captureQueue: CaptureQueue;
  /** Whether a Sign out's delete of the outbox failed. */
  readonly deletion: OutboxState["deletion"];
  readonly workspaces: WorkspaceList;
  /** The workspace open on the phone: the one chosen, or the first that shows. Null when none shows. */
  readonly currentWorkspaceId: string | null;
  /** The workspace chosen last is still being read from this phone, so none is open yet. */
  readonly choosingWorkspace: boolean;
  readonly data: WorkspaceData | null;
  /** The account's Notices, whichever workspace is open. */
  readonly notices: NoticeStore | null;
  /** The wakes of the conversations on screen, one sign-in's and open workspace's, in memory only. */
  readonly wakes: ChatWakes | null;
  /** The app running on the phone, in memory only. */
  readonly runner: AppRunner;
  /** The open workspace's published apps. */
  readonly apps: WorkspaceApps | null;
  /** The open workspace's transactional Collections. */
  readonly collections: WorkspaceCollections | null;
  /** Pages edited live, which end with their sign-in and workspace, as a running app does. */
  readonly livePages: ScopedEnds;
  /** The sign-in's alerts on an iPhone, or null. */
  readonly alerts: Alerts | null;
  readonly workspaceList: WorkspaceListStore | null;
  chooseWorkspace(workspaceId: string): void;
  preloadWorkspace(workspaceId: string): void;
  reloadWorkspaces(): void;
  setShowOnPhone(workspaceId: string, showOnPhone: boolean): void;
}

const Context = createContext<AccountValue | null>(null);

const LOADING: WorkspaceList = { status: "loading" };
const noList = { subscribe: () => () => undefined, state: () => LOADING };
const NONE: OpenWorkspaceState = { currentWorkspaceId: null, data: null, choosing: false };
const noOpen = { subscribe: () => () => undefined, state: () => NONE };

// A build without sample data: the phone's sign-in, the account's workspaces, and what the phone has read of the open
// one, for every screen. Requests go through expo/fetch, which honours the client's `credentials: "omit"` and
// `redirect: "error"` whatever the global fetch is.
//
// The open workspace's reads live in one store, made for its sign-in and workspace (src/server/openWorkspace.ts).
// Switching workspace, signing out and a new sign-in each make another and stop the last, so nothing the last one
// started can reach the screen. Its feed runs while the app is in the foreground. The read cache keeps a copy in
// cache.db, saved before the app goes to the background, so a relaunch shows what was read last. Whenever the sign-in
// changes or ends, it empties and deletes cache.db; at Sign out, that comes after kept.db's commit.
//
// The account's Notices live in their own store, beside the list, so they outlive the open workspace
// (src/server/noticeStore.ts). It reads while the app is in the foreground, and reads the whole list again on each
// return, when the account's workspace list is read again too. Its list and marks are in kept.db. The list goes
// whenever the sign-in changes or ends; the marks wait for their account, and go at Sign out.
//
// The outbox (src/server/outbox.ts) is the account's too, beside the cache and outside any workspace's store. It sends
// only with its records' own account, keeps them through a 401, and deletes them, with the account's Notice rows, at
// Sign out. A read that shows a saved write's result hands it off. An app-state change tries again whatever failed, and
// asks again at once. Only where its Sign out delete stands reaches the screen, so the rest of its changes render
// nothing.
//
// A running app and the apps read (src/apps/appStore.ts), a page edited live (src/pages/pageLive.ts) and the Collections
// read (src/collections/collectionStore.ts) end before anything else happens at Sign out, a sign-in change (a 401
// included), a workspace switch, Show on phone off and a 404 for the workspace.
export function AccountProvider({ children }: { children: ReactNode }) {
  const [runner] = useState(createAppRunner);
  const [livePages] = useState(createScopedEnds);
  const [stores] = useState(createScopedEnds);
  const [teardown] = useState(() => appTeardown(runner, livePages, stores));
  // Sign out deletes the account's kept.db rows: the sign-in ends, and its token goes, once that delete has committed.
  // With phone writes off it sends nothing, not even records an earlier build kept. Both files open once per install.
  const [kept] = useState(createKeptDatabase);
  const [cacheFile] = useState(createCacheDatabase);
  const [cache] = useState(() => createReadCache(createCacheRows(cacheFile)));
  const [outbox] = useState(() => createOutbox({ store: kept, sends: phoneWrites }));
  const openRef = useRef<ReturnType<typeof createOpenWorkspace> | null>(null);
  const [captureQueue] = useState(() =>
    createCaptureQueue({
      store: kept,
      sends: phoneWrites,
      held: outbox.holding,
      onSaved: (workspaceId) => {
        const active = openRef.current?.state().data;
        if (active && active.workspaceId === workspaceId && active.isOpen()) {
          active.invalidate(views.files);
          active.invalidate(views.documentCollections);
        }
      },
    }),
  );
  const [account] = useState(() =>
    createAccount({
      store: secureSignInStore,
      fetch,
      onSignOut: teardown.signOut(async (leave, ending) => {
        clearBinaryFileCache();
        await captureQueue.holdForSignOut();
        try {
          await outbox.signOut(leave, ending);
        } finally {
          clearBinaryFileCache();
          captureQueue.releaseSignOut();
        }
      }),
      pendingSignOuts: pendingSignOuts(kept),
      onSaved: (saved) => cache.preload(saved),
    }),
  );
  const state = useSyncExternalStore(account.subscribe, account.state);
  useEffect(() => {
    void openNow([kept, cacheFile]).then((opened) => opened && launchTimings?.mark("databases"));
    void account.restore();
  }, [account, kept, cacheFile]);
  // Subscribed before the cache and the outbox follow the account, so it runs before either clears anything.
  useEffect(() => teardown.follow(account), [account, teardown]);
  const signIn = state.status === "signed-in" ? state.signIn : null;

  useEffect(() => cache.follow(account), [account, cache]);
  useEffect(() => clearBinaryCacheOnSignInChange(account), [account]);
  useEffect(() => pageTimings?.follow(account), [account]);

  useEffect(() => outbox.follow(account), [account, outbox]);
  useEffect(() => captureQueue.follow(account), [account, captureQueue]);
  const deletion = useSyncExternalStore(outbox.subscribe, () => outbox.state().deletion);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", () => {
      outbox.wake();
      captureQueue.wake();
    });
    return () => subscription.remove();
  }, [outbox, captureQueue]);

  // The saved list shows until the server's answers, so a relaunch opens the last workspace from the cache.
  const list = useMemo<WorkspaceListStore | null>(
    () => signIn && createWorkspaceList(signIn, cache.savedList(signIn)),
    [signIn, cache],
  );
  const workspaces = useSyncExternalStore((list ?? noList).subscribe, (list ?? noList).state);
  useEffect(() => {
    if (workspaces.status !== "ready") return;
    captureQueue.workspaces(
      workspaces.workspaces
        .filter((w) => w.showOnPhone && w.canOpen && w.role === "owner")
        .map((w) => w.workspaceId),
    );
  }, [captureQueue, workspaces]);
  useEffect(() => list?.reload(), [list]);
  const open = useMemo(
    () =>
      signIn && list
        ? createOpenWorkspace({
            signIn,
            list,
            cache,
            onMessages: (workspaceId, messages) => outbox.handoff(signIn, workspaceId, messages),
            // A workspace that stops being the open one, here or from another device, ends its apps and live pages
            // before its store stops.
            beforeSwitch: teardown.open,
            onGone: teardown.hide,
          })
        : null,
    [signIn, list, cache, outbox, teardown],
  );
  const { currentWorkspaceId, data, choosing } = useSyncExternalStore(
    (open ?? noOpen).subscribe,
    (open ?? noOpen).state,
  );
  openRef.current = open;
  if (currentWorkspaceId && !choosing) launchTimings?.mark("chosen");
  const apps = useMemo(
    () =>
      signIn && data
        ? createWorkspaceApps({
            signIn,
            workspaceId: data.workspaceId,
            runner,
            fetch,
            canOpen: canOpenApps,
            cache,
            ends: stores,
            role: data.role,
            open: data.isOpen,
          })
        : null,
    [signIn, data, runner, cache, stores],
  );
  useEffect(() => () => apps?.stop(), [apps]);
  const collections = useMemo(
    () =>
      signIn && data
        ? createWorkspaceCollections(
            signIn,
            data.workspaceId,
            stores,
            cache,
            data.role,
            data.isOpen,
          )
        : null,
    [signIn, data, stores, cache],
  );
  useEffect(() => () => collections?.stop(), [collections]);
  useEffect(() => clearNoticeListsOnSignInChange(account, kept), [account, kept]);
  // As the open workspace's store: making one starts nothing, and the effect runs it.
  const notices = useMemo(
    () =>
      signIn && list
        ? createNoticeStore({ signIn, list, store: kept, held: outbox.holding })
        : null,
    [signIn, list, kept, outbox],
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
    });
    return () => {
      subscription.remove();
      open.stop();
      notices.stop();
    };
  }, [open, list, notices, cache]);

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

  const alerts = useMemo(
    () =>
      signIn && Platform.OS === "ios"
        ? createAlerts({
            signIn,
            store: kept,
            native: nativeAlerts,
            environment: __DEV__ ? "sandbox" : "production",
          })
        : null,
    [signIn, kept],
  );
  useEffect(() => {
    if (!alerts) return;
    void alerts.sync();
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") void alerts.sync();
    });
    return () => {
      subscription.remove();
      alerts.stop();
    };
  }, [alerts]);
  useEffect(() => (Platform.OS === "ios" ? clearAlertsAtSignOut(account) : undefined), [account]);

  const value = useMemo<AccountValue>(
    () => ({
      account,
      state,
      outbox,
      captureQueue,
      deletion,
      workspaces,
      currentWorkspaceId,
      choosingWorkspace: choosing,
      data,
      notices,
      wakes,
      runner,
      apps,
      collections,
      livePages,
      alerts,
      workspaceList: list,
      chooseWorkspace: (workspaceId) => open?.choose(workspaceId),
      preloadWorkspace: (workspaceId) => {
        if (!signIn || workspaces.status !== "ready") return;
        const entry = workspaces.workspaces.find((each) => each.workspaceId === workspaceId);
        if (entry && entry.showOnPhone && entry.canOpen)
          void cache.restore(cacheScope(signIn, entry.workspaceId, entry.role));
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
      captureQueue,
      deletion,
      workspaces,
      currentWorkspaceId,
      choosing,
      data,
      notices,
      wakes,
      runner,
      teardown,
      apps,
      collections,
      livePages,
      alerts,
      list,
      open,
      signIn,
      cache,
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
  const { account, state, deletion, outbox } = useAccount();
  const damaged = useOutboxState(outbox)?.status === "damaged";
  // Once Connect shows, it stays while a Sign out's delete has failed, even if a sign-in finishes meanwhile, so the
  // failure and Try again stay in sight. A Sign out that fails while signed in stays in Settings.
  const [onConnect, setOnConnect] = useState(false);
  const showConnect = state.status === "signed-out" || (onConnect && deletion !== "none");
  if (showConnect !== onConnect) setOnConnect(showConnect);
  if (state.status === "loading") return <View style={{ flex: 1, backgroundColor: theme.bg }} />;
  if (state.status === "unreadable")
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg, justifyContent: "center", padding: 24 }}>
        <ProblemLine text={accountWords.savedUnreadable} onRetry={() => void account.restore()} />
        {damaged ? (
          <DamagedKept outbox={outbox} live={() => true} onDeleted={() => void account.restore()} />
        ) : null}
      </View>
    );
  if (showConnect) return <Connect />;
  return children;
}
