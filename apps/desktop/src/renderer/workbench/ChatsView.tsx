import { PostFeedList } from "./PostFeedList";
import { BookmarkAction, ThreadMessages } from "./ChatPosts";
import { ActionButton, LIKE_EMOJI, PostCard, SaveAsFileActions, type PostData } from "./PostCard";
import { ChatAvatar } from "./ChatAvatar";
import { ChatLane } from "./ChatLane";
import { usePersonalChatFeed } from "./usePersonalChatFeed";
import {
  AgentPresenceHint,
  UnreadPill,
  ShareReadFailureNotice,
  BackHeader,
  joinedChannelLabel,
  ComposerNotice,
  AddressedToMe,
  type ShareReadFailure,
} from "./ChatsControls";
import {
  AcceptDmDialog,
  DmRequestListItem,
  LeaveDmDialog,
  type DmWorkspaceOption,
} from "./DmPlacement";
import {
  answerCreatedChannel,
  answerLocally,
  emptyJoinedLaneOrder,
  mergeShareLanes,
  planJoinedCommit,
  shownChannelWireIds,
  type JoinedCommit,
  type JoinedLaneOrder,
  type ShareListing,
} from "./chatShareLanes";
import { SectionLabel } from "../ui/controls";
import { formatChatTime } from "../time";
import { basenameOf } from "../path";
import { ipcErrorMessage } from "../ipcError";
import {
  AtSign,
  Bot,
  Hash,
  House,
  MessageSquare,
  MessagesSquare,
  Plus,
  SmilePlus,
  Square,
  Users,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ChannelThreadRecord,
  ChatAttachmentRecord,
  ChatChannelRecord,
  ChatChannelShareGrantRow,
  ChatDecisionRecord,
  ChatDispatchStateForThreadResult,
  ChatFeedItemRecord,
  ChatMessageRecord,
  ChatBookmarkRecord,
  ChatReactionRecord,
  ChatRunRecord,
  DmRequestRow,
  DmRecord,
  FileChatThreadRecord,
  JoinedChannelAnswer,
  JoinedSharedChannelRow,
  ListChatChannelSharesResult,
  WorkspaceFileEntry,
} from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import type { AgentNotification } from "./agentNotifications";
import {
  ChatMessageList,
  type ChatMessageListHandle,
  MentionText,
  chatAuthorLabel,
  runReactionToggle,
  type ChatReactionControls,
} from "./chatMessages";
import { MentionComposer } from "./MentionComposer";
import { AddAgentForm } from "./AddAgentForm";
import type { DesktopUserSettings } from "../../settings/userSettings";
import { extractChatFileReferences } from "./chatFileMentions";
import type { MentionCandidate } from "@dohc/workspace-contracts/chat-mentions";
import { PresenceFaces, TypingIndicator } from "../collab/PresenceIndicators";
import { usePresence } from "../collab/usePresence";
import type {
  PresenceTransport,
} from "../collab/presenceChannel";
import type { PresenceScopeInput } from "../../ipc/bridgeContract";
import {
  CHAT_AGENT_PRESENCE_TOPIC,
  agentPresenceClientId,
  resolveAgentPresenceActivity,
} from "../../collab/agentPresence";

// Multi-user chat presence (MU-C1) is opt-in: only under collaboration
// (signedIn && relayConnected) is a transport supplied, so a solo/offline user
// constructs no presence at all. Absent => today's exact single-user Chats.
//
// The collaboration hands back a transport PER SCOPE rather than a single baked
// one: a participant viewing a channel shared TO them must publish into a SHARE
// scope (which the relay maps to the granter's workspace) so they land in the
// same relay presence scope as the owner (who publishes into their WORKSPACE
// scope). See the scope/topic derivation in ChatsView below. Still null when
// solo/offline — the transport factory is simply never called.
export interface ChatPresenceCollaboration {
  transportForScope: (scope: PresenceScopeInput) => PresenceTransport;
  clientId: string;
  displayName: string;
}

export interface AgentSetupSummary {
  agentName?: string;
  preferredName?: string;
  runnerConfigured: boolean;
  runnerEnabled: boolean;
  mcpEnabled: boolean;
}

// The Chats view (PR 13, WS-E): workspace Chats organized in channels, plus
// a read-only "Files" grouping that cross-links to the per-file rail. Built
// to feel like chat, not a forum: the channel composer sends on Enter and a
// new thread never asks for a title — it displays its first-message snippet.
//
// Every async response is gated by a liveness token before it touches state
// (workspace switches and rapid navigation must never repaint stale data).
//
// Shared channels (MU-C4): a channel can be shared to other accounts through
// a relay chat-channel grant. This view marks shared/joined channels, offers
// share/revoke on channels you own, lists invitations under "Shared with
// you", and disables composers in read-only channels. All sharing affordances
// require the signed-in collaboration surface — when share listing fails
// (signed out, local-only workspace), the solo view renders byte-identically
// to before.
//
// Presence seam (MU-C1): once the ephemeral awareness channel lands, member
// presence for a shared channel attaches here keyed by (shareId |
// channelWireId) — no durable state involved.

type OverviewState =
  | { status: "loading" }
  | { status: "unavailable"; message: string }
  | {
      status: "ready";
      channels: ChatChannelRecord[];
      fileThreads: FileChatThreadRecord[];
    };

// The independently committed parts of the Chats overview surfaces. Several
// readers write them, each authoritative for a different subset, so each part
// carries its own commit watermark (see commitTicket).
type CommitLane = "overview" | "joinedShares" | "relayShares" | "relayReach";

// Exported for the shell's expand-to-tab seam: the panel reports where it is
// (onNavChange) and a freshly expanded tab starts there (initialNav).
export type ChatsNav =
  | { level: "channels" }
  | { level: "feed" }
  | { level: "channel"; channel: ChatChannelRecord }
  | {
      level: "thread";
      channel: ChatChannelRecord;
      thread: ChannelThreadRecord;
      focusMessageId?: string;
    }
  // Direct messages (WS-MU-C3): one running conversation per DM (the
  // anti-forum rule), plus a one-step "new message" composer.
  | { level: "dm"; dm: DmRecord; focusMessageId?: string }
  | { level: "dm-new" };

// Unsent input, one field per composer surface, plus the composer's MODE
// (replying to a message / resolving a decision) — without the mode a reply
// drafted in the panel would post as a top-level comment after expanding.
// Part of the expand-to-tab handoff: the shell mirrors the live instance's
// drafts (onDraftsChange) and seeds the next mount with them, so expanding
// or collapsing chats never discards something the user typed.
export interface ChatsDrafts {
  composer: string;
  newThreadBody: string;
  dmRecipients: string;
  dmDraft: string;
  replyTarget: ChatsComposerReplyTarget | null;
  resolveTargetMessageId: string | null;
  // The poll choice taken with the answer, when the poll had choices.
  resolveChosenOption?: string | null;
}

interface ThreadSnapshot {
  messages: ChatMessageRecord[];
  reactions: ChatReactionRecord[];
  decisions: ChatDecisionRecord[];
  attachments: ChatAttachmentRecord[];
  runRecords: Record<string, ChatRunRecord>;
  dispatchState: ChatDispatchStateForThreadResult;
  viewerAuthorId: string;
}

export function reconcileResolvedChatDecision(
  current: ChatDecisionRecord[],
  resolved: ChatDecisionRecord,
): { decisions: ChatDecisionRecord[]; wasOpen: boolean } {
  const existing = current.find(
    (decision) => decision.messageId === resolved.messageId,
  );
  const wasOpen = current.some(
    (decision) =>
      decision.messageId === resolved.messageId && decision.state === "open",
  );
  return {
    decisions: existing
      ? current.map((decision) =>
          decision.messageId === resolved.messageId ? resolved : decision,
        )
      : [...current, resolved],
    wasOpen,
  };
}

// DM polls resolve fresh IPC arrays every tick whether or not anything
// changed. Committing an equal-but-new array re-renders the whole open
// conversation and invalidates every memo keyed on it, so poll commits keep
// the current state when the data is unchanged — the same discipline
// refreshOpenDm applies to setNav. Exported for its unit test.
export function keepIfUnchanged<T>(next: T): (current: T) => T {
  return (current) => (samePollData(current, next) ? current : next);
}

// Structural equality over plain IPC data (primitives, arrays, objects) —
// exactly what a structured-clone bridge response can contain.
function samePollData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) =>
    samePollData(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key],
    ),
  );
}

interface ChannelSnapshot {
  threads: ChannelThreadRecord[];
  feedPosts: Record<string, PostData>;
}

const IDLE_DISPATCH_STATE: ChatDispatchStateForThreadResult = {
  liveRunId: null,
  pendingCount: 0,
  paused: false,
};

const EMPTY_MENTION_CANDIDATES: readonly MentionCandidate[] = [];

interface ChatsComposerReplyTarget {
  messageId: string;
  authorLabel: string;
}

type ComposerReplyTarget = ChatsComposerReplyTarget;

// Whether a new outgoing grant would deepen the over-limit state. Only the
// granted lane can: an outgoing share adds a row there and nowhere else. A
// full received lane is an inbound backlog the user did not create and cannot
// clear from here, and rejecting their outgoing work over it turns one
// account-wide problem into a second one.
function grantedLaneIsOverLimit(failure: ShareReadFailure | null): boolean {
  return (
    failure?.kind === "over-limit" &&
    failure.lanes.some((entry) => entry.lane === "granted")
  );
}

// One row of the chat nav: an icon, a name, and what is waiting on the right.
// The active row is the one the panel currently shows.
function NavRow(props: {
  testId: string;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  muted?: boolean;
  labelTestId?: string;
  trailing?: React.ReactNode;
  data?: Record<`data-${string}`, string>;
  className?: string;
}) {
  return (
    <button
      type="button"
      data-testid={props.testId}
      data-active={props.active ? "true" : "false"}
      aria-current={props.active ? "page" : undefined}
      onClick={props.onClick}
      {...props.data}
      className={`mx-2 flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-left transition-colors duration-75 hover:bg-panel-2 dohc-focus-visible ${
        props.active ? "bg-panel-2" : ""
      } ${props.className ?? ""}`}
    >
      {props.icon}
      <span
        data-testid={props.labelTestId}
        className={`min-w-0 flex-1 truncate text-[13px] ${
          props.active ? "font-medium text-ink" : props.muted ? "text-muted" : "text-ink"
        }`}
      >
        {props.label}
      </span>
      {props.trailing}
    </button>
  );
}

// The strip names the program a runner command starts, not its whole
// command line: a quoted path to a script is a path, and the strip is a
// sentence. The full command sits in the title.
// An agent seen in a joined group's chat lane: who, under whom, and the
// group to open.
type LaneAgent = { key: string; label: string; owner: string; channel: ChatChannelRecord; atMs: number };

export function runnerProgram(command: string): string {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/gu;
  for (const match of command.trim().matchAll(pattern)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
    if (tokens.length === 2) break;
  }
  const basename = (token: string): string => token.split(/[\\/]/u).pop() ?? token;
  const program = tokens[0] ? basename(tokens[0]) : "";
  const script = tokens[1] ? basename(tokens[1]) : "";
  return script && /\.(m?js|cjs|ts|py|sh|ps1)$/u.test(script) ? `${program} ${script}` : program;
}

export function ChatsView(props: {
  workspaceId: string;
  workspaces: readonly DmWorkspaceOption[];
  // Jump a file-linked Chat to where it lives: the file's side rail.
  onOpenFileChat: (thread: FileChatThreadRecord, focusMessageId?: string) => void;
  // The shell's normal file navigation path. Attachment chips use it when
  // present; tests/embedded surfaces may omit it and receive a titled chip.
  onOpenPath?: (path: string, headingAnchor?: string) => void;
  onError: (message: string) => void;
  // @-mention roster for this workspace (the user + available agents). When
  // provided, the composer offers autocomplete and messages render chips.
  mentionCandidates?: readonly MentionCandidate[];
  workspaceFiles?: readonly WorkspaceFileEntry[];
  // "Addressed to me" inbox: agent asks / requests waiting on the user.
  addressedToMe?: readonly AgentNotification[];
  // Main-derived settings/status summary. The Agents section reads it to
  // say whether the configured agent is set up.
  agentSetup?: AgentSetupSummary | null;
  onSetupAgent?: () => void;
  // The user settings the add-agent form writes, and the save that persists
  // them. Absent in embedded surfaces, which then offer no add-agent form.
  userSettings?: DesktopUserSettings | null;
  onSaveUserSettings?: (settings: DesktopUserSettings) => Promise<void>;
  // What the agent reaches: the workspace folder its runner is started in.
  workspacePath?: string;
  // Ephemeral presence/typing transport, present only under collaboration.
  collaboration?: ChatPresenceCollaboration | null;
  // Where this view lives: the side panel (default) or a full editor tab.
  // The page variant centers the narrow surfaces in a reading column — the
  // thread/channel views already read as pages.
  variant?: "panel" | "page";
  // Expand-to-tab: the conversation to open once the overview is ready —
  // the shell hands the live surface's position to whichever instance mounts
  // next, so panel and tab feel like one chats surface. Applied once per
  // mount; workspace switches and later navigation behave exactly as before.
  initialNav?: ChatsNav;
  // Unsent drafts to restore alongside initialNav (same handoff, same
  // apply-once timing).
  initialDrafts?: ChatsDrafts;
  // Reports every navigation so the shell can seed the next mount (panel or
  // expanded tab) with this instance's current conversation.
  onNavChange?: (nav: ChatsNav) => void;
  // The page variant's counterpart of the panel's onOpenInTab: an explicit
  // conversation click, reported before the view navigates in place. It is a
  // user command, so the shell cancels a pending cross-surface navigation
  // (the DM lookup) unconditionally — even when the click repeats the current
  // destination, which still re-loads and re-scrolls. The passive onNavChange
  // report only says where the view already is and stays conditional.
  onNavCommand?: (nav: ChatsNav) => void;
  // The compact panel is a navigator: selecting a conversation can hand its
  // destination to the shell so it opens in the editor instead of replacing
  // the panel's list. The page variant always navigates in place.
  onOpenInTab?: (nav: ChatsNav) => void;
  // Active editor destination, used by a persistent panel navigator to mark
  // the selected channel or DM without navigating the panel itself.
  selectedNav?: ChatsNav;
  // Reports every draft edit (ref-cheap in the shell) so unsent input
  // survives the panel/tab handoff.
  onDraftsChange?: (drafts: ChatsDrafts) => void;
  // Unread badges are the one state the two instances disagree about: the
  // page performs every read, the panel navigator only projects counts it
  // fetched at mount. Keep local thread badges and relay-backed DM badges on
  // separate revisions so a channel refresh cannot wake suspended DM sync.
  onThreadRead?: () => void;
  readRevision?: number;
  // Starting a thread changes the durable channel count. The page reports
  // that write to the shell, which tells the persistent navigator to refetch.
  onThreadStarted?: () => void;
  threadRevision?: number;
  onDmRead?: () => void;
  dmReadRevision?: number;
  // The persistent panel navigator sets this while a Chats editor tab is
  // live: the page instance runs the same polls against the same store, so a
  // second poller doubles every chat read for nothing. Suspends the DM list
  // poll, the open-DM poll, and the activity subscription; mount loads and
  // the read-revision badge catch-ups stay on. On unsuspend, one catch-up
  // pass refreshes what the missed activity events would have.
  suspendPolling?: boolean;
}) {
  const { workspaceId, onNavChange, onDraftsChange, onThreadRead, onDmRead } =
    props;
  const collaboration = props.collaboration ?? null;
  // A stable fallback: a fresh [] per render would defeat the message-list
  // memo boundaries below for every roster-less host.
  const mentionCandidates = props.mentionCandidates ?? EMPTY_MENTION_CANDIDATES;
  const fileMentionCandidates = useMemo(
    () =>
      (props.workspaceFiles ?? [])
        .filter((file) => file.kind === "file" && /\.md$/i.test(file.path))
        .map((file) => ({
          path: file.path,
          label: basenameOf(file.path).replace(/\.md$/i, ""),
        })),
    [props.workspaceFiles],
  );
  const loadFileHeadings = useCallback(
    async (path: string) =>
      (await bridge().listWorkspaceHeadings({ workspaceId, path })).headings,
    [workspaceId],
  );
  const variant = props.variant ?? "panel";
  // Page variant: cap the list-like surfaces at the thread column's width.
  const pageColumn = variant === "page" ? "mx-auto w-full max-w-[640px]" : "";
  const [overview, setOverview] = useState<OverviewState>({ status: "loading" });
  const [nav, setNav] = useState<ChatsNav>({ level: "channels" });
  const [channelThreads, setChannelThreads] = useState<ChannelThreadRecord[]>([]);
  const [feedPosts, setFeedPosts] = useState<Record<string, PostData>>({});
  const [bookmarks, setBookmarks] = useState<ChatBookmarkRecord[]>([]);
  const [bookmarkBusy, setBookmarkBusy] = useState<Set<string>>(() => new Set());
  // Bookmark list reads and mutations are independent request streams. A
  // mutation invalidates any older list read, while per-key mutation
  // generations let unrelated bookmark writes finish concurrently.
  const bookmarkWorkspaceGeneration = useRef(0);
  const bookmarkListGeneration = useRef(0);
  const bookmarkMutationGeneration = useRef(0);
  const bookmarkMutationByKey = useRef(new Map<string, number>());
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [messages, setMessages] = useState<ChatMessageRecord[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [reactions, setReactions] = useState<ChatReactionRecord[]>([]);
  const [decisions, setDecisions] = useState<ChatDecisionRecord[]>([]);
  const [attachments, setAttachments] = useState<ChatAttachmentRecord[]>([]);
  const [runRecords, setRunRecords] = useState<Record<string, ChatRunRecord>>({});
  const [dispatchState, setDispatchState] = useState<ChatDispatchStateForThreadResult>(
    IDLE_DISPATCH_STATE,
  );
  const [dispatchActionBusy, setDispatchActionBusy] = useState(false);
  const [viewerAuthorId, setViewerAuthorId] = useState("");
  const [composer, setComposer] = useState("");
  const [replyTarget, setReplyTarget] = useState<ComposerReplyTarget | null>(null);
  const [resolveTargetMessageId, setResolveTargetMessageId] = useState<string | null>(null);
  const [resolveChosenOption, setResolveChosenOption] = useState<string | null>(null);
  const [flashMessageId, setFlashMessageId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [newThreadBody, setNewThreadBody] = useState("");
  const [startingThread, setStartingThread] = useState(false);
  const [creatingChannel, setCreatingChannel] = useState<string | null>(null);
  const [newGroupType, setNewGroupType] = useState<"posts" | "chat" | "both">("posts");
  const [newGroupPurpose, setNewGroupPurpose] = useState("");
  const resetGroupForm = useCallback(() => {
    setCreatingChannel(null);
    setNewGroupType("posts");
    setNewGroupPurpose("");
  }, []);
  const [addingAgent, setAddingAgent] = useState(false);
  // Direct messages (WS-MU-C3). The section renders only when collaboration
  // is on (signed in + relay) or a DM already exists locally — a solo user
  // sees none of it.
  const [dms, setDms] = useState<DmRecord[]>([]);
  const [dmAvailable, setDmAvailable] = useState(false);
  const [pendingDmRequests, setPendingDmRequests] = useState<DmRequestRow[]>([]);
  const [declinedDmRequests, setDeclinedDmRequests] = useState<DmRequestRow[]>([]);
  const [acceptingDmRequest, setAcceptingDmRequest] = useState<DmRequestRow | null>(
    null,
  );
  const [dmAcceptedElsewhere, setDmAcceptedElsewhere] = useState<{
    granterEmail: string | null;
    workspaceLabel: string;
  } | null>(null);
  const [dmRequestBusy, setDmRequestBusy] = useState<string | null>(null);
  const [leavingDm, setLeavingDm] = useState<DmRecord | null>(null);
  const [dmRecipients, setDmRecipients] = useState("");
  const [dmDraft, setDmDraft] = useState("");
  const [startingDm, setStartingDm] = useState(false);
  const startingDmRef = useRef(false);
  // MU-C4 shared channels. null = the sharing surface is unavailable (signed
  // out / listing failed) and every sharing affordance stays hidden — the
  // solo view is unchanged.
  const [channelShares, setChannelShares] = useState<ShareListing | null>(null);
  // Why the last committed share read did not produce rows, or null when it
  // did. The rows above are what dohc knows; this is what stopped it knowing.
  // Separate facts: a relay that did not answer commits no rows and keeps the
  // cached ones, so without this the surface renders an empty list that reads
  // as "no shares". Its own commit lane, because it answers its own
  // question and an older response must not overwrite a newer one.
  //
  // The two reasons owe the user different things. An outage owes a retry.
  // A listing over dohc's own cap owes the count, the limit, and no retry at
  // all — the same request will answer the same way forever.
  const [shareReadFailure, setShareReadFailure] = useState<ShareReadFailure | null>(
    null,
  );
  // The workspace `channelShares` was last DEFINITIVELY resolved for (even when
  // that resolution is `null` — signed out / listing failed). Presence stays
  // dormant until this equals the current workspaceId, so a conversation's
  // SCOPE (which for a joined channel is derived from channelShares) is never
  // computed from not-yet-loaded share state, and a workspace switch can never
  // publish under the previous workspace's scope. Reset on every switch.
  const [sharesWorkspaceId, setSharesWorkspaceId] = useState<string | null>(null);
  const [sharePanelOpen, setSharePanelOpen] = useState(false);
  const [shareEmail, setShareEmail] = useState("");
  const [shareReadOnly, setShareReadOnly] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [joiningShareId, setJoiningShareId] = useState<string | null>(null);
  // SYNCHRONOUS in-flight guards. `sending` / `startingThread` are React state
  // and stay false until the next render, so a double-send (two Enters in one
  // tick) can fire TWO IPC sends — and two agent invocations — before the state
  // flips. These refs flip synchronously before the first await, so the second
  // call is ignored immediately.
  const sendingRef = useRef(false);
  // Sends are owned per workspace conversation. This lets another conversation
  // send independently while preserving the lock if the user returns to a
  // conversation whose original promise is still in flight.
  const sendRequestGeneration = useRef(0);
  const inFlightSendByContext = useRef(new Map<string, number>());
  const startingThreadRef = useRef(false);
  const liveToken = useRef(0);
  const {
    personalFeed,
    personalFeedLoading,
    personalFeedNextCursor,
    loadPersonalFeed,
    resetForWorkspace,
    prepareOpen,
    invalidate,
    setMessageReactions,
  } = usePersonalChatFeed({ workspaceId, liveToken, onError: props.onError });
  // A live thread can refresh repeatedly without changing navigation. Keep a
  // request sequence separate from the workspace/navigation liveness token so
  // an older activity response can never overwrite a newer one.
  const threadRefreshSeq = useRef(0);
  const channelRefreshSeq = useRef(0);
  const dmRefreshSeq = useRef(0);
  const paintedDmRevision = useRef<{
    workspaceId: string;
    threadId: string;
    revision: number;
  } | null>(null);
  // Per-(message, emoji) toggle sequence so overlapping reaction toggles resolve
  // in order (see runReactionToggle).
  const reactionSeq = useRef(new Map<string, number>());
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const flatChatListRef = useRef<ChatMessageListHandle | null>(null);
  const messageNodes = useRef(new Map<string, HTMLElement>());
  // Stable so the ChatMessageList and ThreadMessages memo boundaries hold
  // across draft keystrokes.
  const setMessageNode = useCallback(
    (messageId: string, element: HTMLElement | null) => {
      if (element) messageNodes.current.set(messageId, element);
      else messageNodes.current.delete(messageId);
    },
    [],
  );
  const focusedMessageJump = useRef<string | null>(null);

  const sendContextKey =
    nav.level === "thread"
      ? `${workspaceId}:thread:${nav.thread.id}`
      : nav.level === "dm"
        ? `${workspaceId}:dm:${nav.dm.threadId ?? nav.dm.channelId}`
        : `${workspaceId}:${nav.level}`;
  const activeSendContext = useRef(sendContextKey);
  activeSendContext.current = sendContextKey;
  const latestComposerState = useRef({
    composer,
    replyMessageId: replyTarget?.messageId,
    resolveTargetMessageId,
  });
  latestComposerState.current = {
    composer,
    replyMessageId: replyTarget?.messageId,
    resolveTargetMessageId,
  };
  const latestDecisions = useRef(decisions);
  latestDecisions.current = decisions;
  useEffect(() => {
    const contextIsSending = inFlightSendByContext.current.has(sendContextKey);
    sendingRef.current = contextIsSending;
    setSending(contextIsSending);
  }, [sendContextKey]);

  // `background` marks a refresh the user did not ask for (the navigator's
  // badge catch-up). Two things follow, and both are about not stealing from
  // whatever the user IS doing:
  //
  //  - It must not touch liveToken. That token means "everything in flight is
  //    now stale", and createChannel, joinShared and shareChannel capture it
  //    to decide whether their own completion still counts. Bumping it here
  //    made a badge refresh landing mid-mutation throw away the mutation's
  //    successful result, leaving the create form or the old invite on screen.
  //    Latest-wins among overview refreshes uses its own sequence instead; the
  //    captured token is still checked, so a workspace switch or a user
  //    navigation still discards this response.
  //  - A transient failure must not replace a working navigator with an error
  //    card (there is nothing to report to a user who asked for nothing).
  //
  // One issue order over every commit into these surfaces, with a watermark
  // per lane. A reader takes a ticket when it issues its request and commits a
  // lane only if no newer ticket landed there first. Same commit-time
  // watermark as the workspace file listing: an id is taken at issue, and a
  // response commits only if it is newer than what is already displayed.
  //
  // Lanes exist because these readers answer different questions.
  // refreshOverview answers all three. refreshShares answers both share lanes.
  // refreshChannelBadges answers the channel listing and the joined grants its
  // listing just synced, and nothing about the relay-backed rows. One sequence
  // over all of them would let a joined-only correction discard a full share
  // read still in flight; one sequence per reader would let two readers undo
  // each other — the person you just invited vanishing, or a cleared badge
  // coming back.
  const commitTicket = useRef(0);
  const committedLane = useRef<Record<CommitLane, number>>({
    overview: 0,
    joinedShares: 0,
    relayShares: 0,
    relayReach: 0,
  });
  const takeCommitTicket = useCallback(() => ++commitTicket.current, []);
  // Claim every lane in `lanes`, or none of them. A response writes exactly
  // what it claims, so a reader that can only speak for part of what it is
  // about to write must not claim the rest and then write it anyway.
  const claimLanes = useCallback(
    (lanes: readonly CommitLane[], ticket: number): boolean => {
      if (lanes.some((lane) => ticket <= committedLane.current[lane])) return false;
      for (const lane of lanes) committedLane.current[lane] = ticket;
      return true;
    },
    [],
  );
  const joinedOrder = useRef<JoinedLaneOrder>(emptyJoinedLaneOrder());
  // The cloud-session era share reads are issued under. A session change
  // bumps it, and the commit point refuses any response from an older era —
  // the same liveToken discipline the DM path uses. Defense in depth with
  // the listing's sessionKey: the generation kills stale IN-FLIGHT responses
  // (an old account's read landing after the switch), the key kills stale
  // CACHE (preservation can only keep the same session's rows).
  const sessionGeneration = useRef(0);
  // The one place a full share listing lands, whichever reader produced it.
  // Success commits per lane: each takes the newest answer it has.
  //
  // A failed lookup says nothing about either lane, and "unknown" is a state
  // of the whole listing — there is no way to store it for one lane alone. So
  // it may commit only when it owns both lanes. Otherwise a response that
  // learned nothing would discard a newer joined-grant answer and lock every
  // channel through channelIsLocked until some later refresh succeeded.
  // Read the committed listing from an async callback (see latestComposerState).
  const latestChannelShares = useRef(channelShares);
  latestChannelShares.current = channelShares;
  // The declaration a reader that has no fresher channel list sends. Readers
  // that just read one (refreshOverview, refreshChannelBadges) declare from
  // that instead — it is newer, and a channel this surface is about to show
  // must be in the scope or channelIsLocked locks it.
  // NULL while the overview is unresolved, and that is not the same as "shows
  // nothing". A read that named nothing answers the lane for nothing, and an
  // unanswered channel locks — so a reader that cannot say what it shows must
  // not ask at all.
  const latestShownWireIds = useRef<string[] | null>(null);
  latestShownWireIds.current =
    overview.status === "ready"
      ? shownChannelWireIds(overview.channels, channelShares?.received ?? [])
      : null;
  // The one path that writes joined answers: the lane claim decides who may
  // evict, the declaration above decides what survives, and planJoinedCommit
  // decides everything else.
  const planJoinedWrite = useCallback(
    (ticket: number, answers: readonly JoinedChannelAnswer[]): JoinedCommit | null =>
      planJoinedCommit(joinedOrder.current, {
        workspaceId,
        ticket,
        answers,
        newestForLane: claimLanes(["joinedShares"], ticket),
        shown: latestShownWireIds.current,
      }),
    [claimLanes, workspaceId],
  );
  const commitShareListing = useCallback(
    (
      ticket: number,
      session: number,
      value: ListChatChannelSharesResult | null,
      options?: { background?: boolean },
    ) => {
      // A response issued under an older cloud session commits nothing: its
      // rows belong to an account the user has left.
      if (session !== sessionGeneration.current) return;
      // A failed lookup for a refresh nobody asked for is not an answer. It
      // fills in only where nothing has answered yet — so the surface resolves
      // instead of waiting on a request that may never return — and it takes
      // no lane, so a real answer still in flight replaces it even though it
      // was issued earlier. Where something has answered, it says nothing at
      // all and the cached rows stand.
      if (value === null && options?.background) {
        const answered =
          committedLane.current.joinedShares > 0 ||
          committedLane.current.relayShares > 0;
        if (answered) return;
        setChannelShares(null);
        // Claims NO lane, reachability included. This refresh learned nothing
        // and only fills in where nothing has answered yet — so a real answer
        // still in flight, issued earlier and therefore holding an older
        // ticket, must still be able to correct it. Taking the lane here left
        // "dohc could not read your shares" standing over a listing that then
        // arrived and worked.
        setShareReadFailure({ kind: "unreachable" });
        setSharesWorkspaceId(workspaceId);
        return;
      }
      // A failure the user asked for answers "unknown", which is the whole
      // listing. It commits only while it owns both lanes — claiming one and
      // leaving it unwritten would starve the reader that can answer it.
      if (value === null) {
        if (!claimLanes(["joinedShares", "relayShares"], ticket)) return;
        setChannelShares(null);
        // The listing did not answer at all, so the surface says so. Without
        // this the user sees an empty sharing surface and every channel
        // read-only, with nothing naming either.
        if (claimLanes(["relayReach"], ticket)) {
          setShareReadFailure({ kind: "unreachable" });
        }
        setSharesWorkspaceId(workspaceId);
        return;
      }
      // Whether dohc could read the relay is its own answer, and every
      // resolved listing carries it — including the unreachable one, which
      // claims no row lane at all.
      const nextFailure: ShareReadFailure | null =
        value.relay.state === "unreachable"
          ? { kind: "unreachable" }
          : value.relay.state === "over-limit"
            ? {
                kind: "over-limit",
                lanes: value.relay.lanes,
                limit: value.relay.limit,
              }
            : null;
      // A refresh nobody asked for may take the reachability lane only when it
      // established an account-scoped answer. The test is what the read
      // learned, not which sentinel it returned: a background read that
      // resolved "unreachable" or "over-limit" established no listing, exactly
      // like one that rejected, and taking the lane over either would let it
      // outrank an authoritative answer still in flight — leaving the notice
      // standing over a listing that then arrived and worked. Keying this on
      // `value === null` covered one of the three shapes.
      //
      // It may still say so where nothing has answered yet, so the surface
      // resolves instead of waiting on a request that may never return.
      const establishedRelayFact =
        value.relay.state === "answered" || value.relay.state === "signed-out";
      if (!options?.background || establishedRelayFact) {
        if (claimLanes(["relayReach"], ticket)) setShareReadFailure(nextFailure);
      } else if (ticket > committedLane.current.relayReach) {
        // It may still say so — an outage the user should see is a real fact,
        // and refusing to show it would trade one silence for another. It
        // reads the watermark without taking it: newer than what is displayed,
        // so a late-arriving older outage cannot repaint over a fresher
        // answer; unclaimed, so an authoritative answer still in flight on an
        // older ticket can still land and clear it.
        setShareReadFailure(nextFailure);
      }
      // The relay lanes are only this answer's to write when it learned an
      // account-scoped fact: the relay's rows, or that no session exists
      // (signed out — cached rows must clear; another account's invitations
      // and recipient emails must not survive a logout). "Unreachable" is not
      // an empty listing: the cached rows stand, and the unclaimed lane lets
      // a real relay answer land its rows.
      // Over-limit is non-authoritative for the same reason unreachable is:
      // dohc has no listing it can stand behind, so the cached rows are still
      // the best thing it knows, and the unclaimed lane lets a listing that
      // later fits land its rows.
      const relayAuthoritative =
        value.relay.state !== "unreachable" && value.relay.state !== "over-limit";
      const listing: ShareListing =
        value.relay.state === "answered"
          ? {
              joined: value.joined,
              granted: value.relay.granted,
              received: value.relay.received,
              sessionKey: value.sessionKey,
            }
          : {
              joined: value.joined,
              granted: [],
              received: [],
              sessionKey: value.sessionKey,
            };
      // Claim each lane independently, even when nothing has resolved yet:
      // two lookups settling in one React batch both read a null ref, and an
      // all-or-nothing claim would let an unreachable answer's joined claim
      // discard an older reached answer's authoritative relay rows. The
      // functional update sees a batch-mate's queued listing, so every
      // claimed lane is written.
      const joined = planJoinedWrite(ticket, value.joined);
      const relay = relayAuthoritative && claimLanes(["relayShares"], ticket);
      if (joined === null && !relay) return;
      setChannelShares((current) => {
        if (current === null) {
          // Nothing to merge into. Only an answer that vouches for the joined
          // rows may seed the listing — they decide channelIsLocked, and a
          // relay-only claim seeding stale joined rows would unlock what
          // nothing has vouched for. It must own the whole lane, not a few
          // wires of it: a newer read that could not answer sets this null on
          // purpose, and re-seeding would put these relay rows back over it.
          return joined?.ownsLane ? { ...listing, joined: joined.write([]) } : current;
        }
        // The cached relay rows are account-scoped: they are preservable
        // only for the same session. Under any other session — a login, a
        // switch — they are never candidates, whatever the relay lane
        // claims, so an unreachable relay on the new account cannot show
        // the previous account's invitations and emails.
        const base =
          current.sessionKey === value.sessionKey
            ? current
            : {
                ...current,
                granted: [],
                received: [],
                sessionKey: value.sessionKey,
              };
        return mergeShareLanes(base, listing, { joined, relay });
      });
      setSharesWorkspaceId(workspaceId);
    },
    [claimLanes, planJoinedWrite, workspaceId],
  );
  const refreshOverview = useCallback(
    async (options?: { background?: boolean }): Promise<void> => {
      const token = options?.background ? liveToken.current : ++liveToken.current;
      const ticket = takeCommitTicket();
      const session = sessionGeneration.current;
      // A refresh nobody asked for never changes what the surface says until
      // it has an answer — and this runs before it knows anything. Taking an
      // error card down here left no Try again to press, and by the rule in
      // the catch below there was nothing to put back: a permanent spinner.
      if (!options?.background) {
        setOverview((current) =>
          current.status === "ready" ? current : { status: "loading" },
        );
      }
      try {
        // The channel listing first, and not beside the share read: the share
        // read now has to be told which channels this surface is showing, and
        // that is what the listing answers. The listing also syncs joined
        // shared channels before it reads, so a channel a sync just pulled is
        // in the declaration rather than missing from it for a whole cycle.
        const result = await bridge().listChatChannels({ workspaceId });
        if (token !== liveToken.current) return;
        // Sharing is OPTIONAL: solo / signed-out workspaces simply render
        // without the sharing affordances. Whether the lookup failed is kept
        // separate from what it returned — null is not an answer, it is the
        // absence of one, and it fails closed in channelIsLocked.
        const shares = await bridge()
          .listChatChannelShares({
            workspaceId,
            channelWireIds: shownChannelWireIds(
              result.channels,
              latestChannelShares.current?.received ?? [],
            ),
          })
          .then((value) => ({ answered: true, value }) as const)
          .catch(() => ({ answered: false, value: null }) as const);
        if (token !== liveToken.current) return;
        // commitShareListing decides what a failure is worth: for a refresh
        // nobody asked for, only a placeholder where nothing has answered yet.
        commitShareListing(ticket, session, shares.value, {
          background: options?.background === true,
        });
        // The channel list settles with its share answer, not before it: a
        // list rendered while the joined lane is still unknown is a list of
        // locked channels, and the flash back to writable is worse than
        // holding the load a moment longer.
        if (claimLanes(["overview"], ticket)) {
          setOverview({
            status: "ready",
            channels: result.channels,
            fileThreads: result.fileThreads,
          });
        }
      } catch (error) {
        if (token !== liveToken.current) return;
        // A refresh nobody asked for never reports a failure. There is nothing
        // to tell a user who asked for nothing, and a failure holds no answer
        // for the lane — so claiming it would only discard the answer of
        // whoever IS still in flight: a working list on screen, or the load
        // the surface is waiting on. Someone always owns settling it, because
        // every foreground refresh commits its own failure.
        if (options?.background) return;
        if (!claimLanes(["overview"], ticket)) return;
        setOverview({
          status: "unavailable",
          message: ipcErrorMessage(error, "Could not load Chats."),
        });
      }
    },
    [claimLanes, commitShareListing, takeCommitTicket, workspaceId],
  );

  // Badge-only refresh for activity nobody asked for. It reads only the
  // channel listing and the joined grants (local questions), takes commit
  // tickets like every other reader so it cannot discard a refresh the user
  // asked for, and keeps one listing in flight: activity arriving mid-read
  // runs exactly one more pass when the read settles. liveToken decides what
  // a drain may do; the record only says who holds the slot.
  const badgeRead = useRef<{ token: number; pending: boolean } | null>(null);
  const refreshChannelBadges = useCallback(async (): Promise<void> => {
    const active = badgeRead.current;
    // Queue onto a read only while it can still deliver. Its listing syncs
    // shared channels over the relay, which can stall for as long as the
    // network wants to; once a navigation or a mutation has moved liveToken
    // past it, that read can commit nothing, and waiting on it would strand
    // every later badge behind a request that is never coming back.
    if (active !== null && active.token === liveToken.current) {
      active.pending = true;
      return;
    }
    // Any other leftover drain has nothing left to say: whatever moved
    // liveToken past it — a switch, a navigation, a mutation — already took
    // away its right to commit. Take the slot.
    const mine = { token: liveToken.current, pending: false };
    badgeRead.current = mine;
    try {
      do {
        mine.pending = false;
        mine.token = liveToken.current;
        const token = mine.token;
        const ticket = takeCommitTicket();
        const session = sessionGeneration.current;
        const isCurrent = () => token === liveToken.current;
        try {
          const result = await bridge().listChatChannels({ workspaceId });
          if (!isCurrent()) return;
          if (claimLanes(["overview"], ticket)) {
            // Settle the surface even while the initial load is still waiting
            // on its share lookup. This answer is newer than the one that load
            // will bring, and the reader that owns the share lanes is still
            // free to fill them in.
            setOverview({
              status: "ready",
              channels: result.channels,
              fileThreads: result.fileThreads,
            });
          }
          // The listing above syncs joined shared channels before it reads, and
          // the registry it syncs into decides what this workspace joined,
          // whether a grant was revoked, and whether one was downgraded. Every
          // one of those reaches the list as a channel this view would
          // otherwise read as its own: sharing offered on someone else's
          // channel, a composer on a read-only grant.
          //
          // So ask every pass. The rows are local — no relay, no engine — and
          // asking only when this view already knew of a joined channel missed
          // the first one, which is exactly when the surface is most wrong.
          const cachedShares = latestChannelShares.current;
          if (cachedShares === null) {
            // Nothing has answered the share lanes yet, and this pass has just
            // put a newer channel list on screen than the lookup that will
            // seed them was scoped to. A channel this pass added would get no
            // answer from that lookup at all, and unanswered locks it — so the
            // pass that shows the list asks about the list, relay rows and
            // all. They are exactly its business while the surface has none.
            //
            // A failure is not: the lookup that owns the lanes is still in
            // flight, and committing an unknown here would only bar it.
            const seedTicket = takeCommitTicket();
            const seed = await bridge()
              .listChatChannelShares({
                workspaceId,
                channelWireIds: shownChannelWireIds(result.channels, []),
              })
              .catch(() => null);
            if (seed !== null && isCurrent()) {
              commitShareListing(seedTicket, session, seed, { background: true });
            }
          } else {
            const sharesTicket = takeCommitTicket();
            const refreshed = await bridge().listJoinedSharedChannels({
              workspaceId,
              // The channels this pass just listed, plus the invitations
              // already on the sharing surface. This read speaks for no relay
              // lane, so the cached invitations are the ones it must cover:
              // a narrower scope would drop their answers and offer Join for
              // a channel this workspace is already in.
              channelWireIds: shownChannelWireIds(
                result.channels,
                cachedShares.received,
              ),
            });
            // Only the joined lane, which is all this read answers. Leaving the
            // relay-backed lane alone also lets a full share read still in
            // flight land its own rows.
            // Planning advances the lane's ordering, so it must not run for a
            // write that cannot land. This read can only correct a listing,
            // and a failure the user asked for may have nulled it while the
            // read was in flight.
            const joined =
              isCurrent() && latestChannelShares.current !== null
                ? planJoinedWrite(sharesTicket, refreshed.joined)
                : null;
            if (joined !== null) {
              setChannelShares((current) =>
                // This read speaks for no relay lane, so it can correct a
                // listing but never establish one.
                current === null
                  ? current
                  : mergeShareLanes(
                      current,
                      // The unclaimed relay lane keeps the current rows and
                      // their session key; this local read speaks for neither.
                      {
                        granted: [],
                        received: [],
                        joined: refreshed.joined,
                        sessionKey: null,
                      },
                      { joined, relay: false },
                    ),
              );
            }
          }
        } catch {
          // Nobody asked for this refresh: a stale badge beats an error card.
        }
        // A queued pass belongs to the token era it was queued in, and it may
        // only run while this drain still holds the slot.
      } while (
        mine.pending &&
        mine.token === liveToken.current &&
        badgeRead.current === mine
      );
    } finally {
      if (badgeRead.current === mine) badgeRead.current = null;
    }
  }, [commitShareListing, planJoinedWrite, takeCommitTicket, workspaceId]);

  const refreshBookmarks = useCallback(async () => {
    const workspaceGeneration = bookmarkWorkspaceGeneration.current;
    const listGeneration = ++bookmarkListGeneration.current;
    const mutationGeneration = bookmarkMutationGeneration.current;
    const desktopBridge = bridge();
    // Older preload fixtures deliberately omit newly added additive surfaces.
    if (typeof desktopBridge.listChatBookmarks !== "function") return;
    try {
      const result = await desktopBridge.listChatBookmarks({ workspaceId });
      if (
        workspaceGeneration !== bookmarkWorkspaceGeneration.current ||
        listGeneration !== bookmarkListGeneration.current ||
        mutationGeneration !== bookmarkMutationGeneration.current
      ) {
        return;
      }
      setBookmarks(result.bookmarks.filter((bookmark) => bookmark.state === "active"));
    } catch {
      // A projection problem must not make the core chat surface unavailable.
    }
  }, [workspaceId]);

  // DM sync: refresh received requests, push the member's local ops, pull the
  // peers' ops, and refresh the established DM list. Best-effort —
  // offline keeps the current list and the next pass retries. A late response
  // for a stale workspace/nav is dropped by the token guard.
  //
  // One sync in flight (#545, badgeRead precedent). The activity signal below
  // fires for every settled file batch and run update, and this is a relay
  // sync, not a local read — a burst must not fan out into a sync per event.
  // A call landing mid-sync is not dropped: it runs exactly one more pass when
  // the sync settles. A drain whose token era ended can commit nothing, so the
  // next caller takes the slot instead of queueing onto it.
  const dmSync = useRef<{ token: number; pending: boolean } | null>(null);
  const keepAcceptedNoticeRef = useRef(false);
  const refreshDms = useCallback(async () => {
    const active = dmSync.current;
    if (active !== null && active.token === liveToken.current) {
      active.pending = true;
      return;
    }
    const mine = { token: liveToken.current, pending: false };
    dmSync.current = mine;
    try {
      do {
        mine.pending = false;
        mine.token = liveToken.current;
        const token = mine.token;
        const session = sessionGeneration.current;
        try {
          const result = await bridge().syncDms({ workspaceId });
          if (token !== liveToken.current) return;
          if (session !== sessionGeneration.current) continue;
          setDmAvailable(result.available);
          setDms(keepIfUnchanged(result.dms));
          setPendingDmRequests(keepIfUnchanged(result.pending));
          setDeclinedDmRequests(keepIfUnchanged(result.declined));
          if (keepAcceptedNoticeRef.current) {
            keepAcceptedNoticeRef.current = false;
          } else {
            setDmAcceptedElsewhere(null);
          }
        } catch {
          // DMs are optional: Chats stays fully usable without them.
        }
      } while (
        mine.pending &&
        mine.token === liveToken.current &&
        dmSync.current === mine
      );
    } finally {
      if (dmSync.current === mine) dmSync.current = null;
    }
  }, [workspaceId]);

  // Workspace switch: drop everything stale and reload from the top.
  useEffect(() => {
    liveToken.current += 1;
    dmRefreshSeq.current += 1;
    paintedDmRevision.current = null;
    resetForWorkspace();
    bookmarkWorkspaceGeneration.current += 1;
    bookmarkListGeneration.current += 1;
    bookmarkMutationGeneration.current += 1;
    bookmarkMutationByKey.current.clear();
    setNav({ level: "channels" });
    setChannelThreads([]);
    setFeedPosts({});
    setMessages([]);
    setReactions([]);
    setDecisions([]);
    setAttachments([]);
    setRunRecords({});
    setDispatchState(IDLE_DISPATCH_STATE);
    setDispatchActionBusy(false);
    setComposer("");
    setReplyTarget(null);
    setResolveTargetMessageId(null);
    setFlashMessageId(null);
    messageNodes.current.clear();
    setNewThreadBody("");
    resetGroupForm();
    setChannelShares(null);
    setShareReadFailure(null);
    setSharesWorkspaceId(null);
    // Nothing is committed for the new workspace yet. Tickets stay monotonic:
    // an in-flight response from the old workspace holds an older ticket and
    // fails the token check. The session generation moves too, because
    // refreshShares commits under IT rather than the nav token — an old
    // workspace's share listing must be refused at the commit point.
    sessionGeneration.current += 1;
    committedLane.current = {
      overview: 0,
      joinedShares: 0,
      relayShares: 0,
      relayReach: 0,
    };
    setSharePanelOpen(false);
    setShareEmail("");
    setShareReadOnly(false);
    setJoiningShareId(null);
    setDms([]);
    setDmAvailable(false);
    setPendingDmRequests([]);
    setDeclinedDmRequests([]);
    setAcceptingDmRequest(null);
    setDmAcceptedElsewhere(null);
    setDmRequestBusy(null);
    setDmRecipients("");
    setDmDraft("");
    setBookmarks([]);
    setBookmarkBusy(new Set());
    setOverview({ status: "loading" });
    void refreshOverview();
    void refreshDms();
    void refreshBookmarks();
    return () => {
      liveToken.current += 1;
      invalidate();
      bookmarkWorkspaceGeneration.current += 1;
      bookmarkListGeneration.current += 1;
      bookmarkMutationGeneration.current += 1;
      bookmarkMutationByKey.current.clear();
    };
  }, [invalidate, refreshBookmarks, refreshDms, refreshOverview, resetForWorkspace, resetGroupForm]);

  const bookmarkFor = useCallback(
    (targetKind: "message" | "thread", targetId: string) =>
      bookmarks.find(
        (bookmark) =>
          bookmark.targetKind === targetKind && bookmark.targetId === targetId,
      ),
    [bookmarks],
  );

  const toggleBookmark = useCallback(
    async (input: {
      target:
        | { kind: "thread"; threadId: string }
        | { kind: "message"; threadId: string; messageId: string };
      mode: "live" | "snapshot";
    }) => {
      const targetId =
        input.target.kind === "thread"
          ? input.target.threadId
          : input.target.messageId;
      const key = `${input.target.kind}:${targetId}`;
      if (bookmarkBusy.has(key) || bookmarkMutationByKey.current.has(key)) return;
      const existing = bookmarkFor(input.target.kind, targetId);
      const workspaceGeneration = bookmarkWorkspaceGeneration.current;
      const mutationGeneration = ++bookmarkMutationGeneration.current;
      // A list response that began before this write reflects older storage
      // and must never erase the mutation result when it eventually resolves.
      bookmarkListGeneration.current += 1;
      bookmarkMutationByKey.current.set(key, mutationGeneration);
      const mutationIsCurrent = () =>
        workspaceGeneration === bookmarkWorkspaceGeneration.current &&
        bookmarkMutationByKey.current.get(key) === mutationGeneration;
      if (!mutationIsCurrent()) return;
      setBookmarkBusy((current) => new Set(current).add(key));
      try {
        if (existing) {
          await bridge().archiveChatBookmark({
            workspaceId,
            bookmarkId: existing.bookmarkId,
          });
          if (!mutationIsCurrent()) return;
          setBookmarks((current) =>
            current.filter(
              (bookmark) => bookmark.bookmarkId !== existing.bookmarkId,
            ),
          );
        } else {
          const result = await bridge().saveChatBookmark({
            workspaceId,
            target: input.target,
            mode: input.mode,
          });
          if (!mutationIsCurrent()) return;
          setBookmarks((current) => [
            ...current.filter(
              (bookmark) => bookmark.bookmarkId !== result.bookmark.bookmarkId,
            ),
            result.bookmark,
          ]);
        }
      } catch (error) {
        if (mutationIsCurrent()) {
          props.onError(
            ipcErrorMessage(error, "Could not update this bookmark."),
          );
        }
      } finally {
        if (mutationIsCurrent()) {
          setBookmarkBusy((current) => {
            const next = new Set(current);
            next.delete(key);
            return next;
          });
          bookmarkMutationByKey.current.delete(key);
        }
      }
    },
    [bookmarkBusy, bookmarkFor, props.onError, workspaceId],
  );

  // Gentle DM poll while the view is open: the other side's messages arrive
  // by relay pull, and the sync is cursor-based (no changes = no work). While a
  // DM conversation is open the inner 4s poll already runs a full syncDms pass,
  // so pause this outer poll then — otherwise viewing a DM doubles the
  // relay/sync cadence for no benefit.
  useEffect(() => {
    if (props.suspendPolling || nav.level === "dm") return;
    const interval = setInterval(() => void refreshDms(), 5_000);
    return () => clearInterval(interval);
  }, [refreshDms, nav.level, props.suspendPolling]);

  // The panel navigator hands every conversation to the page instance, so it
  // never reaches the mark-read above and its channel, file-thread, and DM
  // badges would keep the counts fetched at mount until it remounted. The
  // shell bumps readRevision after each landed local-thread read; the mount
  // value belongs to the load effect above, so only later ones refetch.
  const seenOverviewRevisions = useRef({
    read: props.readRevision,
    thread: props.threadRevision,
  });
  useEffect(() => {
    const revisions = {
      read: props.readRevision,
      thread: props.threadRevision,
    };
    if (
      revisions.read === seenOverviewRevisions.current.read &&
      revisions.thread === seenOverviewRevisions.current.thread
    ) {
      return;
    }
    seenOverviewRevisions.current = revisions;
    void refreshOverview({ background: true });
  }, [props.readRevision, props.threadRevision, refreshOverview]);

  // A landed DM read moves the cursor syncDms reads from. While the navigator
  // is suspended, this DM-specific signal is the only path that clears its
  // pill; channel and file-thread reads must never pay for a relay sync.
  const seenDmReadRevision = useRef(props.dmReadRevision);
  useEffect(() => {
    const revision = props.dmReadRevision;
    if (revision === seenDmReadRevision.current) return;
    seenDmReadRevision.current = revision;
    void refreshDms();
  }, [props.dmReadRevision, refreshDms]);

  const loadChannelSnapshot = useCallback(
    async (channelId: string): Promise<ChannelSnapshot> => {
      const result = await bridge().listChannelThreads({ workspaceId, channelId });
      return {
        threads: result.threads,
        feedPosts: Object.fromEntries(
          result.threads.map((thread) => {
            const preview = thread.openingMessage;
            return [
              thread.id,
              {
                openingMessage: preview
                  ? {
                      id: preview.id,
                      authorKind: preview.authorKind,
                      authorDisplayName: preview.authorDisplayName,
                      authorOwnerDisplayName: preview.authorOwnerDisplayName,
                      authorUserId: preview.authorUserId,
                      createdAtMs: preview.createdAtMs,
                      bodySnippet: preview.bodySnippet,
                    }
                  : null,
                reactions: preview?.reactions ?? [],
                viewerAuthorId: result.viewerAuthorId ?? "",
              },
            ] as const;
          }),
        ),
      };
    },
    [workspaceId],
  );

  const applyChannelSnapshot = useCallback((snapshot: ChannelSnapshot) => {
    setChannelThreads(snapshot.threads);
    setFeedPosts(snapshot.feedPosts);
  }, []);

  const openChannel = useCallback(
    async (channel: ChatChannelRecord) => {
      const token = ++liveToken.current;
      const refreshSeq = ++channelRefreshSeq.current;
      setNav({ level: "channel", channel });
      setSharePanelOpen(false);
      setChannelThreads([]);
      setFeedPosts({});
      setDispatchState(IDLE_DISPATCH_STATE);
      setThreadsLoading(true);
      try {
        const snapshot = await loadChannelSnapshot(channel.id);
        if (
          token !== liveToken.current ||
          refreshSeq !== channelRefreshSeq.current
        ) {
          return;
        }
        applyChannelSnapshot(snapshot);
      } catch (error) {
        if (token !== liveToken.current) return;
        props.onError(ipcErrorMessage(error, "Could not load this channel."));
      } finally {
        if (
          token === liveToken.current &&
          refreshSeq === channelRefreshSeq.current
        ) {
          setThreadsLoading(false);
        }
      }
    },
    [applyChannelSnapshot, loadChannelSnapshot, props.onError],
  );

  const loadThreadSnapshot = useCallback(
    async (threadId: string): Promise<ThreadSnapshot> => {
      const [
        result,
        reactionResult,
        decisionResult,
        attachmentResult,
        runResult,
        nextDispatchState,
      ] =
        await Promise.all([
          bridge().listChatMessages({ workspaceId, threadId }),
          bridge().listChatReactions({ workspaceId, threadId }),
          bridge().listChatThreadDecisions({ workspaceId, threadId }),
          bridge().listChatThreadAttachments({ workspaceId, threadId }),
          bridge()
            .chatRunRecordsForThread({ workspaceId, threadId })
            .catch(() => ({ runs: {} })),
          bridge().chatDispatchStateForThread({ workspaceId, threadId }),
        ]);
      return {
        messages: result.messages,
        reactions: reactionResult.reactions,
        decisions: decisionResult.decisions,
        attachments: attachmentResult.attachments,
        runRecords: runResult.runs,
        dispatchState: nextDispatchState,
        viewerAuthorId: reactionResult.viewerAuthorId,
      };
    },
    [workspaceId],
  );

  const loadDmConversation = useCallback(
    async (
      dm: DmRecord,
      token: number,
      request = ++dmRefreshSeq.current,
      knownRevision?: number,
    ) => {
      if (!dm.threadId) return;
      const session = sessionGeneration.current;
      const revision =
        knownRevision ??
        (
          await bridge().getChatThreadRevision({
            workspaceId,
            threadId: dm.threadId,
          })
        ).revision;
      const [result, reactionResult] = await Promise.all([
        bridge().listChatMessages({ workspaceId, threadId: dm.threadId }),
        bridge().listChatReactions({ workspaceId, threadId: dm.threadId }),
      ]);
      if (
        token !== liveToken.current ||
        request !== dmRefreshSeq.current ||
        session !== sessionGeneration.current
      ) {
        return;
      }
      setMessages(keepIfUnchanged(result.messages));
      setReactions(keepIfUnchanged(reactionResult.reactions));
      setViewerAuthorId(reactionResult.viewerAuthorId);
      paintedDmRevision.current = {
        workspaceId,
        threadId: dm.threadId,
        revision,
      };
      if (dm.connected) {
        const clearedUnread = dm.unreadCount > 0;
        void bridge()
          .markChatThreadRead({
            workspaceId,
            threadId: dm.threadId,
            upToSequence: result.messages.length,
          })
          .then(
            // Only once the cursor write landed (the thread-view precedent),
            // and only when this load actually cleared something: the open-DM
            // poll re-marks on every pass, and reporting those would make the
            // shell's DM revision re-poll the suspended navigator at the
            // very cadence the suspension exists to stop.
            () => {
              if (clearedUnread) onDmRead?.();
            },
            () => {
              // Best-effort, like the thread view.
            },
          );
      }
    },
    [onDmRead, workspaceId],
  );

  const refreshOpenDm = useCallback(
    async (dm: DmRecord, token: number) => {
      const session = sessionGeneration.current;
      const request = ++dmRefreshSeq.current;
      try {
        // Name the open DM: the main-side shared-channel pass is bounded, so an
        // unnamed poll can refresh 16 other channels and leave this one stale.
        const result = await bridge().syncDms({
          workspaceId,
          openChannelId: dm.channelId,
        });
        if (
          token !== liveToken.current ||
          request !== dmRefreshSeq.current ||
          session !== sessionGeneration.current
        ) {
          return;
        }
        setDmAvailable(result.available);
        setDms(keepIfUnchanged(result.dms));
        setPendingDmRequests(keepIfUnchanged(result.pending));
        setDeclinedDmRequests(keepIfUnchanged(result.declined));
        const syncedDm = result.dms.find(
          (entry) => entry.channelId === dm.channelId,
        );
        if (!syncedDm) return;
        setNav((current) => {
          if (current.level !== "dm" || current.dm.channelId !== dm.channelId) {
            return current;
          }
          return samePollData(current.dm, syncedDm)
            ? current
            : { ...current, dm: syncedDm };
        });
        if (!syncedDm.threadId) return;
        const { revision } = await bridge().getChatThreadRevision({
          workspaceId,
          threadId: syncedDm.threadId,
        });
        if (
          token !== liveToken.current ||
          request !== dmRefreshSeq.current ||
          session !== sessionGeneration.current
        ) {
          return;
        }
        const painted = paintedDmRevision.current;
        if (
          painted?.workspaceId === workspaceId &&
          painted.threadId === syncedDm.threadId &&
          painted.revision === revision
        ) {
          return;
        }
        await loadDmConversation(syncedDm, token, request, revision);
      } catch {
        // Offline: keep the conversation as-is; the next tick retries.
      } finally {
        if (token === liveToken.current && request === dmRefreshSeq.current) {
          setMessagesLoading(false);
        }
      }
    },
    [loadDmConversation, workspaceId],
  );

  // MU-C4 derived lookups: a channel matches a grant by its WIRE id. A key
  // that is present with a null value means "asked, and this workspace holds
  // no grant" — an absent key means nobody asked, which is unknown.
  const joinedByWire = useMemo(() => {
    const map = new Map<string, JoinedSharedChannelRow | null>();
    for (const answer of channelShares?.joined ?? []) {
      map.set(answer.channelWireId, answer.joined);
    }
    return map;
  }, [channelShares]);

  const channelIsLocked = useCallback(
    (channel: ChatChannelRecord) => {
      // Share metadata is the authority for whether this local row is owned
      // or joined. If that authority is unavailable, fail closed: treating an
      // unknown joined channel as local would re-enable writes and read-cursor
      // mutations across a permission boundary.
      if (channelShares === null) return true;
      // A channel with no wire identity cannot carry a grant at all.
      if (!channel.wireId) return false;
      const answer = joinedByWire.get(channel.wireId);
      // Not declared, so not answered — a channel the list gained since the
      // last read. Unanswered fails closed exactly like an unresolved
      // listing; the next refresh declares it and unlocks it.
      if (answer === undefined) return true;
      // Answered, and this workspace holds no grant: a plain local channel.
      if (answer === null) return false;
      return answer.access === "read-only" || answer.ended;
    },
    [channelShares, joinedByWire],
  );

  const applyThreadSnapshot = useCallback(
    (threadId: string, snapshot: ThreadSnapshot, markRead: boolean) => {
      setMessages(snapshot.messages);
      setReactions(snapshot.reactions);
      setDecisions(snapshot.decisions);
      setAttachments(snapshot.attachments);
      setRunRecords(snapshot.runRecords);
      setDispatchState(snapshot.dispatchState);
      setViewerAuthorId(snapshot.viewerAuthorId);
      // Everything on screen is read: advance the monotonic cursor and clear
      // this thread's badge locally so back-navigation is immediately honest.
      const upToSequence = snapshot.messages.length;
      if (markRead) {
        setChannelThreads((current) =>
          current.map((entry) =>
            entry.id === threadId ? { ...entry, unreadCount: 0 } : entry,
          ),
        );
        void bridge()
          .markChatThreadRead({ workspaceId, threadId, upToSequence })
          .then(
            // Only once the cursor write landed: a panel refetch before that
            // would read the same count back and look like nothing happened.
            () => onThreadRead?.(),
            () => {
              // Mark-read is best-effort; the badge re-appears on next refresh
              // if the cursor write did not land.
            },
          );
      }
    },
    [onThreadRead, workspaceId],
  );

  const openThread = useCallback(
    async (
      channel: ChatChannelRecord,
      thread: ChannelThreadRecord,
      focusMessageId?: string,
    ) => {
      const token = ++liveToken.current;
      const refreshSeq = ++threadRefreshSeq.current;
      setNav({
        level: "thread",
        channel,
        thread,
        ...(focusMessageId ? { focusMessageId } : {}),
      });
      focusedMessageJump.current = null;
      setMessages([]);
      setReactions([]);
      setDecisions([]);
      setAttachments([]);
      setRunRecords({});
      setDispatchState(IDLE_DISPATCH_STATE);
      setDispatchActionBusy(false);
      setReplyTarget(null);
      setResolveTargetMessageId(null);
      setFlashMessageId(null);
      messageNodes.current.clear();
      setMessagesLoading(true);
      try {
        const snapshot = await loadThreadSnapshot(thread.id);
        if (
          token !== liveToken.current ||
          refreshSeq !== threadRefreshSeq.current
        ) {
          return;
        }
        applyThreadSnapshot(thread.id, snapshot, !channelIsLocked(channel));
      } catch (error) {
        if (token !== liveToken.current) return;
        props.onError(ipcErrorMessage(error, "Could not load this chat."));
      } finally {
        if (
          token === liveToken.current &&
          refreshSeq === threadRefreshSeq.current
        ) {
          setMessagesLoading(false);
        }
      }
    },
    [applyThreadSnapshot, channelIsLocked, loadThreadSnapshot, props.onError],
  );

  // Main emits workspaceActivity for CLI writes, follow mutations, runner
  // reports/failures, and run-record completion. Treat it as an invalidation
  // for every mounted Chats surface. Every response carries the follow request
  // sequence, the navigation token, or both the token and a per-surface
  // request sequence, so a slow refresh cannot repaint a newer one.
  const refreshForActivity = useCallback(() => {
      if (nav.level === "channels") {
        // The roll-up unread badge lives on this list, so a write to a chat
        // the user does not have open is only visible here.
        void refreshChannelBadges();
        // The DM roll-up lives on the same list and used to wait for the 5s
        // poll beside a live channel badge. Same signal, same moment —
        // refreshDms coalesces the burst itself.
        void refreshDms();
        return;
      }
      if (nav.level === "feed") {
        void loadPersonalFeed();
        return;
      }
      if (nav.level === "dm") {
        const token = liveToken.current;
        if (nav.dm.threadId) {
          const refreshSeq = ++dmRefreshSeq.current;
          void loadDmConversation(nav.dm, token, refreshSeq)
            .then(() => {
              if (
                token === liveToken.current &&
                refreshSeq === dmRefreshSeq.current
              ) {
                setMessagesLoading(false);
              }
            })
            .catch(() => {
              if (
                token === liveToken.current &&
                refreshSeq === dmRefreshSeq.current
              ) {
                setMessagesLoading(false);
              }
            });
        } else {
          void refreshOpenDm(nav.dm, token);
        }
        return;
      }
      if (nav.level === "thread") {
        const threadId = nav.thread.id;
        const token = liveToken.current;
        const refreshSeq = ++threadRefreshSeq.current;
        void loadThreadSnapshot(threadId)
          .then((snapshot) => {
            if (
              token !== liveToken.current ||
              refreshSeq !== threadRefreshSeq.current
            ) {
              return;
            }
            applyThreadSnapshot(
              threadId,
              snapshot,
              !channelIsLocked(nav.channel),
            );
            setMessagesLoading(false);
          })
          .catch(() => {
            if (
              token === liveToken.current &&
              refreshSeq === threadRefreshSeq.current
            ) {
              setMessagesLoading(false);
            }
          });
        return;
      }
      if (nav.level === "channel") {
        const channelId = nav.channel.id;
        const token = liveToken.current;
        const refreshSeq = ++channelRefreshSeq.current;
        void loadChannelSnapshot(channelId)
          .then((snapshot) => {
            if (
              token !== liveToken.current ||
              refreshSeq !== channelRefreshSeq.current
            ) {
              return;
            }
            applyChannelSnapshot(snapshot);
            setThreadsLoading(false);
          })
          .catch(() => {
            if (
              token === liveToken.current &&
              refreshSeq === channelRefreshSeq.current
            ) {
              setThreadsLoading(false);
            }
          });
      }
  }, [
    applyChannelSnapshot,
    applyThreadSnapshot,
    channelIsLocked,
    loadChannelSnapshot,
    loadDmConversation,
    loadPersonalFeed,
    loadThreadSnapshot,
    nav,
    refreshOpenDm,
    refreshChannelBadges,
    refreshDms,
  ]);
  // Resuming after a suspension owes one catch-up pass: the activity events
  // that fired meanwhile reached only the page instance, and waiting for the
  // next event would leave this surface stale for as long as the workspace
  // stays quiet. The mount value is deliberately not a resumption.
  const pollingWasSuspended = useRef(props.suspendPolling === true);
  useEffect(() => {
    if (props.suspendPolling) {
      pollingWasSuspended.current = true;
      return;
    }
    const unsubscribe = bridge().onWorkspaceActivity(refreshForActivity);
    if (pollingWasSuspended.current) {
      pollingWasSuspended.current = false;
      refreshForActivity();
    }
    return unsubscribe;
  }, [props.suspendPolling, refreshForActivity]);

  // The anti-forum move: typing in the channel composer starts the chat.
  // One Enter = thread + first message; no title prompt exists on this path.
  const startThread = useCallback(async () => {
    if (nav.level !== "channel") return;
    const body = newThreadBody.trim();
    if (body.length === 0 || startingThread || startingThreadRef.current) return;
    const channel = nav.channel;
    const token = liveToken.current;
    startingThreadRef.current = true;
    setStartingThread(true);
    try {
      const result = await bridge().startChannelThread({
        workspaceId,
        channelId: channel.id,
        body,
        ...(extractChatFileReferences(body).length > 0
          ? { fileReferences: extractChatFileReferences(body) }
          : {}),
      });
      if (token !== liveToken.current) return;
      props.onThreadStarted?.();
      setNewThreadBody("");
      // The completion is the user's command landing: report it through the
      // seam in the same tick as the nav write (see openConversation).
      props.onNavCommand?.({ level: "thread", channel, thread: result.thread });
      setNav({ level: "thread", channel, thread: result.thread });
      setMessages([result.message]);
      setReactions([]);
      setViewerAuthorId(result.viewerAuthorId);
      setDecisions([]);
      setAttachments(result.message.attachments ?? []);
      setRunRecords({});
      setDispatchState(IDLE_DISPATCH_STATE);
      setDispatchActionBusy(false);
      setReplyTarget(null);
      setResolveTargetMessageId(null);
      messageNodes.current.clear();
      setChannelThreads((current) => [result.thread, ...current]);
    } catch (error) {
      if (token !== liveToken.current) return;
      props.onError(ipcErrorMessage(error, "Could not start that chat."));
    } finally {
      startingThreadRef.current = false;
      setStartingThread(false);
    }
  }, [nav, newThreadBody, props.onError, props.onNavCommand, props.onThreadStarted, startingThread, workspaceId]);

  const sendMessage = useCallback(async () => {
    if (nav.level !== "thread") return;
    const trimmedBody = composer.trim();
    const resolvingMessageId = resolveTargetMessageId;
    const chosenOption = resolvingMessageId !== null ? resolveChosenOption : null;
    // An answer with no words of its own says the choice, or the fact.
    const body =
      trimmedBody.length > 0
        ? trimmedBody
        : resolvingMessageId !== null
          ? chosenOption ?? "Resolved ✓"
          : "";
    if (
      body.length === 0 ||
      sending ||
      sendingRef.current ||
      inFlightSendByContext.current.has(sendContextKey)
    ) {
      return;
    }
    const parentMessageId = replyTarget?.messageId;
    const request = ++sendRequestGeneration.current;
    inFlightSendByContext.current.set(sendContextKey, request);
    const requestOwnsActiveContext = () =>
      inFlightSendByContext.current.get(sendContextKey) === request &&
      activeSendContext.current === sendContextKey;
    const clearMatchingComposer = () => {
      const latest = latestComposerState.current;
      const next = { ...latest };
      if (latest.composer === composer) {
        next.composer = "";
        setComposer("");
      }
      if (latest.replyMessageId === replyTarget?.messageId) {
        next.replyMessageId = undefined;
        setReplyTarget(null);
      }
      if (latest.resolveTargetMessageId === resolvingMessageId) {
        next.resolveTargetMessageId = null;
        setResolveTargetMessageId(null);
        setResolveChosenOption(null);
      }
      latestComposerState.current = next;
    };
    sendingRef.current = true;
    setSending(true);
    let sentMessage: ChatMessageRecord | null = null;
    try {
      const result = await bridge().sendChatMessage({
        workspaceId,
        threadId: nav.thread.id,
        ...(parentMessageId ? { parentMessageId } : {}),
        body,
        ...(extractChatFileReferences(body).length > 0
          ? { fileReferences: extractChatFileReferences(body) }
          : {}),
      });
      // A navigation token mismatch normally fences the response. The one safe
      // exception is returning to the exact workspace conversation while this
      // request still owns its send slot.
      if (!requestOwnsActiveContext()) return;
      sentMessage = result.message;
      let resolvedDecision: ChatDecisionRecord | null = null;
      if (resolvingMessageId) {
        const resolution = await bridge().resolveChatDecision({
          workspaceId,
          threadId: nav.thread.id,
          messageId: resolvingMessageId,
          resolvedByMessageId: result.message.id,
          ...(chosenOption ? { chosenOption } : {}),
        });
        if (!requestOwnsActiveContext()) return;
        resolvedDecision = resolution.decision;
      }
      setMessages((current) =>
        current.some((message) => message.id === result.message.id)
          ? current
          : [...current, result.message],
      );
      if (resolvedDecision) {
        const decisionWasOpen = reconcileResolvedChatDecision(
          latestDecisions.current,
          resolvedDecision,
        ).wasOpen;
        setDecisions(
          (current) =>
            reconcileResolvedChatDecision(current, resolvedDecision).decisions,
        );
        if (decisionWasOpen) {
          setChannelThreads((current) =>
            current.map((thread) =>
              thread.id === nav.thread.id
                ? {
                    ...thread,
                    openDecisionCount: Math.max(
                      0,
                      (thread.openDecisionCount ?? 0) - 1,
                    ),
                  }
                : thread,
            ),
          );
        }
      }
      clearMatchingComposer();
      messagesEndRef.current?.scrollIntoView({ block: "end" });
    } catch (error) {
      if (!requestOwnsActiveContext()) return;
      if (sentMessage && resolvingMessageId) {
        // The two durable writes are intentionally separate. If the reply
        // landed but resolution failed, show the real posted message and exit
        // the mode so retrying cannot silently duplicate the reply.
        const posted = sentMessage;
        setMessages((current) =>
          current.some((message) => message.id === posted.id)
            ? current
            : [...current, posted],
        );
        clearMatchingComposer();
        props.onError(
          ipcErrorMessage(error, "Your reply was sent, but the decision is still open."),
        );
      } else {
        props.onError(ipcErrorMessage(error, "Could not send that message."));
      }
    } finally {
      const ownsContext =
        inFlightSendByContext.current.get(sendContextKey) === request;
      if (ownsContext) {
        inFlightSendByContext.current.delete(sendContextKey);
      }
      if (ownsContext && activeSendContext.current === sendContextKey) {
        sendingRef.current = false;
        setSending(false);
      }
    }
  }, [
    composer,
    nav,
    props.onError,
    replyTarget,
    resolveChosenOption,
    resolveTargetMessageId,
    sendContextKey,
    sending,
    workspaceId,
  ]);

  // Reactions (WS-MU-C2): optimistic add/remove of the viewer's own reaction,
  // then reconcile to the server's canonical list (which carries the real
  // reactionId and any peer reactions). Guarded by the liveness token so a
  // slow response never repaints a thread the user already left.
  const toggleReaction = useCallback(
    (input: { messageId: string; emoji: string; nextState: "added" | "removed" }) => {
      const threadId =
        nav.level === "thread"
          ? nav.thread.id
          : nav.level === "dm" && nav.dm.connected
            ? nav.dm.threadId
            : null;
      if (!threadId) return;
      runReactionToggle(
        {
          workspaceId,
          threadId,
          viewerAuthorId,
          liveToken,
          reactionSeq,
          setReactions,
          setViewerAuthorId,
          onError: props.onError,
        },
        input,
      );
    },
    [nav, props.onError, viewerAuthorId, workspaceId],
  );

  // Like from Home. The viewer id may still be unknown here (it arrives with
  // the first reaction listing), so the write goes first and the listing that
  // answers it repaints the item and names the viewer.
  const toggleHomeReaction = useCallback(
    (threadId: string, messageId: string, liked: boolean) => {
      if (nav.level !== "feed") return;
      const token = liveToken.current;
      const cellKey = `${messageId}\u0000${LIKE_EMOJI}`;
      const seq = (reactionSeq.current.get(cellKey) ?? 0) + 1;
      reactionSeq.current.set(cellKey, seq);
      const isCurrent = () =>
        token === liveToken.current && reactionSeq.current.get(cellKey) === seq;
      void bridge()
        .setChatReaction({
          workspaceId,
          threadId,
          messageId,
          emoji: LIKE_EMOJI,
          state: liked ? "removed" : "added",
        })
        .then(() => bridge().listChatReactions({ workspaceId, threadId }))
        .then((result) => {
          if (!isCurrent()) return;
          setMessageReactions(messageId, result.reactions, result.viewerAuthorId);
        })
        .catch((error) => {
          if (!isCurrent()) return;
          props.onError(ipcErrorMessage(error, "Could not update that reaction."));
        });
    },
    [nav.level, props.onError, setMessageReactions, workspaceId],
  );

  const toggleFeedReaction = useCallback(
    (
      threadId: string,
      input: { messageId: string; emoji: string; nextState: "added" | "removed" },
    ) => {
      if (nav.level !== "channel") return;
      const post = feedPosts[threadId];
      if (!post) return;
      runReactionToggle(
        {
          workspaceId,
          threadId,
          viewerAuthorId: post.viewerAuthorId,
          liveToken,
          reactionSeq,
          setReactions: (next) =>
            setFeedPosts((current) => {
              const entry = current[threadId];
              if (!entry) return current;
              const nextReactions =
                typeof next === "function" ? next(entry.reactions) : next;
              return {
                ...current,
                [threadId]: { ...entry, reactions: nextReactions },
              };
            }),
          setViewerAuthorId: (next) =>
            setFeedPosts((current) => {
              const entry = current[threadId];
              if (!entry) return current;
              const nextViewerAuthorId =
                typeof next === "function" ? next(entry.viewerAuthorId) : next;
              return {
                ...current,
                [threadId]: { ...entry, viewerAuthorId: nextViewerAuthorId },
              };
            }),
          onError: props.onError,
        },
        input,
      );
    },
    [feedPosts, nav.level, props.onError, workspaceId],
  );

  // --- Direct messages (WS-MU-C3) -----------------------------------------

  const openDm = useCallback(
    async (dm: DmRecord, focusMessageId?: string) => {
      const token = ++liveToken.current;
      const request = ++dmRefreshSeq.current;
      paintedDmRevision.current = null;
      setNav({
        level: "dm",
        dm,
        ...(focusMessageId ? { focusMessageId } : {}),
      });
      focusedMessageJump.current = null;
      setMessages([]);
      setReactions([]);
      setDecisions([]);
      setAttachments([]);
      setRunRecords({});
      setReplyTarget(null);
      setResolveTargetMessageId(null);
      setFlashMessageId(null);
      messageNodes.current.clear();
      setMessagesLoading(true);
      try {
        await loadDmConversation(dm, token, request);
        if (token !== liveToken.current || request !== dmRefreshSeq.current) {
          return;
        }
        if (dm.connected) {
          setDms((current) =>
            current.map((entry) =>
              entry.channelId === dm.channelId ? { ...entry, unreadCount: 0 } : entry,
            ),
          );
        }
      } catch (error) {
        if (token !== liveToken.current || request !== dmRefreshSeq.current) {
          return;
        }
        props.onError(ipcErrorMessage(error, "Could not load this conversation."));
      } finally {
        if (token === liveToken.current && request === dmRefreshSeq.current) {
          setMessagesLoading(false);
        }
      }
    },
    [loadDmConversation, props.onError],
  );

  const openFeed = useCallback(() => {
    const target: ChatsNav = { level: "feed" };
    if (variant === "panel" && props.onOpenInTab) {
      props.onOpenInTab(target);
      return;
    }
    liveToken.current += 1;
    prepareOpen();
    setNav(target);
  }, [prepareOpen, props.onOpenInTab, variant]);

  useEffect(() => {
    if (nav.level === "feed") void loadPersonalFeed();
  }, [loadPersonalFeed, nav.level]);

  const openConversation = useCallback(
    (
      target: Extract<
        ChatsNav,
        { level: "channel" | "thread" | "dm" | "feed" }
      >,
    ) => {
      if (variant === "panel" && props.onOpenInTab) {
        props.onOpenInTab(target);
        return;
      }
      // In-place navigation is still a command. Report it as one before the
      // local loaders run: an exact repeat of the current destination changes
      // no nav state, so the passive report alone would cancel nothing.
      props.onNavCommand?.(target);
      if (target.level === "feed") openFeed();
      else if (target.level === "channel") void openChannel(target.channel);
      else if (target.level === "thread") {
        void openThread(target.channel, target.thread, target.focusMessageId);
      } else void openDm(target.dm, target.focusMessageId);
    },
    [
      openChannel,
      openDm,
      openFeed,
      openThread,
      props.onNavCommand,
      props.onOpenInTab,
      variant,
    ],
  );

  // Expand-to-tab seam, outbound: report where this view is (and what's
  // typed) so the shell can seed the next mount with this instance's current
  // conversation and unsent drafts. While a seed is still pending the
  // reports are suppressed — nav/drafts start as mount defaults, and
  // reporting those would overwrite the very state the seed is about to
  // restore (closing the tab while the overview is still loading would then
  // hand "channels" and empty drafts back to the panel).
  const handoffReportBlocked = useRef(props.initialNav !== undefined);
  useEffect(() => {
    if (handoffReportBlocked.current) return;
    onNavChange?.(nav);
  }, [nav, onNavChange]);
  useEffect(() => {
    if (handoffReportBlocked.current) return;
    onDraftsChange?.({
      composer,
      newThreadBody,
      dmRecipients,
      dmDraft,
      replyTarget,
      resolveTargetMessageId,
      resolveChosenOption,
    });
  }, [
    composer,
    dmDraft,
    dmRecipients,
    newThreadBody,
    onDraftsChange,
    replyTarget,
    resolveChosenOption,
    resolveTargetMessageId,
  ]);

  // Expand-to-tab seam, inbound: once the overview is ready, jump to the
  // seeded conversation exactly the way a click would (same loaders, same
  // token discipline) and restore the unsent drafts. Waiting for "ready"
  // matters — the open* navigations advance the shared liveness token, so
  // seeding earlier would cancel the initial overview load. Applied once per
  // mount (the ref guard): workspace switches and later navigation never
  // re-apply a stale seed.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || overview.status !== "ready") return;
    seededRef.current = true;
    handoffReportBlocked.current = false;
    const seed = props.initialNav;
    if (seed) {
      if (seed.level === "feed") openFeed();
      else if (seed.level === "channel") void openChannel(seed.channel);
      else if (seed.level === "thread") {
        void openThread(seed.channel, seed.thread, seed.focusMessageId);
      }
      else if (seed.level === "dm") void openDm(seed.dm, seed.focusMessageId);
      else if (seed.level === "dm-new") setNav({ level: "dm-new" });
    }
    const drafts = props.initialDrafts;
    if (drafts) {
      setComposer(drafts.composer);
      setNewThreadBody(drafts.newThreadBody);
      setDmRecipients(drafts.dmRecipients);
      setDmDraft(drafts.dmDraft);
      // After the open* call above: navigation resets these, and restoring
      // the composer text without its mode would post a drafted reply (or
      // decision resolution) as a plain top-level comment.
      setReplyTarget(drafts.replyTarget);
      setResolveTargetMessageId(drafts.resolveTargetMessageId);
      setResolveChosenOption(drafts.resolveChosenOption ?? null);
    }
  }, [
    openChannel,
    openDm,
    openFeed,
    openThread,
    overview.status,
    props.initialDrafts,
    props.initialNav,
  ]);

  // While a DM is open, poll: sync (push the member's ops, pull the peers'),
  // then reload only when its content revision changed. Pending DMs also sync
  // immediately so they can acquire their relay-created thread while the outer
  // list poll is paused. Token and request guards prevent an older pass from
  // repainting a newer snapshot or a local send.
  useEffect(() => {
    if (props.suspendPolling || nav.level !== "dm") return;
    const dm = nav.dm;
    const token = liveToken.current;
    if (!dm.threadId) void refreshOpenDm(dm, token);
    const interval = setInterval(
      () => void refreshOpenDm(dm, token),
      4_000,
    );
    return () => clearInterval(interval);
  }, [nav, refreshOpenDm, props.suspendPolling]);

  // #742 P2-D belt: LeaveDmDialog owns Escape itself, but this clears
  // leavingDm on any navigation away from the DM it was opened for — leaving
  // this DM, opening a different one, or leaving Chats entirely — so a stale
  // confirmation can never reappear over a conversation it wasn't opened for.
  // Also clears it the moment a field-level refresh of the same open DM
  // (refreshOpenDm) reports connected:false: an owner revocation
  // mid-dialog leaves the channelId unchanged, so the nav-change check alone
  // would leave the dialog open — confirming would re-end an already-ended
  // tombstone and promise a request that, for an owner-revoked grant, can
  // never appear.
  useEffect(() => {
    setLeavingDm((current) => {
      if (current === null) return current;
      if (nav.level === "dm" && nav.dm.channelId === current.channelId && nav.dm.connected) {
        return current;
      }
      return null;
    });
  }, [nav]);

  const sendDmMessage = useCallback(async () => {
    if (nav.level !== "dm" || !nav.dm.threadId || !nav.dm.connected) return;
    const body = composer.trim();
    if (
      body.length === 0 ||
      sending ||
      sendingRef.current ||
      inFlightSendByContext.current.has(sendContextKey)
    ) {
      return;
    }
    const threadId = nav.dm.threadId;
    const request = ++sendRequestGeneration.current;
    inFlightSendByContext.current.set(sendContextKey, request);
    const requestOwnsActiveContext = () =>
      inFlightSendByContext.current.get(sendContextKey) === request &&
      activeSendContext.current === sendContextKey;
    sendingRef.current = true;
    setSending(true);
    try {
      const result = await bridge().sendChatMessage({
        workspaceId,
        threadId,
        body,
        ...(extractChatFileReferences(body).length > 0
          ? { fileReferences: extractChatFileReferences(body) }
          : {}),
      });
      if (!requestOwnsActiveContext()) return;
      dmRefreshSeq.current += 1;
      setMessages((current) =>
        current.some((message) => message.id === result.message.id)
          ? current
          : [...current, result.message],
      );
      if (latestComposerState.current.composer === composer) {
        latestComposerState.current = {
          ...latestComposerState.current,
          composer: "",
        };
        setComposer("");
      }
      flatChatListRef.current?.scrollToEnd();
    } catch (error) {
      if (!requestOwnsActiveContext()) return;
      props.onError(ipcErrorMessage(error, "Could not send that message."));
    } finally {
      const ownsContext =
        inFlightSendByContext.current.get(sendContextKey) === request;
      if (ownsContext) {
        inFlightSendByContext.current.delete(sendContextKey);
      }
      if (ownsContext && activeSendContext.current === sendContextKey) {
        sendingRef.current = false;
        setSending(false);
      }
    }
  }, [composer, nav, props.onError, sendContextKey, sending, workspaceId]);

  // Starting a DM = pick who + say something, one step. Starting one with
  // someone you already message opens the existing conversation.
  const startDm = useCallback(async () => {
    const body = dmDraft.trim();
    const recipients = dmRecipients.trim();
    if (body.length === 0 || recipients.length === 0) return;
    if (startingDm || startingDmRef.current) return;
    const token = liveToken.current;
    startingDmRef.current = true;
    setStartingDm(true);
    try {
      const fileReferences = extractChatFileReferences(body);
      const result = await bridge().startDm({
        workspaceId,
        recipients,
        body,
        ...(fileReferences.length > 0 ? { fileReferences } : {}),
      });
      if (token !== liveToken.current) return;
      setDmDraft("");
      setDmRecipients("");
      setDms((current) => [
        result.dm,
        ...current.filter((dm) => dm.channelId !== result.dm.channelId),
      ]);
      // The completion is the user's command landing (see openConversation).
      props.onNavCommand?.({ level: "dm", dm: result.dm });
      void openDm(result.dm);
    } catch (error) {
      if (token !== liveToken.current) return;
      props.onError(ipcErrorMessage(error, "Could not start that conversation."));
    } finally {
      startingDmRef.current = false;
      setStartingDm(false);
    }
  }, [dmDraft, dmRecipients, openDm, props.onError, props.onNavCommand, startingDm, workspaceId]);

  const acceptDmRequest = useCallback(
    async (request: DmRequestRow, chosenWorkspaceId: string) => {
      const token = liveToken.current;
      try {
        const result = await bridge().acceptDm({
          workspaceId: chosenWorkspaceId,
          shareId: request.shareId,
        });
        if (token !== liveToken.current) return;
        setAcceptingDmRequest(null);
        if (chosenWorkspaceId === workspaceId) {
          openConversation({ level: "dm", dm: result.dm });
          void refreshDms();
        } else {
          const label =
            props.workspaces.find(
              (candidate) => candidate.workspaceId === chosenWorkspaceId,
            )?.label ?? chosenWorkspaceId;
          setDmAcceptedElsewhere({
            granterEmail: request.granterEmail,
            workspaceLabel: label,
          });
          keepAcceptedNoticeRef.current = true;
          void refreshDms();
        }
      } catch (error) {
        if (token !== liveToken.current) return;
        props.onError(
          ipcErrorMessage(
            error,
            "dohc could not add that conversation to a workspace.",
          ),
        );
      }
    },
    [openConversation, props.onError, props.workspaces, refreshDms, workspaceId],
  );

  const setDmRequestDeclined = useCallback(
    async (request: DmRequestRow, declined: boolean) => {
      if (dmRequestBusy !== null) return;
      const token = liveToken.current;
      setDmRequestBusy(request.shareId);
      try {
        const updateRequest = declined
          ? bridge().declineDm
          : bridge().requestDmAgain;
        await updateRequest({ shareId: request.shareId });
        if (token !== liveToken.current) return;
        await refreshDms();
      } catch (error) {
        if (token !== liveToken.current) return;
        props.onError(
          ipcErrorMessage(
            error,
            declined
              ? "dohc could not decline that message request."
              : "dohc could not move that message request back to requests.",
          ),
        );
      } finally {
        if (token === liveToken.current) setDmRequestBusy(null);
      }
    },
    [dmRequestBusy, props.onError, refreshDms],
  );

  const grantedByWire = useMemo(() => {
    const map = new Map<string, ChatChannelShareGrantRow[]>();
    for (const row of channelShares?.granted ?? []) {
      if (row.revokedAtMs !== null) continue;
      map.set(row.channelWireId, [...(map.get(row.channelWireId) ?? []), row]);
    }
    return map;
  }, [channelShares]);
  const receivedNotJoined = useMemo(() => {
    if (!channelShares) return [];
    // An ended row is a durable leave tombstone, not an active join. Keep its
    // invitation visible so Leave has an explicit reverse path; a successful
    // rejoin replaces the tombstone through mergeJoinedChannel.
    //
    // An invitation the joined lane did not answer for stays listed. Join is
    // a user-initiated action that main gates in full, so offering it once too
    // often costs a redundant click; hiding it would take away the only route
    // back into a channel this workspace left.
    const joinedIds = new Set<string>();
    for (const answer of channelShares.joined) {
      if (answer.joined && answer.joined.ended !== true) {
        joinedIds.add(answer.joined.shareId);
      }
    }
    return channelShares.received.filter((row) => !joinedIds.has(row.shareId));
  }, [channelShares]);
  const joinedFor = useCallback(
    (channel: ChatChannelRecord) =>
      channel.wireId ? joinedByWire.get(channel.wireId) ?? null : null,
    [joinedByWire],
  );
  const agentChannel =
    overview.status === "ready"
      ? overview.channels.find((channel) => channel.kind === "agent") ?? null
      : null;
  // Agents shared by other people that reach this workspace: an agent that posted in
  // a channel shared to the user belongs to whoever shared it. Derived from
  // the Home items already read, so it costs nothing and lists exactly the
  // agents whose work the user has seen arrive. Read-only: nothing here runs
  // or configures them.
  // Agents that speak only in a group's chat lane never enter Home, so the
  // Agents list also reads each joined group's chat lane. One page of the
  // lane per group, on the nav and after activity; a handful of calls.
  const [laneAgents, setLaneAgents] = useState<LaneAgent[]>([]);
  const laneAgentSeq = useRef(0);
  // What a lane said, by group, keyed on the lane's updated time. Message
  // facts only; the channel and the share are attached when the list is
  // assembled, so a renamed group or a re-issued share shows as it is now.
  const laneAgentCache = useRef(
    new Map<string, { updatedAtMs: number; spoke: Array<{ id: string; label: string; atMs: number }> }>(),
  );
  // The joined chat groups, as one string, so the read runs when that set
  // changes and not on every overview or share refresh.
  const joinedChatGroups = useMemo(() => {
    if (overview.status !== "ready") return [];
    return overview.channels.filter(
      (channel) =>
        typeof channel.wireId === "string" &&
        (channel.type === "chat" || channel.type === "both") &&
        joinedByWire.get(channel.wireId),
    );
  }, [joinedByWire, overview]);
  const joinedChatGroupsKey = joinedChatGroups.map((channel) => channel.id).join("\u0000");
  useEffect(() => {
    if (nav.level !== "channels") return;
    const token = liveToken.current;
    const seq = ++laneAgentSeq.current;
    const isCurrent = () => token === liveToken.current && seq === laneAgentSeq.current;
    if (joinedChatGroups.length === 0) {
      setLaneAgents([]);
      return;
    }
    void Promise.all(
      joinedChatGroups.map(async (channel): Promise<LaneAgent[]> => {
        const listed = await bridge().listChannelThreads({ workspaceId, channelId: channel.id, lane: "chat" });
        // The lane the group shows is its oldest chat thread, as ChatLane reads it.
        const lane = [...listed.threads].sort(
          (left, right) => left.createdAtMs - right.createdAtMs || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
        )[0];
        if (!lane) return [];
        const cached = laneAgentCache.current.get(channel.id);
        let spoke = cached && cached.updatedAtMs === lane.updatedAtMs ? cached.spoke : undefined;
        if (!spoke) {
          const page = await bridge().listChatMessages({ workspaceId, threadId: lane.id });
          spoke = page.messages
            .filter((message) => message.authorKind === "agent")
            .map((message) => ({
              id: message.authorUserId ?? message.authorDisplayName,
              label: chatAuthorLabel(message),
              atMs: message.createdAtMs,
            }));
          // An obsolete read must not seed the cache for a later hit.
          if (isCurrent()) laneAgentCache.current.set(channel.id, { updatedAtMs: lane.updatedAtMs, spoke });
        }
        const joined = joinedByWire.get(channel.wireId ?? "");
        const owner = joined?.granterEmail ?? "someone else";
        return spoke.map((who) => ({
          key: `${joined?.shareId ?? channel.id}\u0000${who.id}`,
          label: who.label,
          owner,
          channel,
          atMs: who.atMs,
        }));
      }),
    )
      .then((found) => {
        if (!isCurrent()) return;
        setLaneAgents(found.flat());
      })
      .catch(() => {
        // The lane read is a convenience for the list; Home's items still
        // name every agent that posts. A failed read leaves the list as is.
      });
    // The group list itself is read through its key, so a new overview
    // object with the same groups does not start another read.
  }, [joinedChatGroupsKey, joinedByWire, nav.level, props.threadRevision, workspaceId]);

  const otherAgents = useMemo(() => {
    const seen = new Map<string, { key: string; label: string; owner: string; atMs: number; fromFeed: boolean; open: () => void }>();
    for (const item of personalFeed) {
      if (item.message.authorKind !== "agent" || !item.channel?.wireId) continue;
      const joined = joinedByWire.get(item.channel.wireId);
      if (!joined) continue;
      const owner = joined.granterEmail ?? "someone else";
      const key = `${joined.shareId}\u0000${item.authorFollowTarget?.targetId ?? item.message.authorDisplayName}`;
      const known = seen.get(key);
      if (!known || known.atMs < item.message.createdAtMs) {
        const channel = item.channel;
        seen.set(key, {
          key,
          label: chatAuthorLabel(item.message),
          owner,
          atMs: item.message.createdAtMs,
          fromFeed: true,
          open: () =>
            openConversation({
              level: "thread",
              channel: { ...channel, wireId: channel.wireId, createdAtMs: 0, updatedAtMs: 0, threadCount: 0, unreadCount: 0 },
              thread: { ...item.thread, channelId: channel.id, messageCount: 0, lastReadSequence: 0, unreadCount: 0 },
              focusMessageId: item.message.id,
            }),
        });
      }
    }
    for (const agent of laneAgents) {
      const known = seen.get(agent.key);
      if (known && (known.fromFeed || known.atMs >= agent.atMs)) continue;
      seen.set(agent.key, {
        key: agent.key,
        label: agent.label,
        owner: agent.owner,
        atMs: agent.atMs,
        fromFeed: false,
        open: () => openConversation({ level: "channel", channel: agent.channel }),
      });
    }
    return [...seen.values()].sort((left, right) => left.label.localeCompare(right.label));
  }, [joinedByWire, laneAgents, openConversation, personalFeed]);

  // Cross-user co-presence for the open channel/thread turns on two decisions
  // per conversation — the SCOPE it lands in and the TOPIC both sides key on.
  //
  //  • SCOPE — where the presence lands on the relay. A PARTICIPANT viewing a
  //    channel shared TO them must publish into a SHARE scope keyed by their
  //    grant's shareId: the relay maps a {kind:"share"} request to the GRANTER's
  //    workspace, so the owner (workspace scope) and every participant (share
  //    scope) fan into one relay scope and see each other. An owner of a shared
  //    channel — and any plain local channel — uses the plain workspace scope.
  //
  //  • TOPIC — the per-conversation key both sides must agree on. A channel's
  //    LOCAL id differs across machines (a replicated channel gets a fresh local
  //    id), so channel presence keys on the cross-machine wireId instead — that
  //    unification is what lets owner + participant meet. The relay's share gate
  //    admits exactly the bare channel wireId as a chat-share presence topic
  //    (presenceTopicAllowedForShare), so the channel topic IS the wireId. For a
  //    plain local channel wireId === channel.id, so solo/owner presence is
  //    functionally unchanged. A thread keys on its own id (already cross-machine)
  //    so typing in one thread never bleeds into a sibling thread.
  //
  // A DIRECT MESSAGE is a kind:"dm" chat channel backed by a chat-channel
  // grant, so it folds into the same derivation: its TOPIC is the DM channel's
  // cross-machine wireId (channel-level co-presence — a DM has one running
  // thread, so this is the natural "who's here", and both participants agree on
  // the wireId), and its SCOPE is the grant's share scope for the PARTICIPANT
  // (who was shared to) or the plain workspace scope for the OWNER — exactly the
  // owner/participant convergence a joined channel uses.
  const activeDm = nav.level === "dm" ? nav.dm : null;
  const activeChannel =
    nav.level === "channel" || nav.level === "thread" ? nav.channel : null;
  const activeJoined = activeChannel ? joinedFor(activeChannel) : null;
  const activeWireId = activeChannel ? activeChannel.wireId ?? activeChannel.id : null;
  const presenceTopic =
    nav.level === "channel"
      ? activeWireId ?? ""
      : nav.level === "thread"
        ? `chat:thread:${nav.thread.id}`
        : nav.level === "dm"
          ? nav.dm.channelWireId
          : "";
  // The scope's stable identity for memoization: a joined channel pins to its
  // grant's shareId, a DM the viewer PARTICIPATES in pins to that DM grant's
  // shareId (both fan into the granter's workspace scope so both sides meet),
  // and everything the viewer owns — plain channels and owned DMs — pins to the
  // workspace. The transport is rebuilt only when this changes, so usePresence
  // re-creates its channel on a real scope switch (aborting the old poll — the
  // no-repaint invariant) and never churns on an unrelated re-render.
  const scopeShareId =
    activeJoined?.shareId ??
    (activeDm?.role === "participant" ? activeDm.shareId : null);
  const workspacePresenceTransport = useMemo(() => {
    if (!collaboration) return null;
    return collaboration.transportForScope({ kind: "workspace", workspaceId });
  }, [collaboration, workspaceId]);
  const presenceTransport = useMemo(() => {
    if (!collaboration) return null;
    if (!scopeShareId) return workspacePresenceTransport;
    const scope: PresenceScopeInput = {
      kind: "share",
      workspaceId,
      shareId: scopeShareId,
    };
    return collaboration.transportForScope(scope);
  }, [collaboration, scopeShareId, workspacePresenceTransport]);
  // Presence stays dormant until the scope is DEFINITIVELY resolved for the
  // active conversation in the current workspace: a joined channel's scope is
  // derived from channelShares, so publishing before that share state loads
  // would land a participant in their own workspace scope (convergence lost)
  // and a workspace switch could briefly publish under the previous workspace's
  // scope. Gating on (channelShares loaded for this workspaceId) closes both.
  const scopeResolved = sharesWorkspaceId === workspaceId;
  const presence = usePresence({
    enabled: collaboration !== null && presenceTopic !== "" && scopeResolved,
    transport: presenceTransport,
    topic: presenceTopic,
    clientId: collaboration?.clientId ?? "",
    displayName: collaboration?.displayName ?? "",
  });
  // Agent summary presence is workspace-private and deliberately independent
  // from the open conversation. It lets the overview row report the one
  // workspace runner while a task-specific thread keeps its own presence
  // scope. With no agent channel/collaboration this channel is never built.
  const agentSummaryPresence = usePresence({
    enabled:
      collaboration !== null && agentChannel !== null && scopeResolved,
    transport: workspacePresenceTransport,
    topic: CHAT_AGENT_PRESENCE_TOPIC,
    clientId: collaboration?.clientId ?? "",
    displayName: collaboration?.displayName ?? "",
  });
  const conversationAgentActivity = resolveAgentPresenceActivity(
    presence.others,
    workspaceId,
  );
  const agentSummaryActivity = resolveAgentPresenceActivity(
    agentSummaryPresence.others,
    workspaceId,
  );
  const reservedAgentClientId = agentPresenceClientId(workspaceId);
  const peoplePresence = useMemo(
    () =>
      presence.others.filter((peer) => peer.clientId !== reservedAgentClientId),
    [presence.others, reservedAgentClientId],
  );

  const refreshShares = useCallback(async () => {
    // This reader has no channel list of its own, and the joined lane answers
    // what a caller NAMES. While the overview is unresolved there is nothing
    // to name, and asking anyway would claim the lane with an answer covering
    // no channel — every channel then reads unanswered, which locks it, and
    // the overview's own fully-scoped answer is refused for being older.
    //
    // refreshOverview is the reader that knows: it reads the channel list
    // first and then asks about exactly those channels. Background, because
    // nobody asked for this refresh and it must not bump liveToken under an
    // in-flight navigation.
    const shown = latestShownWireIds.current;
    if (shown === null) {
      await refreshOverview({ background: true });
      return;
    }
    const ticket = takeCommitTicket();
    const session = sessionGeneration.current;
    const shares = await bridge()
      .listChatChannelShares({ workspaceId, channelWireIds: shown })
      .catch(() => null);
    // Deliberately not liveToken-guarded: the share listing is
    // workspace-scoped, not conversation-scoped, so navigating into a
    // channel must not discard a session refresh's answer. A workspace
    // switch bumps sessionGeneration, and the commit point refuses the
    // stale response there.
    commitShareListing(ticket, session, shares);
  }, [commitShareListing, refreshOverview, takeCommitTicket, workspaceId]);

  // A cloud session transition re-scopes the relay-backed share rows: the
  // granted/received lanes belong to the signed-in account. The generic
  // activity ping only reaches the badge path, which deliberately never asks
  // the relay — so the session signal runs the full listing, whose signed-out
  // answer clears the previous account's rows without any manual refresh.
  useEffect(() => {
    return bridge().onCloudSessionChanged(({ sessionKey, phase }) => {
      // A rotation within the same session — same server, relay, and user;
      // the key deliberately excludes the token — invalidates nothing: the
      // rows stay (an outage during rotation must not hide them), in-flight
      // reads stay valid, and the refresh below simply reloads.
      const current = latestChannelShares.current;
      const changed = current === null || current.sessionKey !== sessionKey;
      if (changed) {
        // Everything issued under the previous session is now stale: a read
        // still in flight must not land the old account's rows after the
        // clear below.
        sessionGeneration.current += 1;
        // And the previous session's rows leave the screen now, not when
        // the next listing resolves — a stalled relay would otherwise keep
        // showing another account's invitations and emails indefinitely.
        // The joined rows stay: they are local, and channelIsLocked depends
        // on them.
        setChannelShares((state) =>
          state === null
            ? state
            : { ...state, granted: [], received: [], sessionKey },
        );
        // The failure is account-scoped too, and it is a PERSISTENT claim
        // rather than a transient one: an over-limit answer names the previous
        // account's share counts, and leaving it up would show them under the
        // new account for as long as its own listing takes to arrive — or for
        // good, if that listing stalls. It goes with the rows it explains.
        setShareReadFailure(null);
        setDms([]);
        setDmAvailable(false);
        setPendingDmRequests([]);
        setDeclinedDmRequests([]);
        setAcceptingDmRequest(null);
        setDmRequestBusy(null);
        setDmAcceptedElsewhere(null);
        setNav((state) =>
          state.level === "dm" ? { level: "channels" } : state,
        );
        setMessages([]);
        setMessagesLoading(false);
        setReactions([]);
        setViewerAuthorId("");
        setComposer("");
        void refreshDms();
        void refreshShares();
        return;
      }
      // Same key, two moments. The changing phase refreshes nothing:
      // mid-transition the credential cache is deliberately empty, and a
      // listing issued now answers an authoritative signed-out that would
      // clear the very rows the same-key rule preserved. The ready phase is
      // adoption end — the one revalidation, now against the settled
      // session, so invitations and revocations from during the reauth
      // land.
      if (phase === "ready") void refreshShares();
    });
  }, [refreshDms, refreshShares]);

  const submitShare = useCallback(async () => {
    // The disabled control is honesty; this is the gate. A submit that slips
    // past it (a stale enter key, a re-render race) would still grow the lane
    // dohc already cannot list. Only the granted lane, though — an outgoing
    // share never touches the received one.
    if (grantedLaneIsOverLimit(shareReadFailure)) return;
    if (nav.level !== "channel" || shareBusy) return;
    const recipientEmail = shareEmail.trim();
    if (recipientEmail.length === 0) return;
    const token = liveToken.current;
    setShareBusy(true);
    try {
      await bridge().shareChatChannel({
        workspaceId,
        channelId: nav.channel.id,
        recipientEmail,
        ...(shareReadOnly ? { access: "read-only" as const } : {}),
      });
      if (token !== liveToken.current) return;
      setShareEmail("");
      setShareReadOnly(false);
      await refreshShares();
    } catch (error) {
      if (token !== liveToken.current) return;
      props.onError(ipcErrorMessage(error, "Could not share that channel."));
    } finally {
      setShareBusy(false);
    }
  }, [
    nav,
    props.onError,
    refreshShares,
    shareBusy,
    shareEmail,
    shareReadFailure,
    shareReadOnly,
    workspaceId,
  ]);

  const revokeShare = useCallback(
    async (shareId: string) => {
      const token = liveToken.current;
      const session = sessionGeneration.current;
      try {
        await bridge().revokeRelayShare({ shareId });
        if (token !== liveToken.current) return;
        // The revocation landed, so apply it to the cached relay lane before
        // asking the relay to confirm it. The follow-up listing can resolve
        // unreachable, and the keep-cached rule would otherwise keep showing
        // the removed person with a live Remove button. A local action takes
        // its own ticket, so a listing issued before the revoke cannot put
        // the row back; the refresh below is newer still and lands normally.
        //
        // Only under the session it started in: a revoke finishing after a
        // switch would otherwise claim a new ticket in the new session's
        // commit order and reject that session's own in-flight answer.
        if (
          session === sessionGeneration.current &&
          claimLanes(["relayShares"], takeCommitTicket())
        ) {
          const revokedAtMs = Date.now();
          setChannelShares((current) =>
            current === null
              ? current
              : {
                  ...current,
                  granted: current.granted.map((row) =>
                    row.shareId === shareId && row.revokedAtMs === null
                      ? { ...row, revokedAtMs }
                      : row,
                  ),
                },
          );
        }
        await refreshShares();
      } catch (error) {
        if (token !== liveToken.current) return;
        props.onError(ipcErrorMessage(error, "Could not remove that person."));
      }
    },
    [claimLanes, props.onError, refreshShares, takeCommitTicket],
  );

  const joinShared = useCallback(
    async (shareId: string) => {
      if (joiningShareId !== null) return;
      const token = liveToken.current;
      setJoiningShareId(shareId);
      try {
        await bridge().joinSharedChannel({ workspaceId, shareId });
        if (token !== liveToken.current) return;
        await refreshOverview();
      } catch (error) {
        if (token !== liveToken.current) return;
        props.onError(ipcErrorMessage(error, "Could not join that channel."));
      } finally {
        // Unconditional reset (the sendingRef/startingThreadRef precedent):
        // refreshOverview bumps liveToken itself, so a token-equality check
        // here can never pass after a successful join and would leave every
        // other Join button dead for the session. A workspace switch already
        // clears joiningShareId in its own effect, so resetting late is
        // harmless there.
        setJoiningShareId(null);
      }
    },
    [joiningShareId, props.onError, refreshOverview, workspaceId],
  );

  const leaveShared = useCallback(
    async (shareId: string) => {
      const token = liveToken.current;
      try {
        await bridge().leaveSharedChannel({ workspaceId, shareId });
        if (token !== liveToken.current) return;
        // The completion is the user's command landing (see openConversation).
        props.onNavCommand?.({ level: "channels" });
        setNav({ level: "channels" });
        await refreshOverview();
      } catch (error) {
        if (token !== liveToken.current) return;
        props.onError(ipcErrorMessage(error, "Could not leave that channel."));
      }
    },
    [props.onError, props.onNavCommand, refreshOverview, workspaceId],
  );

  // Which lane a "both" group shows.
  const [groupLane, setGroupLane] = useState<"posts" | "chat">("posts");
  const createChannel = useCallback(
    async (name: string) => {
      const trimmed = name.trim();
      if (trimmed.length === 0) return;
      const token = liveToken.current;
      try {
        const purpose = newGroupPurpose.trim();
        const result = await bridge().createChatChannel({
          workspaceId,
          name: trimmed,
          type: newGroupType,
          ...(purpose ? { purpose } : {}),
        });
        if (token !== liveToken.current) return;
        resetGroupForm();
        setOverview((current) =>
          current.status === "ready"
            ? { ...current, channels: [...current.channels, result.channel] }
            : current,
        );
        // In the same update that shows the channel: a channel on screen with
        // no answer in the lane is a locked channel. Registered as answered
        // locally, so the read already in flight — issued before this channel
        // existed, and therefore evicting to a view without it — keeps it.
        if (result.channel.wireId) {
          answerLocally(joinedOrder.current, workspaceId, result.channel.wireId);
        }
        setChannelShares((current) => answerCreatedChannel(current, result.channel));
        // The new group opens where any click on it would.
        openConversation({ level: "channel", channel: result.channel });
      } catch (error) {
        if (token !== liveToken.current) return;
        props.onError(ipcErrorMessage(error, "Could not create that channel."));
      }
    },
    [newGroupPurpose, newGroupType, resetGroupForm, openConversation, props.onError, workspaceId],
  );

  const goBack = useCallback(() => {
    // Back is an explicit command like any conversation click: report it
    // synchronously through the same seam, so a DM answer queued in this
    // tick cannot pass its isCurrent() check and remount over the place the
    // user just went back to. Every BackHeader (and the keyboard shortcut)
    // routes through here.
    props.onNavCommand?.(
      nav.level === "thread"
        ? { level: "channel", channel: nav.channel }
        : { level: "channels" },
    );
    liveToken.current += 1;
    if (nav.level === "thread") {
      // Re-open the channel so thread ordering/badges reflect what happened
      // inside the thread.
      void openChannel(nav.channel);
    } else if (nav.level === "channel" || nav.level === "feed") {
      setNav({ level: "channels" });
      setChannelThreads([]);
      setFeedPosts({});
      // Home's rows stay: the nav lists agents shared by other people from them, and
      // opening Home again reloads them before it paints.
      void refreshOverview();
    } else if (nav.level === "dm" || nav.level === "dm-new") {
      setNav({ level: "channels" });
      setMessages([]);
      setComposer("");
      // Drop the compose draft/recipients so reopening "New message" never
      // shows a stale, unrelated "To:" that could misdirect the next send.
      setDmRecipients("");
      setDmDraft("");
      void refreshDms();
    }
  }, [nav, openChannel, props.onNavCommand, refreshDms, refreshOverview]);

  // Ends the DM's registry row through the exact leaveSharedChannel mechanism.
  // The conversation drops out of `dms` immediately; the next
  // syncDms poll's classifyDmRequests puts it back in the request lane
  // because no workspace holds a live row for its shareId anymore. Routes
  // through goBack for its nav + composer-draft cleanup: without
  // it, the next DM opened after leaving could show this one's unsent draft,
  // and Send could reach the wrong person.
  const leaveDmConversation = useCallback(
    async (dm: DmRecord) => {
      const shareId = dm.shareId;
      // The belt effect above already closes the dialog the moment the
      // record it was opened for loses connected; this
      // is the same guard at the one call site that can reach here, closing
      // the last sliver of a click/effect race. sendingRef mirrors this
      // DM's own send state the same way the confirm button's disabled prop
      // does — the dialog only ever opens for the
      // currently-viewed DM, so it IS this DM's in-flight state.
      if (!shareId || !dm.connected || sendingRef.current) return;
      const token = liveToken.current;
      try {
        // Presence leave before the row ends: once leaveDm ends
        // the share, this DM's presence scope rejects further publish/leave
        // calls (the same ended-grant gate messages use), so the effect
        // cleanup's later best-effort leave would be rejected and peers would
        // read this client as present until the relay's presence TTL.
        await presence.leave();
        await bridge().leaveDm({ workspaceId, shareId });
        if (token !== liveToken.current) return;
        setLeavingDm(null);
        setDms((current) =>
          current.filter((candidate) => candidate.channelId !== dm.channelId),
        );
        goBack();
      } catch (error) {
        if (token !== liveToken.current) return;
        // Re-arm presence: if leaveDm rejected, the row
        // never ended and this conversation stays open, but presence.leave()
        // already stopped the channel — without this the client goes
        // invisible to peers until it navigates away and back.
        presence.restart();
        props.onError(
          ipcErrorMessage(error, "dohc could not leave that conversation. Try again."),
        );
      }
    },
    [goBack, presence.leave, presence.restart, props.onError, workspaceId],
  );

  const reactionsByMessage = useMemo(() => {
    const result = new Map<string, ChatReactionRecord[]>();
    for (const reaction of reactions) {
      const current = result.get(reaction.messageId);
      if (current) current.push(reaction);
      else result.set(reaction.messageId, [reaction]);
    }
    return result;
  }, [reactions]);

  // Memoized reaction controls: an inline object literal would change
  // identity on every keystroke and defeat the message-list memo boundaries.
  // The DM and thread surfaces render mutually exclusively, so one object
  // serves both; readOnly is derived first so the memo keys on a boolean,
  // not the whole nav object.
  const threadLocked = nav.level === "thread" && channelIsLocked(nav.channel);
  const reactionReadOnly =
    nav.level === "dm" ? !nav.dm.connected : threadLocked;
  const reactionControls = useMemo<ChatReactionControls>(
    () => ({
      reactions,
      viewerAuthorId,
      onToggle: toggleReaction,
      readOnly: reactionReadOnly,
    }),
    [reactions, reactionReadOnly, toggleReaction, viewerAuthorId],
  );

  const decisionsByMessage = useMemo(
    () => new Map(decisions.map((decision) => [decision.messageId, decision])),
    [decisions],
  );

  const attachmentsByMessage = useMemo(() => {
    const result = new Map<string, ChatAttachmentRecord[]>();
    const seen = new Set<string>();
    const add = (attachment: ChatAttachmentRecord) => {
      if (seen.has(attachment.attachmentId)) return;
      seen.add(attachment.attachmentId);
      const current = result.get(attachment.messageId);
      if (current) current.push(attachment);
      else result.set(attachment.messageId, [attachment]);
    };
    for (const attachment of attachments) add(attachment);
    for (const message of messages) {
      for (const attachment of message.attachments ?? []) add(attachment);
    }
    return result;
  }, [attachments, messages]);

  const scrollToMessage = useCallback((messageId: string) => {
    const node = messageNodes.current.get(messageId);
    if (flatChatListRef.current) {
      if (!flatChatListRef.current.scrollToMessage(messageId)) return;
    } else {
      if (!node) return;
      node.scrollIntoView({ block: "center" });
    }
    setFlashMessageId(messageId);
    const token = liveToken.current;
    window.setTimeout(() => {
      if (token === liveToken.current) {
        setFlashMessageId((current) => (current === messageId ? null : current));
      }
    }, 1_200);
  }, []);

  useEffect(() => {
    const focusMessageId =
      nav.level === "thread" || nav.level === "dm" ? nav.focusMessageId : undefined;
    const conversationId =
      nav.level === "thread"
        ? nav.thread.id
        : nav.level === "dm"
          ? nav.dm.threadId
          : undefined;
    if (
      !focusMessageId ||
      !conversationId ||
      messagesLoading ||
      !messages.some((message) => message.id === focusMessageId)
    ) {
      return;
    }
    const jumpKey = `${conversationId}:${focusMessageId}`;
    if (focusedMessageJump.current === jumpKey) return;
    focusedMessageJump.current = jumpKey;
    const frame = requestAnimationFrame(() => scrollToMessage(focusMessageId));
    return () => cancelAnimationFrame(frame);
  }, [messages, messagesLoading, nav, scrollToMessage]);

  const beginReply = useCallback((message: ChatMessageRecord) => {
    setReplyTarget({
      messageId: message.id,
      authorLabel: chatAuthorLabel(message),
    });
  }, []);

  const beginResolve = useCallback((message: ChatMessageRecord, option?: string) => {
    setResolveTargetMessageId(message.id);
    setResolveChosenOption(option ?? null);
    // A resolving message is also an explicit reply to the decision-bearing
    // message, preserving both pieces of causal structure in one send.
    setReplyTarget({
      messageId: message.id,
      authorLabel: chatAuthorLabel(message),
    });
  }, []);

  const stopThreadRun = useCallback(async () => {
    if (
      nav.level !== "thread" ||
      dispatchState.liveRunId === null ||
      dispatchActionBusy
    ) {
      return;
    }
    const token = liveToken.current;
    const refreshSeq = ++threadRefreshSeq.current;
    const threadId = nav.thread.id;
    setDispatchActionBusy(true);
    try {
      await bridge().stopAgentRun({
        workspaceId,
        runId: dispatchState.liveRunId,
      });
      const next = await bridge().chatDispatchStateForThread({
        workspaceId,
        threadId,
      });
      if (
        token !== liveToken.current ||
        refreshSeq !== threadRefreshSeq.current
      ) {
        return;
      }
      setDispatchState(next);
    } catch (error) {
      if (
        token !== liveToken.current ||
        refreshSeq !== threadRefreshSeq.current
      ) {
        return;
      }
      props.onError(ipcErrorMessage(error, "Could not stop this agent run."));
    } finally {
      if (token === liveToken.current) setDispatchActionBusy(false);
    }
  }, [dispatchActionBusy, dispatchState.liveRunId, nav, props.onError, workspaceId]);

  const resumeThreadDispatch = useCallback(async () => {
    if (nav.level !== "thread" || !dispatchState.paused || dispatchActionBusy) {
      return;
    }
    const token = liveToken.current;
    const refreshSeq = ++threadRefreshSeq.current;
    const threadId = nav.thread.id;
    setDispatchActionBusy(true);
    try {
      await bridge().resumeThreadDispatch({ workspaceId, threadId });
      const next = await bridge().chatDispatchStateForThread({
        workspaceId,
        threadId,
      });
      if (
        token !== liveToken.current ||
        refreshSeq !== threadRefreshSeq.current
      ) {
        return;
      }
      setDispatchState(next);
    } catch (error) {
      if (
        token !== liveToken.current ||
        refreshSeq !== threadRefreshSeq.current
      ) {
        return;
      }
      props.onError(ipcErrorMessage(error, "Could not resume dispatch."));
    } finally {
      if (token === liveToken.current) setDispatchActionBusy(false);
    }
  }, [dispatchActionBusy, dispatchState.paused, nav, props.onError, workspaceId]);

  // Escape walks back up one level — but never steals Escape from a composer
  // holding a draft (that Escape reads as "leave my text alone").
  const onKeyDownCapture = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-chat-escape-local='true']")) return;
      if (
        target instanceof HTMLTextAreaElement &&
        nav.level === "thread" &&
        (replyTarget !== null || resolveTargetMessageId !== null)
      ) {
        return;
      }
      if (
        (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) &&
        target.value.trim().length > 0
      ) {
        return;
      }
      if (nav.level === "channels") return;
      event.stopPropagation();
      goBack();
    },
    [goBack, nav.level, replyTarget, resolveTargetMessageId],
  );

  if (overview.status === "loading") {
    return (
      <div className="flex flex-1 items-center justify-center px-4 text-xs text-subtle">
        Loading Chats...
      </div>
    );
  }

  if (overview.status === "unavailable") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
        <span className="text-xs text-danger">{overview.message}</span>
        <button
          type="button"
          onClick={() => void refreshOverview()}
          className="h-7 cursor-pointer rounded-md border border-line px-2 text-[11px] text-muted hover:bg-line/50 hover:text-ink"
        >
          Try again
        </button>
      </div>
    );
  }

  if (nav.level === "feed") {
    return (
      <div
        data-testid="chats-personal-feed"
        data-variant={variant}
        className="flex min-h-0 flex-1 flex-col"
        onKeyDownCapture={onKeyDownCapture}
      >
        <BackHeader
          label="Home"
          testId="chats-feed"
          onBack={goBack}
          icon={<House size={12} aria-hidden className="shrink-0 text-subtle" />}
        />
        <PostFeedList
          key={`${workspaceId}:home`}
          items={personalFeed}
          itemKey={(item) => item.message.id}
          columnClassName={pageColumn}
          header={<>
            {personalFeed.length === 0 && !personalFeedLoading ? (
              <div className="flex flex-col items-center gap-2 py-10 text-[13px] text-subtle">
                <p className="m-0">Nothing new yet</p>
                <button
                  type="button"
                  data-testid="chats-feed-empty-groups"
                  onClick={goBack}
                  className="rounded-md px-2 py-1 text-[13px] text-muted hover:bg-panel-2 hover:text-ink dohc-focus-visible"
                >
                  Open Groups
                </button>
              </div>
            ) : null}
          </>}
          footer={<>
            {personalFeedLoading ? (
              <p className="py-5 text-center text-[11px] text-subtle">Loading…</p>
            ) : null}
            {personalFeedNextCursor && !personalFeedLoading ? (
              <button
                type="button"
                data-testid="chats-feed-more"
                onClick={() => void loadPersonalFeed(personalFeedNextCursor)}
                className="mt-4 h-8 w-full rounded-md border border-line text-[11px] text-muted hover:bg-line/40 hover:text-ink"
              >
                Load older
              </button>
            ) : null}
          </>}
          renderItem={(item) => {
                const fileThread = item.channel
                  ? null
                  : overview.fileThreads.find((thread) => thread.id === item.thread.id) ?? {
                      ...item.thread,
                      path: null,
                    };
                const feedDm =
                  item.channel?.kind === "dm"
                    ? dms.find((dm) => dm.channelId === item.channel?.id)
                    : undefined;
                const isComment = item.openingMessage
                  ? item.openingMessage.id !== item.message.id
                  : item.message.parentMessageId !== undefined;
                const bookmarkTarget = isComment
                  ? { kind: "message" as const, threadId: item.thread.id, messageId: item.message.id }
                  : { kind: "thread" as const, threadId: item.thread.id };
                const bookmarkId = isComment ? item.message.id : item.thread.id;
                const bookmark = bookmarkFor(bookmarkTarget.kind, bookmarkId);
                const bookmarkKey = `${bookmarkTarget.kind}:${bookmarkId}`;
                // Same authority as the channel view: an unresolved or
                // unanswered share listing fails closed, so Home never offers
                // a write the channel would refuse.
                const locked = item.channel
                  ? channelIsLocked({
                      ...item.channel,
                      wireId: item.channel.wireId,
                      createdAtMs: 0,
                      updatedAtMs: 0,
                      threadCount: 0,
                      unreadCount: 0,
                    })
                  : false;
                const hasFileMentions = extractChatFileReferences(item.message.body).length > 0;
                const isAgent = item.message.authorKind === "agent";
                const time = formatChatTime(item.message.createdAtMs);
                const itemReactions = item.reactions.filter(
                  (reaction) => reaction.messageId === item.message.id,
                );
                const byEmoji = new Map<string, number>();
                for (const reaction of itemReactions) {
                  byEmoji.set(reaction.emoji, (byEmoji.get(reaction.emoji) ?? 0) + 1);
                }
                const itemViewer = item.viewerAuthorId ?? "";
                const liked =
                  itemViewer !== "" &&
                  itemReactions.some(
                    (reaction) =>
                      reaction.emoji === LIKE_EMOJI && reaction.authorId === itemViewer,
                  );
                const where = item.channel
                  ? item.channel.kind === "dm"
                    ? feedDm?.peerLabel ?? item.channel.name
                    : item.channel.kind === "agent"
                      ? "Agent"
                      : `#${item.channel.name}`
                  : fileThread?.path
                    ? basenameOf(fileThread.path)
                    : item.thread.title;
                const open = () => {
                  if (!item.channel) {
                    props.onOpenFileChat(fileThread!, item.message.id);
                    return;
                  }
                  if (feedDm) {
                    openConversation({
                      level: "dm",
                      dm: feedDm,
                      focusMessageId: item.message.id,
                    });
                    return;
                  }
                  openConversation({
                    level: "thread",
                    channel: {
                      ...item.channel,
                      wireId: item.channel.wireId,
                      createdAtMs: 0,
                      updatedAtMs: 0,
                      threadCount: 0,
                      unreadCount: 0,
                    },
                    thread: {
                      ...item.thread,
                      channelId: item.channel.id,
                      messageCount: 0,
                      lastReadSequence: 0,
                      unreadCount: 0,
                    },
                    focusMessageId: item.message.id,
                  });
                };
                const body = (
                  <span className="mt-2 block whitespace-pre-wrap break-words text-[14px] leading-relaxed text-ink">
                    <MentionText
                      body={item.message.body}
                      candidates={mentionCandidates}
                      attachments={item.message.attachments}
                      onOpenPath={hasFileMentions ? props.onOpenPath : undefined}
                    />
                  </span>
                );
                return (
                  <div
                    key={item.message.id}
                    data-testid="chats-feed-item"
                    data-author-kind={item.message.authorKind}
                    className="group @container rounded-xl border border-line bg-panel px-4 pb-1 pt-3.5"
                  >
                    <button
                      type="button"
                      onClick={open}
                      className="block w-full cursor-pointer text-left dohc-focus-visible"
                    >
                      <span className="flex items-center gap-2.5">
                        <ChatAvatar
                          name={item.message.authorDisplayName}
                          kind={isAgent ? "agent" : "human"}
                        />
                        <span className="flex min-w-0 flex-1 flex-col leading-tight">
                          <span
                            className={`truncate text-[14px] font-semibold ${
                              isAgent ? "text-agent" : "text-ink"
                            }`}
                          >
                            {chatAuthorLabel(item.message)}
                          </span>
                          <span className="flex items-center gap-1.5 text-[12px] text-subtle">
                            <span className="truncate font-mono text-[11px]">{where}</span>
                            <span aria-hidden>·</span>
                            <time dateTime={time.iso} title={time.iso} className="shrink-0">
                              {time.label}
                            </time>
                          </span>
                        </span>
                      </span>
                      {isComment ? (
                        <span className="mt-2.5 flex items-center gap-1.5 text-[12px] text-muted">
                          <MessageSquare size={12} aria-hidden className="shrink-0" />
                          <span className="truncate">{item.thread.title}</span>
                        </span>
                      ) : null}
                      {hasFileMentions ? null : body}
                    </button>
                    {hasFileMentions ? body : null}
                    {byEmoji.size > 0 ? (
                      <div
                        data-testid="chats-feed-item-footer"
                        className="mt-2.5 flex items-center gap-1.5 py-1.5 text-[12px] text-subtle"
                      >
                        {[...byEmoji.entries()].map(([emoji, count]) => (
                          <span
                            key={emoji}
                            data-testid="chats-feed-reaction-pill"
                            data-emoji={emoji}
                            className="inline-flex items-center gap-1 rounded-full border border-line bg-bg px-1.5 text-[11px] leading-5 text-muted"
                          >
                            <span aria-hidden>{emoji}</span>
                            <span className="tabular-nums">{count}</span>
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="block h-2.5" />
                    )}
                    <div className="flex items-stretch border-t border-line">
                      <ActionButton
                        testId="chats-feed-like"
                        label="Like"
                        disabled={locked}
                        icon={<SmilePlus size={15} strokeWidth={1.9} aria-hidden />}
                        active={liked}
                        onClick={() => toggleHomeReaction(item.thread.id, item.message.id, liked)}
                      />
                      <ActionButton
                        label={isComment ? "Reply" : "Comment"}
                        icon={<MessageSquare size={15} strokeWidth={1.9} aria-hidden />}
                        onClick={open}
                      />
                      <SaveAsFileActions
                        testIdPrefix="chats-feed-bookmark"
                        bookmark={bookmark}
                        busy={bookmarkBusy.has(bookmarkKey)}
                        onToggle={(mode) =>
                          void toggleBookmark({
                            target: bookmarkTarget,
                            mode,
                          })
                        }
                        onOpen={
                          bookmark && props.onOpenPath
                            ? () => props.onOpenPath?.(bookmark.destinationPath)
                            : undefined
                        }
                      />
                    </div>
                  </div>
                );

          }}
        />
      </div>
    );
  }

  if (nav.level === "dm-new") {
    return (
      <div
        data-testid="chats-dm-new"
        data-variant={variant}
        className="flex min-h-0 flex-1 flex-col"
        onKeyDownCapture={onKeyDownCapture}
      >
        <BackHeader
          label="New message"
          testId="chats-dm-new"
          onBack={goBack}
          icon={<AtSign size={12} aria-hidden className="shrink-0 text-subtle" />}
        />
        <div className={`flex min-h-0 flex-1 flex-col ${pageColumn}`}>
          <div className="flex flex-col gap-1 border-b border-line p-2">
            <label className="sr-only" htmlFor="chats-dm-recipients">
              To
            </label>
            <input
              id="chats-dm-recipients"
              data-testid="chats-dm-recipients"
              autoFocus
              value={dmRecipients}
              placeholder="To: email@example.com"
              onChange={(event) => setDmRecipients(event.target.value)}
              className="h-7 w-full rounded-md border border-line bg-bg px-2 text-[13px] text-ink placeholder:text-subtle dohc-focus-input"
            />
            <p className="m-0 px-1 text-[10px] leading-4 text-subtle">
              Separate several people with commas. They&apos;ll see the conversation on
              their next sync.
            </p>
          </div>
          <div className="min-h-0 flex-1" />
          <MentionComposer
            testIdPrefix="chats-dm-new"
            composerId="chats-dm-new-composer"
            value={dmDraft}
            sending={startingDm}
            placeholder="Write the first message…"
            sendLabel="Start conversation"
            candidates={mentionCandidates}
            fileCandidates={fileMentionCandidates}
            loadFileHeadings={loadFileHeadings}
            onChange={setDmDraft}
            onSend={() => void startDm()}
          />
        </div>
      </div>
    );
  }

  if (nav.level === "dm") {
    const dm = nav.dm;
    return (
      <div
        data-testid="chats-dm-view"
        data-variant={variant}
        className="flex min-h-0 flex-1 flex-col"
        onKeyDownCapture={onKeyDownCapture}
      >
        <BackHeader
          label={dm.peerLabel}
          testId="chats-dm"
          onBack={goBack}
          icon={<AtSign size={12} aria-hidden className="shrink-0 text-subtle" />}
          // A connected participant (shareId set, not already ended) has a
          // live placement to reverse; the owner side (shareId null)
          // never accepted a grant here, and an already-ended row (owner
          // revoked, or already left) has nothing live to end — confirming
          // would re-end a tombstone and promise a request that, for an
          // owner-revoked grant, can never appear (its grant is gone from
          // the relay's received listing).
          action={
            dm.shareId && dm.connected ? (
              <button
                type="button"
                data-testid="chats-dm-leave"
                onClick={() => setLeavingDm(dm)}
                className="h-6 shrink-0 cursor-pointer rounded border border-line px-1.5 text-[10px] text-muted hover:bg-line/50 hover:text-ink"
              >
                Leave
              </button>
            ) : undefined
          }
          trailing={<PresenceFaces others={presence.others} />}
        />
        {/* Presence (MU-C1): "viewing" faces + "typing…" for this DM, keyed by
            its channelWireId and fanned out through the same shareForRecipient
            grant gate. Dormant (calm header, no fake liveness) when solo. */}
        <div className={`flex min-h-0 flex-1 flex-col ${pageColumn}`}>
          {dm.threadId ? (
            <ChatMessageList
              testIdPrefix="chats-dm"
              messages={messages}
              loading={messagesLoading}
              emptyLabel="No messages yet."
              key={`${workspaceId}:${dm.threadId}`}
              listRef={flatChatListRef}
              mentionCandidates={mentionCandidates}
              onOpenPath={props.onOpenPath}
              flashMessageId={flashMessageId}
              reactionControls={reactionControls}
            />
          ) : (
            <div
              data-testid="chats-dm-waiting"
              className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-[11px] text-subtle"
            >
              Waiting for this conversation to sync…
            </div>
          )}
          <TypingIndicator names={presence.typingNames} className="px-2" />
          {dm.connected ? (
            <MentionComposer
              testIdPrefix="chats-dm"
              composerId="chats-dm-composer"
              value={composer}
              sending={sending || !dm.threadId}
              placeholder={`Message ${dm.peerLabel}…`}
              sendLabel="Send message"
              candidates={mentionCandidates}
              fileCandidates={fileMentionCandidates}
              loadFileHeadings={loadFileHeadings}
              onChange={(value) => {
                setComposer(value);
                presence.setTyping(value.trim().length > 0);
              }}
              onSend={() => {
                presence.setTyping(false);
                void sendDmMessage();
              }}
            />
          ) : (
            <ComposerNotice testId="chats-dm-ended">
              This conversation has ended. You can still read it.
            </ComposerNotice>
          )}
        </div>
        {leavingDm ? (
          <LeaveDmDialog
            key={leavingDm.channelId}
            dm={leavingDm}
            workspaceLabel={
              props.workspaces.find((candidate) => candidate.workspaceId === workspaceId)
                ?.label ?? workspaceId
            }
            // The dialog only ever opens for the currently-viewed DM (the
            // P2-D belt enforces this), so `sending` — already scoped to the
            // active send context — IS this DM's own in-flight state.
            sendInFlight={sending}
            onConfirm={() => leaveDmConversation(leavingDm)}
            onClose={() => setLeavingDm(null)}
          />
        ) : null}
      </div>
    );
  }

  if (nav.level === "thread") {
    const threadJoined = joinedFor(nav.channel);
    const threadBookmark = bookmarkFor("thread", nav.thread.id);
    const threadBookmarkKey = `thread:${nav.thread.id}`;
    return (
      <div
        data-testid="chats-thread-view"
        data-variant={variant}
        data-open-decision-count={
          channelThreads.find((thread) => thread.id === nav.thread.id)
            ?.openDecisionCount ?? 0
        }
        className="flex min-h-0 flex-1 flex-col"
        onKeyDownCapture={onKeyDownCapture}
      >
        <BackHeader
          label={nav.thread.title}
          testId="chats-thread"
          onBack={goBack}
          action={
            <span className="inline-flex items-center gap-1">
              <BookmarkAction
                active={Boolean(threadBookmark)}
                busy={bookmarkBusy.has(threadBookmarkKey)}
                destinationPath={threadBookmark?.destinationPath}
                onToggle={
                  threadLocked
                    ? undefined
                    : (mode) =>
                        void toggleBookmark({
                          target: { kind: "thread", threadId: nav.thread.id },
                          mode,
                        })
                }
                onOpen={
                  threadBookmark && props.onOpenPath
                    ? () => props.onOpenPath?.(threadBookmark.destinationPath)
                    : undefined
                }
                testId="chats-thread-bookmark"
              />
              {!threadLocked && dispatchState.liveRunId !== null ? (
                <button
                  type="button"
                  data-testid="chats-stop-agent-run"
                  aria-label="Stop agent run"
                  title="Stop agent run"
                  disabled={dispatchActionBusy}
                  onClick={() => void stopThreadRun()}
                  className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-line px-1.5 font-mono text-[10px] text-muted hover:bg-line/50 hover:text-ink dohc-focus-visible disabled:cursor-default disabled:opacity-50"
                >
                  <Square size={8} fill="currentColor" aria-hidden />
                  Stop
                </button>
              ) : null}
            </span>
          }
          trailing={
            <>
              {nav.channel.kind === "agent" ? (
                <AgentPresenceHint
                  activity={conversationAgentActivity}
                  testId="chats-thread-agent-presence"
                />
              ) : null}
              <PresenceFaces
                others={nav.channel.kind === "agent" ? peoplePresence : presence.others}
              />
            </>
          }
        />
        {dispatchState.paused ? (
          <div
            data-testid="chats-dispatch-status"
            title={dispatchState.pausedReason}
            className="flex h-7 shrink-0 items-center justify-center gap-1 border-b border-line bg-panel-2/35 px-3 font-mono text-[10px] text-subtle"
          >
            <span>dispatch paused — </span>
            {!threadLocked ? (
              <button
                type="button"
                data-testid="chats-resume-dispatch"
                disabled={dispatchActionBusy}
                onClick={() => void resumeThreadDispatch()}
                className="rounded px-1 text-muted underline decoration-line underline-offset-2 hover:text-ink dohc-focus-visible disabled:cursor-default disabled:opacity-50"
              >
                Resume
              </button>
            ) : (
              <span>read-only</span>
            )}
          </div>
        ) : dispatchState.liveRunId !== null ||
          dispatchState.pendingCount > 0 ? (
          <div
            data-testid="chats-dispatch-status"
            className="flex h-7 shrink-0 items-center justify-center border-b border-line bg-panel-2/35 px-3 font-mono text-[10px] text-subtle"
          >
            {dispatchState.liveRunId !== null
              ? `agent working${
                  dispatchState.pendingCount > 0
                    ? ` · ${dispatchState.pendingCount} queued`
                    : ""
                }`
              : `${dispatchState.pendingCount} queued`}
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div
            data-testid="chats-thread-column"
            className="mx-auto w-full max-w-[640px] px-3 pb-16 sm:px-4"
          >
            <ThreadMessages
              nav={nav}
              messages={messages}
              messagesLoading={messagesLoading}
              threadLocked={threadLocked}
              flashMessageId={flashMessageId}
              runRecords={runRecords}
              reactionsByMessage={reactionsByMessage}
              decisionsByMessage={decisionsByMessage}
              attachmentsByMessage={attachmentsByMessage}
              reactionControls={reactionControls}
              mentionCandidates={mentionCandidates}
              bookmarkFor={bookmarkFor}
              bookmarkBusy={bookmarkBusy}
              toggleBookmark={toggleBookmark}
              beginReply={beginReply}
              beginResolve={beginResolve}
              scrollToMessage={scrollToMessage}
              onOpenPath={props.onOpenPath}
              onNavCommand={props.onNavCommand}
              setMessageNode={setMessageNode}
              messagesEndRef={messagesEndRef}
            />
          </div>
        </div>
        <TypingIndicator
          names={presence.typingNames}
          className="mx-auto w-full max-w-[640px] px-3 sm:px-4"
        />
        {threadLocked ? (
          <ComposerNotice testId="chats-readonly-note">
            {threadJoined?.ended
              ? "This channel is no longer shared with you. You can still read it."
              : "This channel is read-only for you."}
          </ComposerNotice>
        ) : (
          <div className="mx-auto w-full max-w-[640px] px-3 sm:px-4">
            {resolveTargetMessageId ? (
              <div
                data-testid="chats-resolving-mode"
                className="flex items-center gap-1 border-x border-t border-line bg-panel-2 px-2.5 py-1.5 font-mono text-[10px] text-muted"
              >
                <span className="min-w-0 flex-1 truncate">
                  {resolveChosenOption
                    ? `Answering the poll · ${resolveChosenOption}`
                    : "Answering the poll"}
                </span>
                <button
                  type="button"
                  data-testid="chats-resolving-cancel"
                  aria-label="Cancel resolving decision"
                  onClick={() => {
                    if (replyTarget?.messageId === resolveTargetMessageId) {
                      setReplyTarget(null);
                    }
                    setResolveTargetMessageId(null);
                    setResolveChosenOption(null);
                  }}
                  className="rounded px-1 text-subtle hover:text-ink dohc-focus-visible"
                >
                  ×
                </button>
              </div>
            ) : null}
            {replyTarget ? (
              <div
                data-testid="chats-replying-mode"
                className="flex items-center gap-1 border-x border-t border-line bg-panel-2 px-2.5 py-1.5 font-mono text-[10px] text-muted"
              >
                <span className="min-w-0 flex-1">
                  Replying to {replyTarget.authorLabel} ·
                </span>
                <button
                  type="button"
                  data-testid="chats-replying-cancel"
                  aria-label="Cancel reply"
                  onClick={() => {
                    if (resolveTargetMessageId === replyTarget.messageId) {
                      setResolveTargetMessageId(null);
                    }
                    setReplyTarget(null);
                  }}
                  className="rounded px-1 text-subtle hover:text-ink dohc-focus-visible"
                >
                  ×
                </button>
              </div>
            ) : null}
            <MentionComposer
              testIdPrefix="chats"
              composerId="chats-composer"
              value={composer}
              sending={sending}
              allowEmptySend={resolveTargetMessageId !== null}
              placeholder="Write a comment…  @ to mention"
              sendLabel="Send message"
              candidates={mentionCandidates}
              fileCandidates={fileMentionCandidates}
              loadFileHeadings={loadFileHeadings}
              onChange={(value) => {
                setComposer(value);
                presence.setTyping(value.trim().length > 0);
              }}
              onEscape={() => {
                setReplyTarget(null);
                setResolveTargetMessageId(null);
              }}
              onSend={() => {
                presence.setTyping(false);
                void sendMessage();
              }}
            />
          </div>
        )}
      </div>
    );
  }

  // An agent is set up when it has a name to post as and something runs it.
  const agentReady = Boolean(props.agentSetup?.agentName && props.agentSetup.runnerEnabled);

  if (nav.level === "channel") {
    const channelJoined = joinedFor(nav.channel);
    const channelLocked = channelIsLocked(nav.channel);
    const groupType = nav.channel.type ?? "posts";
    const showLane = groupType === "chat" || (groupType === "both" && groupLane === "chat");
    const channelGrants = nav.channel.wireId
      ? grantedByWire.get(nav.channel.wireId) ?? []
      : [];
    // Sharing an owned channel needs the sharing surface up; a joined channel
    // is never re-shareable from here (only its owner manages members).
    // Over the cap, a new grant only deepens the state: the relay's create
    // path has no matching cap, so each one grows the lane dohc already
    // cannot list, and the granted rows are empty on an over-limit read so
    // the user cannot remove any to make room. A refusal has to leave a way
    // to retry or degrade; offering the one control that moves retry further
    // away is the opposite. Removal and paging belong to the lane-scoping
    // work, not here.
    const shareGrantsBlocked = grantedLaneIsOverLimit(shareReadFailure);
    const canShare =
      nav.channel.kind !== "agent" &&
      channelShares !== null &&
      channelJoined === null &&
      !!nav.channel.wireId;
    return (
      <div
        data-testid="chats-channel-view"
        data-variant={variant}
        data-group-type={groupType}
        className="flex min-h-0 flex-1 flex-col"
        onKeyDownCapture={onKeyDownCapture}
      >
        <BackHeader
          label={nav.channel.kind === "agent" ? "My agent" : nav.channel.name}
          testId="chats-channel"
          onBack={goBack}
          icon={
            nav.channel.kind === "agent" ? (
              <span aria-hidden className="shrink-0 font-mono text-[12px] text-agent">
                ◈
              </span>
            ) : (
              <Hash size={12} aria-hidden className="shrink-0 text-subtle" />
            )
          }
          trailing={
            <>
              {nav.channel.kind === "agent" ? (
                <AgentPresenceHint
                  activity={agentSummaryActivity}
                  testId="chats-channel-agent-presence"
                />
              ) : null}
              <PresenceFaces
                others={nav.channel.kind === "agent" ? peoplePresence : presence.others}
              />
            </>
          }
          action={
            canShare ? (
              <button
                type="button"
                data-testid="chats-share-channel"
                title={channelGrants.length > 0 ? "Members" : "Add members"}
                aria-expanded={sharePanelOpen}
                onClick={() => setSharePanelOpen((open) => !open)}
                className="flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-[11px] text-muted hover:bg-panel-2 hover:text-ink dohc-focus-visible"
              >
                {channelGrants.length > 0 ? (
                  <span className="flex items-center -space-x-1.5">
                    {channelGrants.slice(0, 3).map((grant) => (
                      <ChatAvatar
                        key={grant.shareId}
                        name={grant.recipientEmail ?? "?"}
                        kind="human"
                        size="strip"
                        className="ring-2 ring-panel"
                      />
                    ))}
                  </span>
                ) : (
                  <Users size={13} aria-hidden />
                )}
                {channelGrants.length > 0 ? `Members · ${channelGrants.length}` : "Add members"}
              </button>
            ) : undefined
          }
        />
        {nav.channel.purpose?.trim() ? (
          <p data-testid="chats-channel-purpose" className="m-0 truncate px-3 pb-2 text-[12px] text-muted">
            {nav.channel.purpose}
          </p>
        ) : null}
        {nav.channel.kind === "agent" && props.agentSetup ? (
          <div
            data-testid="chats-agent-screen"
            data-state={agentReady ? "ready" : "needs-setup"}
            className="flex shrink-0 items-center gap-2 border-b border-line bg-panel-2/40 px-3 py-1.5 text-[11px] text-muted"
          >
            <Bot size={12} aria-hidden className="shrink-0 text-agent" />
            <span
              data-testid="chats-agent-screen-runner"
              className="min-w-0 flex-1 truncate"
              title={agentReady ? props.userSettings?.runner.command.trim() : undefined}
            >
              {agentReady
                ? props.userSettings?.runner.command.trim()
                  ? `Runs ${runnerProgram(props.userSettings.runner.command)}`
                  : "Runner on"
                : props.agentSetup.runnerConfigured
                  ? "Runner configured · dispatch is off"
                  : props.agentSetup.mcpEnabled
                    ? "Workspace MCP on · connect an agent to reply here"
                    : "No runner yet · add an agent under Agents"}
            </span>
            {props.workspacePath ? (
              <span
                data-testid="chats-agent-screen-reach"
                title={props.workspacePath}
                className="hidden shrink-0 truncate font-mono text-[10px] text-subtle sm:inline"
              >
                reaches {props.workspacePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? props.workspacePath}
              </span>
            ) : null}
            {props.onSetupAgent ? (
              <button
                type="button"
                data-testid="chats-agent-screen-manage"
                onClick={props.onSetupAgent}
                className="h-5 shrink-0 cursor-pointer rounded border border-line px-1.5 text-[10px] text-muted hover:bg-line/50 hover:text-ink dohc-focus-visible"
              >
                Manage
              </button>
            ) : null}
          </div>
        ) : null}
        {channelJoined !== null ? (
          <div
            data-testid="chats-joined-banner"
            className="flex shrink-0 items-center gap-1.5 border-b border-line bg-panel-2/40 px-3 py-1.5"
          >
            <ChatAvatar name={channelJoined.granterEmail ?? "?"} kind="human" size="strip" />
            <span className="min-w-0 flex-1 truncate text-[11px] text-muted">
              {joinedChannelLabel(channelJoined)}
            </span>
            <button
              type="button"
              data-testid="chats-leave-shared"
              onClick={() => void leaveShared(channelJoined.shareId)}
              className="h-5 shrink-0 cursor-pointer rounded border border-line px-1.5 text-[10px] text-muted hover:bg-line/50 hover:text-ink"
            >
              Leave
            </button>
          </div>
        ) : null}
        {canShare && sharePanelOpen ? (
          <div
            data-testid="chats-share-panel"
            className="shrink-0 border-b border-line bg-panel-2/40 px-3 py-2"
          >
            {/* Same honesty on the owner side: an unreadable listing left this
                panel showing no members, which reads as "nobody has this
                channel". */}
            {shareReadFailure ? (
              <ShareReadFailureNotice
                testId="chats-share-members-unreadable"
                failure={shareReadFailure}
                stale={channelGrants.length > 0}
                onRetry={() => void refreshShares()}
              />
            ) : null}
            {channelGrants.length > 0 ? (
              <ul className="m-0 mb-2 list-none p-0">
                {channelGrants.map((grant) => (
                  <li
                    key={grant.shareId}
                    data-testid="chats-share-member"
                    className="flex h-7 items-center gap-2"
                  >
                    <ChatAvatar name={grant.recipientEmail ?? "?"} kind="human" size="strip" />
                    <span className="min-w-0 flex-1 truncate text-[12px] text-ink">
                      {grant.recipientEmail ?? "Invited"}
                    </span>
                    {grant.access === "read-only" ? (
                      <span className="shrink-0 font-mono text-[10px] text-subtle">read-only</span>
                    ) : null}
                    <button
                      type="button"
                      data-testid="chats-share-revoke"
                      onClick={() => void revokeShare(grant.shareId)}
                      className="h-5 shrink-0 cursor-pointer rounded border border-line px-1.5 text-[10px] text-muted hover:bg-line/50 hover:text-ink dohc-focus-visible"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <form
              className="flex items-center gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                void submitShare();
              }}
            >
              <label className="sr-only" htmlFor="chats-share-email">
                Add a member by email
              </label>
              <input
                id="chats-share-email"
                data-testid="chats-share-email"
                type="email"
                value={shareEmail}
                disabled={shareGrantsBlocked}
                maxLength={320}
                placeholder="Add by email"
                onChange={(event) => setShareEmail(event.target.value)}
                className="h-6 min-w-0 flex-1 rounded border border-line bg-bg px-2 text-[11px] text-ink placeholder:text-subtle dohc-focus-input"
              />
              <label className="flex shrink-0 cursor-pointer items-center gap-1 text-[10px] text-muted">
                <input
                  data-testid="chats-share-readonly"
                  type="checkbox"
                  checked={shareReadOnly}
                  onChange={(event) => setShareReadOnly(event.target.checked)}
                />
                View only
              </label>
              <button
                type="submit"
                data-testid="chats-share-submit"
                disabled={
                  shareBusy || shareGrantsBlocked || shareEmail.trim().length === 0
                }
                className="h-6 shrink-0 cursor-pointer rounded border border-line px-2 text-[10px] text-muted hover:bg-line/50 hover:text-ink disabled:cursor-default disabled:opacity-50"
              >
                Add
              </button>
            </form>
          </div>
        ) : null}
        {groupType === "both" ? (
          <div
            role="tablist"
            aria-label="Group lanes"
            className="flex shrink-0 gap-1 border-b border-line px-3 py-1.5"
          >
            {(
              [
                ["posts", "Posts"],
                ["chat", "Chat"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={groupLane === value}
                data-testid={`chats-group-lane-${value}`}
                onClick={() => setGroupLane(value)}
                className={`h-7 rounded-md px-3 text-[12px] font-medium transition-colors dohc-focus-visible ${
                  groupLane === value
                    ? "bg-panel-2 text-ink"
                    : "text-muted hover:bg-panel-2 hover:text-ink"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}
        {showLane ? (
          <ChatLane
            workspaceId={workspaceId}
            channel={nav.channel}
            locked={channelLocked}
            mentionCandidates={mentionCandidates}
            fileCandidates={fileMentionCandidates}
            loadFileHeadings={loadFileHeadings}
            onOpenPath={props.onOpenPath}
            onError={props.onError}
            onThreadRead={props.onThreadRead}
            revision={props.threadRevision ?? 0}
          />
        ) : (
        <PostFeedList
          key={`${workspaceId}:${nav.channel.id}`}
          testId="chats-feed-column"
          items={threadsLoading ? [] : channelThreads}
          itemKey={(thread) => thread.id}
          columnClassName="mx-auto w-full max-w-[640px]"
          bottomPadding={64}
          topPadding={0}
          header={<>
            {!channelLocked ? (
              <div className="mb-4 mt-4">
                <MentionComposer
                  testIdPrefix="chats-new-thread"
                  composerId="chats-new-thread-composer"
                  value={newThreadBody}
                  sending={startingThread}
                  surface="post"
                  authorName={collaboration?.displayName || "You"}
                  placeholder={
                    nav.channel.kind === "agent"
                      ? "Message your agent…"
                      : `What's happening in #${nav.channel.name}?`
                  }
                  sendLabel="Start post"
                  candidates={mentionCandidates}
                  fileCandidates={fileMentionCandidates}
                  loadFileHeadings={loadFileHeadings}
                  onChange={setNewThreadBody}
                  onSend={() => void startThread()}
                />
              </div>
            ) : null}
          </>}
          empty={threadsLoading ? (
              <p className="m-0 pt-4 text-center text-[11px] text-subtle">Loading...</p>
            ) : (
              <div
                data-testid="chats-channel-empty"
                className="flex flex-col items-center justify-center gap-1 px-4 py-12 text-center"
              >
                <MessagesSquare size={16} aria-hidden className="text-subtle" />
                <span className="text-[13px] text-subtle">No posts yet</span>
              </div>
            )}
          renderItem={(thread) => {
                  const post = feedPosts[thread.id] ?? {
                    openingMessage: null,
                    reactions: [],
                    viewerAuthorId: "",
                  };
                  const bookmark = bookmarkFor("thread", thread.id);
                  const bookmarkKey = `thread:${thread.id}`;
                  return (
                    <PostCard
                      key={thread.id}
                      thread={thread}
                      data={post}
                      reactionControls={{
                        reactions: post.reactions,
                        viewerAuthorId: post.viewerAuthorId,
                        onToggle: (input) => toggleFeedReaction(thread.id, input),
                        readOnly: channelLocked,
                      }}
                      onOpen={() =>
                        openConversation({ level: "thread", channel: nav.channel, thread })
                      }
                      bookmark={bookmark}
                      bookmarkBusy={bookmarkBusy.has(bookmarkKey)}
                      onToggleBookmark={
                        channelLocked
                          ? undefined
                          : (mode) =>
                              void toggleBookmark({
                                target: { kind: "thread", threadId: thread.id },
                                mode,
                              })
                      }
                      onOpenBookmark={
                        bookmark && props.onOpenPath
                          ? () => props.onOpenPath?.(bookmark.destinationPath)
                          : undefined
                      }
                    />
                  );

          }}
        />
        )}
        {channelLocked && !showLane ? (
          <ComposerNotice testId="chats-readonly-note">
            {channelJoined?.ended
              ? "This channel is no longer shared with you. You can still read it."
              : "This channel is read-only for you."}
          </ComposerNotice>
        ) : null}
      </div>
    );
  }

  const selectedChannelId =
    props.selectedNav?.level === "channel" || props.selectedNav?.level === "thread"
      ? props.selectedNav.channel.id
      : null;
  const selectedDmId =
    props.selectedNav?.level === "dm" ? props.selectedNav.dm.channelId : null;
  const agentLabel = props.agentSetup?.agentName ?? "Your agent";

  return (
    <div
      data-testid="chats-view"
      data-variant={variant}
      className="flex min-h-0 flex-1 flex-col"
      onKeyDownCapture={onKeyDownCapture}
    >
      <div className={`min-h-0 flex-1 overflow-y-auto ${pageColumn}`}>
        <AddressedToMe notifications={props.addressedToMe ?? []} />
        <nav aria-label="Chat" className="flex flex-col pb-3">
          <NavRow
            testId="chats-feed-link"
            active={props.selectedNav?.level === "feed"}
            onClick={() => openConversation({ level: "feed" })}
            icon={<House size={15} strokeWidth={1.9} aria-hidden className="shrink-0 text-muted" />}
            label="Home"
            className="mt-2"
          />
          <SectionLabel as="p" data-testid="chats-channels-heading" className="mb-1 mt-4 px-4">
            Groups
          </SectionLabel>
          <ul className="m-0 list-none p-0">
            {overview.channels
              .filter((channel) => channel.kind === "channel")
              .map((channel) => {
                const joined = joinedFor(channel);
                const grants = channel.wireId ? grantedByWire.get(channel.wireId) ?? [] : [];
                const sharedLabel = joined
                  ? joinedChannelLabel(joined)
                  : grants.length > 0
                    ? `Shared with ${grants.length}`
                    : null;
                return (
                  <li key={channel.id}>
                    <NavRow
                      testId="chats-channel"
                      data={{
                        "data-channel-id": channel.id,
                        "data-channel-slug": channel.slug,
                        "data-thread-count": String(channel.threadCount),
                      }}
                      active={selectedChannelId === channel.id}
                      onClick={() => openConversation({ level: "channel", channel })}
                      icon={<Hash size={15} strokeWidth={1.9} aria-hidden className="shrink-0 text-muted" />}
                      label={channel.name}
                      labelTestId="chats-channel-name"
                      trailing={
                        <>
                          {sharedLabel ? (
                            <span
                              data-testid="chats-channel-shared"
                              title={sharedLabel}
                              className="grid shrink-0 place-items-center text-subtle"
                            >
                              <Users size={12} aria-hidden />
                              <span className="sr-only">{sharedLabel}</span>
                            </span>
                          ) : null}
                          <UnreadPill count={channel.unreadCount} testId="chats-channel-unread" />
                        </>
                      }
                    />
                  </li>
                );
              })}
          </ul>
          {receivedNotJoined.length > 0 || shareReadFailure !== null ? (
            <div data-testid="chats-shared-with-you">
              <SectionLabel as="p" className="mb-1 mt-4 px-4">
                Shared with you
              </SectionLabel>
              {/* The section stays even with nothing to list. Hiding it on an
                  unreadable listing was the whole of #618: the invitations
                  vanished with no copy anywhere saying dohc could not read
                  them. */}
              {shareReadFailure ? (
                <ShareReadFailureNotice
                  testId="chats-shares-unreadable"
                  failure={shareReadFailure}
                  stale={receivedNotJoined.length > 0}
                  onRetry={() => void refreshShares()}
                />
              ) : null}
              <ul className="m-0 list-none p-0">
                {receivedNotJoined.map((row) => (
                  <li key={row.shareId} className="mx-2 flex h-8 items-center gap-2 px-2">
                    <Users size={15} strokeWidth={1.9} aria-hidden className="shrink-0 text-muted" />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                      {row.granterEmail ?? "A teammate"}
                    </span>
                    {row.access === "read-only" ? (
                      <span className="shrink-0 font-mono text-[10px] text-subtle">read-only</span>
                    ) : null}
                    <button
                      type="button"
                      data-testid="chats-join-shared"
                      disabled={joiningShareId !== null}
                      onClick={() => void joinShared(row.shareId)}
                      className="h-6 shrink-0 cursor-pointer rounded border border-line px-2 text-[11px] text-muted hover:bg-line/50 hover:text-ink disabled:cursor-default disabled:opacity-50 dohc-focus-visible"
                    >
                      {joiningShareId === row.shareId ? "Joining…" : "Join"}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {dmAvailable || dms.length > 0 ? (
            <div data-testid="chats-dms-section">
              <SectionLabel as="p" className="mb-1 mt-4 px-4">
                People
              </SectionLabel>
              <ul className="m-0 list-none p-0">
                {dms.map((dm) => (
                  <li key={dm.channelId}>
                    <NavRow
                      testId="chats-dm-item"
                      data={{ "data-channel-id": dm.channelId }}
                      active={selectedDmId === dm.channelId}
                      onClick={() => openConversation({ level: "dm", dm })}
                      icon={<ChatAvatar name={dm.peerLabel} kind="human" size="strip" />}
                      label={dm.peerLabel}
                      labelTestId="chats-dm-name"
                      muted={!dm.connected}
                      trailing={
                        <>
                          {dm.connected ? null : (
                            <span className="shrink-0 font-mono text-[10px] text-subtle">ended</span>
                          )}
                          <UnreadPill count={dm.unreadCount} testId="chats-dm-unread" />
                        </>
                      }
                    />
                  </li>
                ))}
              </ul>
              {dmAvailable ? (
                <NavRow
                  testId="chats-new-dm"
                  onClick={() => {
                    // Always start compose from a clean slate — never inherit a
                    // recipient/draft left over from a previous compose.
                    setDmRecipients("");
                    setDmDraft("");
                    if (variant === "panel" && props.onOpenInTab) {
                      props.onOpenInTab({ level: "dm-new" });
                      return;
                    }
                    // A command like any conversation click (see
                    // openConversation): report it synchronously, or a DM
                    // answer queued in this tick remounts over the compose.
                    props.onNavCommand?.({ level: "dm-new" });
                    setNav({ level: "dm-new" });
                  }}
                  icon={<Plus size={15} strokeWidth={1.9} aria-hidden className="shrink-0 text-muted" />}
                  label="New message"
                  muted
                />
              ) : null}
            </div>
          ) : null}
          {dmAcceptedElsewhere ? (
            <div
              data-testid="chats-dm-accepted-elsewhere"
              className="mx-3 mt-3 flex min-h-7 items-center gap-2 rounded border border-line bg-panel-2 px-2 text-[11px] text-muted"
            >
              <span className="min-w-0 flex-1 truncate">
                {dmAcceptedElsewhere.granterEmail
                  ? `Added your conversation with ${dmAcceptedElsewhere.granterEmail} to ${dmAcceptedElsewhere.workspaceLabel}.`
                  : `Added this conversation to ${dmAcceptedElsewhere.workspaceLabel}.`}
              </span>
              <button
                type="button"
                data-testid="chats-dm-accepted-elsewhere-dismiss"
                aria-label="Dismiss notice"
                onClick={() => setDmAcceptedElsewhere(null)}
                className="grid size-6 shrink-0 place-items-center rounded hover:bg-line/50 hover:text-ink"
              >
                <X size={12} aria-hidden />
              </button>
            </div>
          ) : null}
          {pendingDmRequests.length > 0 || declinedDmRequests.length > 0 ? (
            <div data-testid="chats-dm-requests-section">
              <SectionLabel as="p" className="mb-1 mt-4 px-4">
                Message requests
              </SectionLabel>
              <ul className="m-0 list-none p-0">
                {pendingDmRequests.map((request) => (
                  <DmRequestListItem
                    key={request.shareId}
                    request={request}
                    state="pending"
                    busy={dmRequestBusy !== null}
                    onAccept={() => setAcceptingDmRequest(request)}
                    onDecline={() => void setDmRequestDeclined(request, true)}
                  />
                ))}
              </ul>
              {declinedDmRequests.length > 0 ? (
                <div className="border-t border-line/60 bg-panel-2/40">
                  <SectionLabel as="p" className="m-0 px-4 pb-1 pt-2">
                    Declined
                  </SectionLabel>
                  <ul className="m-0 list-none p-0">
                    {declinedDmRequests.map((request) => (
                      <DmRequestListItem
                        key={request.shareId}
                        request={request}
                        state="declined"
                        busy={dmRequestBusy !== null}
                        onRequestAgain={() =>
                          void setDmRequestDeclined(request, false)
                        }
                      />
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
          {agentChannel || props.userSettings || otherAgents.length > 0 ? (
            <section data-testid="chats-my-agent-section" aria-label="Agents">
              <SectionLabel as="p" className="mb-1 mt-4 px-4">
                Agents
              </SectionLabel>
              {agentChannel ? (
                <NavRow
                  testId="chats-my-agent"
                  data={{ "data-channel-id": agentChannel.id }}
                  active={selectedChannelId === agentChannel.id}
                  onClick={() => openConversation({ level: "channel", channel: agentChannel })}
                  icon={<ChatAvatar name={agentLabel} kind="agent" size="strip" />}
                  label={agentLabel}
                  labelTestId="chats-my-agent-name"
                  trailing={
                    <>
                      {agentReady ? null : (
                        <span
                          data-testid="chats-my-agent-state"
                          className="shrink-0 font-mono text-[10px] text-subtle"
                        >
                          not set up
                        </span>
                      )}
                      <AgentPresenceHint
                        activity={agentSummaryActivity}
                        testId="chats-my-agent-presence"
                      />
                      <UnreadPill count={agentChannel.unreadCount} testId="chats-my-agent-unread" />
                    </>
                  }
                />
              ) : null}
              {otherAgents.length > 0 ? (
                <ul data-testid="chats-other-agents" className="m-0 list-none p-0">
                  {otherAgents.map((agent) => (
                    <li key={agent.key}>
                      <NavRow
                        testId="chats-other-agent"
                        data={{ "data-owner": agent.owner }}
                        active={false}
                        onClick={agent.open}
                        icon={<ChatAvatar name={agent.label} kind="agent" size="strip" />}
                        label={agent.label}
                        labelTestId="chats-other-agent-name"
                        muted
                        trailing={
                          <span className="shrink-0 truncate font-mono text-[10px] text-subtle">
                            via {agent.owner}
                          </span>
                        }
                      />
                    </li>
                  ))}
                </ul>
              ) : null}
              {addingAgent && props.userSettings && props.onSaveUserSettings ? (
                <AddAgentForm
                  workspaceId={workspaceId}
                  settings={props.userSettings}
                  onSave={props.onSaveUserSettings}
                  onDone={() => setAddingAgent(false)}
                  onCancel={() => setAddingAgent(false)}
                />
              ) : null}
              {props.userSettings && props.onSaveUserSettings ? (
                <button
                  type="button"
                  data-testid={agentReady ? "chats-manage-agent" : "chats-add-agent-open"}
                  onClick={() =>
                    agentReady && props.onSetupAgent ? props.onSetupAgent() : setAddingAgent(true)
                  }
                  className="mx-2 flex h-7 w-[calc(100%-1rem)] cursor-pointer items-center gap-1.5 rounded-md px-2 text-[12px] text-muted hover:bg-panel-2 hover:text-ink dohc-focus-visible"
                >
                  {agentReady ? (
                    <>
                      <Bot size={13} aria-hidden className="shrink-0 text-subtle" />
                      Manage agent
                    </>
                  ) : (
                    <>
                      <Plus size={13} aria-hidden className="shrink-0 text-subtle" />
                      Add an agent
                    </>
                  )}
                </button>
              ) : null}
            </section>
          ) : null}
        </nav>
      </div>
      <div className={`shrink-0 border-t border-line p-2 ${pageColumn}`}>
        {creatingChannel === null ? (
          <button
            type="button"
            data-testid="chats-new-channel"
            onClick={() => setCreatingChannel("")}
            className="flex h-7 w-full cursor-pointer items-center justify-center gap-1.5 rounded-md border border-line text-[11px] text-muted hover:bg-line/50 hover:text-ink"
          >
            <Plus size={12} aria-hidden />
            New group
          </button>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void createChannel(creatingChannel);
            }}
          >
            <label className="sr-only" htmlFor="chats-new-channel-name">
              Group name
            </label>
            <input
              id="chats-new-channel-name"
              data-testid="chats-new-channel-name"
              autoFocus
              value={creatingChannel}
              maxLength={80}
              placeholder="Group name"
              onChange={(event) => setCreatingChannel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  resetGroupForm();
                }
              }}
              className="h-7 w-full rounded-md border border-line bg-bg px-2 text-[13px] text-ink placeholder:text-subtle dohc-focus-input"
            />
            <label className="sr-only" htmlFor="chats-new-channel-purpose">
              Purpose
            </label>
            <input
              id="chats-new-channel-purpose"
              data-testid="chats-new-channel-purpose"
              value={newGroupPurpose}
              maxLength={200}
              placeholder="What it's for"
              onChange={(event) => setNewGroupPurpose(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  resetGroupForm();
                }
              }}
              className="mt-1.5 h-7 w-full rounded-md border border-line bg-bg px-2 text-[13px] text-ink placeholder:text-subtle dohc-focus-input"
            />
            <div
              role="radiogroup"
              aria-label="Group type"
              className="mt-1.5 flex gap-1"
            >
              {(
                [
                  ["posts", "Posts"],
                  ["chat", "Chat"],
                  ["both", "Both"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={newGroupType === value}
                  data-testid={`chats-new-channel-type-${value}`}
                  onClick={() => setNewGroupType(value)}
                  className={`h-7 flex-1 rounded-md border text-[12px] transition-colors dohc-focus-visible ${
                    newGroupType === value
                      ? "border-ink bg-panel-2 text-ink"
                      : "border-line text-muted hover:bg-panel-2 hover:text-ink"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              type="submit"
              data-testid="chats-new-channel-submit"
              disabled={creatingChannel.trim().length === 0}
              className="mt-1.5 h-7 w-full rounded-md bg-ink text-[12px] font-medium text-bg hover:opacity-90 disabled:opacity-40 dohc-focus-visible"
            >
              Create group
            </button>
          </form>
        )}
      </div>
      {acceptingDmRequest ? (
        <AcceptDmDialog
          key={acceptingDmRequest.shareId}
          request={acceptingDmRequest}
          currentWorkspaceId={workspaceId}
          workspaces={props.workspaces}
          onAccept={(chosenWorkspaceId) =>
            acceptDmRequest(acceptingDmRequest, chosenWorkspaceId)
          }
          onClose={() => setAcceptingDmRequest(null)}
        />
      ) : null}
    </div>
  );
}
