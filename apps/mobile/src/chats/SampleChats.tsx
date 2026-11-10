import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import * as Haptics from "expo-haptics";
import { Stack, useRouter } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { ChatRow } from "./ChatRow";
import { ChatsHeader } from "./ChatsHeader";
import { useDemoSheet } from "./demoSheets";
import { SectionHeader } from "./SectionHeader";
import type { ChatRowData } from "./sample";
import { useWorkspaces } from "./Workspaces";
import { NotYet } from "../NotYet";
import { syncProblem } from "../demo";
import { SyncBand } from "../notices/SyncBand";
import { FirstScreenProbe, firstScreenProbeOn } from "../firstScreenProbe";
import { useTheme } from "../theme";

type Item =
  | { type: "header"; key: string; title: string; collapsed: boolean; unread: boolean; first: boolean }
  | { type: "row"; key: string; row: ChatRowData };

export function SampleChats() {
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
