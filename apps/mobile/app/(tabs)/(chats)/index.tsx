import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import * as Haptics from "expo-haptics";
import { Stack, useRouter } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { ChatRow } from "../../../src/chats/ChatRow";
import { ChatsHeader } from "../../../src/chats/ChatsHeader";
import { useDemoSheet } from "../../../src/chats/demoSheets";
import { SectionHeader } from "../../../src/chats/SectionHeader";
import type { ChatRowData } from "../../../src/chats/sample";
import { useWorkspaces } from "../../../src/chats/Workspaces";
import { NotYet } from "../../../src/NotYet";
import { syncProblem } from "../../../src/demo";
import { SyncBand } from "../../../src/notices/SyncBand";
import { FirstScreenProbe, firstScreenProbeOn } from "../../../src/firstScreenProbe";
import { sampleBuild } from "../../../src/sampleBuild";
import { ServerChats } from "../../../src/chats/ServerChats";
import { useTheme } from "../../../src/theme";

type Item =
  | { type: "header"; key: string; title: string; collapsed: boolean; unread: boolean; first: boolean }
  | { type: "row"; key: string; row: ChatRowData };

export default function Chats() {
  return sampleBuild ? <SampleChats /> : <ServerChats />;
}

function SampleChats() {
  const theme = useTheme();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [scrolled, setScrolled] = useState(false);
  const { current } = useWorkspaces();
  useDemoSheet();
  const list = useRef<LegendListRef>(null);

  // Slack keeps unread chats visible in a collapsed section; so does this list.
  const items = useMemo<Item[]>(() => (current?.sections ?? []).flatMap((section, index) => {
    const closed = collapsed.has(section.key);
    const rows = closed ? section.rows.filter(row => row.unread) : section.rows;
    return [
      { type: "header" as const, key: `h-${section.key}`, title: section.title, collapsed: closed, unread: section.rows.some(row => row.unread), first: index === 0 },
      ...rows.map(row => ({ type: "row" as const, key: row.id, row })),
    ];
  }), [collapsed, current]);

  const toggle = useCallback((key: string) => {
    void Haptics.selectionAsync();
    setCollapsed(previous => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);
  const open = useCallback((row: ChatRowData) => router.push({ pathname: "/chat/[id]", params: { id: row.id, name: row.name } }), [router]);

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <Stack.Screen options={{ headerShown: false }} />
      {firstScreenProbeOn ? <FirstScreenProbe list={list} /> : null}
      {current ? <ChatsHeader workspace={current} scrolled={scrolled} /> : <NotYet symbol="person.crop.circle.badge.plus" title="First run" />}
      {syncProblem ? <SyncBand problem={syncProblem} /> : null}
      <LegendList
        ref={list}
        data={items}
        keyExtractor={item => item.key}
        getItemType={item => item.type}
        estimatedItemSize={44}
        recycleItems
        scrollEventThrottle={32}
        onScroll={event => setScrolled(event.nativeEvent.contentOffset.y > 0)}
        contentContainerStyle={{ paddingTop: 0, paddingBottom: 120 }}
        renderItem={({ item }) => item.type === "header"
          ? <SectionHeader title={item.title} collapsed={item.collapsed} unread={item.unread} first={item.first} onToggle={() => toggle(item.key.slice(2))} />
          : <ChatRow row={item.row} onPress={open} />}
      />
    </View>
  );
}
