import { Suspense, lazy, memo, useState, type ComponentProps } from "react";
import type {
  ChatThreadRecord,
  SyncStatusResult,
  WorkspaceSummary,
} from "../../ipc/bridgeContract";
import { ErrorBoundary } from "../ErrorBoundary";
import { AboutRail } from "../workbench/AboutRail";
import { SkeletonRows, SkeletonSlot } from "../ui/SkeletonRows";
import { parseTab, setAboutWidth, type WorkbenchState } from "../workbench/workbenchState";
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

const LazyAboutFileChatsOff = lazy(() =>
  import("../workbench/About").then((mod) => ({
    default: mod.AboutFileChatsOff,
  })),
);

type LinkedChatsPanelProps = ComponentProps<typeof LazyLinkedChatsPanel>;

// A conversation's Links read as About shows it; Access waits to be opened.
const CONVERSATION_SECTIONS_OPEN = { links: true, access: false };

// A file's chat opened from search, a mention or the graph. The shell mints
// one per hit and names the tab it belongs to, so the hit lives with the
// shell, not with this rail, and survives About being closed.
export type AboutSearchHit = {
  thread: ChatThreadRecord;
  focusMessageId?: string;
  tab: string | null;
  // Read by About's file panel. The shell drops a read hit once that panel
  // stops showing its thread, so it never hides the tab's own About after.
  read: boolean;
};

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
  aboutTabOpen: boolean;
  shareView: NonNullable<WorkspaceSummary["shareView"]> | null;
  searchChatTarget: AboutSearchHit | null;
  onSearchHitRead: () => void;
  onSearchHitClosed: () => void;
  openPathWithHeading: NonNullable<LinkedChatsPanelProps["onOpenPath"]>;
  onChatsThreadRead: LinkedChatsPanelProps["onThreadRead"];
  reportFailureMessage: LinkedChatsPanelProps["onError"];
  onAgentWaitsForTrust?: LinkedChatsPanelProps["onAgentWaitsForTrust"];
  historyRevision: number;
  historyPaused: boolean;
  openMoment: NonNullable<LinkedChatsPanelProps["history"]>["onOpenMoment"];
  // Changes whenever the open file re-reads: history growth, a version
  // switch, or a share mount's pull.
  linksRevision: number;
  openPathAtLine: LinkedChatsPanelProps["links"]["onOpenLink"];
  openChatMention: NonNullable<LinkedChatsPanelProps["links"]["onOpenChat"]>;
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
    aboutTabOpen,
    shareView,
    searchChatTarget,
    onSearchHitRead,
    onSearchHitClosed,
    openPathWithHeading,
    onChatsThreadRead,
    reportFailureMessage,
    onAgentWaitsForTrust,
    historyRevision,
    historyPaused,
    openMoment,
    linksRevision,
    openPathAtLine,
    openChatMention,
    aboutNotices,
    accessContext,
  } = props;
  // A conversation tab's page says what About shows for it. A shared view
  // has no conversations, so its About stays on files. A chat search hit
  // opens its file's chat here, on the tab it belongs to, which the shell
  // names and drops once focus leaves it. Only that tab's About shows the hit,
  // and the file panel reads it once.
  const showsSearchHit = searchChatTarget !== null && searchChatTarget.tab === focusedTabPath;
  const pendingHit = showsSearchHit && !searchChatTarget.read ? searchChatTarget : null;
  const tab = parseTab(focusedTabPath);
  const conversationTab = !shareView && !showsSearchHit &&
    tab?.kind === "chat" && (tab.target.kind === "channel" || tab.target.kind === "dm");
  // Null for a tab that is not a conversation's.
  const published = useAboutConversation(workspaceId, conversationTab ? focusedTabPath : null);
  const conversation = conversationTab ? published : null;
  const [conversationSections, setConversationSections] = useState(CONVERSATION_SECTIONS_OPEN);
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
          //
          // A file's links come from the engine's own index, not from
          // capture, so they stay above the fact.
          !captureDecided ? (
            loading
          ) : activeDocumentPath ? (
            <Suspense fallback={loading}>
              <LazyAboutFileChatsOff
                workspaceId={workspaceId}
                path={activeDocumentPath}
                revision={linksRevision}
                onOpenLink={openPathAtLine}
                notices={aboutNotices}
                words={chatsOffCopy(syncStatus)}
              />
            </Suspense>
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
              sectionsOpen={conversationSections}
              onToggleSection={(id) => setConversationSections((open) => ({ ...open, [id]: !open[id] }))}
              onOpenFile={openPathWithHeading}
              notices={aboutNotices}
              accessContext={accessContext}
            />
          </Suspense>
        ) : (
          <Suspense fallback={loading}>
            <LazyLinkedChatsPanel
              workspaceId={workspaceId}
              filePath={activeDocumentPath}
              tabPath={focusedTabPath}
              aboutTabOpen={aboutTabOpen}
              {...(shareView
                ? { shareReadOnly: true }
                : { history: { revision: historyRevision, paused: historyPaused, onOpenMoment: openMoment } })}
              // Chats that link here are a Chats call, refused without capture.
              links={{
                revision: linksRevision,
                onOpenLink: openPathAtLine,
                ...(captureAvailable ? { onOpenChat: openChatMention } : {}),
              }}
              initialThread={pendingHit?.thread ?? null}
              initialFocusMessageId={pendingHit?.focusMessageId}
              onInitialThreadConsumed={onSearchHitRead}
              onInitialThreadClosed={onSearchHitClosed}
              onOpenPath={openPathWithHeading}
              onThreadRead={onChatsThreadRead}
              onError={reportFailureMessage}
              onAgentWaitsForTrust={onAgentWaitsForTrust}
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
