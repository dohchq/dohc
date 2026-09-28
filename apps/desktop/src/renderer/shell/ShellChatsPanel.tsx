import { Maximize2 } from "lucide-react";
import { Suspense, lazy, type ComponentProps } from "react";
import type {
  ChatThreadRecord,
  SyncStatusResult,
  WorkspaceSummary,
} from "../../ipc/bridgeContract";
import { ErrorBoundary } from "../ErrorBoundary";
import type { CustomizePart } from "../settings/customize";
import { MoreMenu } from "../ui/MoreMenu";
import { ChatsPanel, type ChatsPanelTab } from "../workbench/ChatsPanel";
import { PanelLoading } from "../workbench/PanelLoading";
import {
  isChatsTabPath,
  setChatsWidth,
  toggleChats,
  type WorkbenchState,
} from "../workbench/workbenchState";
import { chatsOffCopy } from "./capabilityOffCopy";
import { LazyChatsView } from "./lazyViews";

const LazyLinkedChatsPanel = lazy(() =>
  import("../workbench/LinkedChats").then((mod) => ({
    default: mod.LinkedChatsPanel,
  })),
);

type LinkedChatsPanelProps = ComponentProps<typeof LazyLinkedChatsPanel>;

// The right side panel: chats across the workspace, or the active file's.
export function ShellChatsPanel(props: {
  customize: (part: CustomizePart) => void;
  wb: WorkbenchState;
  mutateWb: (updater: (state: WorkbenchState) => WorkbenchState) => void;
  isShareView: boolean;
  chatsPanelActiveTab: ChatsPanelTab;
  setChatsPanelTab: (tab: ChatsPanelTab) => void;
  captureAvailable: boolean;
  captureDecided: boolean;
  focusedTabPath: string | null;
  openChatsTab: () => void;
  syncStatus: SyncStatusResult | null;
  workspaceId: string;
  activeDocumentPath: string | null;
  shareView: NonNullable<WorkspaceSummary["shareView"]> | null;
  searchChatTarget: { thread: ChatThreadRecord; focusMessageId?: string } | null;
  setSearchChatTarget: (target: null) => void;
  openPathWithHeading: LinkedChatsPanelProps["onOpenPath"];
  onChatsThreadRead: LinkedChatsPanelProps["onThreadRead"];
  reportFailureMessage: LinkedChatsPanelProps["onError"];
  chatsNavigatorProps: ComponentProps<typeof LazyChatsView>;
}) {
  const {
    customize,
    wb,
    mutateWb,
    isShareView,
    chatsPanelActiveTab,
    setChatsPanelTab,
    captureAvailable,
    captureDecided,
    focusedTabPath,
    openChatsTab,
    syncStatus,
    workspaceId,
    activeDocumentPath,
    shareView,
    searchChatTarget,
    setSearchChatTarget,
    openPathWithHeading,
    onChatsThreadRead,
    reportFailureMessage,
    chatsNavigatorProps,
  } = props;
  return (
    <ChatsPanel
      width={wb.chatsWidth}
      onWidthChange={(width) => mutateWb((state) => setChatsWidth(state, width))}
      onCollapse={() => mutateWb(toggleChats)}
      // A share view gets the file tab only: a workspace-wide listing
      // would be a superset to filter, which is the shape #627 came from.
      tabs={isShareView ? ["file"] : ["all", "file"]}
      tab={chatsPanelActiveTab}
      onTabChange={setChatsPanelTab}
      actions={
        <>
          {captureAvailable &&
          chatsPanelActiveTab === "all" &&
          !isChatsTabPath(focusedTabPath) ? (
            <button
              type="button"
              data-testid="chats-open-tab"
              aria-label="Open chats in tab"
              title="Open chats in tab"
              onClick={openChatsTab}
              className="grid size-6 place-items-center rounded text-subtle hover:bg-hover hover:text-ink"
            >
              <Maximize2 size={13} aria-hidden />
            </button>
          ) : null}
          <MoreMenu
            label="Chats actions"
            testId="chats-panel-menu"
            items={[{ label: "Customize…", onSelect: () => customize("chats") }]}
          />
        </>
      }
    >
      {/* Chats island: a crash in either panel view stays contained;
          switching panel mode or workspace tab clears the failure. */}
      <ErrorBoundary
        scope="rail"
        resetKeys={[chatsPanelActiveTab, focusedTabPath]}
      >
        {!captureAvailable && !isShareView ? (
          // Main's capture cannot serve chats here, so mounting either
          // view below would issue calls it refuses and show the
          // refusal as an error. Chats is a persistent sidebar
          // rather than a tab, so the panel stays where the user left
          // it — and states the fact, with the one next step that can
          // change it. Before the decision it states nothing.
          //
          // A shared view needs no capture and waits for no decision:
          // main answers its per-file chat from the share scope, and
          // its only tab is the file tab.
          !captureDecided ? (
            <PanelLoading label="Chats" />
          ) : (
            <div
              data-testid="chats-panel-off"
              className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-muted"
            >
              {chatsOffCopy(syncStatus)}
            </div>
          )
        ) : chatsPanelActiveTab === "file" ? (
          <Suspense fallback={<PanelLoading label="Chats" />}>
            <LazyLinkedChatsPanel
              workspaceId={workspaceId}
              filePath={activeDocumentPath}
              {...(shareView ? { shareReadOnly: true } : {})}
              initialThread={searchChatTarget?.thread ?? null}
              initialFocusMessageId={searchChatTarget?.focusMessageId}
              onInitialThreadConsumed={() => setSearchChatTarget(null)}
              onOpenPath={openPathWithHeading}
              onThreadRead={onChatsThreadRead}
              onError={reportFailureMessage}
            />
          </Suspense>
        ) : (
          <Suspense fallback={<PanelLoading label="Chats" />}>
            <LazyChatsView key={workspaceId} {...chatsNavigatorProps} />
          </Suspense>
        )}
      </ErrorBoundary>
    </ChatsPanel>
  );
}
