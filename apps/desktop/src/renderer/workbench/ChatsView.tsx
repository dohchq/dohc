import {
  ArrowLeft,
  AtSign,
  Bookmark,
  Bot,
  Copy,
  FileText,
  Hash,
  MessagesSquare,
  Plus,
  Rss,
  Square,
  Users,
  X,
} from "lucide-react";
import {
  type ReactNode,
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
  ChatChannelShareReceivedRow,
  ChatDecisionRecord,
  ChatDispatchStateForThreadResult,
  ChatMessageRecord,
  ChatBookmarkRecord,
  ChatFeedItemRecord,
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
import { Overlay } from "../Overlay";
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
import { extractChatFileReferences } from "./chatFileMentions";
import type { MentionCandidate } from "@dohc/workspace-contracts/chat-mentions";
import { agentDisplayLabel } from "@dohc/workspace-contracts/chat-identity";
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

export interface AgentSetupSummary {
  preferredName?: string;
  runnerConfigured: boolean;
  runnerEnabled: boolean;
  mcpEnabled: boolean;
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

// The independently committed parts of the Chats overview surfaces. Several
// readers write them, each authoritative for a different subset, so each part
// carries its own commit watermark (see commitTicket).
type CommitLane = "overview" | "joinedShares" | "relayShares" | "relayReach";

// What the view keeps: the flat merged share listing. This is NOT the contract
// result — that one may answer "the relay was unreachable", which is not
// storable as rows. commitShareListing translates, lane by lane. The relay
// rows carry the session they were read under, because they are
// account-scoped: preservation through an outage may only ever keep the SAME
// session's rows.
interface ShareListing {
  granted: ChatChannelShareGrantRow[];
  received: ChatChannelShareReceivedRow[];
  // One answer per channel the read covered. A channel the read did NOT cover
  // is absent, which is unknown, and unknown locks it — see channelIsLocked.
  joined: JoinedChannelAnswer[];
  sessionKey: string | null;
}

// What this surface is showing, and therefore the only channels it may ask
// the joined lane about: the channels in the list, plus the invitations under
// "Shared with you" (each one needs to know whether this workspace already
// joined that channel). The response is one answer per name, so it is bounded
// by the view and not by how many channels the account has ever joined (#640).
function shownChannelWireIds(
  channels: readonly ChatChannelRecord[],
  received: readonly ChatChannelShareReceivedRow[],
): string[] {
  const ids = new Set<string>();
  for (const channel of channels) {
    if (channel.wireId) ids.add(channel.wireId);
  }
  for (const row of received) ids.add(row.channelWireId);
  return [...ids];
}

// Why a committed share read carried no rows. "unreachable" covers both a
// relay that did not answer and a listing the IPC rejected outright: dohc
// could not read it, and a retry is the honest next step. "over-limit" is the
// answer that DID arrive and that dohc cannot list — retrying repeats it
// exactly, so the surface owes the count and the limit instead of a button.
type ShareReadFailure =
  | { kind: "unreachable" }
  | {
      kind: "over-limit";
      lanes: ReadonlyArray<{ lane: "granted" | "received"; rows: number }>;
      limit: number;
    };

// A share listing answers two independent questions. The JOINED rows come from
// the local registry, so any reader that got a listing at all has the true
// answer. The granted/received rows come from the relay — a reader that is not
// authoritative for them must leave them exactly as they were.
// The joined lane is a set of PER-CHANNEL facts, so a read replaces the
// channels it named and leaves the rest alone. Replacing the whole array threw
// away answers the new read never spoke to — a read issued before a channel
// was created landing after it dropped that channel's answer, and the composer
// vanished under the user.
//
// Ordering is unaffected: claimLanes still decides who may write at all, and a
// claim now writes only what it answered.
// Two different questions, and they must not be confused:
//
//  - MERGING is answer-driven. A read writes the channels it answered and
//    leaves the rest, so a read that never named a channel cannot drop it.
//  - EVICTION is view-driven. The newest read also discards answers for
//    channels the view no longer shows — an invitation that was revoked or
//    claimed by another workspace would otherwise sit in the map forever, and
//    a cache that grows with history is the growth this whole change removes.
//
// `keep` is the newest read's view: its own scope plus anything answered
// locally since it was issued. Older reads pass null and evict nothing — they
// are not entitled to say what the view shows.
export function applyJoinedAnswers(
  current: readonly JoinedChannelAnswer[],
  answers: readonly JoinedChannelAnswer[],
  keep: ReadonlySet<string> | null,
): JoinedChannelAnswer[] {
  const byWire = new Map(current.map((answer) => [answer.channelWireId, answer]));
  for (const answer of answers) byWire.set(answer.channelWireId, answer);
  const merged = [...byWire.values()];
  return keep === null ? merged : merged.filter((a) => keep.has(a.channelWireId));
}

// What a response may do to the joined lane, or null when it may do nothing.
type JoinedCommit = {
  // Writes this response's answers into the cached lane. It takes the cached
  // answers because only the updater knows them.
  write: (current: readonly JoinedChannelAnswer[]) => JoinedChannelAnswer[];
  // This response is the newest for the lane. Only it may evict, and only it
  // may ESTABLISH a lane that does not exist yet: seeding is a whole-lane act,
  // and a response that owns a few wires must not put itself — and its own
  // relay rows — over an unknown a newer read established on purpose.
  ownsLane: boolean;
};

// What the joined lane remembers between reads.
export type JoinedLaneOrder = {
  // The workspace these entries are about. They are cleared when it changes,
  // and the state carries the identity rather than a caller remembering to
  // reset it: `local` is eviction-immune until a read NAMES its wire, and no
  // read in another workspace ever will, so a channel created and abandoned
  // in one workspace would sit in every later workspace's `keep` forever.
  workspaceId: string | null;
  // The highest ticket that has ANSWERED each wire id. The lane orders per
  // WIRE, not per lane: one watermark for the whole lane let a newer read
  // outrank an older one for channels the newer read never mentioned. A
  // refreshShares issuing from a stale overview took the watermark, and the
  // overview response that alone knew about a freshly imported channel was
  // then barred whole — leaving that channel unanswered, and therefore
  // locked, until some later refresh. A newer claim outranks only what it
  // answered.
  answeredAt: Map<string, number>;
  // Wire ids this surface answered ITSELF — see answerLocally.
  local: Set<string>;
};

export function emptyJoinedLaneOrder(): JoinedLaneOrder {
  return { workspaceId: null, answeredAt: new Map(), local: new Set() };
}

function adoptWorkspace(order: JoinedLaneOrder, workspaceId: string): void {
  if (order.workspaceId === workspaceId) return;
  order.workspaceId = workspaceId;
  order.answeredAt.clear();
  order.local.clear();
}

// A channel this surface answered ITSELF, with no read behind it. It survives
// eviction until a read names it, because every read now in flight was issued
// before the channel existed.
export function answerLocally(
  order: JoinedLaneOrder,
  workspaceId: string,
  channelWireId: string,
): void {
  adoptWorkspace(order, workspaceId);
  order.local.add(channelWireId);
}

// The one decision the joined lane makes: what this response may write, and
// what the cache may still hold once it has.
//
// Exported with its state because the property this change exists for — a
// cache bounded by the view rather than by history — is a property of these
// two collections and of nothing on screen.
export function planJoinedCommit(
  order: JoinedLaneOrder,
  input: {
    // The workspace this response is about. The order forgets any other.
    workspaceId: string;
    ticket: number;
    answers: readonly JoinedChannelAnswer[];
    // The lane claim. Only the newest response may evict.
    newestForLane: boolean;
    // What the surface shows NOW, or null while it cannot say. A response's
    // own scope is not the view: a read issued from an older render answers
    // less than the surface has since put on screen, so evicting to its scope
    // would drop the answer for a channel the user is looking at — and an
    // unanswered channel locks.
    shown: readonly string[] | null;
  },
): JoinedCommit | null {
  const { workspaceId, ticket, answers, newestForLane, shown } = input;
  adoptWorkspace(order, workspaceId);
  const writable = answers.filter(
    (answer) => ticket > (order.answeredAt.get(answer.channelWireId) ?? 0),
  );
  for (const answer of writable) order.answeredAt.set(answer.channelWireId, ticket);
  let keep: Set<string> | null = null;
  if (newestForLane) {
    // A channel this read named is answered by a read from now on.
    for (const answer of answers) order.local.delete(answer.channelWireId);
    if (shown !== null) {
      keep = new Set([
        ...answers.map((answer) => answer.channelWireId),
        ...shown,
        ...order.local,
      ]);
      // The watermarks are the same cache. Ordering kept for a channel the
      // view no longer shows would grow exactly what evicting the answers
      // stopped growing.
      for (const wire of order.answeredAt.keys()) {
        if (!keep.has(wire)) order.answeredAt.delete(wire);
      }
    }
  }
  // Authority, not payload. A response that owns the lane always commits, even
  // with nothing to write: an answer covering no channel is still the lane's
  // answer, and it is what seeds the listing on a solo workspace.
  if (writable.length === 0 && !newestForLane) return null;
  return {
    write: (current) => applyJoinedAnswers(current, writable, keep),
    ownsLane: newestForLane,
  };
}

// Merges into a listing that EXISTS. Establishing one is a different question
// and each reader answers it for itself: only a reader that speaks for the
// relay lanes can, and only while it owns the joined lane.
function mergeShareLanes(
  current: ShareListing,
  next: ShareListing,
  lanes: { joined: JoinedCommit | null; relay: boolean },
): ShareListing {
  return {
    joined: lanes.joined ? lanes.joined.write(current.joined) : current.joined,
    granted: lanes.relay ? next.granted : current.granted,
    received: lanes.relay ? next.received : current.received,
    sessionKey: lanes.relay ? next.sessionKey : current.sessionKey,
  };
}

// A channel this workspace just created answers itself. main mints the new
// channel's wire id from its own local id, so no grant can exist for it — and
// the caller could not have named it in the read that is already on screen.
// Without this the new channel is unanswered, and unanswered locks: the user
// creates a channel and lands in it with no composer.
//
// It writes ONE key, and applyJoinedAnswers is what keeps it: a read issued
// before the create never named this channel, so when it lands it replaces the
// channels it did name and leaves this entry alone. refreshShares is
// deliberately not liveToken-guarded, so a token bump would not have been
// enough on its own.
function answerCreatedChannel(
  current: ShareListing | null,
  channel: ChatChannelRecord,
): ShareListing | null {
  // Nothing has vouched for the lane yet, and one local fact does not make it
  // an answer. channelIsLocked keeps failing closed until a read settles it.
  if (current === null) return current;
  if (!channel.wireId) return current;
  const wireId = channel.wireId;
  return {
    ...current,
    joined: [
      ...current.joined.filter((answer) => answer.channelWireId !== wireId),
      { channelWireId: wireId, joined: null },
    ],
  };
}

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

type Nav = ChatsNav;

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

interface ChannelSnapshot {
  threads: ChannelThreadRecord[];
  feedPosts: Record<string, FeedPostData>;
}

interface ThreadCommentNode {
  message: ChatMessageRecord;
  replies: ThreadCommentNode[];
}

// The store keeps the true parent id for every reply. Turn the chronological
// message stream into a display tree without trusting malformed relationships:
// missing parents, self-links, and cycles stay visible as top-level comments.
function buildThreadCommentTree(
  openingMessageId: string,
  comments: readonly ChatMessageRecord[],
): ThreadCommentNode[] {
  const nodes: ThreadCommentNode[] = comments.map((message) => ({
    message,
    replies: [],
  }));
  const byId = new Map(nodes.map((node) => [node.message.id, node]));
  const roots: ThreadCommentNode[] = [];

  const createsCycle = (messageId: string, parentId: string): boolean => {
    const seen = new Set([messageId]);
    let cursor: string | undefined = parentId;
    while (cursor && cursor !== openingMessageId) {
      if (seen.has(cursor)) return true;
      seen.add(cursor);
      cursor = byId.get(cursor)?.message.parentMessageId;
    }
    return false;
  };

  for (const node of nodes) {
    const parentId = node.message.parentMessageId;
    const parent =
      parentId && parentId !== openingMessageId ? byId.get(parentId) : undefined;
    if (parent && !createsCycle(node.message.id, parentId!)) {
      parent.replies.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

const IDLE_DISPATCH_STATE: ChatDispatchStateForThreadResult = {
  liveRun: false,
  pendingCount: 0,
  paused: false,
};

export interface ChatsComposerReplyTarget {
  messageId: string;
  authorLabel: string;
}

type ComposerReplyTarget = ChatsComposerReplyTarget;

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
  onOpenPath?: (path: string, headingAnchor?: string) => void;
}) {
  const label = pathBasename(props.attachment.pathHint);
  const title = `${props.attachment.pathHint ?? label}${
    props.attachment.headingText ? `#${props.attachment.headingText}` : ""
  }`;
  const className =
    "inline-flex items-center gap-1 rounded-full border border-line bg-panel-2 px-2 py-0.5 font-mono text-[10px] text-muted";
  const content = (
    <>
      <FileText size={11} aria-hidden className="shrink-0" />
      <span className="max-w-56 truncate">{label}</span>
      {props.attachment.headingText ? (
        <span className="max-w-48 truncate text-subtle">
          #{props.attachment.headingText}
        </span>
      ) : null}
    </>
  );
  if (props.attachment.pathHint && props.onOpenPath) {
    return (
      <button
        type="button"
        data-testid="chats-attachment-chip"
        title={title}
        onClick={() => {
          const path = props.attachment.pathHint ?? "";
          if (props.attachment.headingAnchor) {
            props.onOpenPath?.(path, props.attachment.headingAnchor);
          } else {
            props.onOpenPath?.(path);
          }
        }}
        className={`${className} cursor-pointer hover:border-muted/50 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent`}
      >
        {content}
      </button>
    );
  }
  return (
    <span
      data-testid="chats-attachment-chip"
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
  bookmark?: ChatBookmarkRecord;
  bookmarkBusy?: boolean;
  onToggleBookmark?: (mode: "live" | "snapshot") => void;
  onOpenBookmark?: () => void;
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
        {props.onToggleBookmark || (props.bookmark && props.onOpenBookmark) ? (
          <BookmarkAction
            active={Boolean(props.bookmark)}
            busy={props.bookmarkBusy}
            destinationPath={props.bookmark?.destinationPath}
            onToggle={props.onToggleBookmark}
            onOpen={props.onOpenBookmark}
            testId="chats-post-bookmark"
          />
        ) : null}
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

function BookmarkAction(props: {
  active: boolean;
  busy?: boolean;
  destinationPath?: string;
  onToggle?: (mode: "live" | "snapshot") => void;
  onOpen?: () => void;
  testId: string;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      {props.active && props.onOpen ? (
        <button
          type="button"
          data-testid={`${props.testId}-open`}
          aria-label="Open bookmarked chat file"
          title={props.destinationPath ?? "Open bookmarked chat file"}
          onClick={(event) => {
            event.stopPropagation();
            props.onOpen?.();
          }}
          className="grid size-6 place-items-center rounded text-subtle hover:bg-line/50 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          <FileText size={12} aria-hidden />
        </button>
      ) : null}
      {props.onToggle ? (
        <>
          <button
            type="button"
            data-testid={props.testId}
            aria-pressed={props.active}
            aria-label={props.active ? "Remove chat bookmark" : "Bookmark chat as live file"}
            title={
              props.active
                ? "Remove bookmark (the Markdown file moves to Archived)"
                : "Bookmark as a live Markdown file"
            }
            disabled={props.busy}
            onClick={(event) => {
              event.stopPropagation();
              props.onToggle?.("live");
            }}
            className={`grid size-6 place-items-center rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50 ${
              props.active
                ? "text-accent hover:bg-line/50"
                : "text-subtle hover:bg-line/50 hover:text-ink"
            }`}
          >
            <Bookmark size={12} fill={props.active ? "currentColor" : "none"} aria-hidden />
          </button>
          {!props.active ? (
            <button
              type="button"
              data-testid={`${props.testId}-snapshot`}
              aria-label="Bookmark chat as snapshot"
              title="Bookmark as a static Markdown snapshot"
              disabled={props.busy}
              onClick={(event) => {
                event.stopPropagation();
                props.onToggle?.("snapshot");
              }}
              className="rounded px-1.5 py-1 font-mono text-[9px] text-subtle hover:bg-line/50 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
            >
              snapshot
            </button>
          ) : null}
        </>
      ) : null}
    </span>
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

// One sentence per over-limit lane, counting what the lane actually holds.
//
// The unit is SHARES, not channels. A relay lane carries one row per grant and
// nothing deduplicates the channel — mapRelayShareListing keeps every row,
// because each carries its own recipient — so one channel shared with 4097
// people is 4097 rows. Saying "you share 4097 channels" names the wrong thing
// and sends the user to reduce channels when the excess is grants on a single
// channel they own. It is the same unit slip that made the deleted account
// fixture wrong, arriving at the surface.
//
// The joined lane counts the other unit — mergeJoinedChannel matches on
// channelWireId as well as shareId, so those rows really are one per channel —
// and it has no limit to report at all now that it is read per channel (#640).
function overLimitSentences(failure: {
  lanes: ReadonlyArray<{ lane: "granted" | "received"; rows: number }>;
  limit: number;
}): string[] {
  return failure.lanes.map(({ lane, rows }) =>
    lane === "granted"
      ? `You have ${rows} shares of your channels; the limit is ${failure.limit}.`
      : `You have ${rows} shares from other people; the limit is ${failure.limit}.`,
  );
}

// Whether a NEW outgoing grant would deepen the over-limit state. Only the
// GRANTED lane can: an outgoing share adds a row there and nowhere else. A
// full RECEIVED lane is an inbound backlog the user did not create and cannot
// clear from here, and rejecting their outgoing work over it turns one
// account-wide problem into a second one.
function grantedLaneIsOverLimit(failure: ShareReadFailure | null): boolean {
  return (
    failure?.kind === "over-limit" &&
    failure.lanes.some((entry) => entry.lane === "granted")
  );
}

// What the sharing surface says when a committed share read carried no rows.
// Without it the surface renders an empty list, which reads as "you have no
// shares" (#618).
//
// The two reasons owe different things. An outage owes a retry, because the
// next request can answer. A listing over dohc's own cap owes the count and
// the limit and NO retry: the same request answers the same way forever, and a
// button that cannot work is the defect this notice exists to remove.
function ShareReadFailureNotice(props: {
  testId: string;
  failure: ShareReadFailure;
  // True when rows are still on screen from an earlier read: they are real,
  // they are just older than this failure.
  stale: boolean;
  onRetry: () => void;
}) {
  const staleLine = props.stale ? " This list may be out of date." : "";
  return (
    <div
      data-testid={props.testId}
      data-failure={props.failure.kind}
      className="flex items-start gap-1.5 border-b border-line px-3 py-2"
    >
      <span className="min-w-0 flex-1 text-[11px] leading-4 text-muted">
        {props.failure.kind === "unreachable"
          ? `dohc could not read your shares.${staleLine}`
          : `dohc cannot list this many shares. ${overLimitSentences(
              props.failure,
            ).join(" ")}${staleLine}`}
      </span>
      {props.failure.kind === "unreachable" ? (
        <button
          type="button"
          data-testid={`${props.testId}-retry`}
          onClick={props.onRetry}
          className="h-5 shrink-0 cursor-pointer rounded border border-line px-1.5 text-[10px] text-muted hover:bg-line/50 hover:text-ink"
        >
          Try again
        </button>
      ) : null}
    </div>
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
//
// The rows are informational, and a notification is why: it carries a
// workspace, a run, and copy — never a conversation or a message. The user
// acts where the run does: a blocked run raises its own permission card, and
// the History rail says what it did.
function AddressedToMe(props: { notifications: readonly AgentNotification[] }) {
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
            <div
              data-testid="chats-addressed-item"
              className="flex w-full items-start gap-1.5 px-3 py-2 text-left"
            >
              <Bot size={13} aria-hidden className="mt-0.5 shrink-0 text-accent" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] font-medium text-ink">
                  {notification.title}
                </span>
                <span className="block truncate text-[11px] text-muted">{notification.body}</span>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

type DmWorkspaceOption = { workspaceId: string; label: string };

function AcceptDmDialog(props: {
  request: DmRequestRow;
  currentWorkspaceId: string;
  workspaces: readonly DmWorkspaceOption[];
  onAccept: (workspaceId: string) => Promise<void>;
  onClose: () => void;
}) {
  const defaultWorkspaceId = props.workspaces.some(
    (workspace) => workspace.workspaceId === props.currentWorkspaceId,
  )
    ? props.currentWorkspaceId
    : (props.workspaces[0]?.workspaceId ?? "");
  const [workspaceId, setWorkspaceId] = useState(defaultWorkspaceId);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const chosen = props.workspaces.find(
    (workspace) => workspace.workspaceId === workspaceId,
  );
  const title = props.request.granterEmail
    ? `Add your conversation with ${props.request.granterEmail} to a workspace`
    : "Add this conversation to a workspace";

  async function accept() {
    if (!chosen || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await props.onAccept(chosen.workspaceId);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <Overlay
      onClose={() => {
        if (!busyRef.current) props.onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="chats-accept-dm-title"
        data-testid="chats-accept-dm-dialog"
        className="dohc-elevated flex w-105 max-w-[80vw] flex-col gap-3 rounded-xl border border-line bg-panel p-5"
      >
        <div className="flex flex-col gap-1">
          <h2
            id="chats-accept-dm-title"
            className="m-0 text-sm font-semibold text-ink"
          >
            {title}
          </h2>
          <p className="m-0 text-xs text-muted">
            The conversation stays in the workspace you pick.
          </p>
        </div>
        <fieldset className="m-0 grid gap-1 border-0 p-0" disabled={busy}>
          <legend className="sr-only">Workspace</legend>
          {props.workspaces.map((workspace) => (
            <label
              key={workspace.workspaceId}
              data-testid="chats-accept-dm-workspace-option"
              data-workspace-id={workspace.workspaceId}
              className="flex cursor-pointer items-center gap-2 rounded-md border border-line px-3 py-2 text-xs text-ink hover:bg-panel-2"
            >
              <input
                type="radio"
                name="chats-accept-dm-workspace"
                value={workspace.workspaceId}
                checked={workspaceId === workspace.workspaceId}
                onChange={() => setWorkspaceId(workspace.workspaceId)}
              />
              <span className="truncate">{workspace.label}</span>
            </label>
          ))}
        </fieldset>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            data-testid="chats-accept-dm-cancel"
            disabled={busy}
            onClick={props.onClose}
            className="rounded border border-line px-3 py-1.5 text-xs text-muted hover:text-ink disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="chats-accept-dm-confirm"
            disabled={!chosen || busy}
            onClick={() => void accept()}
            className="rounded bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-50"
          >
            {chosen ? `Add to ${chosen.label}` : "Choose a workspace"}
          </button>
        </div>
      </div>
    </Overlay>
  );
}

// The DM placement reverse path's confirmation (#742): reversible but
// disruptive, so it states what happens before it runs (product invariant).
function LeaveDmDialog(props: {
  dm: DmRecord;
  workspaceLabel: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  async function confirm() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await props.onConfirm();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <Overlay
      onClose={() => {
        if (!busyRef.current) props.onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="chats-leave-dm-title"
        data-testid="chats-leave-dm-dialog"
        // #742 P2-D: this dialog owns Escape. Without the marker, the Chats
        // root's own Escape handler (onKeyDownCapture, capture phase — it
        // runs before this) walks the DM view back before this dialog ever
        // sees the key, leaving it open over whatever conversation goBack
        // lands on next.
        data-chat-escape-local="true"
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          if (!busyRef.current) props.onClose();
        }}
        className="dohc-elevated flex w-105 max-w-[80vw] flex-col gap-3 rounded-xl border border-line bg-panel p-5"
      >
        <div className="flex flex-col gap-1">
          <h2
            id="chats-leave-dm-title"
            className="m-0 text-sm font-semibold text-ink"
          >
            {`Leave your conversation with ${props.dm.peerLabel}?`}
          </h2>
          <p className="m-0 text-xs text-muted">
            {`The conversation leaves ${props.workspaceLabel}. It appears again as a message request, so you can add it to a workspace later. Your messages are kept.`}
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            data-testid="chats-leave-dm-cancel"
            autoFocus
            disabled={busy}
            onClick={props.onClose}
            className="rounded border border-line px-3 py-1.5 text-xs text-muted hover:text-ink disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="chats-leave-dm-confirm"
            disabled={busy}
            onClick={() => void confirm()}
            className="rounded bg-accent px-3 py-1.5 text-xs text-white disabled:opacity-50"
          >
            Leave conversation
          </button>
        </div>
      </div>
    </Overlay>
  );
}

function DmRequestListItem(props: {
  request: DmRequestRow;
  state: "pending" | "declined";
  busy: boolean;
  onAccept?: () => void;
  onDecline?: () => void;
  onRequestAgain?: () => void;
}) {
  const pending = props.state === "pending";
  return (
    <li
      data-testid={pending ? "chats-dm-request-item" : "chats-dm-declined-item"}
      className="border-b border-line"
    >
      <div className="flex items-center gap-1.5 px-3 py-2">
        <AtSign size={13} aria-hidden className="shrink-0 text-subtle" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-medium text-ink">
            {props.request.granterEmail ?? "A teammate"}
          </span>
          <span className="block text-[10px] text-subtle">
            {pending ? "Wants to message you" : "Declined"}
          </span>
        </span>
        {pending ? (
          <>
            {props.onAccept ? (
              <button
                type="button"
                data-testid="chats-dm-request-accept"
                onClick={props.onAccept}
                className="h-6 shrink-0 rounded border border-line px-2 text-[10px] text-muted hover:bg-line/50 hover:text-ink"
              >
                Accept
              </button>
            ) : null}
            {props.onDecline ? (
              <button
                type="button"
                data-testid="chats-dm-request-decline"
                disabled={props.busy}
                onClick={props.onDecline}
                className="h-6 shrink-0 rounded border border-line px-2 text-[10px] text-muted hover:bg-line/50 hover:text-ink disabled:opacity-50"
              >
                Decline
              </button>
            ) : null}
          </>
        ) : props.onRequestAgain ? (
          <button
            type="button"
            data-testid="chats-dm-request-again"
            disabled={props.busy}
            onClick={props.onRequestAgain}
            className="h-6 shrink-0 rounded border border-line px-2 text-[10px] text-muted hover:bg-line/50 hover:text-ink disabled:opacity-50"
          >
            Move back to requests
          </button>
        ) : null}
      </div>
    </li>
  );
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
  // Main-derived settings/status summary. The CTA only navigates to settings;
  // Chats never configures executables or grants capabilities itself.
  agentSetup?: AgentSetupSummary | null;
  onSetupAgent?: () => void;
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
  // The page variant's counterpart of the panel's onOpenInTab: an explicit
  // conversation click, reported BEFORE the view navigates in place. It is a
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
  // fetched at mount. The page reports each landed mark-read; the shell hands
  // the panel a bumped revision so its badges catch up.
  onThreadRead?: () => void;
  readRevision?: number;
}) {
  const { workspaceId, onNavChange, onDraftsChange, onThreadRead } = props;
  const collaboration = props.collaboration ?? null;
  const mentionCandidates = props.mentionCandidates ?? [];
  const fileMentionCandidates = useMemo(
    () =>
      (props.workspaceFiles ?? [])
        .filter((file) => file.kind === "file" && /\.md$/i.test(file.path))
        .map((file) => ({
          path: file.path,
          label: file.path.split("/").at(-1)?.replace(/\.md$/i, "") ?? file.path,
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
  const [nav, setNav] = useState<Nav>({ level: "channels" });
  const [channelThreads, setChannelThreads] = useState<ChannelThreadRecord[]>([]);
  const [feedPosts, setFeedPosts] = useState<Record<string, FeedPostData>>({});
  const [personalFeed, setPersonalFeed] = useState<ChatFeedItemRecord[]>([]);
  const [personalFeedLoading, setPersonalFeedLoading] = useState(false);
  const [personalFeedNextCursor, setPersonalFeedNextCursor] = useState<string | undefined>();
  const [bookmarks, setBookmarks] = useState<ChatBookmarkRecord[]>([]);
  const [bookmarkBusy, setBookmarkBusy] = useState<Set<string>>(() => new Set());
  // Bookmark list reads and mutations are independent request streams. A
  // mutation invalidates any older list read, while per-key mutation
  // generations let unrelated bookmark writes finish concurrently.
  const bookmarkWorkspaceGeneration = useRef(0);
  const bookmarkListGeneration = useRef(0);
  const bookmarkMutationGeneration = useRef(0);
  const bookmarkMutationByKey = useRef(new Map<string, number>());
  const [followedUi, setFollowedUi] = useState<Set<string>>(() => new Set());
  const followRequest = useRef(0);
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
  // WHY the last committed share read did not produce rows, or null when it
  // did. The rows above are what dohc knows; this is what stopped it knowing.
  // Separate facts: a relay that did not answer commits no rows AND keeps the
  // cached ones, so without this the surface renders an empty list that reads
  // as "no shares" (#618). Its own commit lane, because it answers its own
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
  // flips. These refs flip synchronously BEFORE the first await, so the second
  // call is ignored immediately.
  const sendingRef = useRef(false);
  // Sends are owned per workspace conversation. This lets another conversation
  // send independently while preserving the lock if the user returns to a
  // conversation whose original promise is still in flight.
  const sendRequestGeneration = useRef(0);
  const inFlightSendByContext = useRef(new Map<string, number>());
  const startingThreadRef = useRef(false);
  const liveToken = useRef(0);
  // A live thread can refresh repeatedly without changing navigation. Keep a
  // request sequence separate from the workspace/navigation liveness token so
  // an older activity response can never overwrite a newer one.
  const threadRefreshSeq = useRef(0);
  const channelRefreshSeq = useRef(0);
  const feedRefreshSeq = useRef(0);
  const dmRefreshSeq = useRef(0);
  // Per-(message, emoji) toggle sequence so overlapping reaction toggles resolve
  // in order (see runReactionToggle).
  const reactionSeq = useRef(new Map<string, number>());
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const messageNodes = useRef(new Map<string, HTMLElement>());
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
  //    captured token is still CHECKED, so a workspace switch or a user
  //    navigation still discards this response.
  //  - A transient failure must not replace a working navigator with an error
  //    card (there is nothing to report to a user who asked for nothing).
  //
  // ONE issue order over every commit into these surfaces, with a watermark
  // per lane. A reader takes a ticket when it ISSUES its request and commits a
  // lane only if no newer ticket landed there first. Same commit-time
  // watermark as the workspace file listing: an id is taken at issue, and a
  // response commits only if it is newer than what is already displayed.
  //
  // Lanes exist because these readers answer different questions.
  // refreshOverview answers all three. refreshShares answers both share lanes.
  // refreshChannelBadges answers the channel listing and the JOINED grants its
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
  // A FAILED lookup says nothing about either lane, and "unknown" is a state
  // of the whole listing — there is no way to store it for one lane alone. So
  // it may commit only when it owns BOTH lanes. Otherwise a response that
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
  // The ONE path that writes joined answers: the lane claim decides who may
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
      // A failed lookup for a refresh NOBODY ASKED FOR is not an answer. It
      // fills in only where nothing has answered yet — so the surface resolves
      // instead of waiting on a request that may never return — and it takes
      // no lane, so a real answer still in flight replaces it even though it
      // was issued earlier. Where something HAS answered, it says nothing at
      // all and the cached rows stand.
      if (value === null && options?.background) {
        const answered =
          committedLane.current.joinedShares > 0 ||
          committedLane.current.relayShares > 0;
        if (answered) return;
        setChannelShares(null);
        // Claims NO lane, reachability included. This refresh learned nothing
        // and only fills in where nothing has answered yet — so a real answer
        // still in flight, issued EARLIER and therefore holding an older
        // ticket, must still be able to correct it. Taking the lane here left
        // "dohc could not read your shares" standing over a listing that then
        // arrived and worked.
        setShareReadFailure({ kind: "unreachable" });
        setSharesWorkspaceId(workspaceId);
        return;
      }
      // A failure the user asked for answers "unknown", which is the whole
      // listing. It commits only while it owns BOTH lanes — claiming one and
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
      // Whether dohc could READ the relay is its own answer, and every
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
      // A refresh NOBODY ASKED FOR may take the reachability lane only when it
      // ESTABLISHED an account-scoped answer. The test is what the read
      // learned, not which sentinel it returned: a background read that
      // resolved "unreachable" or "over-limit" established no listing, exactly
      // like one that rejected, and taking the lane over either would let it
      // outrank an authoritative answer still in flight — leaving the notice
      // standing over a listing that then arrived and worked. Keying this on
      // `value === null` covered one of the three shapes.
      //
      // It may still SAY so where nothing has answered yet, so the surface
      // resolves instead of waiting on a request that may never return.
      const establishedRelayFact =
        value.relay.state === "answered" || value.relay.state === "signed-out";
      if (!options?.background || establishedRelayFact) {
        if (claimLanes(["relayReach"], ticket)) setShareReadFailure(nextFailure);
      } else if (ticket > committedLane.current.relayReach) {
        // It may still SAY so — an outage the user should see is a real fact,
        // and refusing to show it would trade one silence for another. It
        // READS the watermark without taking it: newer than what is displayed,
        // so a late-arriving older outage cannot repaint over a fresher
        // answer; unclaimed, so an authoritative answer still in flight on an
        // OLDER ticket can still land and clear it.
        setShareReadFailure(nextFailure);
      }
      // The relay lanes are only this answer's to write when it learned an
      // account-scoped fact: the relay's rows, or that no session exists
      // (signed out — cached rows must clear; another account's invitations
      // and recipient emails must not survive a logout). "Unreachable" is NOT
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
          // nothing has vouched for. It must own the whole LANE, not a few
          // wires of it: a newer read that could not answer sets this null on
          // purpose, and re-seeding would put these relay rows back over it.
          return joined?.ownsLane ? { ...listing, joined: joined.write([]) } : current;
        }
        // The cached relay rows are account-scoped: they are preservable
        // only for the SAME session. Under any other session — a login, a
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
        // The channel listing FIRST, and not beside the share read: the share
        // read now has to be told which channels this surface is showing, and
        // that is what the listing answers. The listing also syncs joined
        // shared channels before it reads, so a channel a sync just pulled is
        // in the declaration rather than missing from it for a whole cycle.
        const result = await bridge().listChatChannels({ workspaceId });
        if (token !== liveToken.current) return;
        // Sharing is OPTIONAL: solo / signed-out workspaces simply render
        // without the sharing affordances. Whether the lookup FAILED is kept
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
        // The channel list settles WITH its share answer, not before it: a
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

  // Badge-only refresh, for the invalidation nobody asked for. It differs from
  // refreshOverview in three ways, and each one is a thing this refresh has no
  // authority to do:
  //
  //  - It reads the channel listing, and the JOINED grants that listing's sync
  //    may have just changed. Both are local questions: the joined rows come
  //    from the registry, which is why they have a read of their own. The
  //    relay-backed granted/received rows are nobody's business here.
  //  - It takes its tickets like every other reader, so it cannot discard the
  //    response of a refresh the user DID ask for (a join, a leave, a retry),
  //    and a newer commit cannot be undone by its own late answer. It captures
  //    liveToken, so a workspace switch, a navigation, or a mutation wins.
  //  - It keeps ONE listing in flight. The activity signal fires for every
  //    settled file batch and run update, the listing syncs shared channels
  //    over the relay before it reads, and a persistent navigator plus an
  //    expanded page mount two of these surfaces. Activity arriving mid-read
  //    is not dropped: it runs exactly one more pass when the read settles.
  //
  // liveToken decides what a drain may do, exactly as it does for every other
  // reader: a workspace switch, a navigation, and a mutation all move it, and
  // a pass that captured an older value can neither commit nor run again. The
  // record itself only says who holds the slot, which is what keeps ONE
  // listing in flight.
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
            // put a NEWER channel list on screen than the lookup that will
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
            // ONLY the joined lane, which is all this read answers. Leaving the
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
                      // The unclaimed relay lane keeps the current rows AND
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

  const refreshFollows = useCallback(async () => {
    const request = ++followRequest.current;
    const desktopBridge = bridge();
    if (typeof desktopBridge.listChatFollows !== "function") return;
    try {
      const result = await desktopBridge.listChatFollows({ workspaceId });
      if (request !== followRequest.current) return;
      setFollowedUi(
        new Set(
          result.follows
            .filter((follow) => follow.state === "following")
            .map((follow) => `${follow.targetKind}:${follow.targetId}`),
        ),
      );
    } catch {
      // Feed follows are additive; a transient sync failure must not make
      // channels or messages unavailable.
    }
  }, [workspaceId]);

  // DM sync: refresh received requests, push the member's local ops, pull the
  // peers' ops, and refresh the established DM list. Best-effort —
  // offline keeps the current list and the next pass retries. A late response
  // for a stale workspace/nav is dropped by the token guard.
  //
  // ONE sync in flight (#545, badgeRead precedent). The activity signal below
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
          setDms(result.dms);
          setPendingDmRequests(result.pending);
          setDeclinedDmRequests(result.declined);
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
    feedRefreshSeq.current += 1;
    bookmarkWorkspaceGeneration.current += 1;
    bookmarkListGeneration.current += 1;
    bookmarkMutationGeneration.current += 1;
    bookmarkMutationByKey.current.clear();
    setNav({ level: "channels" });
    setChannelThreads([]);
    setFeedPosts({});
    setPersonalFeed([]);
    setPersonalFeedLoading(false);
    setPersonalFeedNextCursor(undefined);
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
    setShareReadFailure(null);
    setSharesWorkspaceId(null);
    // Nothing is committed for the new workspace yet. Tickets stay monotonic:
    // an in-flight response from the old workspace holds an older ticket AND
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
    setFollowedUi(new Set());
    setOverview({ status: "loading" });
    void refreshOverview();
    void refreshDms();
    void refreshBookmarks();
    void refreshFollows();
    return () => {
      liveToken.current += 1;
      feedRefreshSeq.current += 1;
      bookmarkWorkspaceGeneration.current += 1;
      bookmarkListGeneration.current += 1;
      bookmarkMutationGeneration.current += 1;
      bookmarkMutationByKey.current.clear();
      followRequest.current += 1;
    };
  }, [refreshBookmarks, refreshDms, refreshFollows, refreshOverview]);

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
  // DM conversation is OPEN the inner 4s poll already runs a full syncDms pass,
  // so pause this outer poll then — otherwise viewing a DM doubles the
  // relay/sync cadence for no benefit.
  useEffect(() => {
    if (nav.level === "dm") return;
    const interval = setInterval(() => void refreshDms(), 5_000);
    return () => clearInterval(interval);
  }, [refreshDms, nav.level]);

  // The panel navigator hands every conversation to the page instance, so it
  // never reaches the mark-read above and its channel and file-thread badges
  // would keep the counts fetched at mount until it remounted. The shell bumps
  // readRevision after each landed read; the mount value belongs to the load
  // effect above, so only later ones refetch.
  const seenReadRevision = useRef(props.readRevision);
  useEffect(() => {
    const revision = props.readRevision;
    if (revision === seenReadRevision.current) return;
    seenReadRevision.current = revision;
    void refreshOverview({ background: true });
  }, [props.readRevision, refreshOverview]);

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

  const loadDmConversation = useCallback(
    async (dm: DmRecord, token: number, request = ++dmRefreshSeq.current) => {
      if (!dm.threadId) return;
      const session = sessionGeneration.current;
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
      setMessages(result.messages);
      setReactions(reactionResult.reactions);
      setViewerAuthorId(reactionResult.viewerAuthorId);
      if (dm.connected) {
        void bridge()
          .markChatThreadRead({
            workspaceId,
            threadId: dm.threadId,
            upToSequence: result.messages.length,
          })
          .catch(() => {
            // Best-effort, like the thread view.
          });
      }
    },
    [workspaceId],
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
        setDms(result.dms);
        setPendingDmRequests(result.pending);
        setDeclinedDmRequests(result.declined);
        const syncedDm = result.dms.find(
          (entry) => entry.channelId === dm.channelId,
        );
        if (!syncedDm) return;
        setNav((current) => {
          if (current.level !== "dm" || current.dm.channelId !== dm.channelId) {
            return current;
          }
          const currentDm = current.dm;
          if (
            currentDm.channelWireId === syncedDm.channelWireId &&
            currentDm.name === syncedDm.name &&
            currentDm.peerLabel === syncedDm.peerLabel &&
            currentDm.role === syncedDm.role &&
            currentDm.shareId === syncedDm.shareId &&
            currentDm.threadId === syncedDm.threadId &&
            currentDm.unreadCount === syncedDm.unreadCount &&
            currentDm.connected === syncedDm.connected
          ) {
            return current;
          }
          return { ...current, dm: syncedDm };
        });
        await loadDmConversation(syncedDm, token, request);
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
  // that is PRESENT with a null value means "asked, and this workspace holds
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
            // Only once the cursor write LANDED: a panel refetch before that
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
    [applyThreadSnapshot, channelIsLocked, loadThreadSnapshot, props],
  );

  const loadPersonalFeed = useCallback(
    async (cursor?: string) => {
      const token = liveToken.current;
      const refreshSeq = ++feedRefreshSeq.current;
      const requestIsCurrent = () =>
        token === liveToken.current && refreshSeq === feedRefreshSeq.current;
      setPersonalFeedLoading(true);
      try {
        const page = await bridge().listPersonalChatFeed({
          workspaceId,
          ...(cursor ? { cursor } : {}),
          limit: 30,
        });
        if (!requestIsCurrent()) return;
        setPersonalFeed((current) => (cursor ? [...current, ...page.items] : page.items));
        setPersonalFeedNextCursor(page.nextCursor);
        if (!cursor && page.headCursor) {
          void bridge()
            .markPersonalChatFeedSeen({
              workspaceId,
              headCursor: page.headCursor,
            })
            .catch(() => {
              // Best-effort cursor: the next Feed open can retry.
            });
        }
      } catch (error) {
        if (requestIsCurrent()) {
          props.onError(ipcErrorMessage(error, "Could not load your Feed."));
        }
      } finally {
        if (requestIsCurrent()) setPersonalFeedLoading(false);
      }
    },
    [props.onError, workspaceId],
  );

  // Main emits workspaceActivity for CLI writes, follow mutations, runner
  // reports/failures, and run-record completion. Treat it as an invalidation
  // for every mounted Chats surface. Every response carries the follow request
  // sequence, the navigation token, or both the token and a per-surface
  // request sequence, so a slow refresh cannot repaint a newer one.
  useEffect(() => {
    return bridge().onWorkspaceActivity(() => {
      void refreshFollows();
      if (nav.level === "channels") {
        // The roll-up unread badge lives on this list, so a write to a chat
        // the user does not have open is only visible here.
        void refreshChannelBadges();
        // The DM roll-up lives on the same list and used to wait for the 5s
        // poll beside a live channel badge (#545). Same signal, same moment —
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
    });
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
    refreshFollows,
    refreshChannelBadges,
    refreshDms,
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
        ...(extractChatFileReferences(body).length > 0
          ? { fileReferences: extractChatFileReferences(body) }
          : {}),
      });
      if (token !== liveToken.current) return;
      setNewThreadBody("");
      // The completion is the user's command landing: report it through the
      // seam in the same tick as the nav write (see openConversation).
      props.onNavCommand?.({ level: "thread", channel, thread: result.thread });
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
    props,
    replyTarget,
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

  const openDm = useCallback(
    async (dm: DmRecord, focusMessageId?: string) => {
      const token = ++liveToken.current;
      const request = ++dmRefreshSeq.current;
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
        requestAnimationFrame(() => {
          if (token === liveToken.current) {
            messagesEndRef.current?.scrollIntoView({ block: "end" });
          }
        });
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
    [loadDmConversation, props],
  );

  const openFeed = useCallback(() => {
    const target: ChatsNav = { level: "feed" };
    if (variant === "panel" && props.onOpenInTab) {
      props.onOpenInTab(target);
      return;
    }
    liveToken.current += 1;
    feedRefreshSeq.current += 1;
    setNav(target);
    setPersonalFeed([]);
    setPersonalFeedNextCursor(undefined);
  }, [props.onOpenInTab, variant]);

  useEffect(() => {
    if (nav.level === "feed") void loadPersonalFeed();
  }, [loadPersonalFeed, nav.level]);

  const toggleFeedFollow = useCallback(
    async (
      key: string,
      target:
        | { kind: "thread"; threadId: string }
        | { kind: "author"; threadId: string; messageId: string },
    ) => {
      const following = followedUi.has(key);
      const token = liveToken.current;
      // A follow write supersedes every older list read or write in this
      // workspace. The same generation guards both success and failure so a
      // stale completion cannot repaint state or surface an obsolete error.
      const request = ++followRequest.current;
      try {
        const result = await bridge().setChatFollow({
          workspaceId,
          target,
          state: following ? "unfollowed" : "following",
        });
        if (token !== liveToken.current || request !== followRequest.current) return;
        setFollowedUi((current) => {
          const next = new Set(current);
          const durableKey = `${result.follow.targetKind}:${result.follow.targetId}`;
          if (result.follow.state === "following") next.add(durableKey);
          else next.delete(durableKey);
          // The optimistic key is normally the durable key. Deleting it too
          // also repairs any older message-scoped UI key without a reload.
          if (durableKey !== key) next.delete(key);
          return next;
        });
      } catch (error) {
        if (token !== liveToken.current || request !== followRequest.current) return;
        props.onError(ipcErrorMessage(error, "Could not update that follow."));
      }
    },
    [followedUi, props.onError, workspaceId],
  );

  const toggleChannelFollow = useCallback(
    async (channel: ChatChannelRecord) => {
      if (!channel.wireId) return;
      const key = `channel:${channel.wireId}`;
      const following = followedUi.has(key);
      const token = liveToken.current;
      const request = ++followRequest.current;
      try {
        const result = await bridge().setChatFollow({
          workspaceId,
          target: { kind: "channel", channelId: channel.id },
          state: following ? "unfollowed" : "following",
        });
        if (token !== liveToken.current || request !== followRequest.current) return;
        setFollowedUi((current) => {
          const next = new Set(current);
          const durableKey = `${result.follow.targetKind}:${result.follow.targetId}`;
          if (result.follow.state === "following") next.add(durableKey);
          else next.delete(durableKey);
          return next;
        });
      } catch (error) {
        if (token !== liveToken.current || request !== followRequest.current) return;
        props.onError(ipcErrorMessage(error, "Could not update that channel follow."));
      }
    },
    [followedUi, props.onError, workspaceId],
  );

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
    onDraftsChange?.({
      composer,
      newThreadBody,
      dmRecipients,
      dmDraft,
      replyTarget,
      resolveTargetMessageId,
    });
  }, [
    composer,
    dmDraft,
    dmRecipients,
    newThreadBody,
    onDraftsChange,
    replyTarget,
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
      // AFTER the open* call above: navigation resets these, and restoring
      // the composer text without its mode would post a drafted reply (or
      // decision resolution) as a plain top-level comment.
      setReplyTarget(drafts.replyTarget);
      setResolveTargetMessageId(drafts.resolveTargetMessageId);
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

  // While a DM is open, poll: sync (push the member's ops, pull the peers')
  // then reload the conversation. Pending DMs also sync immediately so they
  // can acquire their relay-created thread while the outer list poll is
  // paused. Token and request guards prevent an older pass from repainting a
  // newer snapshot or a local send.
  useEffect(() => {
    if (nav.level !== "dm") return;
    const dm = nav.dm;
    const token = liveToken.current;
    if (!dm.threadId) void refreshOpenDm(dm, token);
    const interval = setInterval(
      () => void refreshOpenDm(dm, token),
      4_000,
    );
    return () => clearInterval(interval);
  }, [nav, refreshOpenDm]);

  // #742 P2-D belt: LeaveDmDialog owns Escape itself, but this clears
  // leavingDm on any navigation away from the DM it was opened for — leaving
  // this DM, opening a different one, or leaving Chats entirely — so a stale
  // confirmation can never reappear over a conversation it wasn't opened for.
  // A field-level refresh of the SAME open DM (refreshOpenDm) leaves leavingDm
  // alone.
  useEffect(() => {
    setLeavingDm((current) => {
      if (current === null) return current;
      if (nav.level === "dm" && nav.dm.channelId === current.channelId) return current;
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
      messagesEndRef.current?.scrollIntoView({ block: "end" });
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
  }, [composer, nav, props, sendContextKey, sending, workspaceId]);

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
  }, [dmDraft, dmRecipients, openDm, props, startingDm, workspaceId]);

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
    [openConversation, props, refreshDms, workspaceId],
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
    [dmRequestBusy, props, refreshDms],
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
    // Deliberately NOT liveToken-guarded: the share listing is
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
      // A rotation within the SAME session — same server, relay, and user;
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
        // And the previous session's rows leave the SCREEN now, not when
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
      // Same key, two moments. The CHANGING phase refreshes nothing:
      // mid-transition the credential cache is deliberately empty, and a
      // listing issued now answers an authoritative signed-out that would
      // clear the very rows the same-key rule preserved. The READY phase is
      // adoption end — the one revalidation, now against the settled
      // session, so invitations and revocations from during the reauth
      // land.
      if (phase === "ready") void refreshShares();
    });
  }, [refreshDms, refreshShares]);

  const submitShare = useCallback(async () => {
    // The disabled control is honesty; this is the gate. A submit that slips
    // past it (a stale enter key, a re-render race) would still grow the lane
    // dohc already cannot list. Only the GRANTED lane, though — an outgoing
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
    props,
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
        // The revocation LANDED, so apply it to the cached relay lane before
        // asking the relay to confirm it. The follow-up listing can resolve
        // unreachable, and the keep-cached rule would otherwise keep showing
        // the removed person with a live Remove button. A local action takes
        // its own ticket, so a listing issued before the revoke cannot put
        // the row back; the refresh below is newer still and lands normally.
        //
        // Only under the session it started in: a revoke finishing after a
        // switch would otherwise claim a NEW ticket in the new session's
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
    [claimLanes, props, refreshShares, takeCommitTicket],
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
        // The completion is the user's command landing (see openConversation).
        props.onNavCommand?.({ level: "channels" });
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
        // In the same update that shows the channel: a channel on screen with
        // no answer in the lane is a locked channel. Registered as answered
        // LOCALLY, so the read already in flight — issued before this channel
        // existed, and therefore evicting to a view without it — keeps it.
        if (result.channel.wireId) {
          answerLocally(joinedOrder.current, workspaceId, result.channel.wireId);
        }
        setChannelShares((current) => answerCreatedChannel(current, result.channel));
        // The completion is the user's command landing (see openConversation).
        props.onNavCommand?.({ level: "channel", channel: result.channel });
        void openChannel(result.channel);
      } catch (error) {
        if (token !== liveToken.current) return;
        props.onError(ipcErrorMessage(error, "Could not create that channel."));
      }
    },
    [openChannel, props, workspaceId],
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
      setPersonalFeed([]);
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

  // Ends the DM's registry row through the exact leaveSharedChannel mechanism
  // (#742). The conversation drops out of `dms` immediately; the next
  // syncDms poll's classifyDmRequests puts it back in the request lane
  // because no workspace holds a live row for its shareId anymore. Routes
  // through goBack for its nav + composer-draft cleanup (#742 P1-B): without
  // it, the next DM opened after leaving could show this one's unsent draft,
  // and Send could reach the wrong person.
  const leaveDmConversation = useCallback(
    async (dm: DmRecord) => {
      const shareId = dm.shareId;
      if (!shareId) return;
      const token = liveToken.current;
      try {
        // Presence leave BEFORE the row ends (#742 P2-E): once leaveDm ends
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
        props.onError(ipcErrorMessage(error, "dohc could not leave that conversation."));
      }
    },
    [goBack, presence.leave, props, workspaceId],
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

  if (nav.level === "feed") {
    return (
      <div
        data-testid="chats-personal-feed"
        data-variant={variant}
        className="flex min-h-0 flex-1 flex-col"
        onKeyDownCapture={onKeyDownCapture}
      >
        <BackHeader
          label="Feed"
          testId="chats-feed"
          onBack={goBack}
          icon={<Rss size={12} aria-hidden className="shrink-0 text-subtle" />}
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className={`px-3 pb-12 pt-3 sm:px-4 ${pageColumn}`}>
            {personalFeed.length === 0 && !personalFeedLoading ? (
              <div className="rounded-xl border border-line bg-panel px-5 py-8 text-center">
                <Rss size={18} aria-hidden className="mx-auto mb-2 text-subtle" />
                <p className="m-0 text-[13px] font-medium text-ink">You’re caught up</p>
                <p className="mx-auto mb-0 mt-1 max-w-sm text-[11px] leading-5 text-subtle">
                  Follow people, agents, channels, or individual threads. New updates will collect here.
                </p>
              </div>
            ) : null}
            <div className="flex flex-col gap-3">
              {personalFeed.map((item) => {
                const authorKey = item.authorFollowTarget
                  ? `${item.authorFollowTarget.targetKind}:${item.authorFollowTarget.targetId}`
                  : null;
                const threadKey = `thread:${item.thread.id}`;
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
                const bookmark = bookmarkFor("message", item.message.id);
                const bookmarkKey = `message:${item.message.id}`;
                const hasFileMentions = extractChatFileReferences(item.message.body).length > 0;
                return (
                  <article
                    key={item.message.id}
                    data-testid="chats-feed-item"
                    className="rounded-xl border border-line bg-panel px-4 py-3"
                  >
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <button
                          type="button"
                          onClick={() => {
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
                          }}
                          className="block w-full text-left"
                        >
                          <span className="block text-[10px] text-subtle">
                            {item.channel ? `#${item.channel.name} · ` : ""}
                            {formatChatTime(item.message.createdAtMs).label}
                          </span>
                          <span className="mt-0.5 block text-[12px] font-medium text-ink">
                            {chatAuthorLabel(item.message)}
                          </span>
                          {!hasFileMentions ? (
                            <span className="mt-1 block whitespace-pre-wrap text-[13px] leading-5 text-ink">
                              <MentionText
                                body={item.message.body}
                                candidates={mentionCandidates}
                                attachments={item.message.attachments}
                              />
                            </span>
                          ) : null}
                        </button>
                        {hasFileMentions ? (
                          <span className="mt-1 block whitespace-pre-wrap text-[13px] leading-5 text-ink">
                            <MentionText
                              body={item.message.body}
                              candidates={mentionCandidates}
                              attachments={item.message.attachments}
                              onOpenPath={props.onOpenPath}
                            />
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-line/60 pt-2">
                      {authorKey ? (
                        <button
                          type="button"
                          data-testid="chats-feed-follow-author"
                          onClick={() =>
                            void toggleFeedFollow(authorKey, {
                              kind: "author",
                              threadId: item.thread.id,
                              messageId: item.message.id,
                            })
                          }
                          className="rounded-md px-2 py-1 text-[10px] text-muted hover:bg-line/40 hover:text-ink"
                        >
                          {followedUi.has(authorKey) ? "Following author" : "Follow author"}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        data-testid="chats-feed-follow-thread"
                        onClick={() =>
                          void toggleFeedFollow(threadKey, {
                            kind: "thread",
                            threadId: item.thread.id,
                          })
                        }
                        className="rounded-md px-2 py-1 text-[10px] text-muted hover:bg-line/40 hover:text-ink"
                      >
                        {followedUi.has(threadKey) ? "Following thread" : "Follow thread"}
                      </button>
                      <BookmarkAction
                        active={Boolean(bookmark)}
                        busy={bookmarkBusy.has(bookmarkKey)}
                        destinationPath={bookmark?.destinationPath}
                        onToggle={(mode) =>
                          void toggleBookmark({
                            target: {
                              kind: "message",
                              threadId: item.thread.id,
                              messageId: item.message.id,
                            },
                            mode,
                          })
                        }
                        onOpen={
                          bookmark && props.onOpenPath
                            ? () => props.onOpenPath?.(bookmark.destinationPath)
                            : undefined
                        }
                        testId="chats-feed-bookmark"
                      />
                      <span className="ml-auto text-[9px] uppercase tracking-wide text-subtle">
                        {item.matchedBy.join(" · ")}
                      </span>
                    </div>
                  </article>
                );
              })}
            </div>
            {personalFeedLoading ? (
              <p className="py-5 text-center text-[11px] text-subtle">Loading updates…</p>
            ) : null}
            {personalFeedNextCursor && !personalFeedLoading ? (
              <button
                type="button"
                data-testid="chats-feed-more"
                onClick={() => void loadPersonalFeed(personalFeedNextCursor)}
                className="mt-4 h-8 w-full rounded-md border border-line text-[11px] text-muted hover:bg-line/40 hover:text-ink"
              >
                Load older updates
              </button>
            ) : null}
          </div>
        </div>
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
          // A CONNECTED participant (shareId set, not already ended) has a
          // live placement to reverse (#742); the owner side (shareId null)
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
              onOpenPath={props.onOpenPath}
              flashMessageId={flashMessageId}
              onMessageElement={(messageId, element) => {
                if (element) messageNodes.current.set(messageId, element);
                else messageNodes.current.delete(messageId);
              }}
              reactionControls={{
                reactions,
                viewerAuthorId,
                onToggle: toggleReaction,
                readOnly: !dm.connected,
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
            onConfirm={() => leaveDmConversation(leavingDm)}
            onClose={() => setLeavingDm(null)}
          />
        ) : null}
      </div>
    );
  }

  if (nav.level === "thread") {
    const threadJoined = joinedFor(nav.channel);
    const threadLocked = channelIsLocked(nav.channel);
    const openingMessage = messages[0] ?? null;
    const comments = messages.slice(1);
    const threadBookmark = bookmarkFor("thread", nav.thread.id);
    const threadBookmarkKey = `thread:${nav.thread.id}`;
    const reactionControls: ChatReactionControls = {
      reactions,
      viewerAuthorId,
      onToggle: toggleReaction,
      readOnly: threadLocked,
    };
    const commentTree = openingMessage
      ? buildThreadCommentTree(openingMessage.id, comments)
      : [];
    const renderThreadComment = (
      node: ThreadCommentNode,
      depth: number,
      parent: ChatMessageRecord | null,
    ): ReactNode => {
      const comment = node.message;
      const commentTime = formatChatTime(comment.createdAtMs);
      const commentDecision = decisionsByMessage.get(comment.id);
      const commentAttachments = attachmentsByMessage.get(comment.id) ?? [];
      const isAgent = comment.authorKind === "agent";
      const replyCount = node.replies.length;
      const commentBookmark = bookmarkFor("message", comment.id);
      const commentBookmarkKey = `message:${comment.id}`;
      return (
        <li
          key={comment.id}
          ref={(element) => {
            if (element) messageNodes.current.set(comment.id, element);
            else messageNodes.current.delete(comment.id);
          }}
          data-testid="chats-message"
          data-message-id={comment.id}
          data-parent-message-id={comment.parentMessageId}
          data-thread-depth={depth}
          data-author-kind={comment.authorKind}
          className={`group flex min-w-0 flex-col transition-shadow ${
            flashMessageId === comment.id
              ? "rounded-xl ring-2 ring-agent/30 ring-offset-2 ring-offset-bg"
              : ""
          }`}
        >
          {parent ? (
            <button
              type="button"
              data-testid="chats-reply-context"
              // The jump writes no navigation, so nothing else here cancels
              // the pending cross-surface DM lookup — and a jump is still the
              // user commanding this conversation. Report it as one, before
              // the scroll, or the DM answers late and replaces the message
              // they just jumped to.
              onClick={() => {
                props.onNavCommand?.(nav);
                scrollToMessage(parent.id);
              }}
              className="mb-1 w-fit rounded px-2 text-left font-mono text-[10px] text-subtle hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              ↳ replying to {chatAuthorLabel(parent)}
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
              <MentionText
                body={comment.body}
                candidates={mentionCandidates}
                attachments={commentAttachments}
                testId="chats-message-body"
                onOpenPath={props.onOpenPath}
              />
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
                    !threadLocked && commentDecision.state === "open"
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
            {!threadLocked ? (
              <button
                type="button"
                data-testid="chats-comment-reply"
                onClick={() => beginReply(comment)}
                className="rounded hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              >
                Reply
              </button>
            ) : null}
            <BookmarkAction
              active={Boolean(commentBookmark)}
              busy={bookmarkBusy.has(commentBookmarkKey)}
              destinationPath={commentBookmark?.destinationPath}
              onToggle={
                threadLocked
                  ? undefined
                  : (mode) =>
                      void toggleBookmark({
                        target: {
                          kind: "message",
                          threadId: nav.thread.id,
                          messageId: comment.id,
                        },
                        mode,
                      })
              }
              onOpen={
                commentBookmark && props.onOpenPath
                  ? () => props.onOpenPath?.(commentBookmark.destinationPath)
                  : undefined
              }
              testId="chats-message-bookmark"
            />
            {replyCount > 0 ? (
              <span data-testid="chats-reply-count">
                {replyCount} {replyCount === 1 ? "reply" : "replies"}
              </span>
            ) : null}
            {runRecords[comment.id] ? <RunChip run={runRecords[comment.id]} /> : null}
            <time
              data-testid="chats-message-time"
              dateTime={commentTime.iso}
              title={commentTime.iso}
            >
              {commentTime.label}
            </time>
          </div>
          {replyCount > 0 ? (
            <ol
              data-testid="chats-replies"
              aria-label={`Replies to ${chatAuthorLabel(comment)}`}
              className={`relative mt-3 list-none space-y-3 border-l border-line/80 p-0 pl-3 sm:pl-4 ${
                depth < 3 ? "ml-3 sm:ml-5" : "ml-0"
              }`}
            >
              {node.replies.map((reply) =>
                renderThreadComment(reply, depth + 1, comment),
              )}
            </ol>
          ) : null}
        </li>
      );
    };
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
              {!threadLocked && dispatchState.liveRun ? (
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
                className="rounded px-1 text-muted underline decoration-line underline-offset-2 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default disabled:opacity-50"
              >
                Resume
              </button>
            ) : (
              <span>read-only</span>
            )}
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
                    <MentionText
                      body={openingMessage.body}
                      candidates={mentionCandidates}
                      attachments={attachmentsByMessage.get(openingMessage.id) ?? []}
                      testId="chats-message-body"
                      onOpenPath={props.onOpenPath}
                    />
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
                          !threadLocked &&
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
                    <BookmarkAction
                      active={Boolean(bookmarkFor("message", openingMessage.id))}
                      busy={bookmarkBusy.has(`message:${openingMessage.id}`)}
                      destinationPath={
                        bookmarkFor("message", openingMessage.id)?.destinationPath
                      }
                      onToggle={
                        threadLocked
                          ? undefined
                          : (mode) =>
                              void toggleBookmark({
                                target: {
                                  kind: "message",
                                  threadId: nav.thread.id,
                                  messageId: openingMessage.id,
                                },
                                mode,
                              })
                      }
                      onOpen={
                        bookmarkFor("message", openingMessage.id) && props.onOpenPath
                          ? () =>
                              props.onOpenPath?.(
                                bookmarkFor("message", openingMessage.id)!.destinationPath,
                              )
                          : undefined
                      }
                      testId="chats-message-bookmark"
                    />
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
                  {commentTree.map((node) => renderThreadComment(node, 0, null))}
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

  if (nav.level === "channel") {
    const channelJoined = joinedFor(nav.channel);
    const channelLocked = channelIsLocked(nav.channel);
    const channelGrants = nav.channel.wireId
      ? grantedByWire.get(nav.channel.wireId) ?? []
      : [];
    // Sharing an OWNED channel needs the sharing surface up; a joined channel
    // is never re-shareable from here (only its owner manages members).
    // Over the cap, a NEW grant only deepens the state: the relay's create
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
        {nav.channel.kind === "agent" && props.agentSetup ? (
          <div
            data-testid="chats-agent-setup-card"
            data-state={
              props.agentSetup.preferredName && props.agentSetup.runnerEnabled
                ? "ready"
                : "needs-setup"
            }
            className="flex shrink-0 items-center gap-3 border-b border-line bg-panel-2/50 px-3 py-2.5"
          >
            <span className="grid size-7 shrink-0 place-items-center rounded-md border border-agent/30 bg-bg text-agent">
              <Bot size={14} aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p data-testid="chats-agent-setup-name" className="m-0 truncate text-[12px] font-medium text-ink">
                {props.agentSetup.preferredName
                  ? agentDisplayLabel(props.agentSetup.preferredName)
                  : "Set up your agent"}
              </p>
              <p className="m-0 mt-0.5 truncate text-[10px] text-subtle">
                {!props.agentSetup.preferredName
                  ? "Choose your name so agent work is attributed correctly."
                  : props.agentSetup.runnerEnabled
                    ? "Chat runner ready"
                    : props.agentSetup.runnerConfigured
                        ? "Runner configured · dispatch is off"
                        : props.agentSetup.mcpEnabled
                          ? "Workspace MCP enabled · copy its config into your agent."
                          : "Connect a local agent to reply and work in this workspace."}
              </p>
            </div>
            {props.onSetupAgent ? (
              <button
                type="button"
                data-testid="chats-agent-setup-action"
                onClick={props.onSetupAgent}
                className="shrink-0 rounded-md border border-line bg-bg px-2.5 py-1 text-[10px] font-medium text-muted hover:text-ink"
              >
                {props.agentSetup.preferredName && props.agentSetup.runnerEnabled
                  ? "Manage"
                  : "Set up"}
              </button>
            ) : null}
          </div>
        ) : null}
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
                disabled={shareGrantsBlocked}
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
                disabled={
                  shareBusy || shareGrantsBlocked || shareEmail.trim().length === 0
                }
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
                  fileCandidates={fileMentionCandidates}
                  loadFileHeadings={loadFileHeadings}
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
                })}
              </ul>
            )}
          </div>
        </div>
        {channelLocked ? (
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

  return (
    <div
      data-testid="chats-view"
      data-variant={variant}
      className="flex min-h-0 flex-1 flex-col"
      onKeyDownCapture={onKeyDownCapture}
    >
      <div className={`min-h-0 flex-1 overflow-y-auto ${pageColumn}`}>
        <AddressedToMe notifications={props.addressedToMe ?? []} />
        <section className="border-b border-line" aria-label="Feed">
          <button
            type="button"
            data-testid="chats-feed-link"
            data-active={props.selectedNav?.level === "feed" ? "true" : "false"}
            aria-current={props.selectedNav?.level === "feed" ? "page" : undefined}
            onClick={() => openConversation({ level: "feed" })}
            className={`flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-panel-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent ${
              props.selectedNav?.level === "feed" ? "bg-panel-2" : ""
            }`}
          >
            <Rss size={13} aria-hidden className="shrink-0 text-accent" />
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] font-medium text-ink">Feed</span>
              <span className="block text-[10px] text-subtle">Updates from what you follow</span>
            </span>
          </button>
        </section>
        {agentChannel ? (
          <section data-testid="chats-my-agent-section" aria-label="My agent">
            <p className="mb-0 mt-3 px-3 text-[10px] font-semibold uppercase tracking-wide text-subtle">
              My agent
            </p>
            <button
              type="button"
              data-testid="chats-my-agent"
              data-channel-id={agentChannel.id}
              data-active={selectedChannelId === agentChannel.id ? "true" : "false"}
              aria-current={selectedChannelId === agentChannel.id ? "page" : undefined}
              onClick={() =>
                openConversation({ level: "channel", channel: agentChannel })
              }
              className={`flex w-full cursor-pointer items-center gap-1.5 border-b border-line px-3 py-2 text-left transition-colors hover:bg-panel-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent ${
                selectedChannelId === agentChannel.id ? "bg-panel-2" : ""
              }`}
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
              <li key={channel.id} className="flex items-stretch border-b border-line">
                <button
                  type="button"
                  data-testid="chats-channel"
                  data-channel-id={channel.id}
                  data-channel-slug={channel.slug}
                  data-active={selectedChannelId === channel.id ? "true" : "false"}
                  aria-current={selectedChannelId === channel.id ? "page" : undefined}
                  onClick={() =>
                    openConversation({ level: "channel", channel })
                  }
                  className={`flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 px-3 py-2 text-left transition-colors hover:bg-panel-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent ${
                    selectedChannelId === channel.id ? "bg-panel-2" : ""
                  }`}
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
                {channel.wireId ? (
                  <button
                    type="button"
                    data-testid="chats-channel-follow"
                    data-channel-id={channel.id}
                    aria-pressed={followedUi.has(`channel:${channel.wireId}`)}
                    aria-label={`${
                      followedUi.has(`channel:${channel.wireId}`) ? "Unfollow" : "Follow"
                    } #${channel.name}`}
                    title={`${
                      followedUi.has(`channel:${channel.wireId}`) ? "Unfollow" : "Follow"
                    } #${channel.name}`}
                    onClick={() => void toggleChannelFollow(channel)}
                    className={`grid w-9 shrink-0 place-items-center transition-colors hover:bg-panel-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent ${
                      followedUi.has(`channel:${channel.wireId}`)
                        ? "text-accent"
                        : "text-subtle"
                    }`}
                  >
                    <Rss size={12} aria-hidden />
                  </button>
                ) : null}
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
                    data-active={selectedDmId === dm.channelId ? "true" : "false"}
                    aria-current={selectedDmId === dm.channelId ? "page" : undefined}
                    onClick={() => openConversation({ level: "dm", dm })}
                    className={`flex w-full cursor-pointer items-center gap-1.5 px-3 py-2 text-left transition-colors hover:bg-panel-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent ${
                      selectedDmId === dm.channelId ? "bg-panel-2" : ""
                    }`}
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
                    // A command like any conversation click (see
                    // openConversation): report it synchronously, or a DM
                    // answer queued in this tick remounts over the compose.
                    props.onNavCommand?.({ level: "dm-new" });
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
            <p className="mb-0 mt-3 px-3 text-[10px] font-semibold uppercase tracking-wide text-subtle">
              Direct message requests
            </p>
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
                <p className="m-0 px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-subtle">
                  Declined
                </p>
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
        {receivedNotJoined.length > 0 || shareReadFailure !== null ? (
          <div data-testid="chats-shared-with-you">
            <p className="mb-0 mt-3 px-3 text-[10px] font-semibold uppercase tracking-wide text-subtle">
              Shared with you
            </p>
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
                        ? `Open in the Chats panel (${thread.path})`
                        : "Open in the Chats panel"
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
