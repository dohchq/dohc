import { useCallback, useMemo, useState } from "react";
import type {
  EngineMomentRecord,
  WorkspaceFileEntry,
} from "../../desktop/src/ipc/bridgeContract";
import { ChatsView } from "../../desktop/src/renderer/workbench/ChatsView";
import { ReactionStoreProvider } from "../../desktop/src/renderer/workbench/reactionStore";
import { EngineHistoryView } from "../../desktop/src/renderer/workbench/EngineHistory";
import { Explorer } from "../../desktop/src/renderer/workbench/Explorer";
import { GraphView } from "../../desktop/src/renderer/workbench/GraphView";
import { SearchView } from "../../desktop/src/renderer/workbench/SearchView";
import { SidePanel } from "../../desktop/src/renderer/workbench/SidePanel";

// The demo has no engine, so no folder is a collection.
const emptyCollectionFolders: ReadonlySet<string> = new Set();
const noopOpenCollection = () => {};
import { useWorkspaceSearch } from "../../desktop/src/renderer/workbench/useWorkspaceSearch";
import {
  projectTreePath,
  type PendingTreeChange,
} from "../../desktop/src/renderer/workbench/file-tree-optimistic";
import type { DemoPanelId } from "./demoPanels";

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

function demoMoments(documents: DemoWorkspaceDocument[]): EngineMomentRecord[] {
  const events = [
    ["Edited welcome.md", "welcome.md", 55_000],
    ["Saved launch plan", "projects/launch-plan.md", 180_000],
    ["Updated agent workflow", "research/agent-workflows.md", 3_600_000],
    ["Merged offline edits", "welcome.md", 86_400_000],
  ] as const;
  return events
    .filter(([, path]) => documents.some((document) => document.path === path))
    .map(([summary, path, age], index) => {
      const isAgentEvent = path === "research/agent-workflows.md";
      return {
        id: `demo-moment-${index}`,
        versionId: "main",
        path,
        recordedAtMs: Date.now() - age,
        operation: "write" as const,
        origin: isAgentEvent ? ("api" as const) : ("local-file" as const),
        ...(isAgentEvent ? { agentAuthorName: "Your agent" } : {}),
        summary,
        momentOrder: events.length - index,
        contentKind: "text" as const,
        byteLength: documents.find((document) => document.path === path)?.body.length ?? 0,
      };
    });
}

export function DemoSidebar(props: {
  activePanel: DemoPanelId;
  visible: boolean;
  documents: DemoWorkspaceDocument[];
  folders?: string[];
  // The document the editor shows, or null when no tab is open.
  activePath: string | null;
  openTabs: readonly string[];
  onOpenDocument: (path: string) => void;
  onCloseTab: (path: string) => void;
  onCloseAllTabs: () => void;
  onOpenTabsChange: (update: (tabs: string[]) => string[]) => void;
  onCreateDocument: () => void;
  onBeforeChanges: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [width, setWidth] = useState(305);
  const [openEditorsHeight, setOpenEditorsHeight] = useState(180);
  const [expandedFolders, setExpandedFolders] = useState<string[]>([
    "notes",
    "projects",
    "research",
  ]);
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
  const search = useWorkspaceSearch(
    "marketing-demo",
    reportSearchError,
    clearSearchError,
  );
  const files = useMemo<WorkspaceFileEntry[]>(
    () =>
      props.documents.map((document) => ({
        path: document.path,
        kind: "file",
        ...(document.icon ? { icon: document.icon } : {}),
      })),
    [props.documents],
  );
  const folders = useMemo(
    () => [
      ...new Set([
        ...parentFolders(props.documents.map((document) => document.path)),
        ...(props.folders ?? []),
      ]),
    ].sort(),
    [props.documents, props.folders],
  );
  const moments = useMemo(() => demoMoments(props.documents), [props.documents]);
  const historyEntries = useMemo(() => moments.map((moment) => ({ kind: "file" as const, moment })), [moments]);
  const refreshKey = props.documents.map((document) => document.path).join("|");

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
      title={props.activePanel}
      width={width}
      onWidthChange={setWidth}
    >
      {props.activePanel === "explorer" ? (
        <Explorer
          workspaceId="marketing-demo"
          shareView={null}
          files={files}
          folders={folders}
          listingRequest={DEMO_LISTING}
          collectionFolders={emptyCollectionFolders}
          onOpenCollection={noopOpenCollection}
          onNewCollection={noopOpenCollection}
          editorGroups={[
            {
              id: DEMO_EDITOR_GROUP_ID,
              tabs: props.openTabs.map((path) => ({ path })),
              activeTab: props.activePath,
              size: 1,
            },
          ]}
          activeEditorGroup={DEMO_EDITOR_GROUP_ID}
          dirtyPaths={NO_PATHS}
          recoveryPaths={NO_PATHS}
          expandedFolders={expandedFolders}
          pinned={[]}
          openEditorsHeight={openEditorsHeight}
          onOpenEditorsHeightChange={setOpenEditorsHeight}
          createRequest={null}
          onOpenFile={props.onOpenDocument}
          onActivateTab={(_groupId, path) => props.onOpenDocument(path)}
          onCloseTab={(_groupId, path) => props.onCloseTab(path)}
          onCloseAllTabs={props.onCloseAllTabs}
          onNewUntitledTextFile={props.onCreateDocument}
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
          onTogglePin={() => undefined}
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
          // The demo records no History operations, so it has nothing to undo.
          onNotice={() => undefined}
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
          workspaces={[{ workspaceId: "marketing-demo", label: "Marketing" }]}
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
            {
              id: "user:you",
              kind: "user",
              handle: "you",
              label: "You",
              description: "you",
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
        props.activePanel satisfies never
      )}
    </SidePanel>
  );
}
