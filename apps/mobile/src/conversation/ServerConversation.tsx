import { chatWords } from "@dohc/interface-words/notices";
import { workspaceWords } from "@dohc/interface-words/workspace";
import type { PhoneChatWake, PhoneMentionCandidate } from "@dohc/workspace-contracts/chat-wakes";
import { KeyboardAwareLegendList } from "@legendapp/list/keyboard";
import {
  LegendList,
  type LegendListRef,
  type OnViewableItemsChangedInfo,
  type ViewabilityConfig,
} from "@legendapp/list/react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { StyleSheet, Text, View } from "react-native";
import { useAccount, useSignIn } from "../account/AccountProvider";
import { useAccountName } from "../account/useAccountName";
import { ProblemLine } from "../account/ProblemLine";
import { chatTitle } from "../chats/chatLabels";
import type { ChatKind } from "../chats/types";
import type { WakeTarget } from "../server/chatWakes";
import { canWriteGroupChat, phoneWrites, writesIn } from "../server/phoneWrites";
import { views, type ViewState } from "../server/workspaceData";
import type {
  ChatGroup,
  ChatGroupKind,
  ChatMessage,
  ChatThread,
  GroupStream,
  MissingChat,
} from "../server/workspaceReads";
import { useTheme, workspaceMarkFills } from "../theme";
import type { WakeRetry, WakeView } from "./chatWakeState";
import {
  EmptyLine,
  HoldRow,
  NoWorkspace,
  ScreenFailure,
  useWorkspaceGap,
} from "../workspace/ListStates";
import { useKeptContentProblem, useProblemText, useView } from "../workspace/useView";
import { Composer, ComposerProblem, outboxProblem } from "./Composer";
import {
  answerPlace,
  answerRecords,
  answerTarget,
  answerWrite,
  decisionOf,
  type Shown,
} from "./decisionAnswers";
import {
  blockedBy,
  chatWrite,
  createWriteScope,
  groupForStream,
  JOINED_GROUP_LANES,
  lanesOf,
  replyWrite,
  routeReply,
  threadReplyTarget,
  writableJoinedThread,
  type Lanes,
  type ReplyTarget,
} from "./conversationWrites";
import { MessageRow } from "./MessageRow";
import { ComposerBar, RevealAboveComposer, useRevealAboveComposer } from "./revealAboveComposer";
import { streamRows, threadRows } from "./outboxMessages";
import { confirmedReactions, reactionRecords, withReactions } from "./reactions";
import { markShown, markShownPosts, shownMessages } from "./readMarks";
import { UNSHOWN_MESSAGE, UNSHOWN_QUESTION, type ReplyTo } from "./ReplyContext";
import {
  conversationItems,
  localMessage,
  localAuthor,
  type ConversationItem,
  serverMessage,
  withMentions,
} from "./serverMessages";
import { phoneMentions } from "./mentionDraft";
import type { Message } from "./types";
import { useChatWakes } from "./useChatWakes";
import { useVisible } from "./useVisible";
import {
  useChoose,
  useConversationWrites,
  useLocalActions,
  useOutboxState,
  useReact,
  type AnswerActions,
  type LocalActions,
  type ReactActions,
} from "./useOutbox";

// A chat or thread opened from a Notice names its workspace, says it's a thread, and may name a message to open at.
// It shows only while that workspace is the one open, so it never reads the thread from another.
export function ServerConversation() {
  const {
    // oxlint-disable-next-line typescript/no-useless-default-assignment -- a route can omit id at runtime despite the declared type
    id = "",
    name,
    thread,
    workspace,
    message,
    reply,
    answer,
  } = useLocalSearchParams<{
    id: string;
    name?: string;
    thread?: string;
    workspace?: string;
    message?: string;
    /** A thread opened to reply to one of its messages. */
    reply?: string;
    /** A thread opened to answer one of its messages' questions. */
    answer?: string;
  }>();
  const { data } = useAccount();
  const { state: chatsState, retry: retryChats } = useView(views.chats);
  const chats = chatsState.value;
  const joined = data?.joined === true;
  const isThread = thread === "1" || id.startsWith("thread-") || id.startsWith("browser-thread:");
  const joinedThreadId = isThread && phoneWrites && joined ? id : null;
  const threadKnown =
    joinedThreadId !== null &&
    chats?.some((each) => each.threadIds.includes(joinedThreadId)) === true;
  useEnsureThreadListed(
    joinedThreadId,
    chats,
    threadKnown,
    chatsState.loading,
    chatsState.problem,
    retryChats,
  );
  if (workspace !== undefined && data?.workspaceId !== workspace) return <ElsewhereChat />;
  const listedGroup = isThread ? null : groupForStream(chats, id);
  const streamId = listedGroup?.id ?? id;
  const writesKey = `${data?.instance ?? 0}:${isThread ? id : streamId}`;
  const writes = writesIn(data);
  if (isThread) {
    const joinedWritable = joinedThreadId !== null && writableJoinedThread(chats, joinedThreadId);
    return writes || joinedWritable ? (
      <WritableThread
        key={writesKey}
        threadId={id}
        messageId={message ?? null}
        replyId={routeReply(reply, workspace, data?.workspaceId ?? null)}
        answerId={joinedWritable ? null : routeReply(answer, workspace, data?.workspaceId ?? null)}
        joined={joinedWritable}
      />
    ) : (
      <Thread threadId={id} messageId={message ?? null} />
    );
  }
  if (writes) return <OwnerWritableStream key={writesKey} groupId={streamId} name={name ?? ""} />;
  if (canWriteGroupChat(data, listedGroup) && listedGroup?.channelWireId) {
    return (
      <WritableStream
        key={writesKey}
        groupId={streamId}
        postGroupId={listedGroup.channelWireId}
        name={name ?? listedGroup.name}
        lanes={JOINED_GROUP_LANES}
        lanesProblem={null}
        joined
      />
    );
  }
  return <Stream groupId={streamId} name={name ?? listedGroup?.name ?? ""} />;
}

function useEnsureThreadListed(
  threadId: string | null,
  chats: readonly ChatGroup[] | null,
  known: boolean,
  loading: boolean,
  problem: unknown,
  retryChats: () => void,
): "asked" | "reading" | "read" | null {
  const [listRead, setListRead] = useState<{
    readonly threadId: string;
    readonly phase: "asked" | "reading" | "read";
  } | null>(null);
  const phase = threadId !== null && listRead?.threadId === threadId ? listRead.phase : null;
  useEffect(() => {
    if (threadId === null || chats === null || known || phase === "read") return;
    if (phase === null) {
      setListRead({ threadId, phase: "asked" });
      retryChats();
    } else if (loading) {
      if (phase !== "reading") setListRead({ threadId, phase: "reading" });
    } else if (phase === "reading" && problem === null) {
      setListRead({ threadId, phase: "read" });
    }
  }, [chats, known, phase, threadId, loading, problem, retryChats]);
  return phase;
}

/** Opens a thread in the open workspace, at a message, to reply to it or answer its question when one is named. */
function openThread(
  router: ReturnType<typeof useRouter>,
  workspaceId: string | null,
  threadId: string,
  at: {
    readonly message?: string;
    readonly reply?: string;
    readonly answer?: string;
  } = {},
) {
  router.push({
    pathname: "/chat/[id]",
    params: {
      id: threadId,
      thread: "1",
      ...(workspaceId === null ? {} : { workspace: workspaceId }),
      ...at,
    },
  });
}

/** A chat whose workspace is no longer the one open, as when another device hid it. */
function ElsewhereChat() {
  const theme = useTheme();
  return (
    <View style={[styles.screen, { backgroundColor: theme.bg }]}>
      <ScreenFailure text={workspaceWords.chatMissing} />
    </View>
  );
}

/** What a stream or thread adds where phone writes are on: outbox rows, reactions, Reply, answers, and the composer. */
interface ScreenWrites {
  /**
   * The messages only this phone has, given the IDs the screen's read shows, and the IDs of the questions and polls
   * among them, whose answers show here until the outbox saves them.
   */
  local(shown: ReadonlySet<string>, questions: ReadonlySet<string>): readonly Message[];
  /** A message the server has, with this phone's reactions and answer over the server's. */
  message?(entry: ChatMessage, base: Message, shown: Shown): Message;
  readonly actions: LocalActions;
  readonly react?: ReactActions;
  /** The answers its cards offer, given the screen's messages by ID and which of them are posts. */
  answers?(byId: ReadonlyMap<string, ChatMessage>, posts: ReadonlySet<string>): AnswerActions;
  /** Reply on a message. In a stream, `post` says it's a post, whose thread is its own. */
  reply(message: Message, post: boolean): void;
  /**
   * Null until the server says which lanes a stream takes, or its read fails. `mentions` are who the conversation's
   * context read says it can mention, or null while that read loads or after it failed.
   */
  readonly composer:
    | ((
        onLayoutHeight: (height: number) => void,
        title: string,
        mentions: readonly PhoneMentionCandidate[] | null,
      ) => ReactNode)
    | null;
  /** Writes aren't blocked, and the screen still shows its activation, as they are when it's called. */
  writable(): boolean;
}

/**
 * The write plumbing a stream and a thread share. Every answer lands only while the screen still shows the same
 * sign-in, workspace store and chat or thread, so a slow enqueue can't clear another draft or paint its rows, and a
 * Discard confirmed after a change deletes nothing.
 */
function useScreenWrites(target: string) {
  const signIn = useSignIn();
  const { data, outbox } = useAccount();
  const state = useOutboxState(outbox);
  // The screen's store and target, from the commit that shows them until another replaces them or the screen closes,
  // so a controller made for them stops asking, and stays stopped if they return.
  const [scope] = useState(createWriteScope);
  const activation = useMemo(() => (data ? { store: data, target } : null), [data, target]);
  useLayoutEffect(() => (activation ? scope.show(activation) : undefined), [scope, activation]);
  const isCurrent = useCallback(
    () => signIn.isCurrent() && activation !== null && scope.shows(activation),
    [signIn, scope, activation],
  );
  const writes = useConversationWrites(outbox, phoneWrites, isCurrent);
  const blocked = state ? blockedBy(state, phoneWrites) : "loading";
  // Read when called, for a step that runs after an alert or an answer: the outbox may have changed before a render.
  const writable = useCallback(
    () => isCurrent() && blockedBy(outbox.state(), phoneWrites) === null,
    [isCurrent, outbox],
  );
  const actions = useLocalActions(writes, blocked !== null);
  const workspaceId = data?.workspaceId ?? null;
  const rowScope = useMemo(
    () =>
      workspaceId === null
        ? null
        : { origin: signIn.origin, accountId: signIn.userId, workspaceId },
    [signIn, workspaceId],
  );
  const react = useReact(writes, rowScope);
  const accountName = useAccountName(signIn);
  const you = useMemo(() => localAuthor(accountName, workspaceMarkFills), [accountName]);
  const reactionsByMessage = useMemo(
    () => (state && rowScope ? reactionRecords(state, rowScope) : null),
    [state, rowScope],
  );
  const answersByQuestion = useMemo(
    () => (state && rowScope ? answerRecords(state, rowScope) : null),
    [state, rowScope],
  );
  const unconfirmed = state?.unconfirmed;
  // A message this phone has no reaction or answer for keeps its object while the outbox changes, so its row doesn't
  // draw again.
  const [plain] = useState(() => new WeakMap<Message, Message>());
  const message = useCallback(
    (entry: ChatMessage, base: Message, shown: Shown) => {
      const records = reactionsByMessage?.get(entry.id);
      const answers = answersByQuestion?.get(entry.id);
      if (records || answers) {
        const made = withReactions(
          base,
          confirmedReactions(entry.reactions, signIn.userId),
          records,
          unconfirmed,
        );
        const decision = answers ? decisionOf(entry, answers, shown) : null;
        return decision ? { ...made, decision } : made;
      }
      const kept = plain.get(base);
      if (kept) return kept;
      const made = withReactions(base, confirmedReactions(entry.reactions, signIn.userId));
      plain.set(base, made);
      return made;
    },
    [signIn, reactionsByMessage, answersByQuestion, unconfirmed, plain],
  );
  const chooser = useChoose(writes, workspaceId);
  const problem = useMemo(
    () => outboxProblem(state, blocked, () => outbox.wake()),
    [state, blocked, outbox],
  );
  return {
    state,
    writes,
    blocked,
    actions,
    react,
    workspaceId,
    you,
    rowScope,
    message,
    problem,
    answersByQuestion,
    chooser,
    writable,
  };
}

/** The parent of each message a read shows, by ID: undefined for one it doesn't show. */
const parentsIn = (byId: ReadonlyMap<string, ChatMessage>) => (id: string) =>
  byId.get(id)?.parentMessageId;

/** The messages a read shows, by ID. */
const byIdOf = (messages: readonly ChatMessage[]): ReadonlyMap<string, ChatMessage> =>
  new Map(messages.map((entry) => [entry.id, entry]));

const questionsIn = (messages: readonly ChatMessage[]): ReadonlySet<string> =>
  new Set(messages.filter((entry) => entry.needsDecision).map((entry) => entry.id));

/** A reply chosen in a stream: to an outbox post or send whose thread isn't known yet. */
interface StreamReply {
  readonly target: ReplyTarget;
  readonly to: ReplyTo;
}

const excerptOf = (message: Message) =>
  message.body
    .map((segment) => ("text" in segment ? segment.text : `@${segment.mention}`))
    .join("");

const EMPTY_QUESTIONS: ReadonlySet<string> = new Set();

function OwnerWritableStream({ groupId, name }: { groupId: string; name: string }) {
  const lanesView = useMemo(() => views.lanes(groupId), [groupId]);
  const { state: lanesState, retry: retryLanes } = useView(lanesView);
  const context = lanesState.value;
  const lanes = useMemo<Lanes | null>(
    () => (context?.kind === "lanes" ? lanesOf(context) : null),
    [context],
  );
  const problemText = useProblemText();
  const lanesProblem = useMemo(
    () =>
      lanesState.problem
        ? {
            text: `${chatWords.lanesFailed} ${problemText(lanesState.problem)}`,
            retry: retryLanes,
          }
        : null,
    [lanesState.problem, problemText, retryLanes],
  );
  return (
    <WritableStream
      groupId={groupId}
      postGroupId={groupId}
      name={name}
      lanes={lanes}
      lanesProblem={lanesProblem}
      joined={false}
    />
  );
}

// A stream where phone writes are on. Its posts and messages go through the account's outbox. Reply on a message the
// server has opens its thread; on a post or send still in the outbox, the composer replies to it here, and the reply
// waits for the thread that write will name.
function WritableStream({
  groupId,
  postGroupId,
  name,
  lanes,
  lanesProblem,
  joined,
}: {
  groupId: string;
  postGroupId: string;
  name: string;
  lanes: Lanes | null;
  lanesProblem: { readonly text: string; readonly retry: () => void } | null;
  joined: boolean;
}) {
  const router = useRouter();
  const {
    state,
    writes,
    blocked,
    actions,
    react,
    workspaceId,
    you,
    rowScope,
    message,
    problem: outboxProblemNow,
    chooser,
    writable,
  } = useScreenWrites(postGroupId);
  const [replyTo, setReplyTo] = useState<StreamReply | null>(null);
  const local = useCallback(
    (shown: ReadonlySet<string>, questions: ReadonlySet<string>) =>
      state && rowScope
        ? streamRows(state, rowScope, postGroupId, shown, joined ? EMPTY_QUESTIONS : questions).map(
            (row) => localMessage(row, you),
          )
        : [],
    [state, rowScope, postGroupId, joined, you],
  );
  // A poll's choice answers at once, where the poll is. Answer on a question opens its thread to answer there, as
  // Reply does.
  const answers = useCallback(
    (byId: ReadonlyMap<string, ChatMessage>, posts: ReadonlySet<string>): AnswerActions => ({
      blocked: actions.blocked,
      problems: chooser.problems,
      choose: (entry, option) => {
        const question = byId.get(entry.id);
        if (!question) return;
        const how = { post: posts.has(question.id), poll: true };
        chooser.choose(answerPlace(question, parentsIn(byId), how), question.id, option);
      },
      answer: (entry) => {
        const question = byId.get(entry.id);
        if (!question) return;
        openThread(
          router,
          workspaceId,
          question.threadId,
          posts.has(question.id)
            ? { answer: question.id }
            : { message: question.id, answer: question.id },
        );
      },
    }),
    [actions.blocked, chooser, router, workspaceId],
  );
  const reply = useCallback(
    (entry: Message, post: boolean) => {
      const parent = entry.replyable;
      if (entry.local) {
        if (!parent) return;
        // Saved, with its thread named: the reply goes there, so it opens there.
        if (parent.threadId !== null)
          openThread(router, workspaceId, parent.threadId, { reply: parent.messageId });
        else
          setReplyTo({
            target: {
              kind: "outbox",
              operationId: parent.operationId,
              messageId: parent.messageId,
            },
            to: { name: entry.author.name, excerpt: excerptOf(entry) },
          });
        return;
      }
      if (!entry.threadId) return;
      // A post's thread is its own, so a reply to it goes at the top. A chat message's goes under it.
      openThread(
        router,
        workspaceId,
        entry.threadId,
        post ? {} : { message: entry.id, reply: entry.id },
      );
    },
    [router, workspaceId],
  );
  const problem = outboxProblemNow ?? lanesProblem;
  const submit = useCallback(
    async (kind: "send" | "post" | "reply", body: string, title: string) => {
      if (workspaceId === null) return { kind: "blocked" as const };
      if (kind === "reply") {
        const chosen = replyTo;
        const next = chosen && replyWrite(chosen.target, body);
        if (!next) return { kind: "blocked" as const };
        const outcome = await writes.submit(workspaceId, next.write, next.dependsOn);
        // Kept: the reply context goes, unless another was chosen. One whose post or send can't take it stays, with
        // Send off, until the person cancels Reply or chooses another message, so its text never goes to the stream.
        if (outcome.kind === "kept" || outcome.kind === "withheld")
          setReplyTo((current) => (current === chosen ? null : current));
        return outcome;
      }
      if (joined && kind === "send") return { kind: "blocked" as const };
      const write = chatWrite(
        kind === "send" ? { kind, streamId: groupId } : { kind, groupId: postGroupId },
        body,
        title,
      );
      return write ? writes.submit(workspaceId, write) : { kind: "blocked" as const };
    },
    [writes, workspaceId, groupId, postGroupId, joined, replyTo],
  );
  const cancelReply = useCallback(() => setReplyTo(null), []);
  const composer = useMemo(
    () =>
      lanes && (lanes.post || lanes.send)
        ? (
            onLayoutHeight: (height: number) => void,
            title: string,
            mentions: readonly PhoneMentionCandidate[] | null,
          ) => (
            <Composer
              placeholder={chatWords.messageTo(title)}
              lanes={lanes}
              blocked={blocked}
              problem={problem}
              replies={replyTo !== null}
              replyTo={replyTo?.to ?? null}
              onCancelReply={cancelReply}
              onSubmit={submit}
              onLayoutHeight={onLayoutHeight}
              mentions={mentions}
            />
          )
        : lanesProblem
          ? (onLayoutHeight: (height: number) => void) => (
              <ComposerProblem problem={lanesProblem} onLayoutHeight={onLayoutHeight} />
            )
          : null,
    [lanes, blocked, problem, replyTo, cancelReply, submit, lanesProblem],
  );
  const streamWrites = useMemo<ScreenWrites>(
    () => ({
      local,
      ...(joined ? {} : { message, react, answers }),
      actions,
      reply,
      composer,
      writable,
    }),
    [local, joined, message, react, answers, actions, reply, composer, writable],
  );
  return <Stream groupId={groupId} name={name} writes={streamWrites} />;
}

// A thread where phone writes are on: every message in its composer is a reply. Reply on a message names it above the
// field, and the reply goes under it; with none chosen, it goes at the top of the thread. Answer on a question names
// it instead, and the reply answers it, where the desktop puts an answer (`answerPlace`). A thread opened to reply to
// a message, or to answer its question, starts with it chosen, once the read shows it.
function WritableThread({
  threadId,
  messageId,
  replyId,
  answerId,
  joined = false,
}: {
  threadId: string;
  messageId: string | null;
  replyId: string | null;
  answerId: string | null;
  joined?: boolean;
}) {
  const {
    state,
    writes,
    blocked,
    actions,
    react,
    workspaceId,
    you,
    rowScope,
    message,
    problem: outboxProblemNow,
    answersByQuestion,
    chooser,
    writable,
  } = useScreenWrites(threadId);
  const problemText = useProblemText();
  const view = useMemo(() => views.thread(threadId), [threadId]);
  const value = useView(view).state.value;
  const thread = value?.kind === "thread" ? value : null;
  // A post's thread takes its answers at its top. Which it is comes from the lane the chat list names for it, however
  // the thread was opened. One no chat lists, as a file's, is no post, but only once a current read of the list says
  // so: a cached list from before a new post doesn't name it. Null while that isn't known.
  const { state: chatsState, retry: retryChats } = useView(views.chats);
  const chats = chatsState.value;
  const group = chats?.find((each) => each.threadIds.includes(threadId)) ?? null;
  const phase = useEnsureThreadListed(
    threadId,
    chats,
    group !== null,
    chatsState.loading,
    chatsState.problem,
    retryChats,
  );
  const post = useMemo(() => {
    if (group) return group.postThreadIds?.includes(threadId) === true;
    return chats !== null && phase === "read" ? false : null;
  }, [chats, group, phase, threadId]);
  // The message a reply goes under, or the question it answers, never both.
  const [chosen, setChosen] = useState<string | null>(joined || answerId === null ? replyId : null);
  const [answering, setAnswering] = useState<string | null>(joined ? null : answerId);
  // Only a message the read shows is named and replied under: one it doesn't is never guessed at. A chosen message the
  // read doesn't show, as one that went before the thread opened from a Notice, keeps the reply context with Send off
  // until the person cancels Reply or chooses another, so its text never goes to the thread's top.
  const replyTarget = useMemo(
    () => threadReplyTarget(threadId, chosen, thread?.messages ?? []),
    [threadId, chosen, thread],
  );
  const parent = useMemo((): ReplyTo | null => {
    if (chosen === null) return null;
    const entry = thread?.messages.find((each) => each.id === chosen);
    return entry ? { name: entry.authorName, excerpt: entry.body } : UNSHOWN_MESSAGE;
  }, [chosen, thread]);
  // While Answer names a question, the text only ever answers it. Once a read shows the question answered, or no longer
  // shows it, the context and text stay with Send off, until the person cancels Answer or chooses another message.
  const question = useMemo(() => {
    if (answering === null) return null;
    const messages = thread?.messages ?? [];
    const entry = messages.find((each) => each.id === answering);
    const to: ReplyTo = entry
      ? { name: entry.authorName, excerpt: entry.body, answers: true }
      : UNSHOWN_QUESTION;
    return {
      id: answering,
      target: answerTarget(
        entry,
        answersByQuestion?.get(answering),
        parentsIn(byIdOf(messages)),
        post,
      ),
      to,
    };
  }, [answering, thread, answersByQuestion, post]);
  // A failed read of the chat list shows in the composer while it keeps an answer off, chosen or offered by an open
  // question in the thread, with its cause and Try again. The outbox's own problem comes first.
  const answersWait =
    !joined &&
    post === null &&
    (question !== null ||
      (thread?.messages.some((each) => each.decisionState === "open") ?? false));
  const problem = useMemo(
    () =>
      outboxProblemNow ??
      (answersWait && chatsState.problem
        ? {
            text: `${chatWords.lanesFailed} ${problemText(chatsState.problem)}`,
            retry: retryChats,
          }
        : null),
    [outboxProblemNow, answersWait, chatsState.problem, problemText, retryChats],
  );
  const local = useCallback(
    (shown: ReadonlySet<string>) =>
      state && rowScope
        ? threadRows(state, rowScope, threadId, shown).map((row) => localMessage(row, you))
        : [],
    [state, rowScope, threadId, you],
  );
  const reply = useCallback((entry: Message) => {
    if (entry.local) return;
    setChosen(entry.id);
    setAnswering(null);
  }, []);
  // A poll's choice waits, as an answer does, until the chat list says whether this is a post's thread.
  const answers = useCallback(
    (byId: ReadonlyMap<string, ChatMessage>): AnswerActions => ({
      blocked: actions.blocked || post === null,
      problems: chooser.problems,
      choose: (entry, option) => {
        const asked = byId.get(entry.id);
        if (!asked || post === null) return;
        const how = { post, poll: true };
        chooser.choose(answerPlace(asked, parentsIn(byId), how), asked.id, option);
      },
      answer: (entry) => {
        setAnswering(entry.id);
        setChosen(null);
      },
    }),
    [actions.blocked, chooser, post],
  );
  const submit = useCallback(
    async (_kind: "send" | "post" | "reply", body: string) => {
      if (workspaceId === null) return { kind: "blocked" as const };
      // Answering never falls back to an ordinary reply: a closed or waiting answer sends nothing.
      if (question) {
        const { target } = question;
        const write =
          target.kind === "answer" ? answerWrite(target.place, question.id, body) : null;
        if (!write) return { kind: "blocked" as const };
        const outcome = await writes.submit(workspaceId, write);
        if (outcome.kind === "kept" || outcome.kind === "withheld")
          setAnswering((current) => (current === question.id ? null : current));
        return outcome;
      }
      const next = replyTarget === null ? null : replyWrite(replyTarget, body);
      if (!replyTarget || !next) return { kind: "blocked" as const };
      const outcome = await writes.submit(workspaceId, next.write);
      const answered = replyTarget.parentMessageId;
      if (outcome.kind === "kept" || outcome.kind === "withheld")
        setChosen((current) => (current === answered ? null : current));
      return outcome;
    },
    [writes, workspaceId, replyTarget, question],
  );
  const cancelReply = useCallback(() => {
    setChosen(null);
    setAnswering(null);
  }, []);
  const composer = useMemo(
    () =>
      (
        onLayoutHeight: (height: number) => void,
        _title: string,
        mentions: readonly PhoneMentionCandidate[] | null,
      ) => (
        <Composer
          placeholder={chatWords.reply}
          lanes={REPLY_LANES}
          blocked={
            blocked ??
            (question?.target.kind === "waiting" || (question === null && replyTarget === null)
              ? "loading"
              : null)
          }
          problem={problem}
          replies
          replyTo={question?.to ?? parent}
          closed={question?.target.kind === "closed" ? chatWords.answerClosed : null}
          onCancelReply={cancelReply}
          onSubmit={submit}
          onLayoutHeight={onLayoutHeight}
          mentions={mentions}
        />
      ),
    [blocked, problem, question, replyTarget, parent, cancelReply, submit],
  );
  const threadWrites = useMemo<ScreenWrites>(
    () => ({
      local,
      ...(joined ? {} : { message, react, answers }),
      actions,
      reply,
      composer,
      writable,
    }),
    [local, joined, message, react, answers, actions, reply, composer, writable],
  );
  return <Thread threadId={threadId} messageId={messageId} writes={threadWrites} />;
}

/** A thread takes replies, and never a post. */
const REPLY_LANES: Lanes = { post: false, send: true };
const EMPTY_MESSAGES: readonly Message[] = [];

function Stream({
  groupId,
  name,
  writes,
}: {
  groupId: string;
  name: string;
  writes?: ScreenWrites;
}) {
  const view = useMemo(() => views.stream(groupId), [groupId]);
  const { state, retry } = useView(view);
  const stream = state.value?.kind === "stream" ? state.value : null;
  const { data } = useAccount();
  const visible = useVisible();
  const chats = useView(views.chats).state.value;
  // An agent's chat is named as the chat list names it, after the agent, never by its stored name.
  const listed = chats?.find((group) => group.id === groupId && group.kind === "agent");
  const unreadThreadIds = useMemo(
    () => (chats ? new Set(chats.flatMap((group) => group.unreadThreadIds)) : null),
    [chats],
  );
  useEffect(() => {
    if (data?.joined) return;
    const lane = (which: "posts" | "chat") =>
      stream?.items.filter((item) => item.lane === which).map((item) => item.message) ?? null;
    markShown(data, lane("chat"), visible);
    markShownPosts(data, lane("posts"), unreadThreadIds, visible);
  }, [data, stream, unreadThreadIds, visible]);
  const bases = useMemo(
    () =>
      stream?.items.map((item) =>
        serverMessage(
          item.message,
          item.replyCount > 0
            ? { count: item.replyCount, lastMs: item.lastReplyAtMs ?? item.message.createdAtMs }
            : null,
          workspaceMarkFills,
        ),
      ) ?? null,
    [stream],
  );
  const byId = useMemo(() => byIdOf(stream?.items.map((item) => item.message) ?? []), [stream]);
  const decorate = writes?.message;
  const messages = useMemo(
    () =>
      bases && stream && decorate
        ? bases.map((base, index) => {
            const item = stream.items[index];
            return item ? decorate(item.message, base, (id) => byId.get(id)) : base;
          })
        : bases,
    [bases, stream, decorate, byId],
  );
  const localOf = writes?.local;
  const local = useMemo(
    () =>
      localOf && stream
        ? localOf(new Set(byId.keys()), questionsIn([...byId.values()]))
        : undefined,
    [localOf, stream, byId],
  );
  const posts = useMemo(
    () =>
      new Set(stream?.items.filter((item) => item.lane === "posts").map((item) => item.message.id)),
    [stream],
  );
  const reply = writes?.reply;
  const onReply = useMemo(
    () => reply && ((message: Message) => reply(message, posts.has(message.id))),
    [reply, posts],
  );
  const answersOf = writes?.answers;
  const answers = useMemo(() => answersOf?.(byId, posts), [answersOf, byId, posts]);
  // The wakes of the items the stream shows, read again when its read changes or a thread among them changes.
  const wakeTarget = useMemo<WakeTarget>(() => ({ kind: "stream", groupId }), [groupId]);
  const wakeThreads = useMemo(
    () => (stream ? new Set(stream.items.map((item) => item.message.threadId)) : null),
    [stream],
  );
  const writable = writes !== undefined && !writes.actions.blocked && !data?.joined;
  const wakes = useChatWakes(
    wakeTarget,
    wakeThreads,
    visible,
    stream,
    data?.joined ? null : (writes?.writable ?? null),
  );
  return (
    <Conversation
      title={chatTitle(
        kindOf(listed?.kind ?? stream?.groupKind ?? "group"),
        listed?.name ?? stream?.name ?? name,
      )}
      state={state}
      messages={messages}
      retry={retry}
      wakes={wakes.view}
      retryWakes={wakes.retry}
      wakeRetries={wakes.retries}
      {...(writable ? { onRetryWake: wakes.retryWake } : {})}
      {...(writes && onReply
        ? {
            local: local ?? EMPTY_MESSAGES,
            actions: writes.actions,
            ...(writes.react ? { react: writes.react } : {}),
            onReply,
            ...(answers ? { answers } : {}),
            composer: writes.composer,
          }
        : {})}
    />
  );
}

function Thread({
  threadId,
  messageId,
  writes,
}: {
  threadId: string;
  messageId: string | null;
  writes?: ScreenWrites;
}) {
  const view = useMemo(() => views.thread(threadId), [threadId]);
  const { state, retry } = useView(view);
  const thread = state.value?.kind === "thread" ? state.value : null;
  const { data } = useAccount();
  const visible = useVisible();
  // Every message that has been on screen, so the read position never moves back when the person scrolls up.
  const [onScreen, setOnScreen] = useState<ReadonlySet<string>>(() => new Set());
  const addOnScreen = useCallback(
    (ids: readonly string[]) =>
      setOnScreen((known) =>
        ids.every((id) => known.has(id)) ? known : new Set([...known, ...ids]),
      ),
    [],
  );
  useEffect(() => {
    if (data?.joined) return;
    markShown(data, thread ? shownMessages(thread.messages, messageId, onScreen) : null, visible);
  }, [data, thread, messageId, onScreen, visible]);
  const bases = useMemo(
    () => thread?.messages.map((entry) => serverMessage(entry, null, workspaceMarkFills)) ?? null,
    [thread],
  );
  const byId = useMemo(() => byIdOf(thread?.messages ?? []), [thread]);
  const decorate = writes?.message;
  const messages = useMemo(
    () =>
      bases && thread && decorate
        ? bases.map((base, index) => {
            const entry = thread.messages[index];
            return entry ? decorate(entry, base, (id) => byId.get(id)) : base;
          })
        : bases,
    [bases, thread, decorate, byId],
  );
  const localOf = writes?.local;
  const local = useMemo(
    () => (localOf && thread ? localOf(new Set(byId.keys()), new Set()) : undefined),
    [localOf, thread, byId],
  );
  const reply = writes?.reply;
  const onReply = useMemo(() => reply && ((message: Message) => reply(message, false)), [reply]);
  const answersOf = writes?.answers;
  const answers = useMemo(() => answersOf?.(byId, new Set()), [answersOf, byId]);
  const wakeTarget = useMemo<WakeTarget>(() => ({ kind: "thread", threadId }), [threadId]);
  const wakeThreads = useMemo(() => (thread ? new Set([threadId]) : null), [thread, threadId]);
  const writable = writes !== undefined && !writes.actions.blocked && !data?.joined;
  const wakes = useChatWakes(
    wakeTarget,
    wakeThreads,
    visible,
    thread,
    data?.joined ? null : (writes?.writable ?? null),
  );
  return (
    <Conversation
      title={thread?.title || workspaceWords.thread}
      state={state}
      messages={messages}
      retry={retry}
      wakes={wakes.view}
      retryWakes={wakes.retry}
      wakeRetries={wakes.retries}
      {...(writable ? { onRetryWake: wakes.retryWake } : {})}
      anchor={messageId}
      {...(messageId === null ? {} : { onShown: addOnScreen })}
      {...(writes && onReply
        ? {
            local: local ?? EMPTY_MESSAGES,
            actions: writes.actions,
            ...(writes.react ? { react: writes.react } : {}),
            onReply,
            ...(answers ? { answers } : {}),
            composer: writes.composer,
          }
        : {})}
    />
  );
}

function Conversation({
  title,
  state,
  messages,
  retry,
  wakes,
  retryWakes,
  wakeRetries,
  onRetryWake,
  anchor = null,
  onShown,
  local,
  actions,
  react,
  onReply,
  answers,
  composer,
}: {
  title: string;
  state: ViewState<GroupStream | ChatThread | MissingChat>;
  messages: readonly Message[] | null;
  retry(): void;
  /** The wakes of the messages its read shows, as last read, or null before a read. */
  wakes: WakeView | null;
  retryWakes(): void;
  /** Its lines' Try again states, by wake ID. */
  wakeRetries: ReadonlyMap<string, WakeRetry>;
  /** Try again on a line, where writes are on and not blocked. */
  onRetryWake?: (wake: PhoneChatWake) => void;
  /** The message to open at, rather than the end. */
  anchor?: string | null;
  /** Takes the IDs of the messages on screen each time they change. */
  onShown?: (messageIds: readonly string[]) => void;
  /** Where writes are on: the messages only this phone has, after the server's. */
  local?: readonly Message[];
  actions?: LocalActions;
  react?: ReactActions;
  onReply?: (message: Message) => void;
  answers?: AnswerActions;
  /** Where writes are on: the composer, or null until the server says which lanes the chat takes. */
  composer?: ScreenWrites["composer"];
}) {
  const theme = useTheme();
  const router = useRouter();
  const { data } = useAccount();
  const workspaceId = data?.workspaceId ?? null;
  const problemText = useProblemText();
  const kept = useKeptContentProblem(state.problem, retry);
  const [composerHeight, setComposerHeight] = useState(90);
  const list = useRef<LegendListRef>(null);
  const { bar, reveal } = useRevealAboveComposer(list);
  const mentions = wakes?.mentions;
  const items = useMemo(() => {
    if (!messages) return [];
    const candidates = mentions?.length ? phoneMentions(mentions) : null;
    const drawn = (list: readonly Message[]) =>
      candidates ? list.map((entry) => withMentions(entry, candidates)) : list;
    return conversationItems(drawn(messages), Date.now(), local && drawn(local));
  }, [messages, local, mentions]);
  // Where the list opens: at the anchored message when this read has it, else at the end.
  const anchorIndex =
    anchor === null
      ? -1
      : items.findIndex((item) => item.type !== "day" && item.message.id === anchor);
  // Only a post shows its replies' link.
  const openReplies = useCallback(
    (entry: Message) => {
      if (entry.threadId) openThread(router, workspaceId, entry.threadId);
    },
    [router, workspaceId],
  );
  const prefetchReplies = useCallback(
    (entry: Message) => {
      if (data && entry.threadId) data.prefetch(views.thread(entry.threadId));
    },
    [data],
  );
  const onViewableItemsChanged = useMemo(
    () =>
      onShown &&
      (({ viewableItems }: OnViewableItemsChangedInfo<ConversationItem>) =>
        onShown(
          viewableItems.flatMap(({ item }) => (item.type === "day" ? [] : [item.message.id])),
        )),
    [onShown],
  );
  // Only a message the content read shows takes wakes, by its ID; one only this phone has never does. Its lines stay
  // while a read fails: the failure shows once for the conversation, below, not under every message, and no line
  // offers Try again until a read works.
  const retryOn = wakes?.failed === false ? onRetryWake : undefined;
  const wakesOf = (entry: Message) => {
    const own = entry.local === undefined ? wakes?.byMessage.get(entry.id) : undefined;
    return own ? { wakes: own, wakeRetries, ...(retryOn ? { onRetryWake: retryOn } : {}) } : {};
  };
  // Wakes and their Try again states change apart from the messages: their rows draw again.
  const wakeData = useMemo(() => ({ wakes, wakeRetries, retryOn }), [wakes, wakeRetries, retryOn]);
  const renderItem = (item: ConversationItem) =>
    item.type === "day" ? (
      <View style={styles.dayRow}>
        <Text style={[styles.day, { color: theme.muted, backgroundColor: theme.panel2 }]}>
          {item.label}
        </Text>
      </View>
    ) : (
      <MessageRow
        message={item.message}
        continued={item.continued}
        afterExtras={item.afterExtras}
        onOpenReplies={openReplies}
        onPrefetchReplies={prefetchReplies}
        {...(actions ? { actions } : {})}
        {...(react ? { react } : {})}
        {...(onReply ? { onReply } : {})}
        {...(answers ? { answers } : {})}
        {...wakesOf(item.message)}
      />
    );
  const gap = useWorkspaceGap();
  const header = (
    <Stack.Screen
      options={{
        title,
        headerTitle: () => (
          <Text
            style={[styles.name, { color: theme.ink }]}
            numberOfLines={1}
            accessibilityRole="header"
          >
            {title}
          </Text>
        ),
        headerStyle: { backgroundColor: theme.bg },
        headerShadowVisible: true,
        headerTintColor: theme.ink,
      }}
    />
  );
  // No workspace open, as when another device hid the last one: the chat says why, as Home and Chats do.
  if (gap)
    return (
      <View style={[styles.screen, { backgroundColor: theme.bg }]}>
        {header}
        <NoWorkspace />
      </View>
    );
  if (state.value?.kind === "missing")
    return (
      <View style={[styles.screen, { backgroundColor: theme.bg }]}>
        {header}
        <ScreenFailure text={workspaceWords.chatMissing} />
      </View>
    );
  if (!messages) {
    return (
      <View style={[styles.screen, { backgroundColor: theme.bg }]}>
        {header}
        {state.problem ? (
          <ScreenFailure
            text={workspaceWords.chatFailed}
            cause={problemText(state.problem)}
            onRetry={retry}
          />
        ) : (
          <HoldRow />
        )}
      </View>
    );
  }
  return (
    <View style={[styles.screen, { backgroundColor: theme.bg }]}>
      {header}
      {/* What's shown stays while a refresh that failed, or a failing feed, waits for Try again. */}
      {kept ? (
        <View style={[styles.problem, { borderBottomColor: theme.line }]}>
          <ProblemLine text={kept.text} onRetry={kept.retry} />
        </View>
      ) : wakes?.failed ? (
        // The agents' states couldn't be read: once for the conversation, with a Try again that only reads.
        <View style={[styles.problem, { borderBottomColor: theme.line }]}>
          <ProblemLine text={chatWords.wakeReadFailed} onRetry={retryWakes} />
        </View>
      ) : null}
      <ComposerBar.Provider value={bar}>
        <RevealAboveComposer.Provider value={reveal}>
          {items.length === 0 ? (
            <EmptyLine text={workspaceWords.noMessages} />
          ) : composer === undefined ? (
            <LegendList
              data={items}
              extraData={wakeData}
              keyExtractor={(item) => item.key}
              getItemType={(item) => item.type}
              estimatedItemSize={64}
              alignItemsAtEnd
              initialScrollAtEnd={anchorIndex < 0}
              {...(anchorIndex < 0 ? {} : { initialScrollIndex: anchorIndex })}
              maintainScrollAtEnd
              {...(onViewableItemsChanged
                ? { onViewableItemsChanged, viewabilityConfig: onScreenConfig }
                : {})}
              contentContainerStyle={{ paddingBottom: 24 }}
              renderItem={({ item }) => renderItem(item)}
            />
          ) : (
            // Where writes are on, the list rides the keyboard with the composer, and its end clears the composer.
            <KeyboardAwareLegendList
              ref={list}
              data={items}
              extraData={wakeData}
              keyExtractor={(item) => item.key}
              getItemType={(item) => item.type}
              estimatedItemSize={64}
              alignItemsAtEnd
              initialScrollAtEnd={anchorIndex < 0}
              {...(anchorIndex < 0 ? {} : { initialScrollIndex: anchorIndex })}
              maintainScrollAtEnd
              keyboardDismissMode="interactive"
              {...(onViewableItemsChanged
                ? { onViewableItemsChanged, viewabilityConfig: onScreenConfig }
                : {})}
              contentContainerStyle={{ paddingBottom: (composer ? composerHeight : 0) + 24 }}
              renderItem={({ item }) => renderItem(item)}
            />
          )}
          {composer
            ? composer(setComposerHeight, title, wakes && !wakes.failed ? wakes.mentions : null)
            : null}
        </RevealAboveComposer.Provider>
      </ComposerBar.Provider>
    </View>
  );
}

// A message is on screen once it covers 1% of the list. The list's default of 0% also counts a message whose edge
// meets the list's edge with nothing of it showing.
const onScreenConfig: ViewabilityConfig = { viewAreaCoveragePercentThreshold: 1 };

const kindOf = (kind: ChatGroupKind): ChatKind => (kind === "dm" ? "person" : kind);

const styles = StyleSheet.create({
  screen: { flex: 1 },
  name: { fontSize: 17, fontWeight: "600", maxWidth: 260 },
  problem: { paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth },
  dayRow: { alignItems: "center", paddingTop: 12, paddingBottom: 6 },
  day: {
    fontSize: 12,
    fontWeight: "600",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 11,
    overflow: "hidden",
  },
});
