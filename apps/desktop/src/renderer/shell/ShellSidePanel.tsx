import { Suspense, type ComponentProps, type ReactNode } from "react";
import type { SyncStatusResult, WorkspaceSummary } from "../../ipc/bridgeContract";
import { ErrorBoundary } from "../ErrorBoundary";
import type { CustomizePart } from "../settings/customize";
import { MoreMenu } from "../ui/MoreMenu";
import type { RelayShareTarget } from "../RelayShareDialog";
import { SkeletonRows } from "../ui/SkeletonRows";
// Type-only: erased at compile time, so this chunk stays lazy.
import type { SearchView } from "../workbench/SearchView";
import { SidePanel } from "../workbench/SidePanel";
import {
  isViewId,
  setSidebarWidth,
  SHARING_VIEW_ID,
  type WorkbenchState,
} from "../workbench/workbenchState";
import { LazyChatsView, LazyGraphView, LazySharingView, LazySitePreviewPage } from "./lazyViews";
import { SIDE_PANEL_VIEWS } from "./sidePanelViews";

type GraphViewProps = ComponentProps<typeof LazyGraphView>;
type SitePreviewPageProps = ComponentProps<typeof LazySitePreviewPage>;

export interface ShellSidePanelProps {
  customize: (part: CustomizePart) => void;
  wb: WorkbenchState;
  mutateWb: (updater: (state: WorkbenchState) => WorkbenchState) => void;
  sidePanelTitle: string;
  openHistoryTab: () => void;
  openGraphTab: () => void;
  openChatsTab: () => void;
  // Add an app here… opens the Explorer's Apps section. Null while the
  // workspace has no app to pin.
  showAppsInExplorer: (() => void) | null;
  explorerView: ReactNode;
  search: ComponentProps<typeof SearchView>["search"];
  openSearchResult: ComponentProps<typeof SearchView>["onOpenResult"];
  workspaceId: string;
  activeDocumentPath: string | null;
  focusedTabPath: string | null;
  graphKey: GraphViewProps["refreshKey"];
  openPathWithHeading: GraphViewProps["onOpenPath"];
  openGraphChatThread: GraphViewProps["onOpenChatThread"];
  captureAvailable: boolean;
  captureDecided: boolean;
  syncStatus: SyncStatusResult | null;
  chatsNavigatorProps: ComponentProps<typeof LazyChatsView>;
  setAppPinned: (appRoot: string, pinned: boolean) => Promise<void>;
  shareView: NonNullable<WorkspaceSummary["shareView"]> | null;
  historyTimeline: ReactNode;
  sharing: ComponentProps<typeof LazySharingView>;
  selectedAppRoot: string | null;
  openAppTab: SitePreviewPageProps["onOpenApp"];
  reportShellError: SitePreviewPageProps["reportError"];
  appNotices: SitePreviewPageProps["notices"];
  appAccess: SitePreviewPageProps["access"];
  setShareTarget: (target: RelayShareTarget) => void;
}

// The left side panel: the view the activity bar selected, or a pinned app.
export function ShellSidePanel(props: ShellSidePanelProps) {
  const {
    customize,
    wb,
    mutateWb,
    sidePanelTitle,
    workspaceId,
    shareView,
    sharing,
    selectedAppRoot,
    openAppTab,
    reportShellError,
    appNotices,
    appAccess,
    setAppPinned,
    setShareTarget,
    showAppsInExplorer,
  } = props;
  const view = isViewId(wb.activeView) ? SIDE_PANEL_VIEWS[wb.activeView] : null;
  return (
    <SidePanel
      title={sidePanelTitle}
      heading={view?.heading?.(props)}
      width={wb.sidebarWidth}
      onWidthChange={(width) => mutateWb((state) => setSidebarWidth(state, width))}
      actions={
        <>
          {view?.actions?.(props)}
          <MoreMenu
            label="Sidebar actions"
            testId="side-panel-menu"
            items={[
              { label: "Customize…", onSelect: () => customize(view?.customize ?? "sidebar") },
              // Pinned apps open here. The Explorer's Apps section pins one.
              ...(showAppsInExplorer
                ? [{ label: "Add an app here…", onSelect: showAppsInExplorer }]
                : []),
            ]}
          />
        </>
      }
    >
      {/* One island: a crash inside any panel view (or a failed lazy
          chunk under its Suspense) shows an inline error card here —
          the editor, tabs, and rail keep working. Switching views
          clears it. */}
      <ErrorBoundary scope="side-panel" resetKeys={[wb.activeView]}>
      {view ? (
        view.render(props)
      ) : wb.activeView === SHARING_VIEW_ID ? (
        <Suspense fallback={<SkeletonRows layout="panel" label="Loading sharing..." />}>
          <LazySharingView {...sharing} />
        </Suspense>
      ) : selectedAppRoot !== null ? (
        // The same sealed preview an app's tab runs: a sandboxed frame
        // on a dohc loopback server, with no dohc bridge.
        <Suspense fallback={<SkeletonRows layout="panel" label="Loading app..." />}>
          <LazySitePreviewPage
            key={selectedAppRoot}
            variant="panel"
            onOpenApp={openAppTab}
            onUnpin={() => void setAppPinned(selectedAppRoot, false)}
            workspaceId={workspaceId}
            reportError={reportShellError}
            notices={appNotices}
            siteRoot={selectedAppRoot}
            sharedView={!!shareView}
            onShareSite={(target) =>
              setShareTarget({ kind: "paths", paths: target.paths, label: target.label })
            }
            access={appAccess}
          />
        </Suspense>
      ) : null}
      </ErrorBoundary>
    </SidePanel>
  );
}
