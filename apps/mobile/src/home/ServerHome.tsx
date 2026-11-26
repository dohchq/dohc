import { appWords } from "@dohc/interface-words/apps";
import { collectionWords } from "@dohc/interface-words/collections";
import { workspaceWords } from "@dohc/interface-words/workspace";
import * as Haptics from "expo-haptics";
import { Stack, useIsFocused, useRouter } from "expo-router";
import {
  AppWindow,
  ChevronRight,
  File,
  FileText,
  Folder,
  FolderOpen,
  PenTool,
  ShieldCheck,
  Table2,
} from "lucide-react-native";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useAccount } from "../account/AccountProvider";
import { SettingsButton } from "../account/SettingsButton";
import type { AppsState } from "../apps/appStore";
import type { CollectionsState } from "../collections/collectionStore";
import { SectionHeader } from "../chats/SectionHeader";
import { useWorkspaces } from "../chats/Workspaces";
import { memberAppState } from "../apps/reviewControls";
import { appName, shortVersion, type PhoneApp } from "../server/phoneApps";
import { views } from "../server/workspaceData";
import { useTheme } from "../theme";
import { WorkspaceButton } from "../WorkspaceButton";
import { EmptyLine, HoldRow, NoWorkspace, RetryRow } from "../workspace/ListStates";
import { useFailureNotice, useView } from "../workspace/useView";
import { homeRows, type FirstFiles, type HomeRow } from "./homeModel";

const NO_APPS: AppsState = { apps: null, problem: null, failures: 0 };
const NO_COLLECTIONS: CollectionsState = { collections: null, problem: null, failures: 0 };
const nothing = () => () => undefined;

// Home in a signed-in build, in the desktop Home's order: the open workspace's published apps, each version under its app, then
// its pages, in the folders that hold them, then its sketches, its transactional Collections, and last its other files.
// A page opens to read; a folder opens in place; an app's version opens its review; a Collection opens its records. The
// phone opens no other kind of file yet, so those rows only name it.
// The list reads again when the feed reports a file change.
export function ServerHome() {
  const theme = useTheme();
  const { current } = useWorkspaces();
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      alwaysBounceVertical={false}
      style={{ backgroundColor: theme.bg }}
      contentContainerStyle={styles.content}
    >
      <Stack.Screen
        options={{
          title: "Home",
          headerLeft: () => <WorkspaceButton />,
          headerRight: Platform.OS === "android" ? () => <SettingsButton /> : undefined,
        }}
      />
      {Platform.OS === "ios" ? (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.View hidesSharedBackground>
            <SettingsButton />
          </Stack.Toolbar.View>
        </Stack.Toolbar>
      ) : null}
      <NoWorkspace />
      {current ? (
        <Files key={current.id} workspaceId={current.id} workspace={current.name} />
      ) : null}
    </ScrollView>
  );
}

function Files({ workspaceId, workspace }: { workspaceId: string; workspace: string }) {
  const router = useRouter();
  const { state, retry } = useView(views.files);
  const failed = workspaceWords.filesFailed(workspace);
  useFailureNotice(`read:${workspaceId}:files`, failed, state, retry);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set(["other"]));
  const rows = useMemo(
    () => (state.value ? homeRows(state.value, expanded) : null),
    [state.value, expanded],
  );
  const toggle = useCallback((set: typeof setExpanded, key: string) => {
    void Haptics.selectionAsync();
    set((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);
  const press = useCallback(
    (row: HomeRow) => {
      if (row.kind === "folder") toggle(setExpanded, row.path);
      else if (row.kind === "page")
        router.push({ pathname: "/page", params: { path: row.path, t0: String(Date.now()) } });
    },
    [router, toggle],
  );
  const { data, apps, collections } = useAccount();
  const pagesShown = !collapsed.has("pages");
  useEffect(() => {
    if (rows && pagesShown)
      data?.prefetchPages(rows.pages.flatMap((row) => (row.kind === "page" ? [row.path] : [])));
  }, [data, rows, pagesShown]);

  // The workspace's apps and Collections read each time Home shows, and its apps after an approval or a revoke.
  // Collections show only when there is one; a failed read is a toast and a Notices row.
  const theme = useTheme();
  const appsState = useSyncExternalStore(
    apps?.subscribe ?? nothing,
    useCallback(() => apps?.state() ?? NO_APPS, [apps]),
  );
  const collectionsState = useSyncExternalStore(
    collections?.subscribe ?? nothing,
    useCallback(() => collections?.state() ?? NO_COLLECTIONS, [collections]),
  );
  const focused = useIsFocused();
  useEffect(() => {
    if (focused) void apps?.refresh();
  }, [focused, apps]);
  useEffect(() => {
    if (focused) void collections?.refresh();
  }, [focused, collections]);
  const retryApps = useCallback(() => void apps?.refresh(), [apps]);
  const appsFailed = appWords.appsFailed(workspace);
  useFailureNotice(`read:${workspaceId}:apps`, appsFailed, appsState, retryApps);
  const retryCollections = useCallback(() => void collections?.refresh(), [collections]);
  const collectionsFailed = collectionWords.collectionsFailed(workspace);
  useFailureNotice(
    `read:${workspaceId}:collections`,
    collectionsFailed,
    collectionsState,
    retryCollections,
  );

  const pending = state.problem ? <RetryRow label={failed} onRetry={retry} /> : <HoldRow />;
  const fileSection = (id: string, title: string, list: FirstFiles | undefined) => {
    if (!list?.count) return null;
    return (
      <>
        <SectionHeader
          title={title}
          collapsed={collapsed.has(id)}
          unread={false}
          first={false}
          onToggle={() => toggle(setCollapsed, id)}
        />
        {collapsed.has(id)
          ? null
          : list.shown.map((row) => <Row key={row.key} row={row} onPress={press} />)}
      </>
    );
  };
  return (
    <>
      <SectionHeader
        title={appWords.apps}
        collapsed={collapsed.has("apps")}
        unread={false}
        first
        onToggle={() => toggle(setCollapsed, "apps")}
      />
      {collapsed.has("apps") ? null : !appsState.apps ? (
        appsState.problem ? (
          <RetryRow label={appsFailed} onRetry={retryApps} />
        ) : (
          <HoldRow />
        )
      ) : appsState.apps.length === 0 ? (
        <EmptyLine text={appWords.noApps} />
      ) : (
        appGroups(appsState.apps).map(([root, versions]) => {
          const name = appName(versions[0]!);
          if (versions.length === 1)
            return <AppRow key={root} app={versions[0]!} name={name} depth={0} />;
          return (
            <Fragment key={root}>
              <View style={[styles.row, styles.app]} accessible accessibilityRole="header">
                <AppWindow size={18} color={theme.ink} strokeWidth={1.9} />
                <Text style={[styles.name, { color: theme.ink }]} numberOfLines={1}>
                  {name}
                </Text>
              </View>
              {versions.map((app) => (
                <AppRow key={app.publicationId} app={app} name={name} depth={1} />
              ))}
            </Fragment>
          );
        })
      )}
      <SectionHeader
        title={workspaceWords.pages}
        collapsed={collapsed.has("pages")}
        unread={false}
        first={false}
        onToggle={() => toggle(setCollapsed, "pages")}
      />
      {collapsed.has("pages") ? null : !rows ? (
        pending
      ) : rows.pages.length === 0 ? (
        <EmptyLine text={workspaceWords.noPages} />
      ) : (
        rows.pages.map((row) => <Row key={row.key} row={row} onPress={press} />)
      )}
      {fileSection("sketches", workspaceWords.sketches, rows?.sketches)}
      {collectionsState.collections?.length ? (
        <SectionHeader
          title={collectionWords.collections}
          collapsed={collapsed.has("collections")}
          unread={false}
          first={false}
          onToggle={() => toggle(setCollapsed, "collections")}
        />
      ) : null}
      {collapsed.has("collections")
        ? null
        : collectionsState.collections?.map((collection) => (
            <Pressable
              key={collection.datasetId}
              onPress={() =>
                router.push({ pathname: "/collection", params: { id: collection.datasetId } })
              }
              style={({ pressed }) => [
                styles.row,
                styles.app,
                pressed ? { backgroundColor: theme.panel2 } : null,
              ]}
              accessibilityRole="button"
              accessibilityLabel={collection.name}
            >
              <Table2 size={18} color={theme.ink} strokeWidth={1.9} />
              <Text style={[styles.name, { color: theme.ink }]} numberOfLines={1}>
                {collection.name}
              </Text>
            </Pressable>
          ))}
      {fileSection("other", workspaceWords.otherFiles, rows?.others)}
    </>
  );
}

/**
 * The apps by identity, each with its published versions in the catalog's order: the owner's by root folder, and each
 * Member app alone, as its one current version.
 */
function appGroups(apps: readonly PhoneApp[]) {
  const groups = new Map<string, PhoneApp[]>();
  for (const app of apps) {
    const key = app.member ? `member:${app.publicationId}` : app.appRoot;
    groups.set(key, [...(groups.get(key) ?? []), app]);
  }
  return [...groups];
}

/**
 * One version of an app, which opens its review. Alone, it shows its app's name and its version beside it; a Member
 * app shows who made it and whether it waits for a review.
 */
function AppRow(props: { app: PhoneApp; name: string; depth: number }) {
  const { app, name, depth } = props;
  const theme = useTheme();
  const router = useRouter();
  const version = appWords.version(shortVersion(app));
  const label = depth === 0 ? name : version;
  const state = memberAppState(app);
  const made = app.member
    ? app.member.author
      ? appWords.sharedBy(app.member.author)
      : appWords.sharedByMember
    : null;
  const detail = made ? (state ?? "") : depth === 0 ? version : "";
  return (
    <Pressable
      onPress={() => router.push({ pathname: "/app-review", params: { id: app.publicationId } })}
      style={({ pressed }) => [
        styles.row,
        styles.app,
        { paddingLeft: styles.app.paddingLeft + depth * 26 },
        pressed ? { backgroundColor: theme.panel2 } : null,
      ]}
      accessibilityRole="button"
      accessibilityLabel={[
        name,
        ...(made ? [made] : [version]),
        ...(state ? [state] : app.approved ? [appWords.approved] : []),
      ].join(", ")}
    >
      {depth === 0 ? <AppWindow size={18} color={theme.ink} strokeWidth={1.9} /> : null}
      <View style={styles.names}>
        <Text style={[styles.name, { color: theme.ink }]} numberOfLines={1}>
          {label}
        </Text>
        {made ? (
          <Text style={[styles.made, { color: theme.subtle }]} numberOfLines={1}>
            {made}
          </Text>
        ) : null}
      </View>
      <Text
        style={[
          made ? styles.state : styles.detail,
          { color: state ? theme.accent : theme.subtle },
        ]}
        numberOfLines={made ? 2 : 1}
      >
        {detail}
      </Text>
      {app.approved ? <ShieldCheck size={16} color={theme.accent} strokeWidth={2} /> : null}
    </Pressable>
  );
}

const Row = memo(function Row({ row, onPress }: { row: HomeRow; onPress(row: HomeRow): void }) {
  const theme = useTheme();
  const listed = row.kind === "sketch" || row.kind === "other";
  const depth = row.kind === "folder" || row.kind === "page" ? row.depth : 0;
  const Icon =
    row.kind === "folder"
      ? row.open
        ? FolderOpen
        : Folder
      : row.kind === "page"
        ? FileText
        : row.kind === "sketch"
          ? PenTool
          : File;
  const content = (
    <>
      <View style={styles.chevron}>
        {row.kind === "folder" ? (
          <ChevronRight
            size={14}
            color={theme.muted}
            strokeWidth={2}
            style={{ transform: [{ rotate: row.open ? "90deg" : "0deg" }] }}
          />
        ) : null}
      </View>
      <Icon size={18} color={listed ? theme.subtle : theme.ink} strokeWidth={1.9} />
      <Text style={[styles.name, { color: listed ? theme.muted : theme.ink }]} numberOfLines={1}>
        {row.name}
      </Text>
      {listed && row.folder ? (
        <Text style={[styles.detail, { color: theme.subtle }]} numberOfLines={1}>
          {row.folder}
        </Text>
      ) : null}
    </>
  );
  const style = [styles.row, { paddingLeft: 8 + depth * 20 }];
  // A file the phone can't open is no button: it only says the file is there.
  if (listed)
    return (
      <View
        style={style}
        accessible
        accessibilityLabel={row.folder ? `${row.name}, ${row.folder}` : row.name}
      >
        {content}
      </View>
    );
  return (
    <Pressable
      onPress={() => onPress(row)}
      style={({ pressed }) => [style, pressed ? { backgroundColor: theme.panel2 } : null]}
      accessibilityRole="button"
      accessibilityLabel={row.name}
      accessibilityState={row.kind === "folder" ? { expanded: row.open } : undefined}
    >
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
  names: { flex: 1, paddingVertical: 4 },
  state: { maxWidth: "45%", fontSize: 15, textAlign: "right" },
  made: { fontSize: 15 },
  app: { paddingLeft: 32 },
});
