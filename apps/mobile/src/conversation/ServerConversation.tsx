import { workspaceWords } from "@dohc/interface-words/workspace";
import { LegendList } from "@legendapp/list/react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { ProblemLine } from "../account/ProblemLine";
import { chatTitle } from "../chats/chatLabels";
import type { ChatKind } from "../chats/sample";
import { views, type ViewState } from "../server/workspaceData";
import type { ChatGroupKind, ChatMessage, ChatThread, GroupStream, MissingChat } from "../server/workspaceReads";
import { useTheme, workspaceMarkFills } from "../theme";
import { EmptyLine, HoldRow, ScreenFailure } from "../workspace/ListStates";
import { useProblemText, useView } from "../workspace/useView";
import { MessageRow } from "./MessageRow";
import type { Author, Message } from "./sample";

type Item = { type: "day"; key: string; label: string } | { type: "message"; key: string; message: Message; continued: boolean; afterExtras: boolean };

// A chat or a thread in a signed-in build, read-only, as the server holds it: oldest at the top, newest at the bottom.
// A chat's posts open their threads. The phone writes nothing yet, so it has no composer. The view reads again when
// the feed reports a change to one of its threads.
export function ServerConversation() {
  const { id = "", name } = useLocalSearchParams<{ id: string; name?: string }>();
  return id.startsWith("thread-") ? <Thread threadId={id} /> : <Stream groupId={id} name={name ?? ""} />;
}

function Stream({ groupId, name }: { groupId: string; name: string }) {
  const view = useMemo(() => views.stream(groupId), [groupId]);
  const { state, retry } = useView(view);
  const stream = state.value?.kind === "stream" ? state.value : null;
  const messages = useMemo(() => stream?.items.map(item => message(item.message,
    item.replyCount > 0 ? { count: item.replyCount, lastMs: item.lastReplyAtMs ?? item.message.createdAtMs } : null)) ?? null, [stream]);
  return <Conversation title={chatTitle(kindOf(stream?.groupKind ?? "group"), stream?.name ?? name)} state={state} messages={messages} retry={retry} />;
}

function Thread({ threadId }: { threadId: string }) {
  const view = useMemo(() => views.thread(threadId), [threadId]);
  const { state, retry } = useView(view);
  const thread = state.value?.kind === "thread" ? state.value : null;
  const messages = useMemo(() => thread?.messages.map(entry => message(entry, null)) ?? null, [thread]);
  return <Conversation title={thread?.title || workspaceWords.thread} state={state} messages={messages} retry={retry} />;
}

function Conversation({ title, state, messages, retry }: {
  title: string;
  state: ViewState<GroupStream | ChatThread | MissingChat>;
  messages: readonly Message[] | null;
  retry(): void;
}) {
  const theme = useTheme();
  const router = useRouter();
  const problemText = useProblemText();
  const items = useMemo(() => messages ? conversationItems(messages, Date.now()) : [], [messages]);
  const openReplies = useCallback((entry: Message) => {
    if (entry.threadId) router.push({ pathname: "/chat/[id]", params: { id: entry.threadId } });
  }, [router]);
  const header = (
    <Stack.Screen options={{
      headerTitle: () => <Text style={[styles.name, { color: theme.ink }]} numberOfLines={1} accessibilityRole="header">{title}</Text>,
      headerStyle: { backgroundColor: theme.bg }, headerShadowVisible: true, headerTintColor: theme.ink,
    }} />
  );
  if (state.value?.kind === "missing") return <View style={[styles.screen, { backgroundColor: theme.bg }]}>{header}<ScreenFailure text={workspaceWords.chatMissing} /></View>;
  if (!messages) {
    return (
      <View style={[styles.screen, { backgroundColor: theme.bg }]}>
        {header}
        {state.problem
          ? <ScreenFailure text={workspaceWords.chatFailed} cause={problemText(state.problem)} onRetry={retry} />
          : <HoldRow />}
      </View>
    );
  }
  return (
    <View style={[styles.screen, { backgroundColor: theme.bg }]}>
      {header}
      {/* What's shown stays while a refresh that failed waits for Try again. */}
      {state.problem ? <View style={[styles.problem, { borderBottomColor: theme.line }]}><ProblemLine text={problemText(state.problem)} onRetry={retry} /></View> : null}
      {items.length === 0 ? <EmptyLine text={workspaceWords.noMessages} /> : (
        <LegendList
          data={items}
          keyExtractor={item => item.key}
          getItemType={item => item.type}
          estimatedItemSize={64}
          alignItemsAtEnd
          initialScrollAtEnd
          maintainScrollAtEnd
          contentContainerStyle={{ paddingBottom: 24 }}
          renderItem={({ item }) => item.type === "day"
            ? <View style={styles.dayRow}><Text style={[styles.day, { color: theme.muted, backgroundColor: theme.panel2 }]}>{item.label}</Text></View>
            : <MessageRow message={item.message} continued={item.continued} afterExtras={item.afterExtras} onOpenReplies={openReplies} />}
        />
      )}
    </View>
  );
}

const kindOf = (kind: ChatGroupKind): ChatKind => kind === "dm" ? "person" : kind;

const timeOf = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

// The server keeps no colour for a person, so their mark takes a fill by their name, the same in every chat.
function author(entry: ChatMessage): Author {
  if (entry.authorKind === "agent") return { id: entry.authorName, name: entry.authorName, kind: "agent" };
  const hash = [...entry.authorName].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 0);
  const initials = entry.authorName.split(/\s+/).filter(Boolean).slice(0, 2).map(word => [...word][0]?.toUpperCase() ?? "").join("");
  return { id: entry.authorName, name: entry.authorName, kind: "person", initials, hue: workspaceMarkFills[hash % workspaceMarkFills.length]! };
}

function message(entry: ChatMessage, replies: { count: number; lastMs: number } | null): Message {
  return {
    id: entry.id, threadId: entry.threadId, author: author(entry), at: timeOf(entry.createdAtMs), minute: Math.floor(entry.createdAtMs / 60_000),
    body: [{ text: entry.body }],
    ...(replies ? { replies: { count: replies.count, last: timeOf(replies.lastMs), people: [] } } : {}),
  };
}

const dayKey = (ms: number) => new Date(ms).toDateString();

/** Messages under a line for each day, and each follow-up from the same author within 5 minutes without its byline. */
export function conversationItems(messages: readonly Message[], nowMs: number): Item[] {
  const today = dayKey(nowMs);
  const yesterday = dayKey(nowMs - 86_400_000);
  const items: Item[] = [];
  let day: string | null = null;
  for (const [index, entry] of messages.entries()) {
    const at = entry.minute * 60_000;
    const key = dayKey(at);
    if (key !== day) {
      day = key;
      const label = key === today ? workspaceWords.today : key === yesterday ? workspaceWords.yesterday
        : new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
      items.push({ type: "day", key: `day:${key}`, label });
    }
    const previous = index > 0 ? messages[index - 1] : undefined;
    const continued = previous !== undefined && dayKey(previous.minute * 60_000) === key && previous.author.id === entry.author.id &&
      entry.minute - previous.minute <= 5;
    // A follow-up after a thread link sits a little further away, so it doesn't read as part of it.
    items.push({ type: "message", key: entry.id, message: entry, continued, afterExtras: previous?.replies !== undefined });
  }
  return items;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  name: { fontSize: 17, fontWeight: "600", maxWidth: 260 },
  problem: { paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth },
  dayRow: { alignItems: "center", paddingTop: 12, paddingBottom: 6 },
  day: { fontSize: 12, fontWeight: "600", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 11, overflow: "hidden" },
});
