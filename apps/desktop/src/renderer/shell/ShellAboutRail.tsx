import { Suspense, lazy, memo, useEffect, useState, type ComponentProps } from "react";
import type {
  ChatThreadRecord,
  SyncStatusResult,
  WorkspaceSummary,
} from "../../ipc/bridgeContract";
import { ErrorBoundary } from "../ErrorBoundary";
import { AboutRail } from "../workbench/AboutRail";
import { SkeletonRows, SkeletonSlot } from "../ui/SkeletonRows";
import { parseChatTabPath, setAboutWidth, type WorkbenchState } from "../workbench/workbenchState";
import { useAboutConversation } from "../workbench/aboutConversation";
import { chatsOffCopy } from "./capabilityOffCopy";

const LazyLinkedChatsPanel = lazy(() =>
  import("../workbench/LinkedChats").then((mod) => ({
    default: mod.LinkedChatsPanel,
  })),
);

const LazyAboutConversationPanel = lazy(() =>
  import("../workbench/AboutConversationPanel").then((mod) => ({
    default: mod.AboutConversationPanel,
  })),
);

type LinkedChatsPanelProps = ComponentProps<typeof LazyLinkedChatsPanel>;

// The right side panel: About the active file or conversation. Every input is
// state or a stable callback, so a shell render that changes none of them
// skips it.
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
  // A conversation tab's page says what About shows for it. A shared view
  // has no conversations, so its About stays on files. A chat search hit
  // opens its file's chat here, on the tab that had focus when it arrived,
  // until focus moves. The shell mints one target per hit, so each hit
  // latches once, and a hit not yet consumed never follows focus elsewhere.
  const [searchHit, setSearchHit] = useState<{
    target: NonNullable<typeof searchChatTarget>;
    tab: string | null;
    shown: boolean;
  } | null>(null);
  if (searchChatTarget !== null && searchHit?.target !== searchChatTarget) {
    setSearchHit({ target: searchChatTarget, tab: focusedTabPath, shown: true });
  }
  useEffect(() => {
    setSearchHit((hit) => (hit?.shown && hit.tab !== focusedTabPath ? { ...hit, shown: false } : hit));
  }, [focusedTabPath]);
  const showsSearchHit = searchHit?.shown === true && searchHit.tab === focusedTabPath;
  const chatTab = parseChatTabPath(focusedTabPath);
  const conversationTab = !shareView && !showsSearchHit &&
    (chatTab?.kind === "channel" || chatTab?.kind === "dm");
  // Null for a tab that is not a conversation's.
  const published = useAboutConversation(workspaceId, conversationTab ? focusedTabPath : null);
  const conversation = conversationTab ? published : null;
  const [conversationAccessOpen, setConversationAccessOpen] = useState(false);
  const loading = <SkeletonRows inSlot layout="panel" label="Loading About..." />;
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
            loading
          ) : (
            <div
              data-testid="about-rail-off"
              className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-muted"
            >
              {chatsOffCopy(syncStatus)}
            </div>
          )
        ) : conversation === undefined ? (
          loading
        ) : conversation !== null && conversation !== "none" ? (
          <Suspense fallback={loading}>
            <LazyAboutConversationPanel
              workspaceId={workspaceId}
              conversation={conversation}
              accessOpen={conversationAccessOpen}
              onToggleAccess={() => setConversationAccessOpen((open) => !open)}
              notices={aboutNotices}
              accessContext={accessContext}
            />
          </Suspense>
        ) : (
          <Suspense fallback={loading}>
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
