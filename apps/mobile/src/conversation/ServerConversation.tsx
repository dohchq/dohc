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
import type { ChatGroupKind, ChatThread, GroupStream, MissingChat } from "../server/workspaceReads";
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
import { blockedBy, chatWrite, createWriteScope, lanesOf, type Lanes } from "./conversationWrites";
import { MessageRow } from "./MessageRow";
import { streamRows } from "./outboxMessages";
import { markShown, markShownPosts, shownMessages } from "./readMarks";
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
  type LocalActions,
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
  } = useLocalSearchParams<{
    id: string;
    name?: string;
    thread?: string;
    workspace?: string;
    message?: string;
  }>();
  const { data } = useAccount();
  if (workspace !== undefined && data?.workspaceId !== workspace) return <ElsewhereChat />;
  if (thread === "1" || id.startsWith("thread-"))
    return <Thread threadId={id} messageId={message ?? null} />;
  // Writes are off unless the build turns them on (src/server/phoneWrites.ts): the chat stays read-only, as it was.
  return phoneWrites ? (
    <WritableStream groupId={id} name={name ?? ""} />
  ) : (
    <Stream groupId={id} name={name ?? ""} />
  );
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

/** What a stream adds where phone writes are on: its outbox rows, their actions, and the composer. */
interface StreamWrites {
  /** The messages only this phone has, given the IDs the stream's read shows. */
  local(shown: ReadonlySet<string>): readonly Message[];
  readonly actions: LocalActions;
  /** Null until the server says which lanes the stream takes, or its read fails. */
  readonly composer:
    | ((onLayoutHeight: (height: number) => void, title: string) => ReactNode)
    | null;
}

// A stream where phone writes are on. Its posts and messages go through the account's outbox, and each answer lands
// only while the screen still shows the same sign-in, workspace store and chat, so a slow enqueue can't clear another
// chat's draft or paint its rows, and a Discard confirmed after a change deletes nothing.
function WritableStream({ groupId, name }: { groupId: string; name: string }) {
  const signIn = useSignIn();
  const { data, outbox } = useAccount();
  const lanesView = useMemo(() => views.lanes(groupId), [groupId]);
  const { state: lanesState, retry: retryLanes } = useView(lanesView);
  const context = lanesState.value;
  const lanes = useMemo<Lanes | null>(
    () => (context?.kind === "lanes" ? lanesOf(context) : null),
    [context],
  );
  const problemText = useProblemText();
  const state = useOutboxState(outbox);
  // The screen's store and chat, from the commit that shows them until another replaces them or the screen closes, so a
  // controller made for them stops asking.
  const [scope] = useState(createWriteScope);
  useLayoutEffect(() => (data ? scope.show(data, groupId) : undefined), [scope, data, groupId]);
  const isCurrent = useCallback(
    () => signIn.isCurrent() && data !== null && scope.shows(data, groupId),
    [signIn, scope, data, groupId],
  );
  const writes = useConversationWrites(outbox, phoneWrites, isCurrent);
  const blocked = state ? blockedBy(state, phoneWrites) : "loading";
  const actions = useLocalActions(writes, blocked !== null);
  const workspaceId = data?.workspaceId ?? null;
  const you = useMemo<Author>(
    () => ({
      id: "local:you",
      name: chatWords.you,
      kind: "person",
      initials: (signIn.email[0] ?? "").toUpperCase(),
    }),
    [signIn],
  );
  const local = useCallback(
    (shown: ReadonlySet<string>) =>
      state && workspaceId
        ? streamRows(
            state,
            { origin: signIn.origin, accountId: signIn.userId, workspaceId },
            groupId,
            shown,
          ).map((row) => localMessage(row, you))
        : [],
    [state, workspaceId, signIn, groupId, you],
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
  const problem = useMemo(
    () => outboxProblem(state, blocked, () => outbox.wake()) ?? lanesProblem,
    [state, blocked, outbox, lanesProblem],
  );
  const composerKey = `${data?.instance ?? 0}:${groupId}`;
  const submit = useCallback(
    (kind: "send" | "post", body: string, title: string) => {
      const write = chatWrite(
        kind === "send" ? { kind, streamId: groupId } : { kind, groupId },
        body,
        title,
      );
      return write && workspaceId
        ? writes.submit(workspaceId, write)
        : Promise.resolve({ kind: "blocked" as const });
    },
    [writes, workspaceId, groupId],
  );
  // Keyed by the workspace store, which is one sign-in's, and the chat, so a draft never carries to another destination.
  const composer = useMemo(
    () =>
      lanes && (lanes.post || lanes.send)
        ? (onLayoutHeight: (height: number) => void, title: string) => (
            <Composer
              key={composerKey}
              placeholder={chatWords.messageTo(title)}
              lanes={lanes}
              blocked={blocked}
              problem={problem}
              onSubmit={submit}
              onLayoutHeight={onLayoutHeight}
            />
          )
        : lanesProblem
          ? (onLayoutHeight: (height: number) => void) => (
              <ComposerProblem
                key={composerKey}
                problem={lanesProblem}
                onLayoutHeight={onLayoutHeight}
              />
            )
          : null,
    [lanes, blocked, problem, submit, lanesProblem, composerKey],
  );
  const streamWrites = useMemo<StreamWrites>(
    () => ({ local, actions, composer }),
    [local, actions, composer],
  );
  return <Stream groupId={groupId} name={name} writes={streamWrites} />;
}

function Stream({
  groupId,
  name,
  writes,
}: {
  groupId: string;
  name: string;
  writes?: StreamWrites;
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
  const messages = useMemo(
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
  const local = useMemo(
    () =>
      writes && stream
        ? writes.local(new Set(stream.items.map((item) => item.message.id)))
        : undefined,
    [writes, stream],
  );
  return (
    <Conversation
      title={chatTitle(kindOf(stream?.groupKind ?? "group"), stream?.name ?? name)}
      state={state}
      messages={messages}
      retry={retry}
      {...(writes
        ? {
            local: local ?? [],
            actions: writes.actions,
            composer: writes.composer,
          }
        : {})}
    />
  );
}

function Thread({ threadId, messageId }: { threadId: string; messageId: string | null }) {
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
  const messages = useMemo(
    () => thread?.messages.map((entry) => serverMessage(entry, null, workspaceMarkFills)) ?? null,
    [thread],
  );
  return (
    <Conversation
      title={thread?.title || workspaceWords.thread}
      state={state}
      messages={messages}
      retry={retry}
      anchor={messageId}
      {...(messageId === null ? {} : { onShown: addOnScreen })}
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
  /** Where writes are on: the composer, or null until the server says which lanes the chat takes. */
  composer?: StreamWrites["composer"];
}) {
  const theme = useTheme();
  const router = useRouter();
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
      if (entry.threadId)
        router.push({ pathname: "/chat/[id]", params: { id: entry.threadId, thread: "1" } });
    },
    [router],
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
