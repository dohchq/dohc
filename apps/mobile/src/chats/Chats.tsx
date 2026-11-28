import { workspaceWords } from "@dohc/interface-words/workspace";
import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import * as Haptics from "expo-haptics";
import { Stack, useRouter, useScrollToTop } from "expo-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { View } from "react-native";
import { useAccount } from "../account/AccountProvider";
import { writesIn } from "../server/phoneWrites";
import { launchTimings } from "../startup";
import { views } from "../server/workspaceData";
import type { ChatGroup } from "../server/workspaceReads";
import { useTheme, workspaceMarkFills } from "../theme";
import { EmptyLine, HoldRow, NoWorkspace, RetryRow } from "../workspace/ListStates";
import { useFailureNotice, useView } from "../workspace/useView";
import { prefetchChat, unreadPrefetch } from "./chatPrefetch";
import { ChatRow } from "./ChatRow";
import { ChatsHeader } from "./ChatsHeader";
import { SectionHeader } from "./SectionHeader";
import type { ChatRowData, ChatSection, PhoneWorkspace } from "./types";
import { useWorkspaces } from "./Workspaces";

type Item =
  | {
      type: "header";
      key: string;
      title: string;
      collapsed: boolean;
      unread: boolean;
      first: boolean;
    }
  | { type: "row"; key: string; row: ChatRowData }
  | { type: "state"; key: string };

// Chats in a signed-in build, from the server's reads. A sample build feeds ChatsScreen its own sections instead
// (app/(tabs)/(chats)/index.tsx).
export function ServerChats() {
  const { current } = useWorkspaces();
  return current ? (
    <ServerChatList key={current.id} workspace={current} />
  ) : (
    <ChatsScreen current={null} sections={null} notice={<NoWorkspace />} />
  );
}

const SECTIONS: readonly { key: ChatGroup["kind"] | "archived"; title: string }[] = [
  { key: "group", title: workspaceWords.groups },
  { key: "dm", title: workspaceWords.people },
  { key: "agent", title: workspaceWords.agents },
  // Last and folded, as the desktop's sidebar has it.
  { key: "archived", title: workspaceWords.archived },
];
const sectionOf = (group: ChatGroup) => (group.archived ? "archived" : group.kind);

// The server keeps no colour for a person, so their mark takes a fill by their chat's ID, as a workspace's does. As on
// the desktop, an unread chat's name is bold, and a person or an agent also shows its count; a group shows none.
function chatRow(group: ChatGroup): ChatRowData {
  const kind = group.kind === "dm" ? "person" : group.kind;
  const unread = group.unreadCount > 0;
  if (kind === "group") return { id: group.id, kind, name: group.name, unread };
  const count = unread ? { count: group.unreadCount } : {};
  if (kind === "agent") return { id: group.id, kind, name: group.name, unread, ...count };
  const hash = [...group.id].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 0);
  const initials = group.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => [...word][0]?.toUpperCase() ?? "")
    .join("");
  return {
    id: group.id,
    kind,
    name: group.name,
    unread,
    ...count,
    initials,
    hue: workspaceMarkFills[hash % workspaceMarkFills.length]!,
  };
}

function ServerChatList({ workspace }: { workspace: PhoneWorkspace }) {
  const { data, apps, collections } = useAccount();
  const { state, retry } = useView(views.chats);
  const failed = workspaceWords.chatsFailed(workspace.name);
  useFailureNotice(`read:${workspace.id}:chats`, failed, state, retry);
  const groups = state.value;
  const sections = useMemo(
    () =>
      groups &&
      SECTIONS.map((section) => ({
        ...section,
        rows: groups.filter((group) => sectionOf(group) === section.key).map(chatRow),
      })).filter((section) => section.rows.length > 0),
    [groups],
  );
  const prefetch = useCallback(
    (row: ChatRowData) => {
      if (data) prefetchChat(data, row, writesIn(data));
    },
    [data],
  );
  const [warmUnread] = useState(() => unreadPrefetch(writesIn(data)));
  const [pulling, setPulling] = useState(false);
  const refresh = useCallback(() => {
    if (!data) return;
    setPulling(true);
    void data.refresh(views.chats).finally(() => setPulling(false));
  }, [data]);
  useEffect(() => {
    if (sections) launchTimings?.mark("chats", state.fromCache ? "cache" : "server");
    if (sections && data) {
      warmUnread(data, sections);
      void apps?.warm();
      void collections?.warm();
    }
  }, [sections, state.fromCache, data, apps, collections, warmUnread]);
  return (
    <ChatsScreen
      current={workspace}
      sections={sections}
      onPressIn={prefetch}
      failure={state.problem ? { label: failed, onRetry: retry } : null}
      refresh={{ refreshing: pulling, onRefresh: refresh }}
    />
  );
}

/**
 * The Chats tab from either source: the workspace's header, then each section's chats under a header that folds all of
 * them away, unread ones too. Key it by workspace, so one workspace's folded sections don't carry over to another.
 */
export function ChatsScreen({
  current,
  sections,
  failure,
  notice,
  list,
  refresh,
  onPressIn,
}: {
  current: PhoneWorkspace | null;
  /** Null while the chats are read. */
  sections: readonly ChatSection[] | null;
  /** Why the chats could not be read, with Try again. */
  failure?: { readonly label: string; onRetry(): void } | null;
  /** Between the header and the list: why no workspace is open, or the sample's band. */
  notice?: ReactNode;
  list?: RefObject<LegendListRef | null>;
  /** Pull to refresh: reads the chats again, with the spinner while that read runs. */
  refresh?: { readonly refreshing: boolean; onRefresh(): void };
  /** A finger is on a chat's row, before it opens. */
  onPressIn?: (row: ChatRowData) => void;
}) {
  const theme = useTheme();
  const router = useRouter();
  // Tapping Chats again scrolls back to the top. iOS's tab bar finds the list itself; Android's looks only down the
  // screen's first views, where the header is.
  const own = useRef<LegendListRef>(null);
  const listRef = list ?? own;
  useScrollToTop(listRef as RefObject<LegendListRef>);
  const [scrolled, setScrolled] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set(["archived"]));
  const items = useMemo<Item[]>(() => {
    if (!sections?.length) return [{ type: "state", key: "state" }];
    return sections.flatMap((section, index) => {
      const closed = collapsed.has(section.key);
      return [
        {
          type: "header" as const,
          key: `h-${section.key}`,
          title: section.title,
          collapsed: closed,
          unread: section.rows.some((row) => row.unread),
          first: index === 0,
        },
        ...(closed ? [] : section.rows.map((row) => ({ type: "row" as const, key: row.id, row }))),
      ];
    });
  }, [sections, collapsed]);
  const toggle = useCallback((key: string) => {
    void Haptics.selectionAsync();
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);
  const open = useCallback(
    (row: ChatRowData) =>
      router.push({ pathname: "/chat/[id]", params: { id: row.id, name: row.name } }),
    [router],
  );
  const placeholder = sections ? (
    <EmptyLine text={workspaceWords.noChats} />
  ) : failure ? (
    <RetryRow label={failure.label} onRetry={failure.onRetry} />
  ) : (
    <HoldRow />
  );
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <Stack.Screen options={{ headerShown: false }} />
      <ChatsHeader workspace={current} scrolled={scrolled} />
      {notice}
      {current ? (
        <LegendList
          ref={listRef}
          data={items}
          keyExtractor={(item) => item.key}
          getItemType={(item) => item.type}
          estimatedItemSize={44}
          recycleItems
          scrollEventThrottle={32}
          onScroll={(event) => setScrolled(event.nativeEvent.contentOffset.y > 0)}
          contentContainerStyle={{ paddingTop: 0, paddingBottom: 120 }}
          {...(refresh ?? {})}
          renderItem={({ item }) =>
            item.type === "header" ? (
              <SectionHeader
                title={item.title}
                collapsed={item.collapsed}
                unread={item.unread}
                first={item.first}
                onToggle={() => toggle(item.key.slice(2))}
              />
            ) : item.type === "row" ? (
              <ChatRow row={item.row} onPress={open} onPressIn={onPressIn} />
            ) : (
              placeholder
            )
          }
        />
      ) : null}
    </View>
  );
}
