import { Maximize2, RefreshCw } from "lucide-react";
import { Suspense, lazy, type ComponentProps, type ReactNode } from "react";
import type { WorkspaceSummary } from "../../ipc/bridgeContract";
import { ErrorBoundary } from "../ErrorBoundary";
import type { RelayShareTarget } from "../RelayShareDialog";
import { PanelLoading } from "../workbench/PanelLoading";
// Eager on purpose. Behind lazy(), the search input did not exist until the
// chunk resolved, and every character typed in that gap went to whatever the
// user clicked to open the panel — queries arrived with their first letters
// missing. The view carries no dependency the shell does not already load.
import { SearchView } from "../workbench/SearchView";
import { SidePanel } from "../workbench/SidePanel";
import { setSidebarWidth, type WorkbenchState } from "../workbench/workbenchState";
import { LazyGraphView, LazySitePreviewPage } from "./lazyViews";

const LazyAppsView = lazy(() =>
  import("../workbench/AppsView").then((mod) => ({ default: mod.AppsView })),
);

type GraphViewProps = ComponentProps<typeof LazyGraphView>;
type AppsViewProps = ComponentProps<typeof LazyAppsView>;
type SitePreviewPageProps = ComponentProps<typeof LazySitePreviewPage>;

// The left side panel: the view the activity bar selected, or a pinned app.
export function ShellSidePanel(props: {
  wb: WorkbenchState;
  mutateWb: (updater: (state: WorkbenchState) => WorkbenchState) => void;
  sidePanelTitle: string;
  openHistoryTab: () => void;
  openGraphTab: () => void;
  refreshSites: () => void;
  explorerView: ReactNode;
  search: ComponentProps<typeof SearchView>["search"];
  openSearchResult: ComponentProps<typeof SearchView>["onOpenResult"];
  workspaceId: string;
  activeDocumentPath: string | null;
  graphKey: GraphViewProps["refreshKey"];
  openPathWithHeading: GraphViewProps["onOpenPath"] & AppsViewProps["onOpenPath"];
  openGraphChatThread: GraphViewProps["onOpenChatThread"];
  captureAvailable: boolean;
  pinnedRoots: AppsViewProps["pinnedApps"];
  setAppPinned: (appRoot: string, pinned: boolean) => Promise<void>;
  listingsSettled: AppsViewProps["filesSettledRevision"];
  createFirstApp: AppsViewProps["onCreateFirstApp"];
  shareView: NonNullable<WorkspaceSummary["shareView"]> | null;
  historyTimeline: ReactNode;
  selectedAppRoot: string | null;
  openAppTab: SitePreviewPageProps["onOpenApp"];
  reportShellError: SitePreviewPageProps["reportError"];
  setShareTarget: (target: RelayShareTarget) => void;
}) {
  const {
    wb,
    mutateWb,
    sidePanelTitle,
    openHistoryTab,
    openGraphTab,
    refreshSites,
    explorerView,
    search,
    openSearchResult,
    workspaceId,
    activeDocumentPath,
    graphKey,
    openPathWithHeading,
    openGraphChatThread,
    captureAvailable,
    pinnedRoots,
    setAppPinned,
    listingsSettled,
    createFirstApp,
    shareView,
    historyTimeline,
    selectedAppRoot,
    openAppTab,
    reportShellError,
    setShareTarget,
  } = props;
  return (
    <SidePanel
      title={sidePanelTitle}
      width={wb.sidebarWidth}
      onWidthChange={(width) => mutateWb((state) => setSidebarWidth(state, width))}
      actions={
        wb.activeView === "history" ? (
          <button
            type="button"
            data-testid="history-open-tab"
            aria-label="Open history in tab"
            title="Open history in tab"
            onClick={openHistoryTab}
            className="grid size-6 place-items-center rounded text-subtle hover:bg-hover hover:text-ink"
          >
            <Maximize2 size={13} aria-hidden />
          </button>
        ) : wb.activeView === "graph" ? (
          <button
            type="button"
            data-testid="graph-open-tab"
            aria-label="Open graph in tab"
            title="Open graph in tab"
            onClick={openGraphTab}
            className="grid size-6 place-items-center rounded text-subtle hover:bg-hover hover:text-ink"
          >
            <Maximize2 size={13} aria-hidden />
          </button>
        ) : wb.activeView === "sites" ? (
          <button
            type="button"
            data-testid="sites-refresh"
            aria-label="Refresh apps"
            title="Refresh apps"
            onClick={refreshSites}
            className="grid size-6 place-items-center rounded text-subtle hover:bg-hover hover:text-ink"
          >
            <RefreshCw size={13} aria-hidden />
          </button>
        ) : undefined
      }
    >
      {/* One island: a crash inside any panel view (or a failed lazy
          chunk under its Suspense) shows an inline error card here —
          the editor, tabs, and rail keep working. Switching views
          clears it. */}
      <ErrorBoundary scope="side-panel" resetKeys={[wb.activeView]}>
      {wb.activeView === "explorer" ? (
        explorerView
      ) : wb.activeView === "search" ? (
        <SearchView search={search} onOpenResult={openSearchResult} />
      ) : wb.activeView === "graph" ? (
        <Suspense fallback={<PanelLoading label="graph" />}>
          <LazyGraphView
            workspaceId={workspaceId}
            activePath={activeDocumentPath}
            refreshKey={graphKey}
            onOpenPath={openPathWithHeading}
            onOpenChatThread={openGraphChatThread}
            chatMentionsAvailable={captureAvailable}
            variant="panel"
          />
        </Suspense>
      ) : wb.activeView === "sites" ? (
        <Suspense fallback={<PanelLoading label="apps" />}>
          <LazyAppsView
            workspaceId={workspaceId}
            pinnedApps={pinnedRoots}
            onSetPinned={(appRoot, pinned) => void setAppPinned(appRoot, pinned)}
            filesSettledRevision={listingsSettled}
            onOpenPath={openPathWithHeading}
            onCreateFirstApp={createFirstApp}
            receivedShareWorkspace={shareView !== null}
          />
        </Suspense>
      ) : wb.activeView === "history" ? (
        historyTimeline
      ) : selectedAppRoot !== null ? (
        // The same sealed preview an app's tab runs: a sandboxed frame
        // on a dohc loopback server, with no dohc bridge.
        <Suspense fallback={<PanelLoading label="app" />}>
          <LazySitePreviewPage
            key={selectedAppRoot}
            variant="panel"
            onOpenApp={openAppTab}
            onUnpin={() => void setAppPinned(selectedAppRoot, false)}
            workspaceId={workspaceId}
            reportError={reportShellError}
            siteRoot={selectedAppRoot}
            sharedView={!!shareView}
            onShareSite={(target) =>
              setShareTarget({ kind: "paths", paths: target.paths, label: target.label })
            }
          />
        </Suspense>
      ) : null}
      </ErrorBoundary>
    </SidePanel>
  );
}
