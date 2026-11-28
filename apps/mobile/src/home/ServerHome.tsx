import { appWords } from "@dohc/interface-words/apps";
import { collectionWords } from "@dohc/interface-words/collections";
import { documentWords } from "@dohc/interface-words/documents";
import { workspaceWords } from "@dohc/interface-words/workspace";
import * as Crypto from "expo-crypto";
import * as Haptics from "expo-haptics";
import { Stack, useIsFocused, useRouter } from "expo-router";
import {
  AppWindow,
  ChevronRight,
  Ellipsis,
  File,
  FileText,
  Folder,
  FolderOpen,
  PenTool,
  Plus,
  ShieldCheck,
  Table2,
} from "lucide-react-native";
import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useAccount, useSignIn } from "../account/AccountProvider";
import { SettingsButton } from "../account/SettingsButton";
import { HeaderButton } from "../AndroidHeader";
import type { AppsState } from "../apps/appStore";
import type { CollectionsState } from "../collections/collectionStore";
import { NewDocumentCollectionSheet } from "../collections/DocumentCollectionScreens";
import { SectionHeader } from "../chats/SectionHeader";
import { useWorkspaces } from "../chats/Workspaces";
import { choose } from "../confirm";
import { appState } from "../apps/reviewControls";
import { shownProblem } from "../server/client";
import { captureLabel } from "../server/captureQueue";
import { canWriteFiles, isLifecycleManagedPath } from "../server/fileWrites";
import { appName, shortVersion, type PhoneApp } from "../server/phoneApps";
import { createSketch } from "../server/phoneSketches";
import { writesIn } from "../server/phoneWrites";
import { views, type ReadProblem } from "../server/workspaceData";
import { allSketchRows, uniqueSketchPath } from "../sketches/sketchList";
import { useTheme } from "../theme";
import { ripple, TOUCH } from "../touch";
import { WorkspaceButton } from "../WorkspaceButton";
import { EmptyLine, HoldRow, NoWorkspace, RetryRow } from "../workspace/ListStates";
import { useFailureNotice, useView } from "../workspace/useView";
import { useFileLifecycle } from "./FileNameSheet";
import { QuickCaptureSheet } from "./QuickCaptureSheet";
import { appGroups, homeRows, revealedPages, type FirstFiles, type HomeRow } from "./homeModel";

const NO_APPS: AppsState = { apps: null, problem: null, failures: 0 };
const NO_COLLECTIONS: CollectionsState = { collections: null, problem: null, failures: 0 };
const nothing = () => () => undefined;

// Home in a signed-in build, in the desktop Home's order: the open workspace's apps, one per root folder, preferring the
// version sent to the owner's phones, with its versions under it only when it lists several; then its pages, in the
// folders that hold them, then its sketches, its transactional Collections, and last its other files.
// A page opens to read; a folder opens in place; an app or its version opens its review; a Collection opens its
// records. The phone opens no other kind of file yet, so those rows only name it.
// The list reads again when the feed reports a file change.
export function ServerHome() {
  const theme = useTheme();
  const router = useRouter();
  const { current } = useWorkspaces();
  const { data } = useAccount();
  const canEditFiles = canWriteFiles(data, current);
  const lifecycle = useFileLifecycle(current?.name ?? "");
  const [creatingCollection, setCreatingCollection] = useState(false);
  const [capturing, setCapturing] = useState(false);
  useEffect(() => {
    setCreatingCollection(false);
    setCapturing(false);
  }, [data?.workspaceId]);
  const openCreate = () =>
    lifecycle.openCreate((path) =>
      router.push({ pathname: "/page", params: { path, t0: String(Date.now()) } }),
    );
  const openCreateMenu = () =>
    void choose({
      title: workspaceWords.pages,
      options: [
        { label: workspaceWords.quickCapture },
        { label: workspaceWords.newPage },
        { label: collectionWords.newCollection },
      ],
    }).then((picked) => {
      if (picked === 0) setCapturing(true);
      else if (picked === 1) openCreate();
      else if (picked === 2) setCreatingCollection(true);
    });
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
          headerRight:
            Platform.OS === "android"
              ? () => (
                  <View style={styles.headerRight}>
                    {canEditFiles ? (
                      <HeaderButton
                        icon={Plus}
                        label={collectionWords.create}
                        onPress={openCreateMenu}
                      />
                    ) : null}
                    <SettingsButton />
                  </View>
                )
              : undefined,
        }}
      />
      {Platform.OS === "ios" ? (
        <Stack.Toolbar placement="right">
          {canEditFiles ? (
            <Stack.Toolbar.Menu icon="plus" accessibilityLabel={collectionWords.create}>
              <Stack.Toolbar.MenuAction
                icon="tray.and.arrow.down"
                onPress={() => setCapturing(true)}
              >
                {workspaceWords.quickCapture}
              </Stack.Toolbar.MenuAction>
              <Stack.Toolbar.MenuAction icon="doc.badge.plus" onPress={openCreate}>
                {workspaceWords.newPage}
              </Stack.Toolbar.MenuAction>
              <Stack.Toolbar.MenuAction
                icon="tablecells"
                onPress={() => setCreatingCollection(true)}
              >
                {collectionWords.newCollection}
              </Stack.Toolbar.MenuAction>
            </Stack.Toolbar.Menu>
          ) : null}
          <Stack.Toolbar.View hidesSharedBackground>
            <SettingsButton />
          </Stack.Toolbar.View>
        </Stack.Toolbar>
      ) : null}
      <NoWorkspace />
      {current ? (
        <Files
          key={current.id}
          workspaceId={current.id}
          workspace={current.name}
          canEditFiles={canEditFiles}
          deletingPath={lifecycle.deletingPath}
          openActions={lifecycle.openActions}
        />
      ) : null}
      {lifecycle.sheet}
      {canEditFiles ? (
        <>
          <QuickCaptureSheet open={capturing} onClose={() => setCapturing(false)} />
          <NewDocumentCollectionSheet
            open={creatingCollection}
            onClose={() => setCreatingCollection(false)}
            onCreated={(folder) => {
              setCreatingCollection(false);
              router.push({ pathname: "/document-collection", params: { path: folder } });
            }}
          />
        </>
      ) : null}
    </ScrollView>
  );
}

type EditableRow = Extract<HomeRow, { kind: "page" | "sketch" }>;

function Files({
  workspaceId,
  workspace,
  canEditFiles,
  deletingPath,
  openActions,
}: {
  workspaceId: string;
  workspace: string;
  canEditFiles: boolean;
  deletingPath: string | null;
  openActions: ReturnType<typeof useFileLifecycle>["openActions"];
}) {
  const router = useRouter();
  const { state, retry } = useView(views.files);
  const failed = workspaceWords.filesFailed(workspace);
  useFailureNotice(`read:${workspaceId}:files`, failed, state, retry);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set(["other"]));
  const [showAllSketches, setShowAllSketches] = useState(false);
  const [showAllOthers, setShowAllOthers] = useState(false);
  const [creatingSketch, setCreatingSketch] = useState(false);
  const [sketchFailure, setSketchFailure] = useState<{
    problem: ReadProblem | null;
    failures: number;
  }>({
    problem: null,
    failures: 0,
  });
  const createAbort = useRef<AbortController | null>(null);
  const createAttempt = useRef<{ path: string; requestId: string } | null>(null);
  const { data, apps, collections, captureQueue } = useAccount();
  const captureState = useSyncExternalStore(captureQueue.subscribe, captureQueue.state);
  const signIn = useSignIn();
  const workspaceCaptures = useMemo(
    () =>
      captureState.items.filter(
        (item) =>
          item.origin === signIn.origin &&
          item.accountId === signIn.userId &&
          item.workspaceId === workspaceId,
      ),
    [captureState.items, signIn.origin, signIn.userId, workspaceId],
  );
  const pendingCaptures = workspaceCaptures.filter((i) => i.stage !== "refused");
  const refusedCaptures = workspaceCaptures.filter((i) => i.stage === "refused");
  const { state: docCollectionsState, retry: retryDocCollections } = useView(
    views.documentCollections,
  );
  const docCollectionPaths = useMemo(
    () =>
      !data?.joined && docCollectionsState.value?.length
        ? new Set(docCollectionsState.value.map((c) => c.path))
        : undefined,
    [data?.joined, docCollectionsState.value],
  );
  const rows = useMemo(
    () =>
      state.value
        ? homeRows(state.value, expanded, {
            showAllOthers,
            documentCollections: docCollectionPaths,
          })
        : null,
    [state.value, expanded, showAllOthers, docCollectionPaths],
  );
  const openRowActions = useCallback(
    (item: EditableRow) =>
      openActions({ title: item.name, path: item.path, objectId: item.objectId }),
    [openActions],
  );
  const canOpenSketch = data !== null && !data.joined;
  const canCreateSketch =
    writesIn(data) && rows !== null && !state.fromCache && state.problem === null;
  useEffect(() => () => createAbort.current?.abort(), []);
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
      else if (row.kind === "sketch" && canOpenSketch)
        router.push({ pathname: "/sketch", params: { path: row.path } });
    },
    [router, toggle, canOpenSketch],
  );
  const startNewSketch = useCallback(async () => {
    if (!data || !canCreateSketch || creatingSketch) return;
    setCreatingSketch(true);
    setSketchFailure((prev) => ({ problem: null, failures: prev.failures }));
    const controller = new AbortController();
    createAbort.current = controller;
    try {
      const known = [...(state.value ?? [])];
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const current = (createAttempt.current ??= {
          path: uniqueSketchPath(known),
          requestId: Crypto.randomUUID(),
        });
        const result = await createSketch(
          signIn.client,
          data.workspaceId,
          current,
          controller.signal,
        );
        if (controller.signal.aborted || !signIn.isCurrent() || !data.isOpen()) return;
        createAttempt.current = null;
        if (result.kind === "created") {
          void data.refresh(views.files);
          router.push({ pathname: "/sketch", params: { path: result.path } });
          return;
        }
        known.push({ path: current.path, objectId: "", page: false });
      }
      setSketchFailure((prev) => ({ problem: "server-busy", failures: prev.failures + 1 }));
    } catch (error: unknown) {
      if (controller.signal.aborted || !signIn.isCurrent() || !data.isOpen()) return;
      const problem = shownProblem(error);
      if (problem !== null) setSketchFailure((prev) => ({ problem, failures: prev.failures + 1 }));
    } finally {
      if (createAbort.current === controller) createAbort.current = null;
      setCreatingSketch(false);
    }
  }, [canCreateSketch, creatingSketch, data, router, signIn, state.value]);
  useFailureNotice(
    `create:${workspaceId}:sketch`,
    workspaceWords.sketchCreateFailed,
    sketchFailure,
    startNewSketch,
  );
  const shownSketches = useMemo(
    () =>
      showAllSketches && state.value ? allSketchRows(state.value) : (rows?.sketches.shown ?? []),
    [showAllSketches, state.value, rows],
  );
  const pressInRow = useCallback(
    (row: HomeRow) => {
      if (row.kind === "page") data?.prefetch(views.page(row.path));
    },
    [data],
  );
  const prefetchApp = useCallback(
    (publicationId: string) => {
      apps?.prefetchReview(publicationId);
    },
    [apps],
  );
  const pagesShown = !collapsed.has("pages");
  const passed = useRef<{ data: unknown; paths: Set<string> }>({ data: null, paths: new Set() });
  useEffect(() => {
    if (!data || !rows || !pagesShown) return;
    if (passed.current.data !== data) passed.current = { data, paths: new Set() };
    data.prefetchPages(revealedPages(rows.pages, passed.current.paths));
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
  const groupedApps = useMemo(
    () => (appsState.apps ? appGroups(appsState.apps) : null),
    [appsState.apps],
  );
  const focused = useIsFocused();
  useEffect(() => {
    if (focused) void apps?.check();
  }, [focused, apps]);
  useEffect(() => {
    if (focused) void collections?.check();
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
  useFailureNotice(
    `read:${workspaceId}:doc-collections`,
    collectionsFailed,
    docCollectionsState,
    retryDocCollections,
  );

  const pending = state.problem ? <RetryRow label={failed} onRetry={retry} /> : <HoldRow />;
  const fileSection = (
    id: string,
    title: string,
    list: FirstFiles | undefined,
    onShowAll?: () => void,
  ) => {
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
        {collapsed.has(id) ? null : (
          <>
            {list.shown.map((row) => (
              <Row key={row.key} row={row} onPress={press} />
            ))}
            {onShowAll && list.count > list.shown.length ? (
              <Pressable
                onPress={onShowAll}
                android_ripple={ripple(theme)}
                style={({ pressed }) => [
                  styles.row,
                  styles.app,
                  pressed ? { backgroundColor: theme.panel2 } : null,
                ]}
                accessibilityRole="button"
                accessibilityLabel={workspaceWords.showAll(list.count)}
              >
                <Text style={[styles.name, { color: theme.accent }]} numberOfLines={1}>
                  {workspaceWords.showAll(list.count)}
                </Text>
              </Pressable>
            ) : null}
          </>
        )}
      </>
    );
  };
  return (
    <>
      {pendingCaptures.length > 0 ? (
        <Pressable
          onPress={() => captureQueue.wake()}
          android_ripple={ripple(theme)}
          style={[styles.captureRow, { backgroundColor: theme.panel, borderColor: theme.line }]}
          accessibilityRole="button"
        >
          {pendingCaptures.some((i) => i.stage === "sending") ? (
            <ActivityIndicator size="small" />
          ) : null}
          <Text style={[styles.captureText, { color: theme.muted }]} numberOfLines={1}>
            {pendingCaptures.some((i) => i.stage === "sending")
              ? workspaceWords.captureSending(pendingCaptures.length)
              : workspaceWords.captureWaiting(pendingCaptures.length)}
          </Text>
        </Pressable>
      ) : null}
      {refusedCaptures.map((item) => (
        <View
          key={item.requestId}
          style={[styles.captureRow, { backgroundColor: theme.panel, borderColor: theme.line }]}
        >
          <Text style={[styles.captureText, { color: theme.danger }]} numberOfLines={2}>
            {workspaceWords.captureFailed(captureLabel(item))} {item.reason ?? ""}
          </Text>
          <Pressable
            onPress={() => void captureQueue.discard(item.requestId)}
            android_ripple={ripple(theme, true)}
            style={styles.discardBtn}
            accessibilityRole="button"
          >
            <Text style={[styles.discardText, { color: theme.ink }]}>{workspaceWords.discard}</Text>
          </Pressable>
        </View>
      ))}
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
      ) : !groupedApps || groupedApps.length === 0 ? (
        <EmptyLine text={appWords.noApps} />
      ) : (
        groupedApps.map(({ key, versions, approvedBefore }) => {
          const name = appName(versions[0]!);
          if (versions.length === 1)
            return (
              <AppRow
                key={key}
                app={versions[0]!}
                name={name}
                depth={0}
                approvedBefore={approvedBefore}
                onPressIn={prefetchApp}
              />
            );
          return (
            <Fragment key={key}>
              <View style={[styles.row, styles.app]} accessible accessibilityRole="header">
                <AppWindow size={18} color={theme.ink} strokeWidth={1.9} />
                <Text style={[styles.name, { color: theme.ink }]} numberOfLines={1}>
                  {name}
                </Text>
              </View>
              {versions.map((app) => (
                <AppRow
                  key={app.publicationId}
                  app={app}
                  name={name}
                  depth={1}
                  approvedBefore={approvedBefore}
                  onPressIn={prefetchApp}
                />
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
        rows.pages.map((row) => (
          <Row
            key={row.key}
            row={row}
            onPress={press}
            onPressIn={pressInRow}
            onActions={
              canEditFiles && row.kind === "page" && isLifecycleManagedPath(row.path)
                ? openRowActions
                : undefined
            }
            busy={deletingPath === row.path}
          />
        ))
      )}
      {canCreateSketch || (rows?.sketches.count ?? 0) > 0 ? (
        <>
          <SectionHeader
            title={workspaceWords.sketches}
            collapsed={collapsed.has("sketches")}
            unread={false}
            first={false}
            onToggle={() => toggle(setCollapsed, "sketches")}
          />
          {collapsed.has("sketches") ? null : (
            <>
              {shownSketches.map((row) => (
                <Row
                  key={row.key}
                  row={row}
                  onPress={press}
                  openable={canOpenSketch}
                  onActions={
                    canEditFiles && isLifecycleManagedPath(row.path) ? openRowActions : undefined
                  }
                  busy={deletingPath === row.path}
                />
              ))}
              {!showAllSketches && rows && rows.sketches.count > rows.sketches.shown.length ? (
                <Pressable
                  onPress={() => setShowAllSketches(true)}
                  android_ripple={ripple(theme)}
                  style={({ pressed }) => [
                    styles.row,
                    styles.app,
                    pressed ? { backgroundColor: theme.panel2 } : null,
                  ]}
                  accessibilityRole="button"
                >
                  <Text style={[styles.name, { color: theme.accent }]} numberOfLines={1}>
                    {workspaceWords.showAllSketches(rows.sketches.count)}
                  </Text>
                </Pressable>
              ) : null}
              {canCreateSketch ? (
                <Pressable
                  disabled={creatingSketch}
                  onPress={() => void startNewSketch()}
                  android_ripple={ripple(theme)}
                  style={({ pressed }) => [
                    styles.row,
                    styles.app,
                    pressed ? { backgroundColor: theme.panel2 } : null,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={workspaceWords.newSketch}
                >
                  {creatingSketch ? (
                    <ActivityIndicator size="small" />
                  ) : (
                    <Plus size={18} color={theme.accent} strokeWidth={2} />
                  )}
                  <Text style={[styles.name, { color: theme.accent }]} numberOfLines={1}>
                    {creatingSketch ? workspaceWords.creatingSketch : workspaceWords.newSketch}
                  </Text>
                </Pressable>
              ) : null}
            </>
          )}
        </>
      ) : null}
      {collectionsState.collections?.length || docCollectionsState.value?.length ? (
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
        : [
            ...(collectionsState.collections ?? []).map((collection) => ({
              key: collection.datasetId,
              name: collection.name,
              onPressIn: () => void collections?.prefetch(collection.datasetId),
              onPress: () =>
                router.push({ pathname: "/collection", params: { id: collection.datasetId } }),
            })),
            ...(docCollectionsState.value ?? []).map((collection) => ({
              key: `doc:${collection.path}`,
              name: collection.name,
              onPressIn: undefined,
              onPress: () =>
                router.push({
                  pathname: "/document-collection",
                  params: { path: collection.path },
                }),
            })),
          ].map((item) => (
            <Pressable
              key={item.key}
              onPressIn={item.onPressIn}
              onPress={item.onPress}
              android_ripple={{ color: theme.panel2 }}
              style={({ pressed }) => [
                styles.row,
                styles.app,
                pressed ? { backgroundColor: theme.panel2 } : null,
              ]}
              accessibilityRole="button"
              accessibilityLabel={item.name}
            >
              <Table2 size={18} color={theme.ink} strokeWidth={1.9} />
              <Text style={[styles.name, { color: theme.ink }]} numberOfLines={1}>
                {item.name}
              </Text>
            </Pressable>
          ))}
      {fileSection("other", workspaceWords.otherFiles, rows?.others, () => setShowAllOthers(true))}
    </>
  );
}

/**
 * One version of an app, which opens its review. Alone, it shows its app's name; under its app, its version and
 * whether it is private to the owner or published. Each shows whether it waits for a review, and a Member app who made
 * it.
 */
const AppRow = memo(function AppRow(props: {
  app: PhoneApp;
  name: string;
  depth: number;
  approvedBefore: boolean;
  onPressIn(publicationId: string): void;
}) {
  const { app, name, depth, approvedBefore, onPressIn } = props;
  const theme = useTheme();
  const router = useRouter();
  const version = appWords.version(shortVersion(app));
  const label = depth === 0 ? name : version;
  const state = appState(app, approvedBefore);
  const made = app.member
    ? app.member.author
      ? appWords.sharedBy(app.member.author)
      : appWords.sharedByMember
    : depth
      ? app.owner
        ? appWords.privateCopy
        : appWords.publishedCopy
      : null;
  const detail = state ?? "";
  return (
    <Pressable
      onPressIn={() => onPressIn(app.publicationId)}
      onPress={() => router.push({ pathname: "/app-review", params: { id: app.publicationId } })}
      android_ripple={{ color: theme.panel2 }}
      style={({ pressed }) => [
        styles.row,
        styles.app,
        { paddingLeft: styles.app.paddingLeft + depth * 26 },
        pressed ? { backgroundColor: theme.panel2 } : null,
      ]}
      accessibilityRole="button"
      accessibilityLabel={[
        name,
        ...(depth ? [version] : []),
        ...(made ? [made] : []),
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
});

const Row = memo(function Row({
  row,
  onPress,
  onPressIn,
  openable,
  onActions,
  busy,
}: {
  row: HomeRow;
  onPress(row: HomeRow): void;
  onPressIn?(row: HomeRow): void;
  openable?: boolean;
  onActions?(row: EditableRow): void;
  busy?: boolean;
}) {
  const theme = useTheme();
  const listed = row.kind === "other" || (row.kind === "sketch" && !openable);
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
      {(row.kind === "sketch" || row.kind === "other") && row.folder ? (
        <Text style={[styles.detail, { color: theme.subtle }]} numberOfLines={1}>
          {row.folder}
        </Text>
      ) : null}
    </>
  );
  const actionButton =
    onActions && (row.kind === "page" || row.kind === "sketch") ? (
      busy ? (
        <View style={styles.rowMenu}>
          <ActivityIndicator size="small" accessibilityLabel={documentWords.deleting} />
        </View>
      ) : (
        <Pressable
          onPress={() => onActions(row)}
          android_ripple={ripple(theme, true)}
          style={styles.rowMenu}
          accessibilityRole="button"
          accessibilityLabel={workspaceWords.fileActions(row.name)}
        >
          <Ellipsis size={18} color={theme.muted} strokeWidth={2} />
        </Pressable>
      )
    ) : null;
  const style = [
    styles.row,
    { paddingLeft: 8 + depth * 20, paddingRight: actionButton ? 4 : 16 },
    actionButton ? styles.rowMain : null,
  ];
  const main = listed ? (
    <View
      style={style}
      accessible
      accessibilityLabel={row.folder ? `${row.name}, ${row.folder}` : row.name}
    >
      {content}
    </View>
  ) : (
    <Pressable
      onPressIn={onPressIn ? () => onPressIn(row) : undefined}
      onPress={() => onPress(row)}
      android_ripple={ripple(theme)}
      style={({ pressed }) => [style, pressed ? { backgroundColor: theme.panel2 } : null]}
      accessibilityRole="button"
      accessibilityLabel={row.name}
      accessibilityState={row.kind === "folder" ? { expanded: row.open } : undefined}
    >
      {content}
    </Pressable>
  );
  return actionButton ? (
    <View style={styles.rowWrap}>
      {main}
      {actionButton}
    </View>
  ) : (
    main
  );
});

const styles = StyleSheet.create({
  content: { flexGrow: 1, paddingBottom: 120 },
  headerRight: { flexDirection: "row", alignItems: "center" },
  rowWrap: { flexDirection: "row", alignItems: "center", paddingRight: 4 },
  rowMain: { flex: 1 },
  rowMenu: { minWidth: TOUCH, minHeight: TOUCH, alignItems: "center", justifyContent: "center" },
  row: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: TOUCH, paddingRight: 16 },
  chevron: { width: 16, alignItems: "center" },
  name: { flexShrink: 1, fontSize: 17 },
  detail: { flex: 1, fontSize: 15, textAlign: "right" },
  names: { flex: 1, paddingVertical: 4 },
  state: { maxWidth: "45%", fontSize: 15, textAlign: "right" },
  made: { fontSize: 15 },
  app: { paddingLeft: 32 },
  captureRow: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: TOUCH,
    gap: 10,
    marginHorizontal: 16,
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  captureText: { flex: 1, fontSize: 14, lineHeight: 19 },
  discardBtn: { minHeight: TOUCH, justifyContent: "center", paddingHorizontal: 8 },
  discardText: { fontSize: 14, fontWeight: "600" },
});
