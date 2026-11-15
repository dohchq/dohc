import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Ban, Check, CloudOff, PenSquare, Plus, Users, X } from "lucide-react";
import { MAX_DIRECT_PEOPLE, type DirectConversation, type DirectMessage, type DirectPerson } from "@dohc/security-contract/direct-messages";
import type { MembersResult } from "@dohc/cli/members";
import type { MentionCandidate } from "@dohc/workspace-contracts/chat-mentions";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import { DIRECT_SIGNED_OUT, readError, refusalCode, WORKSPACE_NOT_SYNCED } from "../../ipc/errorWords";
import { EmptyState, FieldError, RetryRow, SecondaryButton, SectionLabel } from "../ui/controls";
import { Menu } from "../ui/Menu";
import { MoreMenu, type MoreMenuItem } from "../ui/MoreMenu";
import { SkeletonRows } from "../ui/SkeletonRows";
import { relayPresentation } from "./actorPresentation";
import { ChatAvatar } from "./ChatAvatar";
import { ChatHeader, UnreadPill } from "./ChatsControls";
import { NavRow, SectionActionButton } from "./ChatNavRow";
import { chatRowMenuItems } from "./chatRowMenu";
import { ChatMessageList, type ChatMessageListHandle } from "./chatMessages";
import { EMPTY_ART } from "./EmptyArt";
import { MentionComposer } from "./MentionComposer";
import type { ChatErrorNotice } from "./ChatsView";
import {
  directMessageRecord,
  directPersonName,
  directPresentation,
  directTitle,
  mergeDirectPage,
  useDirectConversations,
  type DirectListState,
  type DirectStore,
} from "./directConversations";

// Direct messages in Chats: the People section, one conversation, and New
// message. The conversations live on the account's server; see directConversations.ts.

type ReportError = (message: string, cause?: unknown, retry?: () => void, refusedPage?: string, notice?: ChatErrorNotice) => void;

interface Reporting {
  onError: ReportError;
  onClearError?: (identity: string) => void;
  onNotice?: (message: string, undo?: () => void) => void;
}

const NO_CANDIDATES: readonly MentionCandidate[] = [];
const LIST_IDENTITY = "direct-list";
const OFFLINE_LINE = "dohc could not reach your server. This is the copy saved on this computer.";

/** A person's round face, or a group's people mark. */
export function DirectAvatar(props: { people: readonly DirectPerson[]; viewerId: string | null }) {
  const [first, second] = props.people;
  if (!first) return <Users size={15} strokeWidth={1.9} aria-hidden className="shrink-0 text-muted" />;
  if (!second) {
    return <ChatAvatar presentation={directPresentation(first.personId, props.viewerId)} name={directPersonName(first)} kind="human" size="strip" />;
  }
  // Two faces small enough to fit a row are too small to read, so a group shows one mark.
  return (
    <span data-testid="chats-dm-group-avatar" aria-hidden className="grid size-[18px] shrink-0 place-items-center rounded-full bg-panel-2 text-muted">
      <Users size={11} strokeWidth={2} />
    </span>
  );
}

/** The mark beside someone the viewer blocks. */
function BlockedMark(props: { testId: string; name: string | null }) {
  return (
    <span data-testid={props.testId} title={props.name ? `You blocked ${props.name}` : "Blocked"} className="inline-flex shrink-0 text-subtle">
      <Ban size={12} aria-hidden />
      <span className="sr-only">Blocked</span>
    </span>
  );
}

function preview(conversation: DirectConversation, viewerId: string): string | null {
  const last = conversation.last;
  if (!last) return null;
  const words = last.body.replace(/\s+/gu, " ").trim();
  if (last.authorId === viewerId) return `You: ${words}`;
  return conversation.people.length > 1 ? `${last.authorName ?? "Someone"}: ${words}` : words;
}

/** Reports a failed list read once per message, and takes it back when a read works. */
function useListFailureReport(state: DirectListState, store: DirectStore, reporting: Reporting) {
  const failure = state.status === "failed" ? state.message : state.status === "ready" ? state.failure : null;
  const report = useRef(reporting);
  report.current = reporting;
  useEffect(() => {
    if (failure) {
      report.current.onError(failure, undefined, () => void store.refresh(), undefined, { identity: LIST_IDENTITY });
    } else if (state.status === "ready") {
      report.current.onClearError?.(LIST_IDENTITY);
    }
  }, [failure, state.status, store]);
}

/** The People section of the Chats sidebar. Hidden while signed out. */
export function DirectPeopleSection(props: Reporting & {
  selectedConversationId: string | null;
  onOpen: (conversationId: string, title: string) => void;
  onNew: () => void;
}) {
  const { state, store } = useDirectConversations();
  useListFailureReport(state, store, props);
  const [menu, setMenu] = useState<{ conversationId: string; at: { x: number; y: number }; fromKeyboard: boolean } | null>(null);
  if (state.status === "signed-out") return null;
  const ready = state.status === "ready" ? state : null;
  const menuConversation = menu && ready ? ready.conversations.find((entry) => entry.conversationId === menu.conversationId) ?? null : null;
  const setBlocked = (conversation: DirectConversation, blocked: boolean) => {
    const person = conversation.people[0];
    if (!person || conversation.people.length !== 1) return;
    void blockPerson({ store, conversationId: conversation.conversationId, person, blocked, reporting: props });
  };
  return (
    <section data-testid="chats-dms-section" aria-label="People">
      <div className="group mt-4 flex h-6 items-center pl-3 pr-2">
        <SectionLabel as="p" className="min-w-0 flex-1">
          People
        </SectionLabel>
        {ready?.saved ? (
          <span data-testid="chats-dms-saved" title={OFFLINE_LINE} className="grid size-6 shrink-0 place-items-center text-subtle">
            <CloudOff size={12} aria-hidden />
            <span className="sr-only">{OFFLINE_LINE}</span>
          </span>
        ) : null}
        <SectionActionButton testId="chats-new-dm-action" label="New message" onClick={props.onNew}>
          <Plus size={12} aria-hidden />
        </SectionActionButton>
      </div>
      {state.status === "loading" ? (
        <SkeletonRows rows={2} label="Loading people…" testId="chats-dms-loading" className="px-3 py-2" />
      ) : state.status === "failed" ? (
        <RetryRow testId="chats-dms-retry" onRetry={() => void store.refresh()}>
          {state.message}
        </RetryRow>
      ) : ready && ready.conversations.length > 0 ? (
        <ul className="m-0 list-none p-0">
          {ready.conversations.map((conversation) => {
            const title = directTitle(conversation.people);
            const unread = conversation.unread > 0;
            const line = preview(conversation, ready.viewerId);
            const single = conversation.people.length === 1 ? conversation.people[0]! : null;
            return (
              <li key={conversation.conversationId}>
                <NavRow
                  testId="chats-dm-item"
                  data={{
                    "data-conversation-id": conversation.conversationId,
                    ...(conversation.blocked ? { "data-blocked": "true" } : {}),
                  }}
                  active={props.selectedConversationId === conversation.conversationId}
                  unread={unread}
                  muted={conversation.blocked}
                  onClick={() => props.onOpen(conversation.conversationId, title)}
                  icon={<DirectAvatar people={conversation.people} viewerId={ready.viewerId} />}
                  label={title}
                  labelTestId="chats-dm-name"
                  // Only an unread row shows its last message, so the rest stay quiet.
                  {...(unread && line ? { detail: line } : {})}
                  {...(line ? { title: `${title}\n${line}` } : {})}
                  menuOpen={menu?.conversationId === conversation.conversationId}
                  onMenu={(at, fromKeyboard) => setMenu({ conversationId: conversation.conversationId, at, fromKeyboard })}
                  trailing={
                    <>
                      {conversation.blocked ? <BlockedMark testId="chats-dm-blocked" name={single ? directPersonName(single) : null} /> : null}
                      <UnreadPill count={conversation.unread} testId="chats-dm-unread" />
                    </>
                  }
                />
              </li>
            );
          })}
        </ul>
      ) : (
        <NavRow
          testId="chats-new-dm"
          onClick={props.onNew}
          icon={<PenSquare size={15} strokeWidth={1.9} aria-hidden className="shrink-0 text-muted" />}
          label="New message"
          muted
        />
      )}
      {menu && menuConversation && ready ? (
        <Menu
          label={`${directTitle(menuConversation.people)} options`}
          menuTestId="chat-row-menu"
          items={chatRowMenuItems(
            {
              kind: "person",
              unread: menuConversation.unread > 0 && menuConversation.last !== null,
              block: menuConversation.people.length === 1
                ? { name: directPersonName(menuConversation.people[0]!), blocked: menuConversation.blocked }
                : null,
            },
            {
              markRead: () => {
                if (menuConversation.last) store.markRead(menuConversation.conversationId, menuConversation.last.seq);
              },
              setBlocked: (blocked) => setBlocked(menuConversation, blocked),
              setArchived: () => undefined,
              addPeople: () => undefined,
              leave: () => undefined,
              setAgentEnabled: () => undefined,
              removeAgent: () => undefined,
              hideChat: () => undefined,
            },
          )}
          at={menu.at}
          fromKeyboard={menu.fromKeyboard}
          width={200}
          open
          onOpenChange={(open) => {
            if (!open) setMenu(null);
          }}
        />
      ) : null}
    </section>
  );
}

/** Reports a failure, with Try again only where trying again can help: a block or a refusal stays as it is. */
function reportDirect(reporting: Reporting, message: string, cause: unknown, retry: () => void, refusedPage?: string, notice?: ChatErrorNotice): void {
  reporting.onError(message, cause, readError(cause).canRetry === false ? undefined : retry, refusedPage, notice);
}

async function blockPerson(input: {
  store: DirectStore;
  conversationId: string;
  person: DirectPerson;
  blocked: boolean;
  reporting: Reporting;
  // In a group, the notice holds Undo, since the block doesn't take the composer's place.
  withUndo?: boolean;
  /** Runs once the change is made, by the first try or by the notice's Try again. */
  onDone?: () => void;
}): Promise<void> {
  const { store, conversationId, person, blocked, reporting } = input;
  const name = directPersonName(person);
  const identity = `direct-block:${conversationId}:${person.personId}`;
  try {
    await store.setBlocked(conversationId, person.personId, blocked);
    reporting.onClearError?.(identity);
    input.onDone?.();
    if (input.withUndo) {
      reporting.onNotice?.(
        blocked ? `Blocked ${name}. You won't see their new messages.` : `Unblocked ${name}`,
        () => void blockPerson({ ...input, blocked: !blocked, withUndo: false, onDone: undefined }),
      );
    }
  } catch (cause) {
    reportDirect(reporting,
      ipcErrorMessage(cause, blocked ? `dohc could not block ${name}.` : `dohc could not unblock ${name}.`),
      cause,
      () => void blockPerson(input),
      undefined,
      { identity },
    );
  }
}

/** Whether the list's newest message is on screen: scrolled to the end, in a window that shows. */
function useNewestInView(list: RefObject<ChatMessageListHandle | null>, ready: boolean): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    if (!ready) return;
    let node: HTMLElement | null = null;
    const check = () => {
      node ??= list.current?.getScrollableNode() ?? null;
      const atEnd = !node || node.scrollHeight - node.scrollTop - node.clientHeight < 48;
      setInView(atEnd && document.visibilityState === "visible");
    };
    // The list mounts its scroller after the first layout.
    const frame = requestAnimationFrame(() => {
      check();
      node?.addEventListener("scroll", check, { passive: true });
    });
    check();
    document.addEventListener("visibilitychange", check);
    return () => {
      cancelAnimationFrame(frame);
      node?.removeEventListener("scroll", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [list, ready]);
  return inView;
}

type History =
  | { conversationId: string; status: "loading" }
  | { conversationId: string; status: "failed"; message: string }
  | { conversationId: string; status: "ready"; messages: readonly DirectMessage[]; more: boolean; saved: boolean; olderLoading: boolean };

/** Where a state's next step lives, when it lives in Settings. */
type OpenSettings = (section: "cloud" | "members") => void;

type ConversationProps = Reporting & {
  conversationId: string;
  onOpenSettings?: OpenSettings;
  variant: "panel" | "page";
  onBack?: () => void;
  mentionCandidates?: readonly MentionCandidate[];
  onOpenPath?: (path: string, headingAnchor?: string) => void;
  /** The people's names, once the list knows them, for the tab. */
  onTitle?: (title: string) => void;
};

/** One direct conversation, read from the server, or this computer's copy while the server is away. */
export function DirectConversationView(props: ConversationProps) {
  // A change of account starts the view over, so nothing read or typed for the last account stays on screen.
  const { store } = useDirectConversations();
  return <ConversationForAccount key={store.session()} {...props} />;
}

function ConversationForAccount(props: ConversationProps) {
  const { conversationId, onTitle } = props;
  const { state, store } = useDirectConversations();
  useListFailureReport(state, store, props);
  const ready = state.status === "ready" ? state : null;
  const viewerId = ready?.viewerId ?? null;
  const conversation = ready?.conversations.find((entry) => entry.conversationId === conversationId) ?? null;
  const reporting = useRef<Reporting>(props);
  reporting.current = props;

  const [history, setHistory] = useState<History>({ conversationId, status: "loading" });
  const shown = history.conversationId === conversationId ? history : ({ conversationId, status: "loading" } as const);
  const request = useRef(0);
  const historyIdentity = `direct-history:${conversationId}`;
  const load = useCallback(async (before?: number) => {
    const mine = ++request.current;
    const session = store.session();
    if (before !== undefined) {
      setHistory((current) => current.conversationId === conversationId && current.status === "ready" ? { ...current, olderLoading: true } : current);
    }
    try {
      const page = await bridge().directHistory(before === undefined ? { conversationId } : { conversationId, before });
      if (mine !== request.current || session !== store.session()) return;
      reporting.current.onClearError?.(historyIdentity);
      setHistory((current) => {
        const previous = current.conversationId === conversationId && current.status === "ready" ? current : null;
        const messages = mergeDirectPage(previous?.messages ?? [], page, before === undefined);
        // An older page, a first page, or a newest page that replaced the rest says what is before it.
        // A newest page that joined what was shown leaves that unchanged.
        const joined = before === undefined && previous !== null && previous.messages.length > 0 && messages[0]?.seq === previous.messages[0]?.seq;
        return {
          conversationId,
          status: "ready",
          messages,
          more: joined ? previous.more : page.more,
          saved: page.saved,
          olderLoading: false,
        };
      });
    } catch (cause) {
      if (mine !== request.current || session !== store.session()) return;
      const message = ipcErrorMessage(cause, "dohc could not read this conversation.");
      // Signed out, the view says to sign in once the list learns it, so a notice would only repeat that.
      if (refusalCode(cause) === DIRECT_SIGNED_OUT) void store.refresh();
      else reportDirect(reporting.current, message, cause, () => void load(before), undefined, { identity: historyIdentity });
      setHistory((current) => current.conversationId === conversationId && current.status === "ready"
        ? { ...current, olderLoading: false }
        : { conversationId, status: "failed", message });
    }
  }, [conversationId, historyIdentity, store]);

  // A change of account starts over.
  const session = store.session();
  useEffect(() => {
    void load();
    return () => {
      request.current += 1;
    };
  }, [load, session]);
  // The server says something new arrived: read the newest page again.
  const lastSeq = conversation?.last?.seq ?? 0;
  const shownSeq = shown.status === "ready" ? shown.messages.at(-1)?.seq ?? 0 : null;
  // The saved copy is shown until the history reads again. When the list reads from the server, read it too.
  const shownSaved = shown.status === "ready" && shown.saved;
  const listFromServer = ready !== null && !ready.saved ? ready : null;
  useEffect(() => {
    if ((shownSeq !== null && lastSeq > shownSeq) || (shownSaved && listFromServer)) void load();
  }, [lastSeq, shownSeq, shownSaved, listFromServer, load]);

  const records = useMemo(
    () => shown.status === "ready" ? shown.messages.map((message) => directMessageRecord(conversationId, message, viewerId)) : [],
    [conversationId, shown, viewerId],
  );

  const listRef = useRef<ChatMessageListHandle | null>(null);
  const newestInView = useNewestInView(listRef, shown.status === "ready");
  const newestSeq = shownSeq ?? 0;
  useEffect(() => {
    if (!conversation || conversation.unread === 0 || !newestInView || newestSeq === 0) return;
    store.markRead(conversationId, newestSeq);
  }, [conversation, conversationId, newestInView, newestSeq, store]);

  const [draft, setDraftState] = useState(() => store.draft(conversationId));
  const [draftFor, setDraftFor] = useState(conversationId);
  if (draftFor !== conversationId) {
    setDraftFor(conversationId);
    setDraftState(store.draft(conversationId));
  }
  const setDraft = (value: string) => {
    setDraftState(value);
    store.setDraft(conversationId, value);
  };
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const sendIdentity = `direct-send:${conversationId}`;
  // Who a failed send was for, so its notice names them.
  const recipients = useRef("");
  // A send and its Try again belong to the account that wrote it. After a change of account, Try again only clears its notice.
  const send = useCallback(async (body: string, messageId: string, session = store.session(), to = recipients.current) => {
    if (session !== store.session()) {
      reporting.current.onClearError?.(sendIdentity);
      return;
    }
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try {
      const result = await bridge().directSend({ conversationId, messageId, body });
      if (session !== store.session()) return;
      store.sent(conversationId, messageId);
      reporting.current.onClearError?.(sendIdentity);
      if (store.draft(conversationId).trim() === body) {
        store.setDraft(conversationId, "");
        setDraftState((current) => current.trim() === body ? "" : current);
      }
      setHistory((current) => {
        if (current.conversationId !== conversationId || current.status !== "ready" || !viewerId) return current;
        const mine: DirectMessage = { seq: result.seq, messageId, authorId: viewerId, authorName: null, body, createdAtMs: Date.now() };
        return { ...current, messages: mergeDirectPage(current.messages, { messages: [mine], more: false }, false) };
      });
      requestAnimationFrame(() => listRef.current?.scrollToEnd());
    } catch (cause) {
      if (session !== store.session()) return;
      reportDirect(reporting.current,
        ipcErrorMessage(cause, "dohc could not send your message."),
        cause,
        () => void send(body, messageId, session, to),
        undefined,
        { identity: sendIdentity, title: `Your message to ${to} wasn't sent` },
      );
      // A send that could not reach the server shows the saved copy at once.
      void store.refresh();
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [conversationId, sendIdentity, store, viewerId]);
  const submit = () => {
    const body = draft.trim();
    if (!body) return;
    void send(body, store.messageIdFor(conversationId, body));
  };

  // Signed out, or as another account, the names stay hidden with the rest of the conversation.
  const title = conversation ? directTitle(conversation.people) : "Direct message";
  recipients.current = title;
  const known = conversation !== null;
  useEffect(() => {
    if (known) onTitle?.(title);
  }, [known, onTitle, title]);
  const single = conversation?.people.length === 1 ? conversation.people[0]! : null;
  const saved = (ready?.saved ?? false) || (shown.status === "ready" && shown.saved);
  const retryOffline = () => {
    void store.refresh();
    void load();
  };
  const menuItems: MoreMenuItem[] = !conversation || saved ? [] : single
    ? [conversation.blocked
      ? { label: `Unblock ${directPersonName(single)}`, onSelect: () => void blockPerson({ store, conversationId, person: single, blocked: false, reporting: props }) }
      : { label: `Block ${directPersonName(single)}`, danger: true, onSelect: () => void blockPerson({ store, conversationId, person: single, blocked: true, reporting: props }) }]
    : conversation.people.map((person) => person.blocked
      ? { label: `Unblock ${directPersonName(person)}`, onSelect: () => void blockPerson({ store, conversationId, person, blocked: false, reporting: props }) }
      : {
        label: `Block ${directPersonName(person)}`,
        danger: true,
        onSelect: () => void blockPerson({ store, conversationId, person, blocked: true, reporting: props, withUndo: true }),
      });

  const header = (
    <ChatHeader
      label={title}
      testId="chats-dm"
      large={props.variant === "page"}
      onBack={props.onBack}
      icon={conversation ? <DirectAvatar people={conversation.people} viewerId={viewerId} /> : <Users size={15} strokeWidth={1.9} aria-hidden className="shrink-0 text-muted" />}
      {...(conversation && conversation.people.length > 1 ? { description: `${conversation.people.length + 1} people` } : {})}
      action={menuItems.length > 0 ? <MoreMenu label="Conversation options" testId="chats-dm-options" items={menuItems} width={220} /> : undefined}
    />
  );

  let body: ReactNode;
  if (state.status === "signed-out") {
    body = (
      <EmptyState data-testid="chats-dm-signed-out" icon={CloudOff} title="Sign in to your server to read your direct messages.">
        <SettingsStep onOpenSettings={props.onOpenSettings} section="cloud" label="Sync and sharing" testId="chats-dm-signed-out-action" />
      </EmptyState>
    );
  } else if (ready && !conversation && shown.status !== "ready") {
    body = <EmptyState data-testid="chats-dm-missing" icon={Users} title="dohc could not find this conversation." />;
  } else if (shown.status === "loading") {
    body = <SkeletonRows label="Loading messages…" className="pt-4" testId="chats-dm-loading" />;
  } else if (shown.status === "failed") {
    body = (
      <div className="flex flex-1 flex-col items-center justify-center">
        <RetryRow testId="chats-dm-history-retry" onRetry={() => void load()}>
          {shown.message}
        </RetryRow>
      </div>
    );
  } else {
    body = (
      <>
        <ChatMessageList
          testIdPrefix="chats-dm"
          // At the top of the history, so it scrolls away with the messages and covers none of them.
          header={shown.more ? (
            <div className="flex justify-center pb-2 pt-1">
              <SecondaryButton size="compact" data-testid="chats-dm-older" disabled={shown.olderLoading} onClick={() => void load(shown.messages[0]?.seq)}>
                {shown.olderLoading ? "Loading…" : "Show earlier messages"}
              </SecondaryButton>
            </div>
          ) : null}
          messages={records}
          loading={false}
          emptyLabel={single ? `This is the start of your conversation with ${directPersonName(single)}.` : "This is the start of your conversation."}
          emptyPicture={EMPTY_ART.posts}
          listRef={listRef}
          mentionCandidates={props.mentionCandidates ?? NO_CANDIDATES}
          onOpenPath={props.onOpenPath}
          column={props.variant === "page"}
        />
      </>
    );
  }

  let footer: ReactNode = null;
  if (conversation && shown.status === "ready") {
    if (saved) {
      footer = (
        <DirectComposerLine testId="chats-dm-offline" icon={<CloudOff size={13} aria-hidden />} action={{ label: "Try again", run: retryOffline }}>
          {OFFLINE_LINE}
        </DirectComposerLine>
      );
    } else if (conversation.blocked && single) {
      footer = (
        <DirectComposerLine
          testId="chats-dm-blocked-line"
          icon={<Ban size={13} aria-hidden />}
          action={{ label: "Unblock", run: () => void blockPerson({ store, conversationId, person: single, blocked: false, reporting: props }) }}
        >
          {`You blocked ${directPersonName(single)}. They can't message you.`}
        </DirectComposerLine>
      );
    } else {
      // A group keeps its composer: a block there hides the person's new messages, so the line says so and offers Unblock.
      const blockedHere = single ? [] : conversation.people.filter((person) => person.blocked);
      footer = (
        <>
          {blockedHere.length > 0 ? (
            <BlockedPeopleLine
              testId="chats-dm-group-blocked"
              unblockTestId="chats-dm-group-unblock"
              className="shrink-0 border-t border-line px-3 py-1.5"
              onUnblock={blockedHere.length === 1
                ? () => void blockPerson({ store, conversationId, person: blockedHere[0]!, blocked: false, reporting: props })
                : null}
            >
              {groupBlockedWords(blockedHere)}
            </BlockedPeopleLine>
          ) : null}
          <MentionComposer
            pinned
            testIdPrefix="chats-dm"
            composerId={`chats-dm-composer-${conversationId}`}
            value={draft}
            sending={sending}
            placeholder={conversation.people.length > 0 ? messagePlaceholder(conversation.people.map(directPersonName)) : `Message ${title}`}
            sendLabel="Send message"
            candidates={props.mentionCandidates ?? NO_CANDIDATES}
            onChange={setDraft}
            onSend={submit}
            inset={props.variant === "page" ? "stream" : "narrow"}
          />
        </>
      );
    }
  }

  return (
    <div data-testid="chats-dm-view" data-variant={props.variant} data-conversation-id={conversationId} className="flex min-h-0 flex-1 flex-col">
      {header}
      <div className={`flex min-h-0 flex-1 flex-col ${props.variant === "page" ? "mx-auto w-full max-w-[720px]" : ""}`}>
        {body}
        {footer}
      </div>
    </div>
  );
}

function SettingsStep(props: { onOpenSettings: OpenSettings | undefined; section: "cloud" | "members"; label: string; testId: string }) {
  const { onOpenSettings, section } = props;
  if (!onOpenSettings) return null;
  return <SecondaryButton data-testid={props.testId} onClick={() => onOpenSettings(section)}>{props.label}</SecondaryButton>;
}

/** "Message Sam Rivera", or "Message Sam Rivera and 6 others" once the names would run long. */
function messagePlaceholder(names: readonly string[]): string {
  return names.length > 2 ? `Message ${names[0]} and ${names.length - 1} others` : `Message ${names.join(" and ")}`;
}

/** Who the viewer blocked, in a line above the composer or under To, with Unblock when there is one person to unblock. */
function BlockedPeopleLine(props: { testId: string; unblockTestId: string; children: string; onUnblock: (() => void) | null; className: string }) {
  return (
    <p data-testid={props.testId} className={`m-0 flex items-center gap-2 text-[12px] text-muted ${props.className}`}>
      <Ban size={12} aria-hidden className="shrink-0 text-subtle" />
      <span className="min-w-0 flex-1 truncate">{props.children}</span>
      {props.onUnblock ? (
        <SecondaryButton size="compact" data-testid={props.unblockTestId} onClick={props.onUnblock}>
          Unblock
        </SecondaryButton>
      ) : null}
    </p>
  );
}

const groupBlockedWords = (blocked: readonly DirectPerson[]) => `You blocked ${directTitle(blocked)}. You won't see their new messages.`;

/** Where the composer would be, when it can't be: why, and what to do. */
function DirectComposerLine(props: { testId: string; icon: ReactNode; children: string; action: { label: string; run: () => void } }) {
  return (
    <div data-testid={props.testId} role="status" className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-2">
      <span className="shrink-0 text-subtle">{props.icon}</span>
      <p className="m-0 min-w-0 flex-1 text-[12px] leading-4 text-muted">{props.children}</p>
      <SecondaryButton size="compact" data-testid={`${props.testId}-action`} onClick={props.action.run}>
        {props.action.label}
      </SecondaryButton>
    </div>
  );
}

type Member = { memberId: string; name: string; paletteSlot: number };
type MemberList =
  | { workspaceId: string; status: "loading" }
  | { workspaceId: string; status: "failed"; message: string }
  // A workspace only on this computer has no members to message yet. Nothing failed.
  | { workspaceId: string; status: "unsynced" }
  | { workspaceId: string; status: "ready"; members: readonly Member[] };

/** The workspace's other active members, by name. Emails stay out of Chats. */
function messageableMembers(result: MembersResult): Member[] {
  if (result.status !== "ready") return [];
  const viewer = result.view.viewer.memberId;
  return result.view.people
    .filter((person) => person.state === "active" && person.memberId !== viewer)
    .map((person) => ({ memberId: person.memberId, name: person.name?.trim() || "Unnamed member", paletteSlot: person.paletteSlot }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const MAX_PICKS = MAX_DIRECT_PEOPLE - 1;

type NewMessageProps = Reporting & {
  workspaceId: string;
  onOpenSettings?: OpenSettings;
  memberIds?: readonly string[];
  variant: "panel" | "page";
  onBack?: () => void;
  mentionCandidates?: readonly MentionCandidate[];
  onOpenConversation: (conversationId: string, title: string) => void;
};

/** New message: pick people from this workspace's members, then write the first message. */
export function NewDirectMessage(props: NewMessageProps) {
  // A change of account starts over with no one picked: the picks were made as the last account.
  const { store } = useDirectConversations();
  const session = store.session();
  const opened = useRef(session);
  return <NewMessageForAccount key={session} {...props} memberIds={session === opened.current ? props.memberIds : undefined} />;
}

function NewMessageForAccount(props: NewMessageProps) {
  const { workspaceId } = props;
  const { state, store } = useDirectConversations();
  const reporting = useRef<Reporting>(props);
  reporting.current = props;
  const [list, setList] = useState<MemberList>({ workspaceId, status: "loading" });
  const members = list.workspaceId === workspaceId ? list : ({ workspaceId, status: "loading" } as const);
  const [attempt, setAttempt] = useState(0);
  const membersIdentity = `direct-members:${workspaceId}`;
  useEffect(() => {
    let current = true;
    setList((previous) => previous.workspaceId === workspaceId && previous.status === "ready" ? previous : { workspaceId, status: "loading" });
    bridge().workspaceMembers({ workspaceId, request: { action: "list" } }).then(
      (result) => {
        if (!current) return;
        reporting.current.onClearError?.(membersIdentity);
        setList({ workspaceId, status: "ready", members: messageableMembers(result) });
      },
      (cause: unknown) => {
        if (!current) return;
        if (refusalCode(cause) === WORKSPACE_NOT_SYNCED) {
          reporting.current.onClearError?.(membersIdentity);
          setList({ workspaceId, status: "unsynced" });
          return;
        }
        const message = ipcErrorMessage(cause, "dohc could not read this workspace's members.");
        reportDirect(reporting.current, message, cause, () => setAttempt((count) => count + 1), undefined, { identity: membersIdentity });
        setList({ workspaceId, status: "failed", message });
      },
    );
    return () => {
      current = false;
    };
  }, [workspaceId, attempt, membersIdentity]);

  const [picked, setPicked] = useState<readonly string[]>(() => (props.memberIds ?? []).slice(0, MAX_PICKS));
  // Opened for someone, such as from Members' Message: their existing conversation opens directly,
  // until the person changes the picks or writes.
  const goStraight = useRef((props.memberIds?.length ?? 0) > 0);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [pickError, setPickError] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();
  const errorId = useId();
  const byId = useMemo(() => new Map(members.status === "ready" ? members.members.map((member) => [member.memberId, member]) : []), [members]);
  // A preselected member this workspace doesn't list is dropped once the list reads.
  const shownPicks = members.status === "ready" ? picked.filter((id) => byId.has(id)) : picked;
  const matches = useMemo(() => {
    if (members.status !== "ready") return [];
    const words = query.trim().toLocaleLowerCase();
    return words ? members.members.filter((member) => member.name.toLocaleLowerCase().includes(words)) : members.members;
  }, [members, query]);
  const full = shownPicks.length >= MAX_PICKS;
  // Once the picks are full, the highlight passes over the members who can't be added.
  const pickable = (member: Member) => !full || shownPicks.includes(member.memberId);
  const step = (from: number, by: 1 | -1): number => {
    for (let index = from + by; index >= 0 && index < matches.length; index += by) if (pickable(matches[index]!)) return index;
    return from;
  };
  const highlighted = Math.min(highlight, matches.length - 1);
  const activeIndex = highlighted < 0 || pickable(matches[highlighted]!) ? highlighted
    : step(highlighted, 1) !== highlighted ? step(highlighted, 1) : step(highlighted, -1) !== highlighted ? step(highlighted, -1) : -1;
  const active = activeIndex >= 0 ? matches[activeIndex]! : null;
  const toggle = (memberId: string) => {
    goStraight.current = false;
    setPickError(false);
    setPicked((current) => current.includes(memberId)
      ? current.filter((id) => id !== memberId)
      : current.length >= MAX_PICKS ? current : [...current, memberId]);
    setQuery("");
    inputRef.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight(step(activeIndex, 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight(activeIndex <= 0 ? 0 : step(activeIndex, -1));
    } else if (event.key === "Enter" && active) {
      event.preventDefault();
      if (!full || shownPicks.includes(active.memberId)) toggle(active.memberId);
    } else if (event.key === "Backspace" && query === "" && shownPicks.length > 0) {
      goStraight.current = false;
      setPicked(shownPicks.slice(0, -1));
    }
  };

  // Whether these people already have a conversation, so the first message lands there.
  const pickKey = [...shownPicks].sort().join(",");
  // Member ids are not account ids, so who the viewer blocks is known only once the picks resolve.
  const [existing, setExisting] = useState<{ key: string; conversationId: string | null; title: string; group: boolean; blocked: readonly DirectPerson[] } | null>(null);
  // Moves after an Unblock here, so the picks resolve again.
  const [resolveAgain, setResolveAgain] = useState(0);
  useEffect(() => {
    if (!pickKey || members.status !== "ready" || state.status !== "ready") return;
    let current = true;
    bridge().directResolve({ workspaceId, memberIds: pickKey.split(",") }).then(
      (resolution) => {
        if (!current) return;
        const title = directTitle(resolution.people);
        if (goStraight.current && resolution.conversationId && !draftRef.current.trim()) {
          goStraight.current = false;
          openConversation.current(resolution.conversationId, title);
          return;
        }
        setExisting({
          key: pickKey, conversationId: resolution.conversationId, title, group: resolution.people.length > 1,
          blocked: resolution.people.filter((person) => person.blocked),
        });
      },
      // Sending says why, if this person can't be messaged.
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [pickKey, members.status, state.status, workspaceId, resolveAgain]);
  const resolved = existing?.key === pickKey ? existing : null;
  // A block belongs to the account, so it is undone from any conversation the two share, a group included.
  const sharedWith = (person: DirectPerson): string | null => resolved?.conversationId
    ?? (state.status === "ready" ? state.conversations.find((entry) => entry.people.some((one) => one.personId === person.personId))?.conversationId : undefined)
    ?? null;
  // Writing to one person the viewer blocked shows no composer, here as in their conversation.
  const blockedPerson = resolved && !resolved.group && resolved.blocked.length === 1 ? resolved.blocked[0]! : null;
  const blockedFrom = blockedPerson ? sharedWith(blockedPerson) : null;
  const blockedChat = blockedPerson && blockedFrom ? { conversationId: blockedFrom, person: blockedPerson } : null;
  const unblockOne = resolved?.blocked.length === 1 ? resolved.blocked[0]! : null;
  const unblockOneFrom = unblockOne ? sharedWith(unblockOne) : null;
  const unblock = (conversationId: string, person: DirectPerson) => void blockPerson({
    store, conversationId, person, blocked: false, reporting: props,
    onDone: () => setResolveAgain((count) => count + 1),
  });

  const [draft, setDraftState] = useState(() => store.draft("new"));
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const openConversation = useRef(props.onOpenConversation);
  openConversation.current = props.onOpenConversation;
  const setDraft = (value: string) => {
    goStraight.current = false;
    setDraftState(value);
    store.setDraft("new", value);
  };
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const sendIdentity = `direct-start:${workspaceId}`;
  const start = useCallback(async (memberIds: readonly string[], body: string, messageId: string, title: string, session = store.session()) => {
    if (session !== store.session()) {
      reporting.current.onClearError?.(sendIdentity);
      return;
    }
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    try {
      const result = await bridge().directStart({ workspaceId, memberIds: [...memberIds], messageId, body });
      if (session !== store.session()) return;
      store.sent(`new:${memberIds.join(",")}`, messageId);
      store.setDraft("new", "");
      reporting.current.onClearError?.(sendIdentity);
      void store.refresh();
      props.onOpenConversation(result.conversationId, title);
    } catch (cause) {
      if (session !== store.session()) return;
      reportDirect(reporting.current,
        ipcErrorMessage(cause, "dohc could not send your message."),
        cause,
        () => void start(memberIds, body, messageId, title, session),
        undefined,
        { identity: sendIdentity, title: `Your message to ${title} wasn't sent` },
      );
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [props.onOpenConversation, sendIdentity, store, workspaceId]);
  const names = shownPicks.map((id) => byId.get(id)?.name ?? "Unnamed member");
  const submit = () => {
    const body = draft.trim();
    if (!body) return;
    if (shownPicks.length === 0) {
      setPickError(true);
      inputRef.current?.focus();
      return;
    }
    const memberIds = [...shownPicks].sort();
    void start(memberIds, body, store.messageIdFor(`new:${memberIds.join(",")}`, body), resolved?.title ?? names.join(", "));
  };

  let content: ReactNode;
  if (state.status === "signed-out") {
    content = (
      <EmptyState data-testid="chats-dm-new-signed-out" icon={CloudOff} title="Sign in to your server to send direct messages.">
        <SettingsStep onOpenSettings={props.onOpenSettings} section="cloud" label="Sync and sharing" testId="chats-dm-new-signed-out-action" />
      </EmptyState>
    );
  } else if (members.status === "loading") {
    content = <SkeletonRows label="Loading members…" className="pt-3" testId="chats-dm-new-loading" />;
  } else if (members.status === "failed") {
    content = (
      <div className="flex flex-1 flex-col items-center justify-center">
        <RetryRow testId="chats-dm-new-retry" onRetry={() => setAttempt((count) => count + 1)}>
          {members.message}
        </RetryRow>
      </div>
    );
  } else if (members.status === "unsynced") {
    content = (
      <EmptyState data-testid="chats-dm-new-unsynced" icon={CloudOff} title="Sync this workspace to message its members.">
        <SettingsStep onOpenSettings={props.onOpenSettings} section="cloud" label="Set up sync" testId="chats-dm-new-unsynced-action" />
      </EmptyState>
    );
  } else if (members.members.length === 0) {
    content = (
      <EmptyState data-testid="chats-dm-new-empty" icon={Users} title="No one else is a member of this workspace yet.">
        <SettingsStep onOpenSettings={props.onOpenSettings} section="members" label="Members" testId="chats-dm-new-empty-action" />
      </EmptyState>
    );
  } else {
    content = (
      <ul id={listId} role="listbox" aria-label="Members" aria-multiselectable="true" data-testid="chats-dm-new-members" className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-1">
        {matches.length === 0 ? (
          <li className="px-2 py-2 text-[12px] text-muted">{`No members match "${query.trim()}".`}</li>
        ) : matches.map((member, index) => {
          const selected = shownPicks.includes(member.memberId);
          const disabled = full && !selected;
          return (
            <li
              key={member.memberId}
              id={`${listId}-${member.memberId}`}
              role="option"
              aria-selected={selected}
              aria-disabled={disabled || undefined}
              data-testid="chats-dm-new-member"
              data-member-id={member.memberId}
              title={disabled ? `A conversation holds up to ${MAX_DIRECT_PEOPLE} people, you included.` : undefined}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => {
                if (!disabled) setHighlight(index);
              }}
              onClick={() => {
                if (!disabled) toggle(member.memberId);
              }}
              className={`flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] ${
                active?.memberId === member.memberId ? "bg-hover" : ""
              } ${disabled ? "cursor-default text-subtle" : "text-ink"}`}
            >
              <ChatAvatar presentation={relayPresentation(member.paletteSlot)} name={member.name} kind="human" size="strip" />
              <span className="min-w-0 flex-1 truncate">{member.name}</span>
              {selected ? <Check size={14} aria-hidden className="shrink-0 text-accent" /> : null}
            </li>
          );
        })}
      </ul>
    );
  }

  const canPick = state.status !== "signed-out" && members.status === "ready" && members.members.length > 0;
  return (
    <div data-testid="chats-dm-new" data-variant={props.variant} className="flex min-h-0 flex-1 flex-col">
      <ChatHeader
        label="New message"
        testId="chats-dm-new"
        large={props.variant === "page"}
        onBack={props.onBack}
        icon={<PenSquare size={13} aria-hidden className="shrink-0 text-subtle" />}
      />
      <div className={`flex min-h-0 flex-1 flex-col ${props.variant === "page" ? "mx-auto w-full max-w-[640px]" : ""}`}>
        {canPick ? (
          <div className="shrink-0 border-b border-line px-3 py-2">
            <div className="flex flex-wrap items-center gap-1">
              <label htmlFor={`${listId}-input`} className="mr-1 text-[12px] text-muted">
                To
              </label>
              {shownPicks.map((id, index) => (
                <span key={id} data-testid="chats-dm-new-pick" data-member-id={id} className="inline-flex h-6 items-center gap-1 rounded-full border border-line bg-panel-2 pl-1 pr-0.5 text-[12px] text-ink">
                  <ChatAvatar presentation={relayPresentation(byId.get(id)?.paletteSlot ?? -1)} name={names[index]!} kind="human" size="strip" className="size-4 text-[8px]" />
                  <span className="max-w-40 truncate">{names[index]}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${names[index]}`}
                    title={`Remove ${names[index]}`}
                    onClick={() => toggle(id)}
                    className="grid size-5 cursor-pointer place-items-center rounded-full text-subtle hover:bg-hover hover:text-ink"
                  >
                    <X size={11} aria-hidden />
                  </button>
                </span>
              ))}
              <input
                ref={inputRef}
                id={`${listId}-input`}
                data-testid="chats-dm-recipients"
                role="combobox"
                aria-expanded="true"
                aria-controls={listId}
                aria-activedescendant={active ? `${listId}-${active.memberId}` : undefined}
                aria-invalid={pickError || undefined}
                aria-describedby={pickError ? errorId : undefined}
                autoFocus={shownPicks.length === 0}
                value={query}
                onChange={(event) => {
                  goStraight.current = false;
                  setQuery(event.target.value);
                  setHighlight(0);
                }}
                onKeyDown={onKeyDown}
                className="h-6 min-w-24 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-subtle"
              />
            </div>
            {pickError ? <FieldError id={errorId} className="mt-1">Choose who to message.</FieldError> : null}
            {full ? (
              <p data-testid="chats-dm-new-full" className="m-0 mt-1.5 text-[12px] text-muted">{`A conversation holds up to ${MAX_DIRECT_PEOPLE} people, you included.`}</p>
            ) : null}
            {resolved && resolved.blocked.length > 0 && !blockedChat ? (
              <BlockedPeopleLine
                testId="chats-dm-new-blocked"
                unblockTestId="chats-dm-new-unblock"
                className="mt-1.5"
                onUnblock={unblockOne && unblockOneFrom ? () => unblock(unblockOneFrom, unblockOne) : null}
              >
                {resolved.group ? groupBlockedWords(resolved.blocked) : `You blocked ${directTitle(resolved.blocked)}. They can't message you.`}
              </BlockedPeopleLine>
            ) : null}
            {resolved?.conversationId ? (
              <p data-testid="chats-dm-new-existing" className="m-0 mt-1.5 flex items-center gap-2 text-[12px] text-muted">
                <span className="min-w-0 flex-1 truncate">{`You already have a conversation with ${resolved.title}.`}</span>
                <SecondaryButton size="compact" data-testid="chats-dm-new-open-existing" onClick={() => props.onOpenConversation(resolved.conversationId!, resolved.title)}>
                  Open conversation
                </SecondaryButton>
              </p>
            ) : null}
          </div>
        ) : null}
        {content}
        {canPick && blockedChat ? (
          <DirectComposerLine
            testId="chats-dm-new-blocked-line"
            icon={<Ban size={13} aria-hidden />}
            action={{ label: "Unblock", run: () => unblock(blockedChat.conversationId, blockedChat.person) }}
          >
            {`You blocked ${directPersonName(blockedChat.person)}. They can't message you.`}
          </DirectComposerLine>
        ) : canPick ? (
          <MentionComposer
            pinned
            testIdPrefix="chats-dm-new"
            composerId="chats-dm-new-composer"
            value={draft}
            sending={sending}
            placeholder={names.length > 0 ? messagePlaceholder(names) : "Write a message"}
            sendLabel="Send message"
            candidates={props.mentionCandidates ?? NO_CANDIDATES}
            onChange={setDraft}
            onSend={submit}
            inset={props.variant === "page" ? "stream" : "narrow"}
          />
        ) : null}
      </div>
    </div>
  );
}
