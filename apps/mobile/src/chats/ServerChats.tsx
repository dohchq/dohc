import { workspaceWords } from "@dohc/interface-words/workspace";
import { LegendList } from "@legendapp/list/react-native";
import * as Haptics from "expo-haptics";
import { Stack, useRouter } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";
import { views } from "../server/workspaceData";
import type { ChatGroup } from "../server/workspaceReads";
import { useTheme, workspaceMarkFills } from "../theme";
import { EmptyLine, HoldRow, NoWorkspace, RetryRow } from "../workspace/ListStates";
import { useFailureNotice, useView } from "../workspace/useView";
import { ChatRow } from "./ChatRow";
import { ChatsHeader } from "./ChatsHeader";
import type { ChatRowData } from "./sample";
import { SectionHeader } from "./SectionHeader";
import { useWorkspaces } from "./Workspaces";

type Item =
  | { type: "header"; key: string; title: string; collapsed: boolean; first: boolean }
  | { type: "row"; key: string; row: ChatRowData }
  | { type: "state"; key: string };

// Chats in a signed-in build: the header, with the switcher and Settings, then the open workspace's groups, people and
// agents, as the server lists them. A chat opens its stream. The server keeps no read marks for the phone yet, so no
// chat shows as unread. The list reads again when the feed reports a chat change.
export function ServerChats() {
  const theme = useTheme();
  const { current } = useWorkspaces();
  const [scrolled, setScrolled] = useState(false);
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <Stack.Screen options={{ headerShown: false }} />
      <ChatsHeader workspace={current} scrolled={scrolled} />
      <NoWorkspace />
      {current ? <ChatList key={current.id} workspaceId={current.id} workspace={current.name} onScrolled={setScrolled} /> : null}
    </View>
  );
}

const SECTIONS: readonly { key: ChatGroup["kind"]; title: string }[] = [
  { key: "group", title: workspaceWords.groups },
  { key: "dm", title: workspaceWords.people },
  { key: "agent", title: workspaceWords.agents },
];

// The server keeps no colour for a person, so their mark takes a fill by their chat's ID, as a workspace's does.
function chatRow(group: ChatGroup): ChatRowData {
  const kind = group.kind === "dm" ? "person" : group.kind;
  if (kind !== "person") return { id: group.id, kind, name: group.name, unread: false };
  const hash = [...group.id].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 0);
  const initials = group.name.split(/\s+/).filter(Boolean).slice(0, 2).map(word => [...word][0]?.toUpperCase() ?? "").join("");
  return { id: group.id, kind, name: group.name, unread: false, initials, hue: workspaceMarkFills[hash % workspaceMarkFills.length]! };
}

function ChatList({ workspaceId, workspace, onScrolled }: { workspaceId: string; workspace: string; onScrolled(scrolled: boolean): void }) {
  const router = useRouter();
  const { state, retry } = useView(views.chats);
  const failed = workspaceWords.chatsFailed(workspace);
  useFailureNotice(`read:${workspaceId}:chats`, failed, state, retry);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const items = useMemo<Item[]>(() => {
    if (!state.value) return [{ type: "state", key: "state" }];
    const sections = SECTIONS.map(section => ({ ...section, rows: state.value?.filter(group => group.kind === section.key).map(chatRow) ?? [] }))
      .filter(section => section.rows.length > 0);
    if (sections.length === 0) return [{ type: "state", key: "state" }];
    return sections.flatMap((section, index) => {
      const closed = collapsed.has(section.key);
      return [
        { type: "header" as const, key: `h-${section.key}`, title: section.title, collapsed: closed, first: index === 0 },
        ...closed ? [] : section.rows.map(row => ({ type: "row" as const, key: row.id, row })),
      ];
    });
  }, [state.value, collapsed]);
  const toggle = useCallback((key: string) => {
    void Haptics.selectionAsync();
    setCollapsed(previous => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);
  const open = useCallback((row: ChatRowData) => router.push({ pathname: "/chat/[id]", params: { id: row.id, name: row.name } }), [router]);
  // Until the first answer, one row's height, or Try again once a read has failed; then the empty line, if it's empty.
  const placeholder = state.value ? <EmptyLine text={workspaceWords.noChats} /> : state.problem ? <RetryRow label={failed} onRetry={retry} /> : <HoldRow />;
  return (
    <LegendList
      data={items}
      keyExtractor={item => item.key}
      getItemType={item => item.type}
      estimatedItemSize={44}
      recycleItems
      scrollEventThrottle={32}
      onScroll={event => onScrolled(event.nativeEvent.contentOffset.y > 0)}
      contentContainerStyle={{ paddingTop: 0, paddingBottom: 120 }}
      renderItem={({ item }) => item.type === "header"
        ? <SectionHeader title={item.title} collapsed={item.collapsed} unread={false} first={item.first} onToggle={() => toggle(item.key.slice(2))} />
        : item.type === "row" ? <ChatRow row={item.row} onPress={open} /> : placeholder}
    />
  );
}
