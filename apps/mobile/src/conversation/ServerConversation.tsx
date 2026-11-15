import { chatWords } from "@dohc/interface-words/notices";
import { workspaceWords } from "@dohc/interface-words/workspace";
import { KeyboardAwareLegendList } from "@legendapp/list/keyboard";
import {
  LegendList,
  type OnViewableItemsChangedInfo,
  type ViewabilityConfig,
} from "@legendapp/list/react-native";
import { Stack, useIsFocused, useLocalSearchParams, useRouter } from "expo-router";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { AppState, StyleSheet, Text, View } from "react-native";
import { useAccount, useSignIn } from "../account/AccountProvider";
import { ProblemLine } from "../account/ProblemLine";
import { chatTitle } from "../chats/chatLabels";
import type { ChatKind } from "../chats/sample";
import { phoneWrites } from "../server/phoneWrites";
import { views, type ViewState } from "../server/workspaceData";
import type {
  ChatGroupKind,
  ChatMessage,
  ChatThread,
  GroupStream,
  MissingChat,
} from "../server/workspaceReads";
import { useTheme, workspaceMarkFills } from "../theme";
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
  blockedBy,
  chatWrite,
  createWriteScope,
  lanesOf,
  replyWrite,
  type Lanes,
  type ReplyTarget,
} from "./conversationWrites";
import { MessageRow } from "./MessageRow";
import { streamRows, threadRows } from "./outboxMessages";
import { confirmedReactions, reactionRecords, withReactions } from "./reactions";
import { markShown, markShownPosts, shownMessages } from "./readMarks";
import type { ReplyTo } from "./ReplyContext";
import {
  conversationItems,
  localMessage,
  type ConversationItem,
  serverMessage,
} from "./serverMessages";
import type { Author, Message } from "./types";
import {
  useConversationWrites,
  useLocalActions,
  useOutboxState,
  useReact,
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
  } = useLocalSearchParams<{
    id: string;
    name?: string;
    thread?: string;
    workspace?: string;
    message?: string;
    /** A thread opened to reply to one of its messages. */
    reply?: string;
  }>();
  const { data } = useAccount();
  if (workspace !== undefined && data?.workspaceId !== workspace) return <ElsewhereChat />;
  // Keyed by the workspace store, which is one sign-in's, and the chat, so a draft, a chosen reply or a controller made
  // for one never carries to another, even when the first comes back.
  const writesKey = `${data?.instance ?? 0}:${id}`;
  // Writes are off unless the build turns them on (src/server/phoneWrites.ts): the chat stays read-only, as it was.
  if (thread === "1" || id.startsWith("thread-"))
    return phoneWrites ? (
      <WritableThread
        key={writesKey}
        threadId={id}
        messageId={message ?? null}
        replyId={reply ?? null}
      />
    ) : (
      <Thread threadId={id} messageId={message ?? null} />
    );
  return phoneWrites ? (
    <WritableStream key={writesKey} groupId={id} name={name ?? ""} />
  ) : (
    <Stream groupId={id} name={name ?? ""} />
  );
}

/** Opens a thread in the open workspace, at a message, to reply to it when one is named. */
function openThread(
  router: ReturnType<typeof useRouter>,
  workspaceId: string | null,
  threadId: string,
  at: { readonly message?: string; readonly reply?: string } = {},
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

/** What a stream or thread adds where phone writes are on: outbox rows, reactions, Reply, and the composer. */
interface ScreenWrites {
  /** The messages only this phone has, given the IDs the screen's read shows. */
  local(shown: ReadonlySet<string>): readonly Message[];
  /** A message the server has, with this phone's reactions over the server's. */
  message(entry: ChatMessage, base: Message): Message;
  readonly actions: LocalActions;
  readonly react: ReactActions;
  /** Reply on a message. In a stream, `post` says it's a post, whose thread is its own. */
  reply(message: Message, post: boolean): void;
  /** Null until the server says which lanes a stream takes, or its read fails. */
  readonly composer:
    | ((onLayoutHeight: (height: number) => void, title: string) => ReactNode)
    | null;
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
  const you = useMemo<Author>(
    () => ({
      id: "local:you",
      name: chatWords.you,
      kind: "person",
      initials: (signIn.email[0] ?? "").toUpperCase(),
    }),
    [signIn],
  );
  const reactionsByMessage = useMemo(
    () => (state && rowScope ? reactionRecords(state, rowScope) : null),
    [state, rowScope],
  );
  const unconfirmed = state?.unconfirmed;
  // A message this phone has no reaction for keeps its object while the outbox changes, so its row doesn't draw again.
  const [plain] = useState(() => new WeakMap<Message, Message>());
  const message = useCallback(
    (entry: ChatMessage, base: Message) => {
      const records = reactionsByMessage?.get(entry.id);
      if (records)
        return withReactions(
          base,
          confirmedReactions(entry.reactions, signIn.userId),
          records,
          unconfirmed,
        );
      const kept = plain.get(base);
      if (kept) return kept;
      const made = withReactions(base, confirmedReactions(entry.reactions, signIn.userId));
      plain.set(base, made);
      return made;
    },
    [signIn, reactionsByMessage, unconfirmed, plain],
  );
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
  };
}

/** A reply chosen in a stream: to an outbox post or send whose thread isn't known yet. */
interface StreamReply {
  readonly target: ReplyTarget;
  readonly to: ReplyTo;
}

const excerptOf = (message: Message) =>
  message.body
    .map((segment) => ("text" in segment ? segment.text : `@${segment.mention}`))
    .join("");

// A stream where phone writes are on. Its posts and messages go through the account's outbox. Reply on a message the
// server has opens its thread; on a post or send still in the outbox, the composer replies to it here, and the reply
// waits for the thread that write will name.
function WritableStream({ groupId, name }: { groupId: string; name: string }) {
  const router = useRouter();
  const lanesView = useMemo(() => views.lanes(groupId), [groupId]);
  const { state: lanesState, retry: retryLanes } = useView(lanesView);
  const context = lanesState.value;
  const lanes = useMemo<Lanes | null>(
    () => (context?.kind === "lanes" ? lanesOf(context) : null),
    [context],
  );
  const problemText = useProblemText();
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
  } = useScreenWrites(groupId);
  const [replyTo, setReplyTo] = useState<StreamReply | null>(null);
  const local = useCallback(
    (shown: ReadonlySet<string>) =>
      state && rowScope
        ? streamRows(state, rowScope, groupId, shown).map((row) => localMessage(row, you))
        : [],
    [state, rowScope, groupId, you],
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
  // A failed read of the lanes shows in the composer's place, with its cause and Try again, and keeps the composer when
  // it has lanes already. The outbox's own problem comes first.
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
      const write = chatWrite(
        kind === "send" ? { kind, streamId: groupId } : { kind, groupId },
        body,
        title,
      );
      return write ? writes.submit(workspaceId, write) : { kind: "blocked" as const };
    },
    [writes, workspaceId, groupId, replyTo],
  );
  const cancelReply = useCallback(() => setReplyTo(null), []);
  const composer = useMemo(
    () =>
      lanes && (lanes.post || lanes.send)
        ? (onLayoutHeight: (height: number) => void, title: string) => (
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
    () => ({ local, message, actions, react, reply, composer }),
    [local, message, actions, react, reply, composer],
  );
  return <Stream groupId={groupId} name={name} writes={streamWrites} />;
}

// A thread where phone writes are on: every message in its composer is a reply. Reply on a message names it above the
// field, and the reply goes under it; with none chosen, it goes at the top of the thread. A thread opened to reply to
// a message starts with it chosen, once the read shows it.
function WritableThread({
  threadId,
  messageId,
  replyId,
}: {
  threadId: string;
  messageId: string | null;
  replyId: string | null;
}) {
  const { state, writes, blocked, actions, react, workspaceId, you, rowScope, message, problem } =
    useScreenWrites(threadId);
  const view = useMemo(() => views.thread(threadId), [threadId]);
  const value = useView(view).state.value;
  const thread = value?.kind === "thread" ? value : null;
  const [chosen, setChosen] = useState<string | null>(replyId);
  // Only a message the read shows is named and replied under: one it doesn't is never guessed at.
  const parent = useMemo(() => {
    const entry = chosen === null ? undefined : thread?.messages.find((each) => each.id === chosen);
    return entry
      ? { id: entry.id, to: { name: entry.authorName, excerpt: entry.body } satisfies ReplyTo }
      : null;
  }, [chosen, thread]);
  const local = useCallback(
    (shown: ReadonlySet<string>) =>
      state && rowScope
        ? threadRows(state, rowScope, threadId, shown).map((row) => localMessage(row, you))
        : [],
    [state, rowScope, threadId, you],
  );
  const reply = useCallback((entry: Message) => {
    if (!entry.local) setChosen(entry.id);
  }, []);
  const submit = useCallback(
    async (_kind: "send" | "post" | "reply", body: string) => {
      const next = replyWrite(
        { kind: "thread", threadId, parentMessageId: parent?.id ?? null },
        body,
      );
      if (!next || workspaceId === null) return { kind: "blocked" as const };
      const outcome = await writes.submit(workspaceId, next.write);
      const answered = parent?.id ?? null;
      if (outcome.kind === "kept" || outcome.kind === "withheld")
        setChosen((current) => (current === answered ? null : current));
      return outcome;
    },
    [writes, workspaceId, threadId, parent],
  );
  const cancelReply = useCallback(() => setChosen(null), []);
  const composer = useMemo(
    () => (onLayoutHeight: (height: number) => void) => (
      <Composer
        placeholder={chatWords.reply}
        lanes={REPLY_LANES}
        blocked={blocked}
        problem={problem}
        replies
        replyTo={parent?.to ?? null}
        onCancelReply={cancelReply}
        onSubmit={submit}
        onLayoutHeight={onLayoutHeight}
      />
    ),
    [blocked, problem, parent, cancelReply, submit],
  );
  const threadWrites = useMemo<ScreenWrites>(
    () => ({ local, message, actions, react, reply, composer }),
    [local, message, actions, react, reply, composer],
  );
  return <Thread threadId={threadId} messageId={messageId} writes={threadWrites} />;
}

/** A thread takes replies, and never a post. */
const REPLY_LANES: Lanes = { post: false, send: true };

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
  const unreadThreadIds = useMemo(
    () => (chats ? new Set(chats.flatMap((group) => group.unreadThreadIds)) : null),
    [chats],
  );
  useEffect(() => {
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
  const decorate = writes?.message;
  const messages = useMemo(
    () =>
      bases && stream && decorate
        ? bases.map((base, index) => {
            const item = stream.items[index];
            return item ? decorate(item.message, base) : base;
          })
        : bases,
    [bases, stream, decorate],
  );
  const local = useMemo(
    () =>
      writes && stream
        ? writes.local(new Set(stream.items.map((item) => item.message.id)))
        : undefined,
    [writes, stream],
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
  return (
    <Conversation
      title={chatTitle(kindOf(stream?.groupKind ?? "group"), stream?.name ?? name)}
      state={state}
      messages={messages}
      retry={retry}
      {...(writes && onReply
        ? {
            local: local ?? [],
            actions: writes.actions,
            react: writes.react,
            onReply,
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
  useEffect(
    () =>
      markShown(data, thread ? shownMessages(thread.messages, messageId, onScreen) : null, visible),
    [data, thread, messageId, onScreen, visible],
  );
  const bases = useMemo(
    () => thread?.messages.map((entry) => serverMessage(entry, null, workspaceMarkFills)) ?? null,
    [thread],
  );
  const decorate = writes?.message;
  const messages = useMemo(
    () =>
      bases && thread && decorate
        ? bases.map((base, index) => {
            const entry = thread.messages[index];
            return entry ? decorate(entry, base) : base;
          })
        : bases,
    [bases, thread, decorate],
  );
  const local = useMemo(
    () =>
      writes && thread
        ? writes.local(new Set(thread.messages.map((entry) => entry.id)))
        : undefined,
    [writes, thread],
  );
  const reply = writes?.reply;
  const onReply = useMemo(() => reply && ((message: Message) => reply(message, false)), [reply]);
  return (
    <Conversation
      title={thread?.title || workspaceWords.thread}
      state={state}
      messages={messages}
      retry={retry}
      anchor={messageId}
      {...(messageId === null ? {} : { onShown: addOnScreen })}
      {...(writes && onReply
        ? {
            local: local ?? [],
            actions: writes.actions,
            react: writes.react,
            onReply,
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
  anchor = null,
  onShown,
  local,
  actions,
  react,
  onReply,
  composer,
}: {
  title: string;
  state: ViewState<GroupStream | ChatThread | MissingChat>;
  messages: readonly Message[] | null;
  retry(): void;
  /** The message to open at, rather than the end. */
  anchor?: string | null;
  /** Takes the IDs of the messages on screen each time they change. */
  onShown?: (messageIds: readonly string[]) => void;
  /** Where writes are on: the messages only this phone has, after the server's. */
  local?: readonly Message[];
  actions?: LocalActions;
  react?: ReactActions;
  onReply?: (message: Message) => void;
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
  const items = useMemo(
    () => (messages ? conversationItems(messages, Date.now(), local) : []),
    [messages, local],
  );
  // Where the list opens: at the anchored message when this read has it, else at the end.
  const anchorIndex =
    anchor === null
      ? -1
      : items.findIndex((item) => item.type !== "day" && item.message.id === anchor);
  const openReplies = useCallback(
    (entry: Message) => {
      if (entry.threadId) openThread(router, workspaceId, entry.threadId);
    },
    [router, workspaceId],
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
        {...(actions ? { actions } : {})}
        {...(react ? { react } : {})}
        {...(onReply ? { onReply } : {})}
      />
    );
  const gap = useWorkspaceGap();
  const header = (
    <Stack.Screen
      options={{
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
      ) : null}
      {items.length === 0 ? (
        <EmptyLine text={workspaceWords.noMessages} />
      ) : composer === undefined ? (
        <LegendList
          data={items}
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
          data={items}
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
      {composer ? composer(setComposerHeight, title) : null}
    </View>
  );
}

// A message is on screen once it covers 1% of the list. The list's default of 0% also counts a message whose edge
// meets the list's edge with nothing of it showing.
const onScreenConfig: ViewabilityConfig = { viewAreaCoveragePercentThreshold: 1 };

const kindOf = (kind: ChatGroupKind): ChatKind => (kind === "dm" ? "person" : kind);

const subscribeAppState = (listener: () => void) => {
  const subscription = AppState.addEventListener("change", listener);
  return () => subscription.remove();
};
const appActive = () => AppState.currentState === "active";

function useVisible(): boolean {
  const focused = useIsFocused();
  const active = useSyncExternalStore(subscribeAppState, appActive);
  return focused && active;
}

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
