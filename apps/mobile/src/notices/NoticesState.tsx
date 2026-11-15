import { accountWords } from "@dohc/interface-words/account";
import { noticesWords } from "@dohc/interface-words/notices";
import { useRouter } from "expo-router";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useAccount, useSignIn } from "../account/AccountProvider";
import { demoMode } from "../demo";
import { sampleBuild } from "../sampleBuild";
import type { NoticeRecord } from "../server/notices";
import type { NoticeFailure, NoticeListState } from "../server/noticeStore";
import { serverName } from "../server/origin";
import { phoneWrites } from "../server/phoneWrites";
import { readThread } from "../server/workspaceReads";
import { failureStep, type Reported } from "../workspace/failureReports";
import {
  createNoticeTargets,
  noticeAction,
  replyCandidate,
  targetKey,
  type MentionTarget,
  type TargetRead,
} from "./noticeWrites";
import { phoneTarget, presentNotice, type PhoneNotice, type PhoneTarget } from "./phoneNotice";
import { useHideToast, useShowToast } from "./Toast";
import { doneToast } from "./toastSlots";

// The sample's notices, in a sample build only (src/sampleBuild.ts).
// src/routes.test.ts reads the next statement as text, on one line.
// oxfmt-ignore
const sample = __DEV__ || process.env.EXPO_PUBLIC_DOHC_SAMPLE === "1" ? (require("./sample") as typeof import("./sample")) : null;

interface NoticesState {
  readonly notices: readonly PhoneNotice[];
  readonly unread: number;
  /** The whole list is known, so no rows means none. */
  readonly known: boolean;
  /** A new failure held on this phone goes on top, unread, replacing an earlier one with its id. */
  add(notice: PhoneNotice): void;
  /** Done for a Notice from the server, with Undo on a toast; Dismiss for a failure held on this phone. */
  dismiss(id: string): void;
  /** Marks a Notice from the server read or unread. */
  setRead(id: string, read: boolean): void;
  markAllRead(): void;
  /** Reads the account's Notices again from the start. */
  refresh(): void;
  /** The rows on screen, by ID, while Notices is: a mention among them reads its message, to offer Reply. */
  see(ids: readonly string[]): void;
}

const State = createContext<NoticesState | null>(null);

/** Failures held on this phone, newest first. */
function useLocalNotices(initial: readonly PhoneNotice[]) {
  const [notices, setNotices] = useState(initial);
  const add = useCallback(
    (notice: PhoneNotice) =>
      setNotices((previous) => [notice, ...previous.filter((entry) => entry.id !== notice.id)]),
    [],
  );
  const remove = useCallback(
    (id: string) => setNotices((previous) => previous.filter((notice) => notice.id !== id)),
    [],
  );
  const readAll = useCallback(
    () => setNotices((previous) => previous.map((notice) => ({ ...notice, read: true }))),
    [],
  );
  return useMemo(() => ({ notices, add, remove, readAll }), [notices, add, remove, readAll]);
}

// One list for the Notices tab and its badge, so marking read clears both.
export function NoticesProvider({ children }: { children: ReactNode }) {
  return sampleBuild ? (
    <SampleNoticesState>{children}</SampleNoticesState>
  ) : (
    <ServerNoticesState>{children}</ServerNoticesState>
  );
}

function SampleNoticesState({ children }: { children: ReactNode }) {
  const local = useLocalNotices(
    !sample || demoMode === "empty" || demoMode === "band-empty"
      ? []
      : demoMode === "notice-end-failed" ||
          demoMode === "notice-clipped" ||
          demoMode === "notice-clipped-open"
        ? [sample.endFailedSample, ...sample.sampleNotices]
        : demoMode === "notices-reply"
          ? [...sample.sampleNotices, sample.replySample]
          : sample.sampleNotices,
  );
  const value = useMemo<NoticesState>(
    () => ({
      notices: local.notices,
      unread: local.notices.filter((notice) => !notice.read).length,
      known: true,
      add: local.add,
      dismiss: local.remove,
      setRead: () => undefined,
      markAllRead: local.readAll,
      refresh: () => undefined,
      see: () => undefined,
    }),
    [local],
  );
  return <State value={value}>{children}</State>;
}

const NO_NOTICES: NoticeListState = {
  notices: [],
  known: false,
  reads: { problem: null, failures: 0 },
  marks: { problem: null, failures: 0 },
};
const noSubscribe = () => () => undefined;
const noState = () => NO_NOTICES;
const NO_READS: ReadonlyMap<string, TargetRead> = new Map();
const noReads = () => NO_READS;

// The account's Notices from the server, with failures held on this phone on top.
function ServerNoticesState({ children }: { children: ReactNode }) {
  const {
    notices: store,
    workspaces,
    currentWorkspaceId,
    chooseWorkspace,
    reloadWorkspaces,
  } = useAccount();
  const relay = useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.state ?? noState);
  const local = useLocalNotices([]);
  const router = useRouter();
  const showToast = useShowToast();
  const signIn = useSignIn();

  // The reads behind Reply, one sign-in's, made only where phone writes are on. Making one starts nothing: rows on
  // screen ask for theirs through `see`.
  const targets = useMemo(
    () =>
      phoneWrites
        ? createNoticeTargets({
            signIn,
            read: (workspaceId, threadId, signal) =>
              readThread(signIn.client, workspaceId, threadId, signal),
          })
        : null,
    [signIn],
  );
  useEffect(() => () => targets?.stop(), [targets]);
  const reads = useSyncExternalStore(targets?.subscribe ?? noSubscribe, targets?.state ?? noReads);
  // The handlers check the latest list and records through these when the person acts.
  const latest = useRef({ workspaces, records: relay.notices });
  latest.current = { workspaces, records: relay.notices };

  // Opening reads the Notice, and opens its target in its own workspace. It never runs anything.
  const open = useCallback(
    (record: NoticeRecord, target: PhoneTarget) => {
      if (record.readAtMs === null) store?.mark(record.noticeId, "read");
      if (target.kind === "agents") return router.push("/settings");
      chooseWorkspace(target.workspaceId);
      if (target.kind === "page")
        return router.push({
          pathname: "/page",
          params: { path: target.path, workspace: target.workspaceId },
        });
      router.push({
        pathname: "/chat/[id]",
        params: {
          id: target.threadId,
          thread: "1",
          workspace: target.workspaceId,
          ...(target.messageId === null ? {} : { message: target.messageId }),
        },
      });
    },
    [store, router, chooseWorkspace],
  );

  // Reply opens a mention's thread with its message chosen, as Open opens it, once the latest list, sign-in and read
  // still show that message. When they no longer do, it opens the target as Open does, if the phone still shows it.
  const reply = useCallback(
    (record: NoticeRecord) => {
      const list = latest.current.workspaces;
      const action = noticeAction(record, {
        list,
        writes: phoneWrites,
        signIn,
        reads: targets?.state() ?? NO_READS,
      });
      if (action.kind !== "reply") {
        const target = phoneTarget(record, list);
        return target ? open(record, target) : undefined;
      }
      const { workspaceId, threadId, messageId } = action.target;
      if (record.readAtMs === null) store?.mark(record.noticeId, "read");
      chooseWorkspace(workspaceId);
      router.push({
        pathname: "/chat/[id]",
        params: {
          id: threadId,
          thread: "1",
          workspace: workspaceId,
          message: messageId,
          reply: messageId,
        },
      });
    },
    [signIn, targets, open, store, chooseWorkspace, router],
  );
  const retryTarget = useCallback(
    (record: NoticeRecord) => {
      const target = replyCandidate(record, latest.current.workspaces, phoneWrites);
      if (target) targets?.retry(target);
    },
    [targets],
  );

  // A row the store didn't change, whose read didn't change, keeps its object, so its NoticeRow doesn't draw again.
  const presented = useMemo(
    () =>
      new WeakMap<
        NoticeRecord,
        { readonly read: TargetRead | undefined; readonly notice: PhoneNotice }
      >(),
    [workspaces, currentWorkspaceId, open, reply, retryTarget],
  );
  const relayNotices = useMemo(
    () =>
      relay.notices.map((record) => {
        const candidate = replyCandidate(record, workspaces, phoneWrites);
        const read = candidate ? reads.get(targetKey(candidate)) : undefined;
        const known = presented.get(record);
        if (known && known.read === read) return known.notice;
        const action = noticeAction(record, {
          list: workspaces,
          writes: phoneWrites,
          signIn,
          reads,
        });
        const notice = presentNotice(record, {
          list: workspaces,
          currentWorkspaceId,
          action,
          open,
          reply,
          retryTarget,
        });
        presented.set(record, { read, notice });
        return notice;
      }),
    [
      relay.notices,
      presented,
      workspaces,
      currentWorkspaceId,
      open,
      reply,
      retryTarget,
      reads,
      signIn,
    ],
  );

  // Only the mentions on screen read their messages, one read per workspace and thread.
  const visible = useRef<readonly string[]>([]);
  const wantVisible = useCallback(() => {
    if (!targets) return;
    const ids = new Set(visible.current);
    const { workspaces: list, records } = latest.current;
    const wanted: MentionTarget[] = [];
    for (const record of records) {
      if (!ids.has(`relay:${record.noticeId}`)) continue;
      const candidate = replyCandidate(record, list, phoneWrites);
      if (candidate) wanted.push(candidate);
    }
    targets.want(wanted);
  }, [targets]);
  const see = useCallback(
    (ids: readonly string[]) => {
      visible.current = ids;
      wantVisible();
    },
    [wantVisible],
  );
  // A list that became ready, or a row that changed, while on screen.
  useEffect(() => wantVisible(), [wantVisible, workspaces, relay.notices]);
  const notices = useMemo(() => [...local.notices, ...relayNotices], [local.notices, relayNotices]);
  // The handlers read the list through this, so they keep their identity: a failure report takes itself back when its
  // `dismiss` changes.
  const shown = useRef(notices);
  shown.current = notices;

  const dismiss = useCallback(
    (id: string) => {
      const relayId = shown.current.find((notice) => notice.id === id)?.relayId;
      if (relayId === undefined) return local.remove(id);
      store?.mark(relayId, "dismissed");
      showToast(doneToast(relayId, () => store?.mark(relayId, "restore")));
    },
    [store, local.remove, showToast],
  );
  const setRead = useCallback(
    (id: string, read: boolean) => {
      const relayId = shown.current.find((entry) => entry.id === id)?.relayId;
      if (relayId !== undefined) store?.mark(relayId, read ? "read" : "unread");
    },
    [store],
  );
  const markAllRead = useCallback(() => {
    store?.markAllRead();
    local.readAll();
  }, [store, local.readAll]);
  // A refresh reads the workspace list too, for a Show on phone change made on another device, and the mentions'
  // messages.
  const refresh = useCallback(() => {
    store?.refresh();
    reloadWorkspaces();
    targets?.refresh();
  }, [store, reloadWorkspaces, targets]);

  const instance = store?.instance ?? 0;
  useReport("notices:reads", noticesWords.readFailed, relay.reads, instance, refresh, local);
  const retryMarks = useCallback(() => store?.retryMarks(), [store]);
  useReport("notices:marks", noticesWords.marksFailed, relay.marks, instance, retryMarks, local);

  const value = useMemo<NoticesState>(
    () => ({
      notices,
      unread: notices.filter((notice) => !notice.read).length,
      known: relay.known,
      add: local.add,
      dismiss,
      setRead,
      markAllRead,
      refresh,
      see,
    }),
    [notices, relay.known, local.add, dismiss, setRead, markAllRead, refresh, see],
  );
  return <State value={value}>{children}</State>;
}

/**
 * Reports a failing read or send of the account's Notices once, as a toast on the other tabs and a row here, both with
 * Try again. Its next success takes both back.
 */
function useReport(
  id: string,
  title: string,
  state: NoticeFailure,
  instance: number,
  retry: () => void,
  local: { add(notice: PhoneNotice): void; remove(id: string): void },
) {
  const showToast = useShowToast();
  const hideToast = useHideToast();
  const server = serverName(useSignIn().origin);
  const reported = useRef<Reported>({ instance, failures: 0 });
  const { add, remove } = local;
  useEffect(() => {
    const step = failureStep(reported.current, instance, state);
    reported.current = step.reported;
    if (step.takeBack) {
      hideToast(id);
      remove(id);
    }
    if (!step.show || state.problem === null) return;
    const body =
      state.problem === "storage"
        ? noticesWords.marksNotStored
        : accountWords.problem(state.problem, server);
    showToast({
      id,
      tone: "failure",
      title,
      body,
      action: { label: noticesWords.tryAgain, onPress: retry },
    });
    add({
      id,
      senderKind: null,
      senderLabel: "",
      title,
      body,
      minutesAgo: 0,
      atMs: Date.now(),
      read: false,
      retry: true,
      onRetry: retry,
      dismissible: true,
      failed: true,
    });
  }, [id, title, state, instance, retry, server, showToast, hideToast, add, remove]);
}

export function useNotices(): NoticesState {
  const state = useContext(State);
  if (!state) throw new Error("useNotices needs NoticesProvider");
  return state;
}
