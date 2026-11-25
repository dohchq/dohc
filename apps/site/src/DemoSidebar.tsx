import { useCallback, useMemo, useState } from "react";
import type {
  EngineMomentRecord,
  SitePackageInfo,
  WorkspaceFileEntry,
} from "../../desktop/src/ipc/bridgeContract";
import type { ExplorerApps } from "../../desktop/src/renderer/workbench/AppsSection";
import { ChatsView } from "../../desktop/src/renderer/workbench/ChatsView";
import { ReactionStoreProvider } from "../../desktop/src/renderer/workbench/reactionStore";
import { EngineHistoryView } from "../../desktop/src/renderer/workbench/EngineHistory";
import { Explorer } from "../../desktop/src/renderer/workbench/Explorer";
import { ExplorerModeSwitch } from "../../desktop/src/renderer/workbench/ExplorerModeSwitch";
import { GraphView } from "../../desktop/src/renderer/workbench/GraphView";
import { SearchView } from "../../desktop/src/renderer/workbench/SearchView";
import { SidePanel } from "../../desktop/src/renderer/workbench/SidePanel";
import { VIEW_IDENTITY } from "../../desktop/src/renderer/workbench/viewIdentity";
import type { ExplorerMode } from "../../desktop/src/renderer/workbench/workbenchState";

import { useWorkspaceSearch } from "../../desktop/src/renderer/workbench/useWorkspaceSearch";
import {
  projectTreePath,
  type PendingTreeChange,
} from "../../desktop/src/renderer/workbench/file-tree-optimistic";
import { GUESTS_DATASET, GUESTS_DATASET_PATH, GUESTS_TABLE_ID } from "./demoCollection";
import type { DemoPanelId } from "./demoPanels";
import { APP_ENTRY, APP_ROOT, APP_TITLE } from "./demoWorkspace";

const noCollectionFolders: ReadonlySet<string> = new Set();
const APP_FOLDERS: ReadonlySet<string> = new Set([APP_ROOT]);
const FIXED_FILES: readonly WorkspaceFileEntry[] = [
  { path: APP_ENTRY, kind: "file" },
  { path: GUESTS_DATASET_PATH, kind: "file" },
];
const DATA_COLLECTIONS = [
  {
    datasetId: GUESTS_DATASET.datasetId,
    datasetPath: GUESTS_DATASET_PATH,
    tableId: GUESTS_TABLE_ID,
    name: GUESTS_DATASET.name,
  },
];
const TRIP_PLANNER: SitePackageInfo = {
  root: APP_ROOT,
  title: APP_TITLE,
  kind: "static",
  confidence: "high",
  entryPath: APP_ENTRY,
  configPath: null,
  packagePath: null,
  packageManager: null,
  scripts: {},
  configuredScripts: {},
  configuredPreviewMode: null,
  configuredBuildOutput: null,
  buildOutputs: [],
  sourceFiles: [APP_ENTRY],
  shareManifest: { ok: false, reason: "no-runnable-artifact" },
  diagnostics: [],
  authority: { kind: "workspace" },
};
const noop = () => {};

// The demo has no editing pipeline, so no path ever holds a set-aside draft.
const NO_PATHS: ReadonlySet<string> = new Set();
// The demo bridge changes the documents before it answers, so the one listing
// the Explorer sees is always current and settles each answered change.
const DEMO_LISTING = 0;
export const DEMO_EDITOR_GROUP_ID = "demo-editor-group";

export type DemoWorkspaceDocument = {
  path: string;
  title: string;
  body: string;
  icon?: string;
};

function parentFolders(paths: string[]): string[] {
  const folders = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      folders.add(parts.slice(0, index).join("/"));
    }
  }
  return [...folders].sort();
}

type DemoMomentAuthor =
  | { personAuthorName: string }
  | { liveAuthorName: string }
  | { agentAuthorName: string };

function demoMoments(documents: DemoWorkspaceDocument[]): EngineMomentRecord[] {
  const events: Array<[string, string, number, DemoMomentAuthor]> = [
    ["Ticked off the Alfama flat", "Trip plan.md", 50_000, { personAuthorName: "You" }],
    ["Added the Regaleira tickets", "Days/Day 2 - Sintra.md", 900_000, { liveAuthorName: "Priya" }],
    ["Built the trip planner app", APP_ENTRY, 3_600_000, { agentAuthorName: "Your agent" }],
    ["Split the costs", "Budget.md", 7_200_000, { liveAuthorName: "Sam" }],
    ["Started the trip plan", "Trip plan.md", 86_400_000, { personAuthorName: "You" }],
  ];
  const paths = new Set([APP_ENTRY, ...documents.map((document) => document.path)]);
  return events
    .filter(([, path]) => paths.has(path))
    .map(([summary, path, age, author], index) => ({
      id: `demo-moment-${index}`,
      versionId: "main",
      path,
      recordedAtMs: Date.now() - age,
      operation: "write" as const,
      origin:
        "agentAuthorName" in author
          ? ("api" as const)
          : "liveAuthorName" in author
            ? ("ydoc" as const)
            : ("local-file" as const),
      ...author,
      summary,
      momentOrder: events.length - index,
      contentKind: "text" as const,
      byteLength: documents.find((document) => document.path === path)?.body.length ?? 0,
    }));
}

export function DemoSidebar(props: {
  activePanel: DemoPanelId;
  visible: boolean;
  documents: DemoWorkspaceDocument[];
  folders?: string[];
  activePath: string | null;
  openTabs: readonly string[];
  tabLabels: ReadonlyMap<string, string>;
  pinnedPages: readonly string[];
  pinnedApps: readonly string[];
  onTogglePinnedPage: (path: string) => void;
  onSetAppPinned: (appRoot: string, pinned: boolean) => void;
  onNewCollection: () => void;
  onOpenDocument: (path: string) => void;
  onCloseTab: (path: string) => void;
  onCloseAllTabs: () => void;
  onOpenTabsChange: (update: (tabs: string[]) => string[]) => void;
  onCreateDocument: (folder: string) => void;
  onBeforeChanges: () => Promise<void>;
  onError: (message: string) => void;
  onNotice: (message: string, undo?: () => void) => void;
  revealPaths: readonly string[] | null;
  onRevealed: () => void;
}) {
  const [width, setWidth] = useState(305);
  const [openEditorsHeight, setOpenEditorsHeight] = useState(180);
  const [explorerMode, setExplorerMode] = useState<ExplorerMode>("home");
  const [expandedFolders, setExpandedFolders] = useState<string[]>(["Days"]);
  const [revealing, setRevealing] = useState(props.revealPaths);
  if (props.revealPaths !== revealing) {
    setRevealing(props.revealPaths);
    const ancestors = parentFolders([...(props.revealPaths ?? [])]);
    setExpandedFolders((current) => [...new Set([...current, ...ancestors])]);
  }
  const [searchError, setSearchError] = useState<{
    message: string;
    retry: () => void;
  } | null>(null);
  const reportSearchError = useCallback((error: unknown, retry: () => void) => {
    const fallback = "dohc could not search this workspace.";
    const detail = error instanceof Error ? error.message.trim() : "";
    setSearchError({
      message:
        detail && detail !== fallback && !detail.startsWith(`${fallback} `)
          ? `${fallback} ${detail}`
          : detail || fallback,
      retry,
    });
  }, []);
  const clearSearchError = useCallback(() => setSearchError(null), []);
  const search = useWorkspaceSearch("marketing-demo", reportSearchError, clearSearchError);
  const files = useMemo<WorkspaceFileEntry[]>(
    () => [
      ...props.documents.map((document) => ({
        path: document.path,
        kind: "file" as const,
        ...(document.icon ? { icon: document.icon } : {}),
      })),
      ...FIXED_FILES,
    ],
    [props.documents],
  );
  const apps = useMemo<ExplorerApps>(
    () => ({
      state: { status: "ready", workspaceId: "marketing-demo", apps: [TRIP_PLANNER] },
      retry: noop,
      pinnedApps: props.pinnedApps,
      onSetPinned: props.onSetAppPinned,
      reveal: false,
      onRevealed: noop,
    }),
    [props.onSetAppPinned, props.pinnedApps],
  );
  const folders = useMemo(
    () =>
      [
        ...new Set([...parentFolders(files.map((file) => file.path)), ...(props.folders ?? [])]),
      ].sort(),
    [files, props.folders],
  );
  const moments = useMemo(() => demoMoments(props.documents), [props.documents]);
  const historyEntries = useMemo(
    () => moments.map((moment) => ({ kind: "file" as const, moment })),
    [moments],
  );
  const refreshKey = props.documents
    .map(
      (document) => `${document.path}:${document.body.match(/\[\[[^\]\n]*\]\]/g)?.join("") ?? ""}`,
    )
    .join("|");

  function reprojectPaths(changes: PendingTreeChange[]) {
    const project = (paths: string[]) => [
      ...new Set(
        paths.flatMap((path) => {
          const next = projectTreePath(path, changes);
          return next === null ? [] : [next];
        }),
      ),
    ];
    props.onOpenTabsChange(project);
    setExpandedFolders(project);
  }

  if (!props.visible) return null;

  return (
    <SidePanel
      title={VIEW_IDENTITY[props.activePanel].label}
      heading={
        props.activePanel === "explorer" ? (
          <ExplorerModeSwitch mode={explorerMode} onChange={setExplorerMode} />
        ) : undefined
      }
      width={width}
      onWidthChange={setWidth}
    >
      {props.activePanel === "explorer" ? (
        <Explorer
          workspaceId="marketing-demo"
          mode={explorerMode}
          onModeChange={setExplorerMode}
          listed
          shareView={null}
          files={files}
          folders={folders}
          listingRequest={DEMO_LISTING}
          collectionFolders={noCollectionFolders}
          onOpenCollection={noop}
          onNewCollection={props.onNewCollection}
          appFolders={APP_FOLDERS}
          apps={apps}
          dataCollections={DATA_COLLECTIONS}
          onOpenDataCollection={() => props.onOpenDocument(GUESTS_DATASET_PATH)}
          editorGroups={[
            {
              id: DEMO_EDITOR_GROUP_ID,
              tabs: props.openTabs.map((path) => ({ path })),
              activeTab: props.activePath,
              size: 1,
            },
          ]}
          activeEditorGroup={DEMO_EDITOR_GROUP_ID}
          tabLabels={props.tabLabels}
          dirtyPaths={NO_PATHS}
          recoveryPaths={NO_PATHS}
          expandedFolders={expandedFolders}
          pinned={[...props.pinnedPages]}
          openEditorsHeight={openEditorsHeight}
          onOpenEditorsHeightChange={setOpenEditorsHeight}
          newFolderRequest={null}
          onNewPage={props.onCreateDocument}
          onOpenFile={props.onOpenDocument}
          onActivateTab={(_groupId, path) => props.onOpenDocument(path)}
          onCloseTab={(_groupId, path) => props.onCloseTab(path)}
          onCloseAllTabs={props.onCloseAllTabs}
          onCollapseFolders={() => setExpandedFolders([])}
          onSetFolderExpanded={(path, expanded) =>
            setExpandedFolders((current) =>
              expanded
                ? current.includes(path)
                  ? current
                  : [...current, path]
                : current.filter((entry) => entry !== path),
            )
          }
          onToggleFolder={(path) =>
            setExpandedFolders((current) =>
              current.includes(path)
                ? current.filter((entry) => entry !== path)
                : [...current, path],
            )
          }
          onTogglePin={props.onTogglePinnedPage}
          onBeginChanges={async () => {
            await props.onBeforeChanges();
            return {
              settle: async () => undefined,
              release: () => undefined,
            };
          }}
          onPathsChanged={reprojectPaths}
          onImportFiles={() => undefined}
          onRefreshShareMounts={() => undefined}
          onUnmountShare={() => undefined}
          onShare={() => undefined}
          onRefresh={() => DEMO_LISTING}
          onError={props.onError}
          onNotice={props.onNotice}
          revealPaths={props.revealPaths}
          onRevealed={props.onRevealed}
        />
      ) : props.activePanel === "search" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {searchError ? (
            <div
              role="alert"
              className="flex min-h-8 shrink-0 items-center gap-2 border-b border-line bg-danger/10 px-3 text-[12px] text-danger"
            >
              <span className="min-w-0 flex-1 truncate">{searchError.message}</span>
              <button
                type="button"
                onClick={() => {
                  const retry = searchError.retry;
                  setSearchError(null);
                  retry();
                }}
                className="h-6 shrink-0 cursor-pointer rounded border border-danger/40 px-2 text-[11px] transition-colors hover:bg-danger/10"
              >
                Try again
              </button>
            </div>
          ) : null}
          <SearchView search={search} onOpenResult={props.onOpenDocument} />
        </div>
      ) : props.activePanel === "chats" ? (
        <ReactionStoreProvider workspaceId="marketing-demo">
          <ChatsView
            workspaceId="marketing-demo"
            onOpenFileChat={(thread) => thread.path && props.onOpenDocument(thread.path)}
            onOpenPath={props.onOpenDocument}
            onError={() => undefined}
            mentionCandidates={[
              {
                id: "agent:default",
                kind: "agent",
                handle: "agent",
                label: "Your agent",
                description: "your agent",
              },
              { id: "user:sam", kind: "user", handle: "sam", label: "Sam", description: "Sam" },
              {
                id: "user:priya",
                kind: "user",
                handle: "priya",
                label: "Priya",
                description: "Priya",
              },
            ]}
          />
        </ReactionStoreProvider>
      ) : props.activePanel === "graph" ? (
        <GraphView
          workspaceId="marketing-demo"
          activePath={props.activePath}
          refreshKey={refreshKey}
          onOpenPath={props.onOpenDocument}
        />
      ) : props.activePanel === "history" ? (
        <EngineHistoryView
          entries={historyEntries}
          hasMore={false}
          loadingMore={false}
          onLoadMore={() => undefined}
          onOpenMoment={(momentId) => {
            const path = moments.find((moment) => moment.id === momentId)?.path;
            if (path) props.onOpenDocument(path);
          }}
        />
      ) : (
        (props.activePanel satisfies never)
      )}
    </SidePanel>
  );
}
