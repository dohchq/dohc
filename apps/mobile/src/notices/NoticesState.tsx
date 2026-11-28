import { accountWords } from "@dohc/interface-words/account";
import { noticeStorageWords, noticesWords } from "@dohc/interface-words/notices";
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
import { blockedBy, type OutboxRecord } from "../conversation/conversationWrites";
import { useLocalActions, useOutboxState } from "../conversation/useOutbox";
import { demoMode } from "../demo";
import { sampleBuild } from "../sampleBuild";
import type { NoticeRecord } from "../server/notices";
import { isStorageProblem, type NoticeFailure, type NoticeListState } from "../server/noticeStore";
import { serverName } from "../server/origin";
import { phoneWrites } from "../server/phoneWrites";
import { readChats, readThread } from "../server/workspaceReads";
import { failureStep, type Reported } from "../workspace/failureReports";
import type { WakeView } from "../conversation/chatWakeState";
import {
  answerLookup,
  answerReply,
  answerView,
  createNoticeEditor,
  namedQuestion,
  rereadSaved,
  type AnswerVisit,
} from "./noticeAnswers";
import {
  answerCandidate,
  candidateOf,
  createNoticeTargets,
  isPost,
  noticeAction,
  shownQuestion,
  targetKey,
  verifiedQuestion,
  type MessageTarget,
  type TargetRead,
} from "./noticeWrites";
import { phoneTarget, presentNotice, type PhoneNotice, type PhoneTarget } from "./phoneNotice";
import { useHideToast, useShowToast } from "./Toast";
import { markDone } from "./toastSlots";

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
  /**
   * The rows on screen, by ID, while Notices is, or null once it isn't: a mention or an agent's question among them
   * reads its message, to offer Reply or Answer. Leaving Notices closes a row's answer.
   */
  see(ids: readonly string[] | null): void;
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
          : demoMode === "notices-answer"
            ? [...sample.answerSamples.map((each) => each.notice), ...sample.sampleNotices]
            : sample.sampleNotices,
  );
  const notices = useSampleAnswers(local.notices);
  const value = useMemo<NoticesState>(
    () => ({
      notices,
      unread: notices.filter((notice) => !notice.read).length,
      known: true,
      add: local.add,
      dismiss: local.remove,
      setRead: () => undefined,
      markAllRead: local.readAll,
      refresh: () => undefined,
      see: () => undefined,
    }),
    [notices, local],
  );
  return <State value={value}>{children}</State>;
}

const always = { isCurrent: () => true };

/**
 * Design review only, in notices-answer: the sample's answer rows, over an outbox in memory that reaches no server, as
 * the signed-in rows are over the account's.
 */
function useSampleAnswers(notices: readonly PhoneNotice[]): readonly PhoneNotice[] {
  const router = useRouter();
  const asks = demoMode === "notices-answer" && sample ? sample.answerSamples : null;
  const [outbox] = useState(() => (asks && sample ? sample.answerOutbox() : null));
  const state = useOutboxState(outbox);
  const [editor] = useState(() =>
    createNoticeEditor({
      signIn: always,
      outbox,
      enabled: outbox !== null,
      verify: (noticeId) => {
        const ask = asks?.find((each) => each.notice.id === noticeId);
        return ask && sample ? verifiedQuestion(ask.target, sample.answerRead) : null;
      },
      answers: (target) =>
        sample
          ? answerLookup(outbox?.state() ?? null, sample.answerScope)(
              target.workspaceId,
              target.messageId,
            )
          : [],
    }),
  );
  const visit = useSyncExternalStore(editor.subscribe, editor.state);
  const actions = useLocalActions(editor.recovery, state ? blockedBy(state, true) !== null : true);
  return useMemo(() => {
    if (!asks || !sample) return notices;
    const answersOf = answerLookup(state, sample.answerScope);
    const read = sample.answerRead;
    const openChat = () =>
      router.push({ pathname: "/chat/[id]", params: { id: "g-planning", name: "planning" } });
    return notices.map((notice) => {
      const ask = asks.find((each) => each.notice.id === notice.id);
      if (!ask) return notice;
      const view = answerView({
        noticeId: notice.id,
        shown: shownQuestion(ask.target, read),
        verified: verifiedQuestion(ask.target, read),
        showing: true,
        named: ask.target,
        answers: answersOf(ask.target.workspaceId, ask.target.messageId),
        editor,
        visit,
        actions,
        open: openChat,
      });
      const answerable = view?.answerable === true;
      return {
        ...notice,
        open: answerable ? ("answer" as const) : ("open" as const),
        onOpen: answerable ? () => void editor.open(notice.id) : openChat,
        ...(view ? { answer: view } : {}),
      };
    });
  }, [asks, notices, state, editor, visit, actions, router]);
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
const NO_ANSWERS: readonly OutboxRecord[] = [];
const noVersion = () => 0;
const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, index) => id === b[index]);

// The account's Notices from the server, with failures held on this phone on top.
function ServerNoticesState({ children }: { children: ReactNode }) {
  const {
    notices: store,
    workspaces,
    currentWorkspaceId,
    chooseWorkspace,
    reloadWorkspaces,
    outbox,
    wakes,
  } = useAccount();
  const relay = useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.state ?? noState);
  const local = useLocalNotices([]);
  const router = useRouter();
  const showToast = useShowToast();
  const signIn = useSignIn();
  const outboxState = useOutboxState(phoneWrites ? outbox : null);

  // The reads behind Reply and Answer, one sign-in's, made only where phone writes are on. Making one starts nothing:
  // rows on screen ask for theirs through `see`. An agent's question also reads its workspace's chat list, so its answer
  // goes where the open thread would put it. A read that shows a saved answer's reply hands it off, as the open
  // workspace's reads do. Nothing here marks a thread read.
  const targets = useMemo(
    () =>
      phoneWrites
        ? createNoticeTargets({
            signIn,
            read: (workspaceId, threadId, signal) =>
              readThread(signIn.client, workspaceId, threadId, signal),
            readPost: async (workspaceId, threadId, signal) =>
              isPost((await readChats(signIn.client, workspaceId, signal)).value, threadId),
            onThread: (workspaceId, thread) => outbox.handoff(signIn, workspaceId, thread.messages),
          })
        : null,
    [signIn, outbox],
  );
  useEffect(() => () => targets?.stop(), [targets]);
  const reads = useSyncExternalStore(targets?.subscribe ?? noSubscribe, targets?.state ?? noReads);
  // The handlers check the latest list and records through these when the person acts.
  const latest = useRef({ workspaces, records: relay.notices });
  latest.current = { workspaces, records: relay.notices };

  // This phone's answers in the account's outbox, whatever the list shows now.
  const scope = useMemo(() => ({ origin: signIn.origin, accountId: signIn.userId }), [signIn]);
  const answersOf = useMemo(() => answerLookup(outboxState, scope), [outboxState, scope]);
  const answersFor = useCallback(
    (target: MessageTarget) => answersOf(target.workspaceId, target.messageId),
    [answersOf],
  );

  // The in-row answer, one sign-in's, so a change of sign-in closes it and its field. Each write goes to the Notice's
  // own workspace, once the latest list and read still verify its question.
  const editor = useMemo(
    () =>
      createNoticeEditor({
        signIn,
        outbox: phoneWrites ? outbox : null,
        enabled: phoneWrites,
        verify: (noticeId) => {
          const { workspaces: list, records } = latest.current;
          const record = records.find((each) => `relay:${each.noticeId}` === noticeId);
          const candidate =
            record && signIn.isCurrent() ? answerCandidate(record, list, phoneWrites) : null;
          return candidate && targets
            ? verifiedQuestion(candidate, targets.state().get(targetKey(candidate)))
            : null;
        },
        answers: (target) =>
          answerLookup(outbox.state(), scope)(target.workspaceId, target.messageId),
      }),
    [signIn, outbox, targets, scope],
  );
  useEffect(() => () => editor.stop(), [editor]);
  const visit = useSyncExternalStore(editor.subscribe, editor.state);
  const answerActions = useLocalActions(
    editor.recovery,
    outboxState ? blockedBy(outboxState, phoneWrites) !== null : true,
  );

  // Opening reads the Notice, and opens its target in its own workspace. It never runs anything.
  const open = useCallback(
    (record: NoticeRecord, target: PhoneTarget) => {
      if (record.readAtMs === null) void store?.mark(record.noticeId, "read");
      if (target.kind === "agents") return router.push("/settings");
      chooseWorkspace(target.workspaceId);
      if (target.kind === "page")
        return router.push({
          pathname: "/page",
          params: { path: target.path, workspace: target.workspaceId, t0: String(Date.now()) },
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
      if (record.readAtMs === null) void store?.mark(record.noticeId, "read");
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
  // Answer opens the row's own answer, once the latest list, sign-in and read still verify the question, and reads the
  // Notice. It never opens or switches a workspace. When they no longer verify it, it opens the target as Open does.
  const answer = useCallback(
    (record: NoticeRecord) => {
      if (editor.open(`relay:${record.noticeId}`)) {
        if (record.readAtMs === null) void store?.mark(record.noticeId, "read");
        return;
      }
      const target = phoneTarget(record, latest.current.workspaces);
      if (target) open(record, target);
    },
    [editor, store, open],
  );
  const retryTarget = useCallback(
    (record: NoticeRecord) => {
      const target = candidateOf(record, latest.current.workspaces, phoneWrites);
      if (target) targets?.retry(target);
    },
    [targets],
  );

  // The wakes of each answered question's chosen reply, read in the Notice's own workspace, only for rows on screen and
  // the row whose answer is open.
  const wakeVersion = useSyncExternalStore(
    wakes?.subscribe ?? noSubscribe,
    wakes?.version ?? noVersion,
  );
  const [seen, setSeen] = useState<readonly string[]>([]);

  // A row the store didn't change, whose read, answers, visit and wakes didn't change, keeps its object, so its
  // NoticeRow doesn't draw again.
  const presented = useMemo(
    () =>
      new WeakMap<
        NoticeRecord,
        {
          readonly read: TargetRead | undefined;
          readonly answers: readonly OutboxRecord[];
          readonly visit: AnswerVisit | null;
          readonly wakes: WakeView | null;
          readonly notice: PhoneNotice;
        }
      >(),
    [
      workspaces,
      currentWorkspaceId,
      open,
      reply,
      answer,
      retryTarget,
      editor,
      answerActions,
      wakes,
    ],
  );
  const relayNotices = useMemo(
    () =>
      relay.notices.map((record) => {
        const candidate = candidateOf(record, workspaces, phoneWrites);
        const read = candidate ? reads.get(targetKey(candidate)) : undefined;
        // The answers this phone keeps show whatever the list says now, so one for a hidden workspace keeps Discard.
        const named = phoneWrites ? namedQuestion(record) : null;
        const answers = named ? answersOf(named.workspaceId, named.messageId) : NO_ANSWERS;
        const editing = visit?.noticeId === `relay:${record.noticeId}` ? visit : null;
        const asked = candidate?.answer === true && signIn.isCurrent() ? candidate : null;
        const shown = asked ? shownQuestion(asked, read) : null;
        const chosen = answerReply(shown);
        const wakeView =
          asked && chosen !== null && wakes
            ? wakes.view(asked.workspaceId, { kind: "thread", threadId: asked.threadId })
            : null;
        const known = presented.get(record);
        if (
          known &&
          known.read === read &&
          known.answers === answers &&
          known.visit === editing &&
          known.wakes === wakeView
        )
          return known.notice;
        const action = noticeAction(record, {
          list: workspaces,
          writes: phoneWrites,
          signIn,
          reads,
          answers: answersFor,
        });
        const notice = presentNotice(record, {
          list: workspaces,
          currentWorkspaceId,
          action,
          open,
          reply,
          answer,
          retryTarget,
        });
        const target = phoneTarget(record, workspaces);
        const view = named
          ? answerView({
              noticeId: notice.id,
              shown,
              verified: asked ? verifiedQuestion(asked, read) : null,
              showing: asked !== null,
              named,
              answers,
              editor,
              visit: editing,
              actions: answerActions,
              ...(target ? { open: () => open(record, target) } : {}),
            })
          : null;
        const chosenWakes = chosen === null ? undefined : wakeView?.byMessage.get(chosen);
        // A failed read shows on the chosen answer even when no wake of it is known yet, with Try again.
        const withWakes =
          view && asked && wakes && wakeView && chosen !== null && (chosenWakes || wakeView.failed)
            ? {
                ...view,
                wakes: {
                  wakes: chosenWakes ?? [],
                  failed: wakeView.failed,
                  retry: () => wakes.refresh(asked.workspaceId),
                },
              }
            : view;
        const row = withWakes ? { ...notice, answer: withWakes } : notice;
        presented.set(record, { read, answers, visit: editing, wakes: wakeView, notice: row });
        return row;
      }),
    [
      relay.notices,
      presented,
      workspaces,
      currentWorkspaceId,
      open,
      reply,
      answer,
      retryTarget,
      reads,
      signIn,
      answersOf,
      answersFor,
      visit,
      editor,
      answerActions,
      wakes,
      // The wakes' views change apart from the rows' records.
      wakeVersion,
    ],
  );

  // Each chosen reply's thread wakes are wanted while its row is on screen or its answer is open, one per workspace
  // and thread. A new read of that thread wants them again, which reads them again.
  const wakeThreads = useMemo(() => {
    const ids = new Set(seen);
    if (visit) ids.add(visit.noticeId);
    const byKey = new Map<string, { readonly target: MessageTarget; readonly read: TargetRead }>();
    for (const record of relay.notices) {
      if (!ids.has(`relay:${record.noticeId}`)) continue;
      const candidate = answerCandidate(record, workspaces, phoneWrites);
      if (!candidate || !signIn.isCurrent()) continue;
      const read = reads.get(targetKey(candidate));
      if (read && answerReply(shownQuestion(candidate, read)) !== null)
        byKey.set(targetKey(candidate), { target: candidate, read });
    }
    return byKey;
  }, [seen, visit, relay.notices, workspaces, reads, signIn]);
  const wanting = useRef(new Map<string, { readonly read: TargetRead; release(): void }>());
  useEffect(() => {
    const held = wanting.current;
    for (const [key, entry] of held)
      if (!wakeThreads.has(key)) {
        entry.release();
        held.delete(key);
      }
    if (!wakes) return;
    for (const [key, { target, read }] of wakeThreads) {
      const was = held.get(key);
      if (was?.read === read) continue;
      const { workspaceId, threadId } = target;
      // Wanted again before the last want goes, so the read already running is replaced, not dropped.
      const release = wakes.want(workspaceId, { kind: "thread", threadId }, new Set([threadId]));
      was?.release();
      held.set(key, { read, release });
    }
  }, [wakes, wakeThreads]);
  useEffect(() => {
    const held = wanting.current;
    return () => {
      for (const entry of held.values()) entry.release();
      held.clear();
    };
  }, [wakes]);

  // Only the rows on screen read their messages, one read per workspace and thread, and the row whose answer is open
  // keeps its read while it scrolls away. A row's answer closes when its Notice leaves the list or its workspace stops
  // showing on the phone, which also drops its read.
  const visible = useRef<readonly string[]>([]);
  const wantVisible = useCallback(() => {
    if (!targets) return;
    const ids = new Set(visible.current);
    const { workspaces: list, records } = latest.current;
    const editing = editor.state();
    if (editing) {
      const record = records.find((each) => `relay:${each.noticeId}` === editing.noticeId);
      if (record && answerCandidate(record, list, phoneWrites)) ids.add(editing.noticeId);
      else editor.close(editing.noticeId);
    }
    const wanted: MessageTarget[] = [];
    for (const record of records) {
      if (!ids.has(`relay:${record.noticeId}`)) continue;
      const candidate = candidateOf(record, list, phoneWrites);
      if (candidate) wanted.push(candidate);
    }
    targets.want(wanted);
  }, [targets, editor]);
  const see = useCallback(
    (ids: readonly string[] | null) => {
      if (ids === null) editor.close();
      visible.current = ids ?? [];
      const next = visible.current;
      setSeen((previous) => (sameIds(previous, next) ? previous : next));
      wantVisible();
    },
    [wantVisible, editor],
  );
  // A list that became ready, or a row that changed, while on screen, and an answer opened or closed.
  useEffect(() => wantVisible(), [wantVisible, workspaces, relay.notices, visit]);

  // Once the outbox saves an answer, its question's thread is read again, so the reply shows, the outbox hands the
  // record off, and the server's state takes over from the phone's.
  const reread = useMemo(() => new Set<string>(), [targets]);
  useEffect(() => {
    if (!targets) return;
    const { workspaces: list, records } = latest.current;
    const questions = records.flatMap((record) => {
      const candidate = answerCandidate(record, list, phoneWrites);
      return candidate ? [candidate] : [];
    });
    rereadSaved(questions, answersFor, targets.retry, reread);
  }, [targets, answersFor, reread]);

  const notices = useMemo(() => [...local.notices, ...relayNotices], [local.notices, relayNotices]);
  // The handlers read the list through this, so they keep their identity: a failure report takes itself back when its
  // `dismiss` changes.
  const shown = useRef(notices);
  shown.current = notices;

  const dismiss = useCallback(
    (id: string) => {
      const relayId = shown.current.find((notice) => notice.id === id)?.relayId;
      if (relayId === undefined) return local.remove(id);
      if (store) void markDone(store.mark, relayId, showToast);
    },
    [store, local.remove, showToast],
  );
  const setRead = useCallback(
    (id: string, read: boolean) => {
      const relayId = shown.current.find((entry) => entry.id === id)?.relayId;
      if (relayId !== undefined) void store?.mark(relayId, read ? "read" : "unread");
    },
    [store],
  );
  const markAllRead = useCallback(() => {
    store?.markAllRead();
    local.readAll();
  }, [store, local.readAll]);
  // A refresh reads the workspace list too, for a Show on phone change made on another device, and the mentions'
  // messages and agents' questions.
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
 * Try again. Its next success takes both back. A failure of this phone's storage takes its own words, which say what
 * it means for the person's changes. A Sign out that hasn't finished gets no Try again, since trying again can't help.
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
    const problem = state.problem;
    const words = isStorageProblem(problem)
      ? noticeStorageWords[problem]
      : { title, body: accountWords.problem(problem, server) };
    const retries = problem !== "held";
    showToast({
      id,
      tone: "failure",
      title: words.title,
      body: words.body,
      ...(retries ? { action: { label: noticesWords.tryAgain, onPress: retry } } : {}),
    });
    add({
      id,
      senderKind: null,
      senderLabel: "",
      title: words.title,
      body: words.body,
      minutesAgo: 0,
      atMs: Date.now(),
      read: false,
      retry: retries,
      onRetry: retries ? retry : undefined,
      dismissible: true,
      failed: true,
    });
  }, [id, title, state, instance, retry, server, showToast, hideToast, add, remove]);
}

export const useOptionalNotices = (): NoticesState | null => useContext(State);

export function useNotices(): NoticesState {
  const state = useContext(State);
  if (!state) throw new Error("useNotices needs NoticesProvider");
  return state;
}
