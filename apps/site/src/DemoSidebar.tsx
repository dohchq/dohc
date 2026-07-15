import { useMemo, useState } from "react";
import type {
  EngineMomentRecord,
  WorkspaceFileEntry,
} from "../../desktop/src/ipc/bridgeContract";
import { ChatsView } from "../../desktop/src/renderer/workbench/ChatsView";
import { EngineHistoryView } from "../../desktop/src/renderer/workbench/EngineHistory";
import { Explorer } from "../../desktop/src/renderer/workbench/Explorer";
import { GraphView } from "../../desktop/src/renderer/workbench/GraphView";
import { SearchView } from "../../desktop/src/renderer/workbench/SearchView";
import { SidePanel } from "../../desktop/src/renderer/workbench/SidePanel";
import { SitesView } from "../../desktop/src/renderer/workbench/SitesView";
import { useWorkspaceSearch } from "../../desktop/src/renderer/workbench/useWorkspaceSearch";
import type { ViewId } from "../../desktop/src/renderer/workbench/workbenchState";
import {
  projectTreePath,
  type PendingTreeChange,
} from "../../desktop/src/renderer/workbench/file-tree-optimistic";

export type DemoPanelId = ViewId | "chats";

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
    ["Saved latest edits", "projects/launch-plan.md", 180_000],
    ["Updated agent workflows", "research/agent-workflows.md", 3_600_000],
    ["Reconciled offline edits", "welcome.md", 86_400_000],
  ] as const;
  return events
    .filter(([, path]) => documents.some((document) => document.path === path))
    .map(([summary, path, age], index) => ({
      id: `demo-moment-${index}`,
      versionId: "main",
      path,
      recordedAtMs: Date.now() - age,
      operation: "write" as const,
      origin: index === 2 ? ("api" as const) : ("local-file" as const),
      ...(index === 2 ? { agentAuthorName: "You" } : {}),
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
  activePath: string;
  onOpenDocument: (path: string) => void;
  onCreateDocument: () => void;
  onBeforeChanges: () => Promise<void>;
}) {
  const [width, setWidth] = useState(305);
  const [openEditorsHeight, setOpenEditorsHeight] = useState(180);
  const [expandedFolders, setExpandedFolders] = useState<string[]>([
    "notes",
    "projects",
    "research",
  ]);
  const [openTabs, setOpenTabs] = useState<string[]>(() =>
    props.documents.slice(0, 5).map((document) => document.path),
  );
  const search = useWorkspaceSearch("marketing-demo");
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
  const refreshKey = props.documents.map((document) => document.path).join("|");

  function open(path: string) {
    setOpenTabs((current) => (current.includes(path) ? current : [...current, path]));
    props.onOpenDocument(path);
  }

  function reprojectPaths(changes: PendingTreeChange[]) {
    const project = (paths: string[]) => [
      ...new Set(
        paths.flatMap((path) => {
          const next = projectTreePath(path, changes);
          return next === null ? [] : [next];
        }),
      ),
    ];
    setOpenTabs(project);
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
          files={files}
          folders={folders}
          activeTab={props.activePath}
          openTabs={openTabs.map((path) => ({ path }))}
          dirtyTab={null}
          expandedFolders={expandedFolders}
          pinned={[]}
          openEditorsHeight={openEditorsHeight}
          onOpenEditorsHeightChange={setOpenEditorsHeight}
          createRequest={null}
          onOpenFile={open}
          onActivateTab={open}
          onCloseTab={(path) =>
            setOpenTabs((current) => current.filter((entry) => entry !== path))
          }
          onCloseAllTabs={() => setOpenTabs([])}
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
          onBeforeChanges={props.onBeforeChanges}
          onPathsChanged={reprojectPaths}
          onImportFiles={() => undefined}
          onRefreshShareMounts={() => undefined}
          onUnmountShare={() => undefined}
          onShare={() => undefined}
          onRefresh={() => undefined}
          onNewFileDialog={props.onCreateDocument}
        />
      ) : props.activePanel === "search" ? (
        <SearchView search={search} onOpenResult={(path) => open(path)} />
      ) : props.activePanel === "chats" ? (
        <ChatsView
          workspaceId="marketing-demo"
          onOpenFileChat={(thread) => thread.path && open(thread.path)}
          onOpenPath={open}
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
      ) : props.activePanel === "graph" ? (
        <GraphView
          workspaceId="marketing-demo"
          activePath={props.activePath}
          refreshKey={refreshKey}
          onOpenPath={open}
        />
      ) : props.activePanel === "sites" ? (
        <SitesView
          workspaceId="marketing-demo"
          files={files}
          refreshKey={props.documents.length}
          onOpenPath={() => open("projects/launch-plan.md")}
        />
      ) : (
        <EngineHistoryView
          moments={moments}
          hasMore={false}
          loadingMore={false}
          onLoadMore={() => undefined}
          onOpenMoment={(momentId) => {
            const path = moments.find((moment) => moment.id === momentId)?.path;
            if (path) open(path);
          }}
        />
      )}
    </SidePanel>
  );
}
