import { parseTab } from "../workbench/workbenchState";
import { Maximize2 } from "lucide-react";
import { Suspense, type ReactNode } from "react";
import type { CustomizePart } from "../settings/customize";
import { SkeletonRows, SkeletonSlot } from "../ui/SkeletonRows";
// Eager on purpose. Behind lazy(), the search input did not exist until the
// chunk resolved, and every character typed in that gap went to whatever the
// user clicked to open the panel — queries arrived with their first letters
// missing. The view carries no dependency the shell does not already load.
import { SearchView } from "../workbench/SearchView";
import { VIEW_IDENTITY, type ViewIdentity } from "../workbench/viewIdentity";
import { type ViewId } from "../workbench/workbenchState";
import { chatsOffCopy } from "./capabilityOffCopy";
import { LazyChatsView, LazyGraphView } from "./lazyViews";
import type { ShellSidePanelProps } from "./ShellSidePanel";

// One of dohc's own side-panel views: what the rail shows for it, what the
// panel renders while it is selected, and the panel header's controls. The
// rail and Settings read only the label and icon, from VIEW_IDENTITY, so
// they load none of the views.
export interface SidePanelView extends ViewIdentity {
  // What the panel menu's Customize… opens while this view is selected.
  customize?: CustomizePart;
  render: (context: ShellSidePanelProps) => ReactNode;
  actions?: (context: ShellSidePanelProps) => ReactNode;
}

function HeaderButton(props: {
  testId: string;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={props.testId}
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
      className="grid size-6 place-items-center rounded text-subtle hover:bg-hover hover:text-ink"
    >
      {props.children}
    </button>
  );
}

const openInTabIcon = <Maximize2 size={13} aria-hidden />;

export const SIDE_PANEL_VIEWS: Readonly<Record<ViewId, SidePanelView>> = {
  explorer: {
    ...VIEW_IDENTITY.explorer,
    render: (context) => context.explorerView,
  },
  chats: {
    ...VIEW_IDENTITY.chats,
    customize: "chats",
    actions: (context) =>
      context.captureAvailable && !(parseTab(context.focusedTabPath)?.kind === "chat") ? (
        <HeaderButton testId="chats-open-tab" label="Open chats in tab" onClick={context.openChatsTab}>
          {openInTabIcon}
        </HeaderButton>
      ) : null,
    // The list mounts only while Chats is the selected view, so it reads and
    // polls nothing while another view or no panel is showing.
    render: (context) => (
      // Every loading state here puts its lines at the top of the panel, so
      // each one takes over from the last without blinking.
      <SkeletonSlot>
        {context.captureAvailable ? (
          <Suspense fallback={<SkeletonRows inSlot layout="panel" label="Loading Chats..." />}>
            <LazyChatsView key={context.workspaceId} {...context.chatsNavigatorProps} />
          </Suspense>
        ) : context.captureDecided ? (
          // Main's capture cannot serve chats here, so mounting the list
          // would issue calls it refuses. The view states the fact, with the
          // one next step that can change it. A shared view never shows this
          // view: it has chat per file, in About, and no workspace-wide
          // listing (the shape #627 came from).
          <div
            data-testid="chats-off"
            className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-muted"
          >
            {chatsOffCopy(context.syncStatus)}
          </div>
        ) : (
          // Main has not decided yet — a load state, not a claim.
          <SkeletonRows inSlot layout="panel" label="Loading Chats..." />
        )}
      </SkeletonSlot>
    ),
  },
  search: {
    ...VIEW_IDENTITY.search,
    render: (context) => (
      <SearchView search={context.search} onOpenResult={context.openSearchResult} />
    ),
  },
  graph: {
    ...VIEW_IDENTITY.graph,
    actions: (context) => (
      <HeaderButton testId="graph-open-tab" label="Open graph in tab" onClick={context.openGraphTab}>
        {openInTabIcon}
      </HeaderButton>
    ),
    render: (context) => (
      <Suspense fallback={<SkeletonRows layout="panel" label="Loading graph..." />}>
        <LazyGraphView
          workspaceId={context.workspaceId}
          activePath={context.activeDocumentPath}
          refreshKey={context.graphKey}
          onOpenPath={context.openPathWithHeading}
          onOpenChatThread={context.openGraphChatThread}
          chatMentionsAvailable={context.captureAvailable}
          onError={context.reportShellError}
          variant="panel"
        />
      </Suspense>
    ),
  },
  history: {
    ...VIEW_IDENTITY.history,
    actions: (context) => (
      <HeaderButton testId="history-open-tab" label="Open history in tab" onClick={context.openHistoryTab}>
        {openInTabIcon}
      </HeaderButton>
    ),
    render: (context) => context.historyTimeline,
  },
};
