import { Suspense, lazy, memo, type ComponentProps } from "react";
import type {
  ChatThreadRecord,
  SyncStatusResult,
  WorkspaceSummary,
} from "../../ipc/bridgeContract";
import { ErrorBoundary } from "../ErrorBoundary";
import { AboutRail } from "../workbench/AboutRail";
import { SkeletonRows, SkeletonSlot } from "../ui/SkeletonRows";
import { setAboutWidth, type WorkbenchState } from "../workbench/workbenchState";
import { chatsOffCopy } from "./capabilityOffCopy";

const LazyLinkedChatsPanel = lazy(() =>
  import("../workbench/LinkedChats").then((mod) => ({
    default: mod.LinkedChatsPanel,
  })),
);

type LinkedChatsPanelProps = ComponentProps<typeof LazyLinkedChatsPanel>;

// The right side panel: About the active file. Every input is state or a
// stable callback, so a shell render that changes none of them skips it.
export const ShellAboutRail = memo(function ShellAboutRail(props: {
  wb: WorkbenchState;
  mutateWb: (updater: (state: WorkbenchState) => WorkbenchState) => void;
  captureAvailable: boolean;
  captureDecided: boolean;
  focusedTabPath: string | null;
  syncStatus: SyncStatusResult | null;
  workspaceId: string;
  activeDocumentPath: string | null;
  fileTabOpen: boolean;
  shareView: NonNullable<WorkspaceSummary["shareView"]> | null;
  searchChatTarget: { thread: ChatThreadRecord; focusMessageId?: string } | null;
  setSearchChatTarget: (target: null) => void;
  openPathWithHeading: LinkedChatsPanelProps["onOpenPath"];
  onChatsThreadRead: LinkedChatsPanelProps["onThreadRead"];
  reportFailureMessage: LinkedChatsPanelProps["onError"];
  historyRevision: number;
  openMoment: NonNullable<LinkedChatsPanelProps["history"]>["onOpenMoment"];
  aboutNotices: LinkedChatsPanelProps["notices"];
  accessContext: LinkedChatsPanelProps["accessContext"];
}) {
  const {
    wb,
    mutateWb,
    captureAvailable,
    captureDecided,
    focusedTabPath,
    syncStatus,
    workspaceId,
    activeDocumentPath,
    fileTabOpen,
    shareView,
    searchChatTarget,
    setSearchChatTarget,
    openPathWithHeading,
    onChatsThreadRead,
    reportFailureMessage,
    historyRevision,
    openMoment,
    aboutNotices,
    accessContext,
  } = props;
  return (
    <AboutRail
      width={wb.aboutWidth}
      onWidthChange={(width) => mutateWb((state) => setAboutWidth(state, width))}
    >
      {/* About island: a crash here stays contained; switching workspace
          tab clears the failure. */}
      <ErrorBoundary scope="rail" resetKeys={[focusedTabPath]}>
        {/* Every loading state here puts its lines at the top of the panel,
            so each one takes over from the last without blinking. */}
        <SkeletonSlot>
        {!captureAvailable && !shareView ? (
          // Main's capture cannot serve the file's chats here, so mounting
          // About would issue calls it refuses and show the refusal as an
          // error. The rail stays where the user left it and states the
          // fact, with the one next step that can change it. Before the
          // decision it states nothing.
          //
          // A shared view needs no capture and waits for no decision: main
          // answers its per-file chat from the share scope.
          !captureDecided ? (
            <SkeletonRows inSlot layout="panel" label="Loading About..." />
          ) : (
            <div
              data-testid="about-rail-off"
              className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-muted"
            >
              {chatsOffCopy(syncStatus)}
            </div>
          )
        ) : (
          <Suspense fallback={<SkeletonRows inSlot layout="panel" label="Loading About..." />}>
            <LazyLinkedChatsPanel
              workspaceId={workspaceId}
              filePath={activeDocumentPath}
              fileTabOpen={fileTabOpen}
              {...(shareView
                ? { shareReadOnly: true }
                : { history: { revision: historyRevision, onOpenMoment: openMoment } })}
              initialThread={searchChatTarget?.thread ?? null}
              initialFocusMessageId={searchChatTarget?.focusMessageId}
              onInitialThreadConsumed={() => setSearchChatTarget(null)}
              onOpenPath={openPathWithHeading}
              onThreadRead={onChatsThreadRead}
              onError={reportFailureMessage}
              notices={aboutNotices}
              accessContext={accessContext}
            />
          </Suspense>
        )}
        </SkeletonSlot>
      </ErrorBoundary>
    </AboutRail>
  );
});
