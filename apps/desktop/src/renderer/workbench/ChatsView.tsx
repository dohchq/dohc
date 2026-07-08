import { ArrowLeft, AtSign, Bot, FileText, Hash, MessagesSquare, Plus, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ChannelThreadRecord,
  ChatChannelRecord,
  ChatChannelShareGrantRow,
  ChatMessageRecord,
  ChatReactionRecord,
  DmRecord,
  FileChatThreadRecord,
  JoinedSharedChannelRow,
  ListChatChannelSharesResult,
} from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import type { AgentNotification } from "./agentNotifications";
import {
  ChatMessageList,
  formatChatTime,
  ipcErrorMessage,
  runReactionToggle,
} from "./chatMessages";
import { MentionComposer } from "./MentionComposer";
import { findMentions, type MentionCandidate } from "./mentions";
import { PresenceFaces, TypingIndicator } from "../collab/PresenceIndicators";
import { usePresence } from "../collab/usePresence";
import type { PresenceTransport } from "../collab/presenceChannel";

// Multi-user chat presence (MU-C1) is opt-in: only under collaboration
// (signedIn && relayConnected) is a transport supplied, so a solo/offline user
// constructs no presence at all. Absent => today's exact single-user Chats.
export interface ChatPresenceCollaboration {
  transport: PresenceTransport;
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

type Nav =
  | { level: "channels" }
  | { level: "channel"; channel: ChatChannelRecord }
  | { level: "thread"; channel: ChatChannelRecord; thread: ChannelThreadRecord }
  // Direct messages (WS-MU-C3): one running conversation per DM (the
  // anti-forum rule), plus a one-step "new message" composer.
  | { level: "dm"; dm: DmRecord }
  | { level: "dm-new" };

function UnreadPill(props: { count: number; testId: string }) {
  if (props.count <= 0) return null;
  return (
    <span
      data-testid={props.testId}
      aria-label={`${props.count} unread`}
      className="min-w-4 shrink-0 rounded-full bg-ink px-1 text-center text-[9px] font-semibold leading-4 text-bg"
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
              className="flex w-full cursor-pointer items-start gap-1.5 px-3 py-2 text-left transition-colors hover:bg-line/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
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
  onError: (message: string) => void;
  // @-mention roster for this workspace (the user + available agents). When
  // provided, the composer offers autocomplete and messages render chips.
  mentionCandidates?: readonly MentionCandidate[];
  // Called after a message that @-mentions an agent is sent, so the shell can
  // pull that agent into the thread (the existing agent-chat reply path).
  onAgentMentioned?: (input: { threadId: string; mentioned: MentionCandidate[]; body: string }) => void;
  // "Addressed to me" inbox: agent asks / requests waiting on the user.
  addressedToMe?: readonly AgentNotification[];
  onOpenAddressed?: (notification: AgentNotification) => void;
  // Ephemeral presence/typing transport, present ONLY under collaboration.
  collaboration?: ChatPresenceCollaboration | null;
}) {
  const { workspaceId } = props;
  const collaboration = props.collaboration ?? null;
  const mentionCandidates = props.mentionCandidates ?? [];
  const agentCandidates = mentionCandidates.filter((candidate) => candidate.kind === "agent");
  const [overview, setOverview] = useState<OverviewState>({ status: "loading" });
  const [nav, setNav] = useState<Nav>({ level: "channels" });
  const [channelThreads, setChannelThreads] = useState<ChannelThreadRecord[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [messages, setMessages] = useState<ChatMessageRecord[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [reactions, setReactions] = useState<ChatReactionRecord[]>([]);
  const [viewerAuthorId, setViewerAuthorId] = useState("");
  const [composer, setComposer] = useState("");
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
  // Per-(message, emoji) toggle sequence so overlapping reaction toggles resolve
  // in order (see runReactionToggle).
  const reactionSeq = useRef(new Map<string, number>());
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Presence topic for the open channel/thread (stable per conversation). A
  // thread scopes to its OWN id so typing in one thread never bleeds into a
  // sibling thread of the same channel. A solo user (no collaboration
  // transport) keeps this dormant.
  const presenceTopic =
    nav.level === "channel"
      ? `chat:channel:${nav.channel.id}`
      : nav.level === "thread"
        ? `chat:thread:${nav.thread.id}`
        : "";
  const presence = usePresence({
    enabled: collaboration !== null && presenceTopic !== "",
    transport: collaboration?.transport ?? null,
    topic: presenceTopic,
    clientId: collaboration?.clientId ?? "",
    displayName: collaboration?.displayName ?? "",
  });

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
    setMessages([]);
    setComposer("");
    setNewThreadBody("");
    setCreatingChannel(null);
    setChannelShares(null);
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

  const openChannel = useCallback(
    async (channel: ChatChannelRecord) => {
      const token = ++liveToken.current;
      setNav({ level: "channel", channel });
      setSharePanelOpen(false);
      setChannelThreads([]);
      setThreadsLoading(true);
      try {
        const result = await bridge().listChannelThreads({
          workspaceId,
          channelId: channel.id,
        });
        if (token !== liveToken.current) return;
        setChannelThreads(result.threads);
      } catch (error) {
        if (token !== liveToken.current) return;
        props.onError(ipcErrorMessage(error, "Could not load this channel."));
      } finally {
        if (token === liveToken.current) setThreadsLoading(false);
      }
    },
    [props, workspaceId],
  );

  const openThread = useCallback(
    async (channel: ChatChannelRecord, thread: ChannelThreadRecord) => {
      const token = ++liveToken.current;
      setNav({ level: "thread", channel, thread });
      setMessages([]);
      setReactions([]);
      setMessagesLoading(true);
      try {
        const [result, reactionResult] = await Promise.all([
          bridge().listChatMessages({ workspaceId, threadId: thread.id }),
          bridge().listChatReactions({ workspaceId, threadId: thread.id }),
        ]);
        if (token !== liveToken.current) return;
        setMessages(result.messages);
        setReactions(reactionResult.reactions);
        setViewerAuthorId(reactionResult.viewerAuthorId);
        requestAnimationFrame(() =>
          messagesEndRef.current?.scrollIntoView({ block: "end" }),
        );
        // Everything on screen is read: advance the monotonic cursor and
        // clear this thread's badge locally so back-navigation is honest
        // without a refetch round trip.
        const upToSequence = result.messages.length;
        setChannelThreads((current) =>
          current.map((entry) =>
            entry.id === thread.id ? { ...entry, unreadCount: 0 } : entry,
          ),
        );
        void bridge()
          .markChatThreadRead({ workspaceId, threadId: thread.id, upToSequence })
          .catch(() => {
            // Mark-read is best-effort; the badge re-appears on next refresh
            // if the cursor write did not land.
          });
      } catch (error) {
        if (token !== liveToken.current) return;
        props.onError(ipcErrorMessage(error, "Could not load this chat."));
      } finally {
        if (token === liveToken.current) setMessagesLoading(false);
      }
    },
    [props, workspaceId],
  );

  // After a human message is sent, pull any @-mentioned agent into the thread
  // through the shell (which wires the existing agent-chat reply path). Deduped
  // by candidate id so "@agent @agent" invokes once.
  const notifyAgentMention = useCallback(
    (threadId: string, body: string) => {
      if (!props.onAgentMentioned || agentCandidates.length === 0) return;
      // Invoke path is code-aware: an @agent typed inside inline code or a
      // fenced block (e.g. `npm install @agent/pkg`) must NOT invoke the agent.
      const mentioned = findMentions(body, agentCandidates, { ignoreCode: true }).map(
        (match) => match.candidate,
      );
      if (mentioned.length === 0) return;
      const unique = Array.from(new Map(mentioned.map((c) => [c.id, c])).values());
      props.onAgentMentioned({ threadId, mentioned: unique, body });
    },
    [agentCandidates, props],
  );

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
      setChannelThreads((current) => [result.thread, ...current]);
      notifyAgentMention(result.thread.id, body);
    } catch (error) {
      if (token !== liveToken.current) return;
      props.onError(ipcErrorMessage(error, "Could not start that chat."));
    } finally {
      startingThreadRef.current = false;
      setStartingThread(false);
    }
  }, [nav, newThreadBody, notifyAgentMention, props, startingThread, workspaceId]);

  const sendMessage = useCallback(async () => {
    if (nav.level !== "thread") return;
    const body = composer.trim();
    if (body.length === 0 || sending || sendingRef.current) return;
    const token = liveToken.current;
    sendingRef.current = true;
    setSending(true);
    try {
      const result = await bridge().sendChatMessage({
        workspaceId,
        threadId: nav.thread.id,
        body,
      });
      if (token !== liveToken.current) return;
      setMessages((current) => [...current, result.message]);
      setComposer("");
      messagesEndRef.current?.scrollIntoView({ block: "end" });
      notifyAgentMention(nav.thread.id, body);
    } catch (error) {
      if (token !== liveToken.current) return;
      props.onError(ipcErrorMessage(error, "Could not send that message."));
    } finally {
      // Unconditional reset (LinkedChats precedent): navigation bumps the
      // token without resetting `sending`, and the token guard on the READ
      // above already prevents concurrent sends.
      sendingRef.current = false;
      setSending(false);
    }
  }, [composer, nav, notifyAgentMention, props, sending, workspaceId]);

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
      setMessagesLoading(true);
      try {
        await loadDmConversation(dm, token);
        if (token !== liveToken.current) return;
        setDms((current) =>
          current.map((entry) =>
            entry.channelId === dm.channelId ? { ...entry, unreadCount: 0 } : entry,
          ),
        );
        requestAnimationFrame(() =>
          messagesEndRef.current?.scrollIntoView({ block: "end" }),
        );
      } catch (error) {
        if (token !== liveToken.current) return;
        props.onError(ipcErrorMessage(error, "Could not load this conversation."));
      } finally {
        if (token === liveToken.current) setMessagesLoading(false);
      }
    },
    [loadDmConversation, props],
  );

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

  const refreshShares = useCallback(async () => {
    const token = liveToken.current;
    const shares = await bridge()
      .listChatChannelShares({ workspaceId })
      .catch(() => null);
    if (token !== liveToken.current) return;
    setChannelShares(shares);
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

  // Escape walks back up one level — but never steals Escape from a composer
  // holding a draft (that Escape reads as "leave my text alone").
  const onKeyDownCapture = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
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
    [goBack, nav.level],
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
          className="h-7 cursor-pointer rounded border border-line px-2 text-[11px] text-muted hover:bg-line/50 hover:text-ink"
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
        className="flex min-h-0 flex-1 flex-col"
        onKeyDownCapture={onKeyDownCapture}
      >
        <BackHeader
          label="New message"
          testId="chats-dm-new"
          onBack={goBack}
          icon={<AtSign size={12} aria-hidden className="shrink-0 text-subtle" />}
        />
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
            className="h-7 w-full rounded border border-line bg-bg px-2 text-[12px] text-ink placeholder:text-subtle focus:outline focus:outline-2 focus:-outline-offset-1 focus:outline-accent"
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
    );
  }

  if (nav.level === "dm") {
    const dm = nav.dm;
    return (
      <div
        data-testid="chats-dm-view"
        className="flex min-h-0 flex-1 flex-col"
        onKeyDownCapture={onKeyDownCapture}
      >
        <BackHeader
          label={dm.peerLabel}
          testId="chats-dm"
          onBack={goBack}
          icon={<AtSign size={12} aria-hidden className="shrink-0 text-subtle" />}
        />
        {/* Presence seam (MU-C1): once the awareness channel lands, "viewing"
            and "typing…" render here, keyed by this DM's channelWireId and
            fanned out through the SAME shareForRecipient grant gate. Until
            then the header stays calm — no fake liveness. */}
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
        {dm.connected ? (
          <MentionComposer
            testIdPrefix="chats-dm"
            composerId="chats-dm-composer"
            value={composer}
            sending={sending || !dm.threadId}
            placeholder={`Message ${dm.peerLabel}…`}
            sendLabel="Send message"
            candidates={mentionCandidates}
            onChange={setComposer}
            onSend={() => void sendDmMessage()}
          />
        ) : (
          <ComposerNotice testId="chats-dm-ended">
            This conversation has ended. You can still read it.
          </ComposerNotice>
        )}
      </div>
    );
  }

  if (nav.level === "thread") {
    const threadJoined = joinedFor(nav.channel);
    const threadLocked = threadJoined !== null && (threadJoined.access === "read-only" || threadJoined.ended);
    return (
      <div
        data-testid="chats-thread-view"
        className="flex min-h-0 flex-1 flex-col"
        onKeyDownCapture={onKeyDownCapture}
      >
        <BackHeader
          label={nav.thread.title}
          testId="chats-thread"
          onBack={goBack}
          trailing={<PresenceFaces others={presence.others} />}
        />
        <ChatMessageList
          testIdPrefix="chats"
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
        <TypingIndicator names={presence.typingNames} className="px-2" />
        {threadLocked ? (
          <ComposerNotice testId="chats-readonly-note">
            {threadJoined.ended
              ? "This channel is no longer shared with you. You can still read it."
              : "This channel is read-only for you."}
          </ComposerNotice>
        ) : (
          <MentionComposer
            testIdPrefix="chats"
            composerId="chats-composer"
            value={composer}
            sending={sending}
            placeholder="Write a message…  @ to mention"
            sendLabel="Send message"
            candidates={mentionCandidates}
            onChange={(value) => {
              setComposer(value);
              presence.setTyping(value.trim().length > 0);
            }}
            onSend={() => {
              presence.setTyping(false);
              void sendMessage();
            }}
          />
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
    const canShare = channelShares !== null && channelJoined === null && !!nav.channel.wireId;
    return (
      <div
        data-testid="chats-channel-view"
        className="flex min-h-0 flex-1 flex-col"
        onKeyDownCapture={onKeyDownCapture}
      >
        <BackHeader
          label={nav.channel.name}
          testId="chats-channel"
          onBack={goBack}
          icon={<Hash size={12} aria-hidden className="shrink-0 text-subtle" />}
          trailing={<PresenceFaces others={presence.others} />}
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
          {threadsLoading ? (
            <p className="m-0 pt-4 text-center text-[11px] text-subtle">Loading...</p>
          ) : channelThreads.length === 0 ? (
            <div
              data-testid="chats-channel-empty"
              className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center"
            >
              <MessagesSquare size={16} aria-hidden className="text-subtle" />
              <span className="text-xs text-muted">Nothing here yet.</span>
              <span className="text-[11px] text-subtle">
                Type below to start a chat.
              </span>
            </div>
          ) : (
            <ul className="m-0 list-none p-0">
              {channelThreads.map((thread) => (
                <li key={thread.id} className="border-b border-line">
                  <button
                    type="button"
                    data-testid="chats-thread"
                    data-thread-id={thread.id}
                    onClick={() => void openThread(nav.channel, thread)}
                    className="flex w-full cursor-pointer items-center gap-1.5 px-3 py-2 text-left transition-colors hover:bg-line/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
                  >
                    <span className="min-w-0 flex-1">
                      <span
                        data-testid="chats-thread-name"
                        className="block truncate text-[12px] font-medium text-ink"
                      >
                        {thread.title}
                      </span>
                      <span className="block text-[10px] text-subtle">
                        {formatChatTime(thread.updatedAtMs).label}
                      </span>
                    </span>
                    <UnreadPill count={thread.unreadCount} testId="chats-thread-unread" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {channelLocked ? (
          <ComposerNotice testId="chats-readonly-note">
            {channelJoined.ended
              ? "This channel is no longer shared with you. You can still read it."
              : "This channel is read-only for you."}
          </ComposerNotice>
        ) : (
          <MentionComposer
            testIdPrefix="chats-new-thread"
            composerId="chats-new-thread-composer"
            value={newThreadBody}
            sending={startingThread}
            placeholder={`Message #${nav.channel.name}…  @ to mention`}
            sendLabel="Start a new chat"
            candidates={mentionCandidates}
            onChange={setNewThreadBody}
            onSend={() => void startThread()}
          />
        )}
      </div>
    );
  }

  return (
    <div
      data-testid="chats-view"
      className="flex min-h-0 flex-1 flex-col"
      onKeyDownCapture={onKeyDownCapture}
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <AddressedToMe
          notifications={props.addressedToMe ?? []}
          onOpen={props.onOpenAddressed}
        />
        <ul className="m-0 list-none p-0">
          {overview.channels
            .filter((channel) => channel.kind !== "dm")
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
                  className="flex w-full cursor-pointer items-center gap-1.5 px-3 py-2 text-left transition-colors hover:bg-line/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
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
                    className="flex w-full cursor-pointer items-center gap-1.5 px-3 py-2 text-left transition-colors hover:bg-line/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
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
                  className="flex h-7 w-full cursor-pointer items-center justify-center gap-1.5 rounded border border-line text-[11px] text-muted hover:bg-line/50 hover:text-ink"
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
                    className="flex w-full cursor-pointer items-center gap-1.5 px-3 py-2 text-left transition-colors hover:bg-line/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
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
      <div className="shrink-0 border-t border-line p-2">
        {creatingChannel === null ? (
          <button
            type="button"
            data-testid="chats-new-channel"
            onClick={() => setCreatingChannel("")}
            className="flex h-7 w-full cursor-pointer items-center justify-center gap-1.5 rounded border border-line text-[11px] text-muted hover:bg-line/50 hover:text-ink"
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
              className="h-7 w-full rounded border border-line bg-bg px-2 text-[12px] text-ink placeholder:text-subtle focus:outline focus:outline-2 focus:-outline-offset-1 focus:outline-accent"
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
