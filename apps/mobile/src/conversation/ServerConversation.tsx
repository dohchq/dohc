import { workspaceWords } from "@dohc/interface-words/workspace";
import { LegendList } from "@legendapp/list/react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { ProblemLine } from "../account/ProblemLine";
import { chatTitle } from "../chats/chatLabels";
import type { ChatKind } from "../chats/sample";
import { views, type ViewState } from "../server/workspaceData";
import type { ChatGroupKind, ChatThread, GroupStream, MissingChat } from "../server/workspaceReads";
import { useTheme, workspaceMarkFills } from "../theme";
import { EmptyLine, HoldRow, NoWorkspace, ScreenFailure, useWorkspaceGap } from "../workspace/ListStates";
import { useKeptContentProblem, useProblemText, useView } from "../workspace/useView";
import { MessageRow } from "./MessageRow";
import type { Message } from "./sample";
import { conversationItems, serverMessage } from "./serverMessages";


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
  const messages = useMemo(() => stream?.items.map(item => serverMessage(item.message,
    item.replyCount > 0 ? { count: item.replyCount, lastMs: item.lastReplyAtMs ?? item.message.createdAtMs } : null, workspaceMarkFills)) ?? null, [stream]);
  return <Conversation title={chatTitle(kindOf(stream?.groupKind ?? "group"), stream?.name ?? name)} state={state} messages={messages} retry={retry} />;
}

function Thread({ threadId }: { threadId: string }) {
  const view = useMemo(() => views.thread(threadId), [threadId]);
  const { state, retry } = useView(view);
  const thread = state.value?.kind === "thread" ? state.value : null;
  const messages = useMemo(() => thread?.messages.map(entry => serverMessage(entry, null, workspaceMarkFills)) ?? null, [thread]);
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
  const kept = useKeptContentProblem(state.problem, retry);
  const items = useMemo(() => messages ? conversationItems(messages, Date.now()) : [], [messages]);
  const openReplies = useCallback((entry: Message) => {
    if (entry.threadId) router.push({ pathname: "/chat/[id]", params: { id: entry.threadId } });
  }, [router]);
  const gap = useWorkspaceGap();
  const header = (
    <Stack.Screen options={{
      headerTitle: () => <Text style={[styles.name, { color: theme.ink }]} numberOfLines={1} accessibilityRole="header">{title}</Text>,
      headerStyle: { backgroundColor: theme.bg }, headerShadowVisible: true, headerTintColor: theme.ink,
    }} />
  );
  // No workspace open, as when another device hid the last one: the chat says why, as Home and Chats do.
  if (gap) return <View style={[styles.screen, { backgroundColor: theme.bg }]}>{header}<NoWorkspace /></View>;
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
      {/* What's shown stays while a refresh that failed, or a failing feed, waits for Try again. */}
      {kept ? <View style={[styles.problem, { borderBottomColor: theme.line }]}><ProblemLine text={kept.text} onRetry={kept.retry} /></View> : null}
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

const styles = StyleSheet.create({
  screen: { flex: 1 },
  name: { fontSize: 17, fontWeight: "600", maxWidth: 260 },
  problem: { paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth },
  dayRow: { alignItems: "center", paddingTop: 12, paddingBottom: 6 },
  day: { fontSize: 12, fontWeight: "600", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 11, overflow: "hidden" },
});
