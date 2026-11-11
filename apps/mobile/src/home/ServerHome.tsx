import { workspaceWords } from "@dohc/interface-words/workspace";
import * as Haptics from "expo-haptics";
import { Stack, useRouter } from "expo-router";
import { ChevronRight, File, FileText, Folder, FolderOpen, PenTool } from "lucide-react-native";
import { Fragment, memo, useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SectionHeader } from "../chats/SectionHeader";
import { useWorkspaces } from "../chats/Workspaces";
import { views } from "../server/workspaceData";
import { useTheme } from "../theme";
import { WorkspaceButton } from "../WorkspaceButton";
import { EmptyLine, HoldRow, NoWorkspace, RetryRow } from "../workspace/ListStates";
import { useFailureNotice, useView } from "../workspace/useView";
import { homeRows, type HomeRow } from "./homeModel";

// Home in a signed-in build: the open workspace's pages, in the folders that hold them, then its sketches and other files, as the
// desktop's Home lists them. A page opens to read; a folder opens in place. The phone opens no other kind of file yet,
// so those rows only name it. The list reads again when the feed reports a file change.
export function ServerHome() {
  const theme = useTheme();
  const { current } = useWorkspaces();
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" alwaysBounceVertical={false} style={{ backgroundColor: theme.bg }}
      contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: "Home", headerLeft: () => <WorkspaceButton /> }} />
      <NoWorkspace />
      {current ? <Files key={current.id} workspaceId={current.id} workspace={current.name} /> : null}
    </ScrollView>
  );
}

function Files({ workspaceId, workspace }: { workspaceId: string; workspace: string }) {
  const router = useRouter();
  const { state, retry } = useView(views.files);
  const failed = workspaceWords.filesFailed(workspace);
  useFailureNotice(`read:${workspaceId}:files`, failed, state, retry);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const rows = useMemo(() => state.value ? homeRows(state.value, expanded) : null, [state.value, expanded]);
  const toggle = useCallback((set: typeof setExpanded, key: string) => {
    void Haptics.selectionAsync();
    set(previous => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);
  const press = useCallback((row: HomeRow) => {
    if (row.kind === "folder") toggle(setExpanded, row.path);
    else if (row.kind === "page") router.push({ pathname: "/page", params: { path: row.path } });
  }, [router, toggle]);

  // Until the first answer, the section holds one row's height, or Try again once a read has failed.
  const pending = state.problem ? <RetryRow label={failed} onRetry={retry} /> : <HoldRow />;
  return (
    <>
      <SectionHeader title={workspaceWords.pages} collapsed={collapsed.has("pages")} unread={false} first onToggle={() => toggle(setCollapsed, "pages")} />
      {collapsed.has("pages") ? null : !rows ? pending
        : rows.pages.length === 0 ? <EmptyLine text={workspaceWords.noPages} />
        : rows.pages.map(row => <Row key={row.key} row={row} onPress={press} />)}
      {rows ? ([["sketches", workspaceWords.sketches, rows.sketches], ["other", workspaceWords.otherFiles, rows.others]] as const)
        .map(([id, title, list]) => list.count > 0 ? (
          <Fragment key={id}>
            <SectionHeader title={title} collapsed={collapsed.has(id)} unread={false} first={false} onToggle={() => toggle(setCollapsed, id)} />
            {collapsed.has(id) ? null : list.shown.map(row => <Row key={row.key} row={row} onPress={press} />)}
          </Fragment>
        ) : null) : null}
    </>
  );
}

const Row = memo(function Row({ row, onPress }: { row: HomeRow; onPress(row: HomeRow): void }) {
  const theme = useTheme();
  const listed = row.kind === "sketch" || row.kind === "other";
  const depth = row.kind === "folder" || row.kind === "page" ? row.depth : 0;
  const Icon = row.kind === "folder" ? row.open ? FolderOpen : Folder : row.kind === "page" ? FileText : row.kind === "sketch" ? PenTool : File;
  const content = (
    <>
      <View style={styles.chevron}>
        {row.kind === "folder" ? <ChevronRight size={14} color={theme.muted} strokeWidth={2}
          style={{ transform: [{ rotate: row.open ? "90deg" : "0deg" }] }} /> : null}
      </View>
      <Icon size={18} color={listed ? theme.subtle : theme.ink} strokeWidth={1.9} />
      <Text style={[styles.name, { color: listed ? theme.muted : theme.ink }]} numberOfLines={1}>{row.name}</Text>
      {listed && row.folder ? <Text style={[styles.detail, { color: theme.subtle }]} numberOfLines={1}>{row.folder}</Text> : null}
    </>
  );
  const style = [styles.row, { paddingLeft: 8 + depth * 20 }];
  // A file the phone can't open is no button: it only says the file is there.
  if (listed) return <View style={style} accessible accessibilityLabel={row.folder ? `${row.name}, ${row.folder}` : row.name}>{content}</View>;
  return (
    <Pressable onPress={() => onPress(row)} style={({ pressed }) => [style, pressed ? { backgroundColor: theme.panel2 } : null]}
      accessibilityRole="button" accessibilityLabel={row.name}
      accessibilityState={row.kind === "folder" ? { expanded: row.open } : undefined}>
      {content}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  content: { flexGrow: 1, paddingBottom: 120 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44, paddingRight: 16 },
  chevron: { width: 16, alignItems: "center" },
  name: { flexShrink: 1, fontSize: 17 },
  detail: { flex: 1, fontSize: 15, textAlign: "right" },
});
