import {
  ArrowLeft,
  AtSign,
  Bot,
  Copy,
  FileText,
  Hash,
  MessagesSquare,
  Plus,
  Square,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChannelThreadRecord,
  ChatAttachmentRecord,
  ChatChannelRecord,
  ChatChannelShareGrantRow,
  ChatDecisionRecord,
  ChatDispatchStateForThreadResult,
  ChatMessageRecord,
  ChatReactionRecord,
  ChatRunRecord,
  DmRecord,
  FileChatThreadRecord,
  JoinedSharedChannelRow,
  ListChatChannelSharesResult,
} from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import type { AgentNotification } from "./agentNotifications";
import {
  ChatMessageList,
  MessageReactions,
  MentionText,
  chatAuthorLabel,
  formatChatTime,
  ipcErrorMessage,
  runReactionToggle,
  type ChatReactionControls,
} from "./chatMessages";
import { MentionComposer } from "./MentionComposer";
import type { MentionCandidate } from "@dohc/workspace-contracts/chat-mentions";
import { PresenceFaces, TypingIndicator } from "../collab/PresenceIndicators";
import { usePresence } from "../collab/usePresence";
import type {
  PresenceScope,
  PresenceTransport,
} from "../collab/presenceChannel";
import {
  CHAT_AGENT_PRESENCE_TOPIC,
  agentPresenceClientId,
  resolveAgentPresenceActivity,
  type AgentPresenceActivity,
} from "../../collab/agentPresence";

// Multi-user chat presence (MU-C1) is opt-in: only under collaboration
// (signedIn && relayConnected) is a transport supplied, so a solo/offline user
// constructs no presence at all. Absent => today's exact single-user Chats.
//
// The collaboration hands back a transport PER SCOPE rather than a single baked
// one: a participant viewing a channel shared TO them must publish into a SHARE
// scope (which the relay maps to the granter's workspace) so they land in the
// SAME relay presence scope as the owner (who publishes into their WORKSPACE
// scope). See the scope/topic derivation in ChatsView below. Still null when
// solo/offline — the transport factory is simply never called.
export interface ChatPresenceCollaboration {
  transportForScope: (scope: PresenceScope) => PresenceTransport;
  clientId: string;
  displayName: string;
}

// The Chats view (PR 13, WS-E): workspace Chats organized in channels, plus
// a read-only "Files" grouping that cross-links to the per-file rail. Built
// to feel like chat, not a forum: the channel composer sends on Enter and a
// new thread NEVER asks for a title — it displays its first-message snippet.
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

// Exported for the shell's expand-to-tab seam: the panel reports where it is
// (onNavChange) and a freshly expanded tab starts there (initialNav).
export type ChatsNav =
  | { level: "channels" }
  | { level: "channel"; channel: ChatChannelRecord }
  | { level: "thread"; channel: ChatChannelRecord; thread: ChannelThreadRecord }
  // Direct messages (WS-MU-C3): one running conversation per DM (the
  // anti-forum rule), plus a one-step "new message" composer.
  | { level: "dm"; dm: DmRecord }
  | { level: "dm-new" };

type Nav = ChatsNav;

// Unsent input, one field per composer surface. Part of the expand-to-tab
// handoff: the shell mirrors the live instance's drafts (onDraftsChange) and
// seeds the next mount with them, so expanding or collapsing chats never
// discards something the user typed.
export interface ChatsDrafts {
  composer: string;
  newThreadBody: string;
  dmRecipients: string;
  dmDraft: string;
}

type FeedOpeningMessage = Omit<
  NonNullable<ChannelThreadRecord["openingMessage"]>,
  "reactions"
>;

interface FeedPostData {
  openingMessage: FeedOpeningMessage | null;
  reactions: ChatReactionRecord[];
  viewerAuthorId: string;
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

interface ChannelSnapshot {
  threads: ChannelThreadRecord[];
  feedPosts: Record<string, FeedPostData>;
}

const IDLE_DISPATCH_STATE: ChatDispatchStateForThreadResult = {
  liveRun: false,
  pendingCount: 0,
  paused: false,
};

interface ComposerReplyTarget {
  messageId: string;
  authorLabel: string;
}

function pathBasename(pathHint: string | undefined): string {
  if (!pathHint) return "attachment";
  return pathHint.split(/[\\/]/).filter(Boolean).at(-1) ?? "attachment";
}

function AgentBadge(props: { testIdPrefix: string }) {
  return (
    <span
      data-testid={`${props.testIdPrefix}-agent-badge`}
      className="rounded border border-agent/40 px-1 font-mono text-[10px] text-agent"
    >
      agent
    </span>
  );
}

function AgentPresenceHint(props: {
  activity: AgentPresenceActivity | null;
  testId: string;
}) {
  if (props.activity === null) return null;
  const working = props.activity === "working";
  return (
    <span
      data-testid={props.testId}
      aria-label={`Agent is ${props.activity}`}
      title={`Agent is ${props.activity}`}
      className="inline-flex shrink-0 items-center gap-1 font-mono text-[10px] text-subtle"
    >
      <span
        aria-hidden
        className={`size-1.5 rounded-full ${
          working ? "bg-agent" : "border border-agent/60 bg-transparent"
        }`}
      />
      {props.activity}
    </span>
  );
}

function DecisionStatus(props: {
  decision: ChatDecisionRecord;
  onResolve?: () => void;
  testIdPrefix: string;
}) {
  if (props.decision.state === "resolved") {
    return (
      <span
        data-testid={`${props.testIdPrefix}-decision-resolved`}
        className="rounded-md border border-success/40 bg-success/10 px-1.5 py-0.5 font-mono text-[10px] text-success"
      >
        resolved
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span
        data-testid={`${props.testIdPrefix}-decision-open`}
        className="rounded-md border border-warning/40 bg-warning/10 px-1.5 py-0.5 font-mono text-[10px] text-warning"
      >
        needs decision
      </span>
      {props.onResolve ? (
        <button
          type="button"
          data-testid={`${props.testIdPrefix}-decision-resolve`}
          onClick={props.onResolve}
          className="rounded px-1 py-0.5 font-mono text-[10px] text-subtle hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          Resolve
        </button>
      ) : null}
    </span>
  );
}

function AttachmentChip(props: {
  attachment: ChatAttachmentRecord;
  onOpenPath?: (path: string) => void;
}) {
  const label = pathBasename(props.attachment.pathHint);
  const className =
    "inline-flex items-center gap-1 rounded-full border border-line bg-panel-2 px-2 py-0.5 font-mono text-[10px] text-muted";
  const content = (
    <>
      <FileText size={11} aria-hidden className="shrink-0" />
      <span className="max-w-56 truncate">{label}</span>
    </>
  );
  if (props.attachment.pathHint && props.onOpenPath) {
    return (
      <button
        type="button"
        data-testid="chats-attachment-chip"
        title={props.attachment.pathHint}
        onClick={() => props.onOpenPath?.(props.attachment.pathHint ?? "")}
        className={`${className} cursor-pointer hover:border-muted/50 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent`}
      >
        {content}
      </button>
    );
  }
  return (
    <span
      data-testid="chats-attachment-chip"
      title={props.attachment.pathHint}
      className={className}
    >
      {content}
    </span>
  );
}

function RunChip(props: { run: ChatRunRecord }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const started = formatChatTime(props.run.startedAtMs);
  return (
    <span
      ref={containerRef}
      data-chat-escape-local="true"
      className="relative inline-flex"
    >
      <button
        ref={triggerRef}
        type="button"
        data-testid="chats-run-chip"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((current) => !current)}
        className="rounded border border-line px-1.5 font-mono text-[10px] text-subtle hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        run {props.run.runId.slice(0, 7)}
      </button>
      {open ? (
        <span
          role="dialog"
          aria-label={`Run ${props.run.runId}`}
          data-testid="chats-run-popover"
          className="dohc-popover dohc-pop-in absolute left-0 top-full z-30 mt-1 grid w-72 max-w-[calc(100vw-2rem)] gap-2 rounded-lg border border-line bg-panel p-3 text-left"
        >
          <span className="grid gap-0.5">
            <span className="font-mono text-[10px] uppercase tracking-wide text-subtle">Command</span>
            <code data-testid="chats-run-command" className="break-words text-[11px] text-ink">
              {props.run.command}
            </code>
          </span>
          <span className="grid grid-cols-2 gap-2">
            <span className="grid gap-0.5">
              <span className="font-mono text-[10px] uppercase tracking-wide text-subtle">Started</span>
              <time
                data-testid="chats-run-started"
                dateTime={started.iso}
                className="font-mono text-[10px] text-muted"
              >
                {started.label}
              </time>
            </span>
            <span className="grid gap-0.5">
              <span className="font-mono text-[10px] uppercase tracking-wide text-subtle">Exit code</span>
              <span data-testid="chats-run-exit-code" className="font-mono text-[10px] text-muted">
                {props.run.exitCode ?? "—"}
              </span>
            </span>
          </span>
          <span className="grid gap-0.5">
            <span className="font-mono text-[10px] uppercase tracking-wide text-subtle">Log</span>
            <span className="flex min-w-0 items-center gap-1.5">
              <code data-testid="chats-run-log-path" className="min-w-0 flex-1 break-all text-[10px] text-muted">
                {props.run.logPath ?? "No log path"}
              </code>
              {props.run.logPath ? (
                <button
                  type="button"
                  data-testid="chats-run-copy-log"
                  aria-label="Copy log path"
                  title="Copy log path"
                  onClick={() => {
                    void bridge()
                      .writeClipboardText({ text: props.run.logPath ?? "" })
                      .catch(() => undefined);
                  }}
                  className="grid size-6 shrink-0 place-items-center rounded border border-line text-subtle hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <Copy size={11} aria-hidden />
                </button>
              ) : null}
            </span>
          </span>
        </span>
      ) : null}
    </span>
  );
}

// A derived title repeats the body's first line; the card already shows it
// in serif, so the excerpt starts after it.
function postExcerpt(title: string, body: string): string {
  const newline = body.indexOf("\n");
  const firstLine = (newline === -1 ? body : body.slice(0, newline)).trim();
  if (firstLine !== title.trim()) return body;
  return newline === -1 ? "" : body.slice(newline + 1).trim();
}

function PostCard(props: {
  thread: ChannelThreadRecord;
  data: FeedPostData;
  reactionControls: ChatReactionControls;
  onOpen: () => void;
}) {
  const message = props.data.openingMessage;
  const isAgent = message?.authorKind === "agent";
  const time = formatChatTime(message?.createdAtMs ?? props.thread.createdAtMs);
  const commentCount = Math.max(0, props.thread.messageCount - 1);
  const excerpt = message ? postExcerpt(props.thread.title, message.bodySnippet) : "";
  return (
    <li
      data-testid="chats-post-card"
      data-thread-id={props.thread.id}
      data-author-kind={message?.authorKind ?? "unknown"}
      role="button"
      tabIndex={0}
      onClick={props.onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          props.onOpen();
        }
      }}
      style={
        isAgent
          ? { borderLeftColor: "color-mix(in oklab, var(--dohc-agent) 55%, var(--dohc-line))" }
          : undefined
      }
      className={`group cursor-pointer rounded-xl border border-line bg-panel px-4 py-3 text-left transition-[border-color,transform] hover:-translate-y-px hover:border-muted/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
        isAgent ? "border-l-2" : ""
      }`}
    >
      {/* Compatibility target retained for existing navigation/e2e drivers;
          the card itself is the new semantic button. */}
      <div data-testid="chats-thread" data-thread-id={props.thread.id}>
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <span
            data-testid="chats-post-author"
            className={`text-[13px] font-medium ${isAgent ? "text-agent" : "text-ink"}`}
          >
            {message ? chatAuthorLabel(message) : "Unknown author"}
          </span>
          {isAgent ? <AgentBadge testIdPrefix="chats-post" /> : null}
          <time
            data-testid="chats-post-time"
            dateTime={time.iso}
            title={time.iso}
            className="font-mono text-[10px] text-subtle"
          >
            {time.label}
          </time>
          <span className="ml-auto">
            <UnreadPill count={props.thread.unreadCount} testId="chats-thread-unread" />
          </span>
        </span>
        <span
          data-testid="chats-post-title"
          className="mt-1.5 block text-balance font-serif text-[17px] font-semibold leading-snug text-ink"
        >
          {props.thread.title}
        </span>
        {excerpt ? (
          <span
            data-testid="chats-post-excerpt"
            className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-[13px] text-muted"
          >
            {excerpt}
          </span>
        ) : null}
      </div>
      <div
        data-testid="chats-post-footer"
        className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-line pt-2.5"
      >
        {message ? (
          <MessageReactions
            testIdPrefix="chats-post"
            messageId={message.id}
            records={props.data.reactions.filter((reaction) => reaction.messageId === message.id)}
            controls={props.reactionControls}
            flush
          />
        ) : null}
        {(props.thread.openDecisionCount ?? 0) > 0 ? (
          <span
            data-testid="chats-post-decision-open"
            className="rounded-md border border-warning/40 bg-warning/10 px-1.5 py-0.5 font-mono text-[10px] text-warning"
          >
            needs decision
          </span>
        ) : null}
        <span className="min-w-2 flex-1" />
        <span
          data-testid="chats-post-comment-count"
          className="font-mono text-[11px] text-subtle"
        >
          {commentCount} {commentCount === 1 ? "comment" : "comments"}
        </span>
      </div>
    </li>
  );
}

function UnreadPill(props: { count: number; testId: string }) {
  if (props.count <= 0) return null;
  return (
    <span
      data-testid={props.testId}
      aria-label={`${props.count} unread`}
      className="min-w-4 shrink-0 rounded-full bg-ink px-1 text-center text-[10px] font-semibold leading-4 text-bg"
    >
      {props.count > 99 ? "99+" : props.count}
    </span>
  );
}

function BackHeader(props: {
  label: string;
  testId: string;
  onBack: () => void;
  icon?: React.ReactNode;
  // Optional calm trailing slot (e.g. presence faces of who else is here).
  trailing?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-line px-2">
      <button
        type="button"
        data-testid={`${props.testId}-back`}
        aria-label="Back"
        title="Back"
        onClick={props.onBack}
        className="grid size-6 shrink-0 cursor-pointer place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink"
      >
        <ArrowLeft size={13} aria-hidden />
      </button>
      {props.icon}
      <span
        data-testid={`${props.testId}-title`}
        className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink"
      >
        {props.label}
      </span>
      {props.action}
      {props.trailing}
    </div>
  );
}

// One line describing who a joined channel came from — calm, not a banner.
function joinedChannelLabel(joined: JoinedSharedChannelRow): string {
  const from = joined.granterEmail ?? "someone else";
  const suffix = joined.ended
    ? " — no longer shared"
    : joined.access === "read-only"
      ? " — read-only"
      : "";
  return `Shared by ${from}${suffix}`;
}

// The read-only / ended composer replacement: honest and quiet.
function ComposerNotice(props: { testId: string; children: React.ReactNode }) {
  return (
    <p
      data-testid={props.testId}
      className="m-0 shrink-0 border-t border-line px-3 py-2 text-[11px] text-subtle"
    >
      {props.children}
    </p>
  );
}

// "Addressed to me" inbox: the calm, in-context list of things the agent is
// waiting on the user for (asks + needs-input). It reuses the agent
// notification model rather than a heavy new surface, and stays hidden when
// there's nothing to answer.
function AddressedToMe(props: {
  notifications: readonly AgentNotification[];
  onOpen?: (notification: AgentNotification) => void;
}) {
  const waiting = props.notifications.filter(
    (notification) => notification.kind === "asked" || notification.kind === "needs-input",
  );
  if (waiting.length === 0) return null;
  return (
    <section
      data-testid="chats-addressed-to-me"
      aria-label="Addressed to me"
      className="border-b border-line bg-panel-2/40"
    >
      <p className="mb-0 px-3 pt-2 text-[10px] font-semibold uppercase tracking-wide text-subtle">
        Addressed to me
      </p>
      <ul className="m-0 list-none p-0">
        {waiting.map((notification) => (
          <li key={notification.id}>
            <button
              type="button"
              data-testid="chats-addressed-item"
              onClick={() => props.onOpen?.(notification)}
              className="flex w-full cursor-pointer items-start gap-1.5 px-3 py-2 text-left transition-colors hover:bg-panel-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
            >
              <Bot size={13} aria-hidden className="mt-0.5 shrink-0 text-accent" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium text-ink">
                  {notification.title}
                </span>
                <span className="block truncate text-[11px] text-muted">{notification.body}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ChatsView(props: {
  workspaceId: string;
  // Jump a file-linked Chat to where it lives: the file's side rail.
  onOpenFileChat: (thread: FileChatThreadRecord) => void;
  // The shell's normal file navigation path. Attachment chips use it when
  // present; tests/embedded surfaces may omit it and receive a titled chip.
  onOpenPath?: (path: string) => void;
  onError: (message: string) => void;
  // @-mention roster for this workspace (the user + available agents). When
  // provided, the composer offers autocomplete and messages render chips.
  mentionCandidates?: readonly MentionCandidate[];
  // "Addressed to me" inbox: agent asks / requests waiting on the user.
  addressedToMe?: readonly AgentNotification[];
  onOpenAddressed?: (notification: AgentNotification) => void;
  // Ephemeral presence/typing transport, present ONLY under collaboration.
  collaboration?: ChatPresenceCollaboration | null;
  // Where this view lives: the side panel (default) or a full editor tab.
  // The page variant centers the narrow surfaces in a reading column — the
  // thread/channel views already read as pages.
  variant?: "panel" | "page";
  // Expand-to-tab: the conversation to open once the overview is ready —
  // the shell hands the live surface's position to whichever instance mounts
  // next, so panel and tab feel like ONE chats surface. Applied once per
  // mount; workspace switches and later navigation behave exactly as before.
  initialNav?: ChatsNav;
  // Unsent drafts to restore alongside initialNav (same handoff, same
  // apply-once timing).
  initialDrafts?: ChatsDrafts;
  // Reports every navigation so the shell can seed the next mount (panel or
  // expanded tab) with this instance's current conversation.
  onNavChange?: (nav: ChatsNav) => void;
  // Reports every draft edit (ref-cheap in the shell) so unsent input
  // survives the panel/tab handoff.
  onDraftsChange?: (drafts: ChatsDrafts) => void;
}) {
  const { workspaceId, onNavChange, onDraftsChange } = props;
  const collaboration = props.collaboration ?? null;
  const mentionCandidates = props.mentionCandidates ?? [];
  const variant = props.variant ?? "panel";
  // Page variant: cap the list-like surfaces at the thread column's width.
  const pageColumn = variant === "page" ? "mx-auto w-full max-w-[640px]" : "";
  const [overview, setOverview] = useState<OverviewState>({ status: "loading" });
  const [nav, setNav] = useState<Nav>({ level: "channels" });
  const [channelThreads, setChannelThreads] = useState<ChannelThreadRecord[]>([]);
  const [feedPosts, setFeedPosts] = useState<Record<string, FeedPostData>>({});
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
  const [flashMessageId, setFlashMessageId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [newThreadBody, setNewThreadBody] = useState("");
  const [startingThread, setStartingThread] = useState(false);
  const [creatingChannel, setCreatingChannel] = useState<string | null>(null);
  // Direct messages (WS-MU-C3). The section renders only when collaboration
  // is on (signed in + relay) or a DM already exists locally — a solo user
  // sees none of it.
  const [dms, setDms] = useState<DmRecord[]>([]);
  const [dmAvailable, setDmAvailable] = useState(false);
  const [dmRecipients, setDmRecipients] = useState("");
  const [dmDraft, setDmDraft] = useState("");
  const [startingDm, setStartingDm] = useState(false);
  const startingDmRef = useRef(false);
  // MU-C4 shared channels. null = the sharing surface is unavailable (signed
  // out / listing failed) and every sharing affordance stays hidden — the
  // solo view is unchanged.
  const [channelShares, setChannelShares] = useState<ListChatChannelSharesResult | null>(null);
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
  // flips. These refs flip synchronously BEFORE the first await, so the second
  // call is ignored immediately.
  const sendingRef = useRef(false);
  const startingThreadRef = useRef(false);
  const liveToken = useRef(0);
  // A live thread can refresh repeatedly without changing navigation. Keep a
  // request sequence separate from the workspace/navigation liveness token so
  // an older activity response can never overwrite a newer one.
  const threadRefreshSeq = useRef(0);
  const channelRefreshSeq = useRef(0);
  // Per-(message, emoji) toggle sequence so overlapping reaction toggles resolve
  // in order (see runReactionToggle).
  const reactionSeq = useRef(new Map<string, number>());
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const messageNodes = useRef(new Map<string, HTMLElement>());

  const refreshOverview = useCallback(async () => {
    const token = ++liveToken.current;
    setOverview((current) =>
      current.status === "ready" ? current : { status: "loading" },
    );
    try {
      const [result, shares] = await Promise.all([
        bridge().listChatChannels({ workspaceId }),
        // Sharing is OPTIONAL: solo / signed-out workspaces simply render
        // without the sharing affordances.
        bridge()
          .listChatChannelShares({ workspaceId })
          .catch(() => null),
      ]);
      if (token !== liveToken.current) return;
      setChannelShares(shares);
      setSharesWorkspaceId(workspaceId);
      setOverview({
        status: "ready",
        channels: result.channels,
        fileThreads: result.fileThreads,
      });
    } catch (error) {
      if (token !== liveToken.current) return;
      setOverview({
        status: "unavailable",
        message: ipcErrorMessage(error, "Could not load Chats."),
      });
    }
  }, [workspaceId]);

  // DM sync: reconcile with the relay (auto-join received DM grants, push the
  // member's local ops, pull the peers') and refresh the list. Best-effort —
  // offline keeps the current list and the next pass retries. A late response
  // for a stale workspace/nav is dropped by the token guard.
  const refreshDms = useCallback(async () => {
    const token = liveToken.current;
    try {
      const result = await bridge().syncDms({ workspaceId });
      if (token !== liveToken.current) return;
      setDmAvailable(result.available);
      setDms(result.dms);
    } catch {
      // DMs are optional: Chats stays fully usable without them.
    }
  }, [workspaceId]);

  // Workspace switch: drop everything stale and reload from the top.
  useEffect(() => {
    liveToken.current += 1;
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
    setCreatingChannel(null);
    setChannelShares(null);
    setSharesWorkspaceId(null);
    setSharePanelOpen(false);
    setShareEmail("");
    setShareReadOnly(false);
    setJoiningShareId(null);
    setDms([]);
    setDmAvailable(false);
    setDmRecipients("");
    setDmDraft("");
    setOverview({ status: "loading" });
    void refreshOverview();
    void refreshDms();
    return () => {
      liveToken.current += 1;
    };
  }, [refreshDms, refreshOverview]);

  // Gentle DM poll while the view is open: the other side's messages arrive
  // by relay pull, and the sync is cursor-based (no changes = no work). While a
  // DM conversation is OPEN the inner 4s poll already runs a full syncDms pass,
  // so pause this outer poll then — otherwise viewing a DM doubles the
  // relay/sync cadence for no benefit.
  useEffect(() => {
    if (nav.level === "dm") return;
    const interval = setInterval(() => void refreshDms(), 5_000);
    return () => clearInterval(interval);
  }, [refreshDms, nav.level]);

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
    [applyChannelSnapshot, loadChannelSnapshot, props],
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

  const applyThreadSnapshot = useCallback(
    (threadId: string, snapshot: ThreadSnapshot) => {
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
      setChannelThreads((current) =>
        current.map((entry) =>
          entry.id === threadId ? { ...entry, unreadCount: 0 } : entry,
        ),
      );
      void bridge()
        .markChatThreadRead({ workspaceId, threadId, upToSequence })
        .catch(() => {
          // Mark-read is best-effort; the badge re-appears on next refresh if
          // the cursor write did not land.
        });
    },
    [workspaceId],
  );

  const openThread = useCallback(
    async (channel: ChatChannelRecord, thread: ChannelThreadRecord) => {
      const token = ++liveToken.current;
      const refreshSeq = ++threadRefreshSeq.current;
      setNav({ level: "thread", channel, thread });
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
        applyThreadSnapshot(thread.id, snapshot);
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
    [applyThreadSnapshot, loadThreadSnapshot, props],
  );

  // Main emits workspaceActivity for CLI writes, runner reports/failures, and
  // run-record completion. Treat it as an invalidation for whichever Chats
  // surface is open. Every response carries both the navigation token and a
  // per-surface request sequence so a slow refresh cannot repaint a newer one.
  useEffect(() => {
    if (nav.level === "thread") {
      const threadId = nav.thread.id;
      return bridge().onWorkspaceActivity(() => {
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
            applyThreadSnapshot(threadId, snapshot);
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
      });
    }
    if (nav.level === "channel") {
      const channelId = nav.channel.id;
      return bridge().onWorkspaceActivity(() => {
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
      });
    }
    return undefined;
  }, [
    applyChannelSnapshot,
    applyThreadSnapshot,
    loadChannelSnapshot,
    loadThreadSnapshot,
    nav,
  ]);

  // The anti-forum move: typing in the channel composer STARTS the chat.
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
      });
      if (token !== liveToken.current) return;
      setNewThreadBody("");
      setNav({ level: "thread", channel, thread: result.thread });
      setMessages([result.message]);
      setReactions([]);
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
  }, [nav, newThreadBody, props, startingThread, workspaceId]);

  const sendMessage = useCallback(async () => {
    if (nav.level !== "thread") return;
    const trimmedBody = composer.trim();
    const resolvingMessageId = resolveTargetMessageId;
    const body =
      trimmedBody.length > 0
        ? trimmedBody
        : resolvingMessageId !== null
          ? "Resolved ✓"
          : "";
    if (body.length === 0 || sending || sendingRef.current) return;
    const parentMessageId = replyTarget?.messageId;
    const token = liveToken.current;
    sendingRef.current = true;
    setSending(true);
    let sentMessage: ChatMessageRecord | null = null;
    try {
      const result = await bridge().sendChatMessage({
        workspaceId,
        threadId: nav.thread.id,
        ...(parentMessageId ? { parentMessageId } : {}),
        body,
      });
      if (token !== liveToken.current) return;
      sentMessage = result.message;
      let resolvedDecision: ChatDecisionRecord | null = null;
      if (resolvingMessageId) {
        const resolution = await bridge().resolveChatDecision({
          workspaceId,
          threadId: nav.thread.id,
          messageId: resolvingMessageId,
          resolvedByMessageId: result.message.id,
        });
        if (token !== liveToken.current) return;
        resolvedDecision = resolution.decision;
      }
      setMessages((current) => [...current, result.message]);
      if (resolvedDecision) {
        setDecisions((current) =>
          current.map((decision) =>
            decision.messageId === resolvedDecision.messageId
              ? resolvedDecision
              : decision,
          ),
        );
        setChannelThreads((current) =>
          current.map((thread) =>
            thread.id === nav.thread.id
              ? {
                  ...thread,
                  openDecisionCount: Math.max(0, (thread.openDecisionCount ?? 0) - 1),
                }
              : thread,
          ),
        );
      }
      setComposer("");
      setReplyTarget(null);
      setResolveTargetMessageId(null);
      messagesEndRef.current?.scrollIntoView({ block: "end" });
    } catch (error) {
      if (token !== liveToken.current) return;
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
        setComposer("");
        setReplyTarget(null);
        setResolveTargetMessageId(null);
        props.onError(
          ipcErrorMessage(error, "Your reply was sent, but the decision is still open."),
        );
      } else {
        props.onError(ipcErrorMessage(error, "Could not send that message."));
      }
    } finally {
      // Unconditional reset (LinkedChats precedent): navigation bumps the
      // token without resetting `sending`, and the token guard on the READ
      // above already prevents concurrent sends.
      sendingRef.current = false;
      setSending(false);
    }
  }, [composer, nav, props, replyTarget, resolveTargetMessageId, sending, workspaceId]);

  // Reactions (WS-MU-C2): optimistic add/remove of the viewer's own reaction,
  // then reconcile to the server's canonical list (which carries the real
  // reactionId and any peer reactions). Guarded by the liveness token so a
  // slow response never repaints a thread the user already left.
  const toggleReaction = useCallback(
    (input: { messageId: string; emoji: string; nextState: "added" | "removed" }) => {
      if (nav.level !== "thread") return;
      runReactionToggle(
        {
          workspaceId,
          threadId: nav.thread.id,
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
    [nav, props, viewerAuthorId, workspaceId],
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

  const loadDmConversation = useCallback(
    async (dm: DmRecord, token: number) => {
      if (!dm.threadId) return;
      const [result, reactionResult] = await Promise.all([
        bridge().listChatMessages({ workspaceId, threadId: dm.threadId }),
        bridge().listChatReactions({ workspaceId, threadId: dm.threadId }),
      ]);
      if (token !== liveToken.current) return;
      setMessages(result.messages);
      setReactions(reactionResult.reactions);
      setViewerAuthorId(reactionResult.viewerAuthorId);
      void bridge()
        .markChatThreadRead({
          workspaceId,
          threadId: dm.threadId,
          upToSequence: result.messages.length,
        })
        .catch(() => {
          // Best-effort, like the thread view.
        });
    },
    [workspaceId],
  );

  const openDm = useCallback(
    async (dm: DmRecord) => {
      const token = ++liveToken.current;
      setNav({ level: "dm", dm });
      setMessages([]);
      setReactions([]);
      setDecisions([]);
      setAttachments([]);
      setRunRecords({});
      setReplyTarget(null);
      setResolveTargetMessageId(null);
      setMessagesLoading(true);
      try {
        await loadDmConversation(dm, token);
        if (token !== liveToken.current) return;
        setDms((current) =>
          current.map((entry) =>
            entry.channelId === dm.channelId ? { ...entry, unreadCount: 0 } : entry,
          ),
        );
        requestAnimationFrame(() => {
          if (token === liveToken.current) {
            messagesEndRef.current?.scrollIntoView({ block: "end" });
          }
        });
      } catch (error) {
        if (token !== liveToken.current) return;
        props.onError(ipcErrorMessage(error, "Could not load this conversation."));
      } finally {
        if (token === liveToken.current) setMessagesLoading(false);
      }
    },
    [loadDmConversation, props],
  );

  // Expand-to-tab seam, outbound: report where this view is (and what's
  // typed) so the shell can seed the next mount with this instance's current
  // conversation and unsent drafts. While a seed is still PENDING the
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
    onDraftsChange?.({ composer, newThreadBody, dmRecipients, dmDraft });
  }, [composer, dmDraft, dmRecipients, newThreadBody, onDraftsChange]);

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
      if (seed.level === "channel") void openChannel(seed.channel);
      else if (seed.level === "thread") void openThread(seed.channel, seed.thread);
      else if (seed.level === "dm") void openDm(seed.dm);
      else if (seed.level === "dm-new") setNav({ level: "dm-new" });
    }
    const drafts = props.initialDrafts;
    if (drafts) {
      setComposer(drafts.composer);
      setNewThreadBody(drafts.newThreadBody);
      setDmRecipients(drafts.dmRecipients);
      setDmDraft(drafts.dmDraft);
    }
  }, [
    openChannel,
    openDm,
    openThread,
    overview.status,
    props.initialDrafts,
    props.initialNav,
  ]);

  // While a DM is open, poll: sync (push the member's ops, pull the peers')
  // then reload the conversation. Token-guarded so a stale response never
  // repaints a view the user already left.
  useEffect(() => {
    if (nav.level !== "dm" || !nav.dm.threadId) return;
    const dm = nav.dm;
    const token = liveToken.current;
    const interval = setInterval(() => {
      void (async () => {
        try {
          await bridge().syncDms({ workspaceId });
          if (token !== liveToken.current) return;
          await loadDmConversation(dm, token);
        } catch {
          // Offline: keep the conversation as-is; the next tick retries.
        }
      })();
    }, 4_000);
    return () => clearInterval(interval);
  }, [loadDmConversation, nav, workspaceId]);

  const sendDmMessage = useCallback(async () => {
    if (nav.level !== "dm" || !nav.dm.threadId || !nav.dm.connected) return;
    const body = composer.trim();
    if (body.length === 0 || sending || sendingRef.current) return;
    const threadId = nav.dm.threadId;
    const token = liveToken.current;
    sendingRef.current = true;
    setSending(true);
    try {
      const result = await bridge().sendChatMessage({ workspaceId, threadId, body });
      if (token !== liveToken.current) return;
      setMessages((current) => [...current, result.message]);
      setComposer("");
      messagesEndRef.current?.scrollIntoView({ block: "end" });
    } catch (error) {
      if (token !== liveToken.current) return;
      props.onError(ipcErrorMessage(error, "Could not send that message."));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [composer, nav, props, sending, workspaceId]);

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
      const result = await bridge().startDm({ workspaceId, recipients, body });
      if (token !== liveToken.current) return;
      setDmDraft("");
      setDmRecipients("");
      setDms((current) => [
        result.dm,
        ...current.filter((dm) => dm.channelId !== result.dm.channelId),
      ]);
      void openDm(result.dm);
    } catch (error) {
      if (token !== liveToken.current) return;
      props.onError(ipcErrorMessage(error, "Could not start that conversation."));
    } finally {
      startingDmRef.current = false;
      setStartingDm(false);
    }
  }, [dmDraft, dmRecipients, openDm, props, startingDm, workspaceId]);

  // MU-C4 derived lookups: a channel matches a grant by its WIRE id.
  const joinedByWire = useMemo(() => {
    const map = new Map<string, JoinedSharedChannelRow>();
    for (const row of channelShares?.joined ?? []) map.set(row.channelWireId, row);
    return map;
  }, [channelShares]);
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
    const joinedIds = new Set(channelShares.joined.map((row) => row.shareId));
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

  // Cross-user co-presence for the open channel/thread turns on two decisions
  // per conversation — the SCOPE it lands in and the TOPIC both sides key on.
  //
  //  • SCOPE — where the presence lands on the relay. A PARTICIPANT viewing a
  //    channel shared TO them must publish into a SHARE scope keyed by their
  //    grant's shareId: the relay maps a {kind:"share"} request to the GRANTER's
  //    workspace, so the owner (workspace scope) and every participant (share
  //    scope) fan into ONE relay scope and see each other. An owner of a shared
  //    channel — and any plain local channel — uses the plain workspace scope.
  //
  //  • TOPIC — the per-conversation key BOTH sides must agree on. A channel's
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
  // grant, so it folds into the SAME derivation: its TOPIC is the DM channel's
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
  // and everything the viewer OWNS — plain channels and owned DMs — pins to the
  // workspace. The transport is rebuilt ONLY when this changes, so usePresence
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
    const scope: PresenceScope = { kind: "share", shareId: scopeShareId };
    return collaboration.transportForScope(scope);
  }, [collaboration, scopeShareId, workspacePresenceTransport]);
  // Presence stays dormant until the scope is DEFINITIVELY resolved for the
  // active conversation in the CURRENT workspace: a joined channel's scope is
  // derived from channelShares, so publishing before that share state loads
  // would land a participant in their OWN workspace scope (convergence lost)
  // and a workspace switch could briefly publish under the previous workspace's
  // scope. Gating on (channelShares loaded for THIS workspaceId) closes both.
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
    const token = liveToken.current;
    const shares = await bridge()
      .listChatChannelShares({ workspaceId })
      .catch(() => null);
    if (token !== liveToken.current) return;
    setChannelShares(shares);
    setSharesWorkspaceId(workspaceId);
  }, [workspaceId]);

  const submitShare = useCallback(async () => {
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
  }, [nav, props, refreshShares, shareBusy, shareEmail, shareReadOnly, workspaceId]);

  const revokeShare = useCallback(
    async (shareId: string) => {
      const token = liveToken.current;
      try {
        await bridge().revokeRelayShare({ shareId });
        if (token !== liveToken.current) return;
        await refreshShares();
      } catch (error) {
        if (token !== liveToken.current) return;
        props.onError(ipcErrorMessage(error, "Could not remove that person."));
      }
    },
    [props, refreshShares],
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
        // refreshOverview bumps liveToken ITSELF, so a token-equality check
        // here can never pass after a successful join and would leave every
        // other Join button dead for the session. A workspace switch already
        // clears joiningShareId in its own effect, so resetting late is
        // harmless there.
        setJoiningShareId(null);
      }
    },
    [joiningShareId, props, refreshOverview, workspaceId],
  );

  const leaveShared = useCallback(
    async (shareId: string) => {
      const token = liveToken.current;
      try {
        await bridge().leaveSharedChannel({ workspaceId, shareId });
        if (token !== liveToken.current) return;
        setNav({ level: "channels" });
        await refreshOverview();
      } catch (error) {
        if (token !== liveToken.current) return;
        props.onError(ipcErrorMessage(error, "Could not leave that channel."));
      }
    },
    [props, refreshOverview, workspaceId],
  );

  const createChannel = useCallback(
    async (name: string) => {
      const trimmed = name.trim();
      if (trimmed.length === 0) return;
      const token = liveToken.current;
      try {
        const result = await bridge().createChatChannel({
          workspaceId,
          name: trimmed,
        });
        if (token !== liveToken.current) return;
        setCreatingChannel(null);
        setOverview((current) =>
          current.status === "ready"
            ? { ...current, channels: [...current.channels, result.channel] }
            : current,
        );
        void openChannel(result.channel);
      } catch (error) {
        if (token !== liveToken.current) return;
        props.onError(ipcErrorMessage(error, "Could not create that channel."));
      }
    },
    [openChannel, props, workspaceId],
  );

  const goBack = useCallback(() => {
    liveToken.current += 1;
    if (nav.level === "thread") {
      // Re-open the channel so thread ordering/badges reflect what happened
      // inside the thread.
      void openChannel(nav.channel);
    } else if (nav.level === "channel") {
      setNav({ level: "channels" });
      setChannelThreads([]);
      setFeedPosts({});
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
  }, [nav, openChannel, refreshDms, refreshOverview]);

  const reactionsByMessage = useMemo(() => {
    const result = new Map<string, ChatReactionRecord[]>();
    for (const reaction of reactions) {
      const current = result.get(reaction.messageId);
      if (current) current.push(reaction);
      else result.set(reaction.messageId, [reaction]);
    }
    return result;
  }, [reactions]);

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

  const messagesById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages],
  );

  const scrollToMessage = useCallback((messageId: string) => {
    const node = messageNodes.current.get(messageId);
    if (!node) return;
    node.scrollIntoView({ block: "center" });
    setFlashMessageId(messageId);
    const token = liveToken.current;
    window.setTimeout(() => {
      if (token === liveToken.current) {
        setFlashMessageId((current) => (current === messageId ? null : current));
      }
    }, 1_200);
  }, []);

  const beginReply = useCallback((message: ChatMessageRecord) => {
    setReplyTarget({
      messageId: message.id,
      authorLabel: chatAuthorLabel(message),
    });
  }, []);

  const beginResolve = useCallback((message: ChatMessageRecord) => {
    setResolveTargetMessageId(message.id);
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
      !dispatchState.liveRun ||
      dispatchActionBusy
    ) {
      return;
    }
    const token = liveToken.current;
    const refreshSeq = ++threadRefreshSeq.current;
    const threadId = nav.thread.id;
    setDispatchActionBusy(true);
    try {
      await bridge().stopAgentRun({ workspaceId });
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
  }, [dispatchActionBusy, dispatchState.liveRun, nav, props, workspaceId]);

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
  }, [dispatchActionBusy, dispatchState.paused, nav, props, workspaceId]);

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
              className="h-7 w-full rounded-md border border-line bg-bg px-2 text-[13px] text-ink placeholder:text-subtle focus:outline focus:outline-2 focus:-outline-offset-1 focus:outline-accent"
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
          trailing={<PresenceFaces others={presence.others} />}
        />
        {/* Presence (MU-C1): "viewing" faces + "typing…" for this DM, keyed by
            its channelWireId and fanned out through the SAME shareForRecipient
            grant gate. Dormant (calm header, no fake liveness) when solo. */}
        <div className={`flex min-h-0 flex-1 flex-col ${pageColumn}`}>
          {dm.threadId ? (
            <ChatMessageList
              testIdPrefix="chats-dm"
              messages={messages}
              loading={messagesLoading}
              emptyLabel="No messages yet."
              endRef={messagesEndRef}
              mentionCandidates={mentionCandidates}
              reactionControls={{
                reactions,
                viewerAuthorId,
                onToggle: toggleReaction,
              }}
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
      </div>
    );
  }

  if (nav.level === "thread") {
    const threadJoined = joinedFor(nav.channel);
    const threadLocked =
      threadJoined !== null &&
      (threadJoined.access === "read-only" || threadJoined.ended);
    const openingMessage = messages[0] ?? null;
    const comments = messages.slice(1);
    const reactionControls: ChatReactionControls = {
      reactions,
      viewerAuthorId,
      onToggle: toggleReaction,
    };
    return (
      <div
        data-testid="chats-thread-view"
        data-variant={variant}
        className="flex min-h-0 flex-1 flex-col"
        onKeyDownCapture={onKeyDownCapture}
      >
        <BackHeader
          label={nav.thread.title}
          testId="chats-thread"
          onBack={goBack}
          action={
            dispatchState.liveRun ? (
              <button
                type="button"
                data-testid="chats-stop-agent-run"
                aria-label="Stop agent run"
                title="Stop agent run"
                disabled={dispatchActionBusy}
                onClick={() => void stopThreadRun()}
                className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-line px-1.5 font-mono text-[10px] text-muted hover:bg-line/50 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default disabled:opacity-50"
              >
                <Square size={8} fill="currentColor" aria-hidden />
                Stop
              </button>
            ) : undefined
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
            <button
              type="button"
              data-testid="chats-resume-dispatch"
              disabled={dispatchActionBusy}
              onClick={() => void resumeThreadDispatch()}
              className="rounded px-1 text-muted underline decoration-line underline-offset-2 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default disabled:opacity-50"
            >
              Resume
            </button>
          </div>
        ) : dispatchState.liveRun || dispatchState.pendingCount > 0 ? (
          <div
            data-testid="chats-dispatch-status"
            className="flex h-7 shrink-0 items-center justify-center border-b border-line bg-panel-2/35 px-3 font-mono text-[10px] text-subtle"
          >
            {dispatchState.liveRun
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
            {messagesLoading ? (
              <p className="m-0 pt-4 text-center text-[11px] text-subtle">Loading...</p>
            ) : openingMessage === null ? (
              <p className="m-0 pt-4 text-center text-[11px] text-subtle">
                No messages yet.
              </p>
            ) : (
              <>
                <article
                  ref={(node) => {
                    if (node) messageNodes.current.set(openingMessage.id, node);
                    else messageNodes.current.delete(openingMessage.id);
                  }}
                  data-testid="chats-message"
                  data-message-id={openingMessage.id}
                  data-author-kind={openingMessage.authorKind}
                  className={`group pt-5 transition-shadow ${
                    flashMessageId === openingMessage.id
                      ? "rounded-lg ring-2 ring-agent/30 ring-offset-2 ring-offset-bg"
                      : ""
                  }`}
                >
                  <p
                    data-testid="chats-thread-eyebrow"
                    className="m-0 font-mono text-[10px] uppercase tracking-wide text-subtle"
                  >
                    {nav.channel.kind === "agent"
                      ? "My agent · thread"
                      : `#${nav.channel.name} · thread`}
                  </p>
                  <h1
                    data-testid="chats-thread-post-title"
                    className="mb-0 mt-2 text-balance font-serif text-[22px] font-semibold leading-tight text-ink"
                  >
                    {nav.thread.title}
                  </h1>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span
                      data-testid="chats-message-author"
                      data-author-kind={openingMessage.authorKind}
                      className={`text-[13px] font-medium ${
                        openingMessage.authorKind === "agent" ? "text-agent" : "text-ink"
                      }`}
                    >
                      {chatAuthorLabel(openingMessage)}
                    </span>
                    {openingMessage.authorKind === "agent" ? (
                      <AgentBadge testIdPrefix="chats-message" />
                    ) : null}
                    <time
                      data-testid="chats-message-time"
                      dateTime={formatChatTime(openingMessage.createdAtMs).iso}
                      title={formatChatTime(openingMessage.createdAtMs).iso}
                      className="font-mono text-[10px] text-subtle"
                    >
                      {formatChatTime(openingMessage.createdAtMs).label}
                    </time>
                  </div>
                  <p
                    data-testid="chats-message-body"
                    className="mb-0 mt-3 select-text cursor-text whitespace-pre-wrap break-words text-[14px] leading-relaxed text-ink"
                  >
                    {mentionCandidates.length > 0 ? (
                      <MentionText
                        body={openingMessage.body}
                        candidates={mentionCandidates}
                        testId="chats-message-body"
                      />
                    ) : (
                      openingMessage.body
                    )}
                  </p>
                  {(attachmentsByMessage.get(openingMessage.id) ?? []).length > 0 ? (
                    <div
                      data-testid="chats-message-attachments"
                      className="mt-3 flex flex-wrap items-center gap-1.5"
                    >
                      {(attachmentsByMessage.get(openingMessage.id) ?? []).map(
                        (attachment) => (
                          <AttachmentChip
                            key={attachment.attachmentId}
                            attachment={attachment}
                            onOpenPath={props.onOpenPath}
                          />
                        ),
                      )}
                    </div>
                  ) : null}
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <MessageReactions
                      testIdPrefix="chats"
                      messageId={openingMessage.id}
                      records={reactionsByMessage.get(openingMessage.id) ?? []}
                      controls={reactionControls}
                      flush
                    />
                    {decisionsByMessage.get(openingMessage.id) ? (
                      <DecisionStatus
                        decision={decisionsByMessage.get(openingMessage.id)!}
                        onResolve={
                          decisionsByMessage.get(openingMessage.id)?.state === "open"
                            ? () => beginResolve(openingMessage)
                            : undefined
                        }
                        testIdPrefix="chats-message"
                      />
                    ) : null}
                    {runRecords[openingMessage.id] ? (
                      <RunChip run={runRecords[openingMessage.id]} />
                    ) : null}
                  </div>
                </article>

                <div
                  data-testid="chats-comments-divider"
                  className="mb-1 mt-5 flex items-center gap-2"
                >
                  <span className="font-mono text-[10px] uppercase tracking-wide text-subtle">
                    Comments
                  </span>
                  <span aria-hidden className="h-px flex-1 bg-line" />
                </div>

                <ol data-testid="chats-comments" className="m-0 list-none space-y-3 p-0 pt-2">
                  {comments.map((comment, index) => {
                    const previousMessage = messages[index];
                    const parent = comment.parentMessageId
                      ? messagesById.get(comment.parentMessageId)
                      : undefined;
                    const showReplyContext =
                      comment.parentMessageId !== undefined &&
                      comment.parentMessageId !== previousMessage?.id;
                    const commentTime = formatChatTime(comment.createdAtMs);
                    const commentDecision = decisionsByMessage.get(comment.id);
                    const commentAttachments = attachmentsByMessage.get(comment.id) ?? [];
                    const isAgent = comment.authorKind === "agent";
                    return (
                      <li
                        key={comment.id}
                        ref={(node) => {
                          if (node) messageNodes.current.set(comment.id, node);
                          else messageNodes.current.delete(comment.id);
                        }}
                        data-testid="chats-message"
                        data-message-id={comment.id}
                        data-author-kind={comment.authorKind}
                        className={`group flex flex-col transition-shadow ${
                          flashMessageId === comment.id
                            ? "rounded-xl ring-2 ring-agent/30 ring-offset-2 ring-offset-bg"
                            : ""
                        }`}
                      >
                        {showReplyContext ? (
                          <button
                            type="button"
                            data-testid="chats-reply-context"
                            onClick={() => scrollToMessage(comment.parentMessageId ?? "")}
                            className="mb-1 w-fit rounded px-2 text-left font-mono text-[10px] text-subtle hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                          >
                            ↳ replying to {parent ? chatAuthorLabel(parent) : "message"}
                          </button>
                        ) : null}
                        <div
                          data-testid="chats-comment-bubble"
                          style={
                            isAgent
                              ? {
                                  borderLeftColor:
                                    "color-mix(in oklab, var(--dohc-agent) 55%, var(--dohc-line))",
                                }
                              : undefined
                          }
                          className={`w-fit max-w-[92%] rounded-xl border border-line bg-panel-2 px-3.5 py-2 ${
                            isAgent ? "border-l-2" : ""
                          }`}
                        >
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span
                              data-testid="chats-message-author"
                              data-author-kind={comment.authorKind}
                              className={`text-[13px] font-semibold ${
                                isAgent ? "text-agent" : "text-ink"
                              }`}
                            >
                              {chatAuthorLabel(comment)}
                            </span>
                            {isAgent ? <AgentBadge testIdPrefix="chats-comment" /> : null}
                          </div>
                          <p
                            data-testid="chats-message-body"
                            className="mb-0 mt-0.5 select-text cursor-text whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink"
                          >
                            {mentionCandidates.length > 0 ? (
                              <MentionText
                                body={comment.body}
                                candidates={mentionCandidates}
                                testId="chats-message-body"
                              />
                            ) : (
                              comment.body
                            )}
                          </p>
                          {commentAttachments.length > 0 ? (
                            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                              {commentAttachments.map((attachment) => (
                                <AttachmentChip
                                  key={attachment.attachmentId}
                                  attachment={attachment}
                                  onOpenPath={props.onOpenPath}
                                />
                              ))}
                            </div>
                          ) : null}
                          {commentDecision ? (
                            <div className="mt-2">
                              <DecisionStatus
                                decision={commentDecision}
                                onResolve={
                                  commentDecision.state === "open"
                                    ? () => beginResolve(comment)
                                    : undefined
                                }
                                testIdPrefix="chats-comment"
                              />
                            </div>
                          ) : null}
                        </div>
                        <div className="flex flex-wrap items-center gap-3 px-2 pt-1 font-mono text-[11px] text-subtle">
                          <MessageReactions
                            testIdPrefix="chats"
                            messageId={comment.id}
                            records={reactionsByMessage.get(comment.id) ?? []}
                            controls={reactionControls}
                            flush
                          />
                          <button
                            type="button"
                            data-testid="chats-comment-reply"
                            onClick={() => beginReply(comment)}
                            className="rounded hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                          >
                            Reply
                          </button>
                          {runRecords[comment.id] ? (
                            <RunChip run={runRecords[comment.id]} />
                          ) : null}
                          <time
                            data-testid="chats-message-time"
                            dateTime={commentTime.iso}
                            title={commentTime.iso}
                          >
                            {commentTime.label}
                          </time>
                        </div>
                      </li>
                    );
                  })}
                </ol>
                <div ref={messagesEndRef} />
              </>
            )}
          </div>
        </div>
        <TypingIndicator
          names={presence.typingNames}
          className="mx-auto w-full max-w-[640px] px-3 sm:px-4"
        />
        {threadLocked ? (
          <ComposerNotice testId="chats-readonly-note">
            {threadJoined.ended
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
                <span className="min-w-0 flex-1">
                  Resolving decision — your reply records it ·
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
                  }}
                  className="rounded px-1 text-subtle hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
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
                  className="rounded px-1 text-subtle hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
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

  if (nav.level === "channel") {
    const channelJoined = joinedFor(nav.channel);
    const channelLocked =
      channelJoined !== null && (channelJoined.access === "read-only" || channelJoined.ended);
    const channelGrants = nav.channel.wireId
      ? grantedByWire.get(nav.channel.wireId) ?? []
      : [];
    // Sharing an OWNED channel needs the sharing surface up; a joined channel
    // is never re-shareable from here (only its owner manages members).
    const canShare =
      nav.channel.kind !== "agent" &&
      channelShares !== null &&
      channelJoined === null &&
      !!nav.channel.wireId;
    return (
      <div
        data-testid="chats-channel-view"
        data-variant={variant}
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
                title="Share this channel"
                onClick={() => setSharePanelOpen((open) => !open)}
                className="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded border border-line px-1.5 text-[10px] text-muted hover:bg-line/50 hover:text-ink"
              >
                <Users size={11} aria-hidden />
                {channelGrants.length > 0 ? `Shared · ${channelGrants.length}` : "Share"}
              </button>
            ) : undefined
          }
        />
        {channelJoined !== null ? (
          <div
            data-testid="chats-joined-banner"
            className="flex shrink-0 items-center gap-1.5 border-b border-line bg-panel-2/40 px-3 py-1.5"
          >
            <Users size={11} aria-hidden className="shrink-0 text-subtle" />
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
            {channelGrants.length > 0 ? (
              <ul className="m-0 mb-2 list-none p-0">
                {channelGrants.map((grant) => (
                  <li
                    key={grant.shareId}
                    data-testid="chats-share-member"
                    className="flex items-center gap-1.5 py-0.5"
                  >
                    <span className="min-w-0 flex-1 truncate text-[11px] text-ink">
                      {grant.recipientEmail ?? "Invited"}
                    </span>
                    {grant.access === "read-only" ? (
                      <span className="shrink-0 text-[10px] text-subtle">read-only</span>
                    ) : null}
                    <button
                      type="button"
                      data-testid="chats-share-revoke"
                      onClick={() => void revokeShare(grant.shareId)}
                      className="h-5 shrink-0 cursor-pointer rounded border border-line px-1.5 text-[10px] text-muted hover:bg-line/50 hover:text-ink"
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
                Share with email
              </label>
              <input
                id="chats-share-email"
                data-testid="chats-share-email"
                type="email"
                value={shareEmail}
                maxLength={320}
                placeholder="teammate@example.com"
                onChange={(event) => setShareEmail(event.target.value)}
                className="h-6 min-w-0 flex-1 rounded border border-line bg-bg px-2 text-[11px] text-ink placeholder:text-subtle focus:outline focus:outline-2 focus:-outline-offset-1 focus:outline-accent"
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
                disabled={shareBusy || shareEmail.trim().length === 0}
                className="h-6 shrink-0 cursor-pointer rounded border border-line px-2 text-[10px] text-muted hover:bg-line/50 hover:text-ink disabled:cursor-default disabled:opacity-50"
              >
                Share
              </button>
            </form>
            <p className="mb-0 mt-1 text-[10px] leading-4 text-subtle">
              They see this whole channel and can post in it{shareReadOnly ? " (view only)" : ""}.
              You can remove anyone later.
            </p>
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div
            data-testid="chats-feed-column"
            className="mx-auto w-full max-w-[640px] px-3 pb-16 sm:px-4"
          >
            {!channelLocked ? (
              <div className="mb-4 mt-4">
                <MentionComposer
                  testIdPrefix="chats-new-thread"
                  composerId="chats-new-thread-composer"
                  value={newThreadBody}
                  sending={startingThread}
                  surface="post"
                  placeholder={
                    nav.channel.kind === "agent"
                      ? "Message your agent…"
                      : `Start a post in #${nav.channel.name}…`
                  }
                  sendLabel="Start post"
                  candidates={mentionCandidates}
                  onChange={setNewThreadBody}
                  onSend={() => void startThread()}
                />
              </div>
            ) : null}
            {threadsLoading ? (
              <p className="m-0 pt-4 text-center text-[11px] text-subtle">Loading...</p>
            ) : channelThreads.length === 0 ? (
              <div
                data-testid="chats-channel-empty"
                className="flex flex-col items-center justify-center gap-1 px-4 py-12 text-center"
              >
                <MessagesSquare size={16} aria-hidden className="text-subtle" />
                <span className="text-xs text-muted">Nothing here yet.</span>
                <span className="text-[11px] text-subtle">
                  {channelLocked
                    ? "There are no posts to read."
                    : nav.channel.kind === "agent"
                      ? "Ask for a change, a summary, or a plan — your agent replies here."
                      : "Start a post above."}
                </span>
              </div>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-3 p-0">
                {channelThreads.map((thread) => {
                  const post = feedPosts[thread.id] ?? {
                    openingMessage: null,
                    reactions: [],
                    viewerAuthorId: "",
                  };
                  return (
                    <PostCard
                      key={thread.id}
                      thread={thread}
                      data={post}
                      reactionControls={{
                        reactions: post.reactions,
                        viewerAuthorId: post.viewerAuthorId,
                        onToggle: (input) => toggleFeedReaction(thread.id, input),
                      }}
                      onOpen={() => void openThread(nav.channel, thread)}
                    />
                  );
                })}
              </ul>
            )}
          </div>
        </div>
        {channelLocked ? (
          <ComposerNotice testId="chats-readonly-note">
            {channelJoined.ended
              ? "This channel is no longer shared with you. You can still read it."
              : "This channel is read-only for you."}
          </ComposerNotice>
        ) : null}
      </div>
    );
  }

  return (
    <div
      data-testid="chats-view"
      data-variant={variant}
      className="flex min-h-0 flex-1 flex-col"
      onKeyDownCapture={onKeyDownCapture}
    >
      <div className={`min-h-0 flex-1 overflow-y-auto ${pageColumn}`}>
        <AddressedToMe
          notifications={props.addressedToMe ?? []}
          onOpen={props.onOpenAddressed}
        />
        {agentChannel ? (
          <section data-testid="chats-my-agent-section" aria-label="My agent">
            <p className="mb-0 mt-3 px-3 text-[10px] font-semibold uppercase tracking-wide text-subtle">
              My agent
            </p>
            <button
              type="button"
              data-testid="chats-my-agent"
              data-channel-id={agentChannel.id}
              onClick={() => void openChannel(agentChannel)}
              className="flex w-full cursor-pointer items-center gap-1.5 border-b border-line px-3 py-2 text-left transition-colors hover:bg-panel-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
            >
              <span
                data-testid="chats-my-agent-glyph"
                aria-hidden
                className="shrink-0 font-mono text-[13px] text-agent"
              >
                ◈
              </span>
              <span
                data-testid="chats-my-agent-name"
                className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink"
              >
                My agent
              </span>
              <AgentPresenceHint
                activity={agentSummaryActivity}
                testId="chats-my-agent-presence"
              />
              <UnreadPill count={agentChannel.unreadCount} testId="chats-my-agent-unread" />
            </button>
          </section>
        ) : null}
        <p
          data-testid="chats-channels-heading"
          className="mb-0 mt-3 px-3 text-[10px] font-semibold uppercase tracking-wide text-subtle"
        >
          Channels
        </p>
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
              <li key={channel.id} className="border-b border-line">
                <button
                  type="button"
                  data-testid="chats-channel"
                  data-channel-id={channel.id}
                  data-channel-slug={channel.slug}
                  onClick={() => void openChannel(channel)}
                  className="flex w-full cursor-pointer items-center gap-1.5 px-3 py-2 text-left transition-colors hover:bg-panel-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
                >
                  <Hash size={13} aria-hidden className="shrink-0 text-subtle" />
                  <span className="min-w-0 flex-1">
                    <span
                      data-testid="chats-channel-name"
                      className="block truncate text-[12px] font-medium text-ink"
                    >
                      {channel.name}
                    </span>
                    <span className="block truncate text-[10px] text-subtle">
                      {channel.threadCount === 1
                        ? "1 chat"
                        : `${channel.threadCount} chats`}
                      {sharedLabel ? (
                        <span data-testid="chats-channel-shared"> · {sharedLabel}</span>
                      ) : null}
                    </span>
                  </span>
                  {sharedLabel ? (
                    <Users size={11} aria-hidden className="shrink-0 text-subtle" />
                  ) : null}
                  <UnreadPill count={channel.unreadCount} testId="chats-channel-unread" />
                </button>
              </li>
            );
          })}
        </ul>
        {dmAvailable || dms.length > 0 ? (
          <div data-testid="chats-dms-section">
            <p className="mb-0 mt-3 px-3 text-[10px] font-semibold uppercase tracking-wide text-subtle">
              Direct messages
            </p>
            <ul className="m-0 list-none p-0">
              {dms.map((dm) => (
                <li key={dm.channelId} className="border-b border-line">
                  <button
                    type="button"
                    data-testid="chats-dm-item"
                    data-channel-id={dm.channelId}
                    onClick={() => void openDm(dm)}
                    className="flex w-full cursor-pointer items-center gap-1.5 px-3 py-2 text-left transition-colors hover:bg-panel-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
                  >
                    <AtSign size={13} aria-hidden className="shrink-0 text-subtle" />
                    <span className="min-w-0 flex-1">
                      <span
                        data-testid="chats-dm-name"
                        className="block truncate text-[12px] font-medium text-ink"
                      >
                        {dm.peerLabel}
                      </span>
                      <span className="block text-[10px] text-subtle">
                        {dm.connected ? "Direct message" : "Ended"}
                      </span>
                    </span>
                    <UnreadPill count={dm.unreadCount} testId="chats-dm-unread" />
                  </button>
                </li>
              ))}
            </ul>
            {dmAvailable ? (
              <div className="px-3 py-1.5">
                <button
                  type="button"
                  data-testid="chats-new-dm"
                  onClick={() => {
                    // Always start compose from a clean slate — never inherit a
                    // recipient/draft left over from a previous compose.
                    setDmRecipients("");
                    setDmDraft("");
                    setNav({ level: "dm-new" });
                  }}
                  className="flex h-7 w-full cursor-pointer items-center justify-center gap-1.5 rounded-md border border-line text-[11px] text-muted hover:bg-line/50 hover:text-ink"
                >
                  <Plus size={12} aria-hidden />
                  New message
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
        {receivedNotJoined.length > 0 ? (
          <div data-testid="chats-shared-with-you">
            <p className="mb-0 mt-3 px-3 text-[10px] font-semibold uppercase tracking-wide text-subtle">
              Shared with you
            </p>
            <ul className="m-0 list-none p-0">
              {receivedNotJoined.map((row) => (
                <li key={row.shareId} className="border-b border-line">
                  <div className="flex items-center gap-1.5 px-3 py-2">
                    <Users size={13} aria-hidden className="shrink-0 text-subtle" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-medium text-ink">
                        A channel from {row.granterEmail ?? "a teammate"}
                      </span>
                      <span className="block text-[10px] text-subtle">
                        {row.access === "read-only"
                          ? "You can read it"
                          : "You can read and post"}
                      </span>
                    </span>
                    <button
                      type="button"
                      data-testid="chats-join-shared"
                      disabled={joiningShareId !== null}
                      onClick={() => void joinShared(row.shareId)}
                      className="h-6 shrink-0 cursor-pointer rounded border border-line px-2 text-[10px] text-muted hover:bg-line/50 hover:text-ink disabled:cursor-default disabled:opacity-50"
                    >
                      {joiningShareId === row.shareId ? "Joining…" : "Join"}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {overview.fileThreads.length > 0 ? (
          <div data-testid="chats-files-section">
            <p className="mb-0 mt-3 px-3 text-[10px] font-semibold uppercase tracking-wide text-subtle">
              Files
            </p>
            <ul className="m-0 list-none p-0">
              {overview.fileThreads.map((thread) => (
                <li key={thread.id} className="border-b border-line">
                  <button
                    type="button"
                    data-testid="chats-file-chat"
                    data-thread-id={thread.id}
                    title={
                      thread.path
                        ? `Open in the file rail (${thread.path})`
                        : "Open in the file rail"
                    }
                    onClick={() => props.onOpenFileChat(thread)}
                    className="flex w-full cursor-pointer items-center gap-1.5 px-3 py-2 text-left transition-colors hover:bg-panel-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
                  >
                    <FileText size={13} aria-hidden className="shrink-0 text-subtle" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-medium text-ink">
                        {thread.title}
                      </span>
                      <span className="block truncate text-[10px] text-subtle">
                        {thread.path ?? "File no longer tracked"}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
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
            New channel
          </button>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void createChannel(creatingChannel);
            }}
          >
            <label className="sr-only" htmlFor="chats-new-channel-name">
              Channel name
            </label>
            <input
              id="chats-new-channel-name"
              data-testid="chats-new-channel-name"
              autoFocus
              value={creatingChannel}
              maxLength={80}
              placeholder="Channel name"
              onChange={(event) => setCreatingChannel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setCreatingChannel(null);
                }
              }}
              className="h-7 w-full rounded-md border border-line bg-bg px-2 text-[13px] text-ink placeholder:text-subtle focus:outline focus:outline-2 focus:-outline-offset-1 focus:outline-accent"
            />
            <p className="mb-0 mt-1 px-1 text-[10px] leading-4 text-subtle">
              Press Enter to create the channel.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
