import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Ban, Check, CloudOff, PenSquare, Plus, User, Users, X } from "lucide-react";
import type {
  DirectConversation,
  DirectMessage,
  DirectPerson,
} from "@dohc/security-contract/direct-messages";
import type { MembersResult } from "@dohc/cli/members";
import type { MentionCandidate } from "@dohc/workspace-contracts/chat-mentions";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import {
  DIRECT_SIGNED_OUT,
  DIRECT_START_INACTIVE_MESSAGE,
  readError,
  refusalCode,
  WORKSPACE_NOT_SYNCED,
} from "../../ipc/errorWords";
import { EmptyState, FieldError, RetryRow, SecondaryButton, SectionLabel } from "../ui/controls";
import { isComposingKey } from "../ui/keys";
import { MENU_ACTIVE_OPTION, Menu } from "../ui/Menu";
import { MoreMenu, type MoreMenuItem } from "../ui/MoreMenu";
import { SkeletonRows } from "../ui/SkeletonRows";
import { relayPresentation } from "./actorPresentation";
import { ChatAvatar } from "./ChatAvatar";
import { ChatHeader, UnreadPill } from "./ChatsControls";
import { NavRow, SectionActionButton } from "./ChatNavRow";
import { chatRowMenuItems } from "./chatRowMenu";
import { ChatMessageList, type ChatMessageListHandle } from "./chatMessages";
import { chatOnScreen, showChat, watchChatsOnScreen } from "./chatsOnScreen";
import { EMPTY_ART } from "./EmptyArt";
import { MentionComposer, type MentionComposerHandle } from "./MentionComposer";
import type { ChatErrorNotice } from "./ChatsView";
import {
  directMessageRecord,
  directPersonName,
  directPresentation,
  directScreenKey,
  mergeDirectPage,
  directShownThrough,
  useDirectConversations,
  type DirectListState,
  type DirectStore,
  type DirectViewer,
} from "./directConversations";
import { useToastsAbove } from "./toastClearance";

// Direct messages in Chats: the People section, one conversation, and New
// message. Each conversation is between two people and lives on the account's
// server; see directConversations.ts. A direct message belongs to no
// workspace, so it offers no @ of a workspace's people and opens no files.

type ReportError = (
  message: string,
  cause?: unknown,
  retry?: () => void,
  refusedPage?: string,
  notice?: ChatErrorNotice,
) => void;

interface Reporting {
  onError: ReportError;
  onClearError?: (identity: string) => void;
  // The title bar names the server as the problem, so a list read that fails
  // files no notice of its own: the server's report covers it.
  serverNamed?: boolean;
}

const NO_CANDIDATES: readonly MentionCandidate[] = [];
const LIST_IDENTITY = "direct-list";

/** The other person's round face. */
export function DirectAvatar(props: { person: DirectPerson; viewerId: string | null }) {
  return (
    <ChatAvatar
      presentation={directPresentation(props.person.personId, props.viewerId)}
      name={directPersonName(props.person)}
      kind="human"
      size="strip"
    />
  );
}

/** The mark beside someone the viewer blocks. */
function BlockedMark(props: { testId: string; name: string }) {
  return (
    <span
      data-testid={props.testId}
      title={`You blocked ${props.name}`}
      className="inline-flex shrink-0 text-subtle"
    >
      <Ban size={12} aria-hidden />
      <span className="sr-only">Blocked</span>
    </span>
  );
}

function preview(conversation: DirectConversation, viewerId: string): string {
  const words = conversation.last.body.replace(/\s+/gu, " ").trim();
  return conversation.last.authorId === viewerId ? `You: ${words}` : words;
}

/** Reports a failed list read once per message, and takes it back when a read works. */
function useListFailureReport(state: DirectListState, store: DirectStore, reporting: Reporting) {
  const failure =
    state.status === "failed" ? state.message : state.status === "ready" ? state.failure : null;
  const serverNamed = reporting.serverNamed === true;
  const report = useRef(reporting);
  report.current = reporting;
  useEffect(() => {
    // One outage, one notice: a failed send that says the same already names it, with its own Try again.
    if (failure && !serverNamed && failure !== store.sendFailure()) {
      report.current.onError(failure, undefined, () => void store.refresh(), undefined, {
        identity: LIST_IDENTITY,
      });
    } else if (failure || state.status === "ready") {
      report.current.onClearError?.(LIST_IDENTITY);
    }
  }, [failure, serverNamed, state.status, store]);
}

/** The People section of the Chats sidebar. Hidden while signed out. */
export function DirectPeopleSection(
  props: Reporting & {
    selectedConversationId: string | null;
    onOpen: (conversationId: string, title: string) => void;
    /** Absent where no one can be picked, such as a copy whose membership ended. */
    onNew?: () => void;
  },
) {
  const { state, store } = useDirectConversations();
  useListFailureReport(state, store, props);
  const [menu, setMenu] = useState<{
    conversationId: string;
    at: { x: number; y: number };
    fromKeyboard: boolean;
  } | null>(null);
  if (state.status === "signed-out") return null;
  const ready = state.status === "ready" ? state : null;
  const menuConversation =
    menu && ready
      ? (ready.conversations.find((entry) => entry.conversationId === menu.conversationId) ?? null)
      : null;
  return (
    <section data-testid="chats-dms-section" aria-label="People">
      <div className="group mt-4 flex h-6 items-center pl-3 pr-2">
        <SectionLabel as="p" className="min-w-0 flex-1">
          People
        </SectionLabel>
        {props.onNew ? (
          <SectionActionButton
            testId="chats-new-dm-action"
            label="New message"
            onClick={props.onNew}
          >
            <Plus size={12} aria-hidden />
          </SectionActionButton>
        ) : null}
      </div>
      {state.status === "loading" ? (
        <SkeletonRows
          rows={2}
          label="Loading people…"
          testId="chats-dms-loading"
          className="px-3 py-2"
        />
      ) : state.status === "failed" ? (
        <RetryRow testId="chats-dms-retry" onRetry={() => void store.refresh()}>
          {state.message}
        </RetryRow>
      ) : ready && ready.conversations.length > 0 ? (
        <ul className="m-0 list-none p-0">
          {ready.conversations.map((conversation) => {
            const title = directPersonName(conversation.person);
            const unread = conversation.unread > 0;
            const line = preview(conversation, ready.viewerId);
            const { blocked } = conversation.person;
            return (
              <li key={conversation.conversationId}>
                <NavRow
                  testId="chats-dm-item"
                  data={{
                    "data-conversation-id": conversation.conversationId,
                    ...(blocked ? { "data-blocked": "true" } : {}),
                  }}
                  active={props.selectedConversationId === conversation.conversationId}
                  unread={unread}
                  muted={blocked}
                  onClick={() => props.onOpen(conversation.conversationId, title)}
                  icon={<DirectAvatar person={conversation.person} viewerId={ready.viewerId} />}
                  label={title}
                  labelTestId="chats-dm-name"
                  // Only an unread row shows its last message, so the rest stay quiet.
                  {...(unread ? { detail: line } : {})}
                  title={`${title}\n${line}`}
                  menuOpen={menu?.conversationId === conversation.conversationId}
                  onMenu={(at, fromKeyboard) =>
                    setMenu({ conversationId: conversation.conversationId, at, fromKeyboard })
                  }
                  trailing={
                    <>
                      {blocked ? <BlockedMark testId="chats-dm-blocked" name={title} /> : null}
                      <UnreadPill count={conversation.unread} testId="chats-dm-unread" />
                    </>
                  }
                />
              </li>
            );
          })}
        </ul>
      ) : (
        <p
          data-testid="chats-dms-empty"
          className="m-0 px-3 py-1.5 text-[12px] leading-4 text-muted"
        >
          No direct messages yet.
        </p>
      )}
      {menu && menuConversation && ready ? (
        <Menu
          label={`${directPersonName(menuConversation.person)} options`}
          menuTestId="chat-row-menu"
          items={chatRowMenuItems(
            {
              kind: "person",
              unread: menuConversation.unread > 0,
              block: {
                name: directPersonName(menuConversation.person),
                blocked: menuConversation.person.blocked,
              },
            },
            {
              markRead: () =>
                store.markRead(menuConversation.conversationId, menuConversation.last.seq),
              setBlocked: (blocked) =>
                void blockPerson({
                  store,
                  conversationId: menuConversation.conversationId,
                  person: menuConversation.person,
                  blocked,
                  reporting: props,
                }),
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
function reportDirect(
  reporting: Reporting,
  message: string,
  cause: unknown,
  retry: () => void,
  refusedPage?: string,
  notice?: ChatErrorNotice,
): void {
  reporting.onError(
    message,
    cause,
    readError(cause).canRetry === false ? undefined : retry,
    refusedPage,
    notice,
  );
}

async function blockPerson(input: {
  store: DirectStore;
  conversationId: string;
  person: DirectPerson;
  blocked: boolean;
  reporting: Reporting;
  /** Runs once the change is made, by the first try or by the notice's Try again. */
  onDone?: () => void;
  /** The account that asked. Try again keeps it, so main refuses a retry once another account signs in. */
  viewer?: DirectViewer;
}): Promise<void> {
  const { store, conversationId, person, blocked, reporting } = input;
  const name = directPersonName(person);
  const identity = `direct-block:${conversationId}`;
  let viewer = input.viewer;
  try {
    viewer ??= store.viewer();
    await store.setBlocked(viewer, conversationId, blocked);
    reporting.onClearError?.(identity);
    // No notice: the blocked line, with its Unblock, shows the change where it happened.
    input.onDone?.();
  } catch (cause) {
    reportDirect(
      reporting,
      ipcErrorMessage(
        cause,
        blocked ? `dohc could not block ${name}.` : `dohc could not unblock ${name}.`,
      ),
      cause,
      () => void blockPerson(viewer === undefined ? input : { ...input, viewer }),
      undefined,
      { identity },
    );
  }
}

/** Whether the list's newest message is on screen: scrolled to the end, in a window that shows. */
// The newest message shows to the person: the conversation is on screen in a focused window, scrolled to its end.
function useNewestInView(
  list: RefObject<ChatMessageListHandle | null>,
  conversationId: string,
  ready: boolean,
): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    if (!ready) return;
    let node: HTMLElement | null = null;
    const check = () => {
      node ??= list.current?.getScrollableNode() ?? null;
      const atEnd = !node || node.scrollHeight - node.scrollTop - node.clientHeight < 48;
      setInView(atEnd && chatOnScreen(directScreenKey(conversationId)));
    };
    // The list mounts its scroller after the first layout.
    const frame = requestAnimationFrame(() => {
      check();
      node?.addEventListener("scroll", check, { passive: true });
    });
    check();
    const unwatch = watchChatsOnScreen(check);
    return () => {
      cancelAnimationFrame(frame);
      node?.removeEventListener("scroll", check);
      unwatch();
    };
  }, [conversationId, list, ready]);
  return inView;
}

type History =
  | { conversationId: string; status: "loading" }
  | { conversationId: string; status: "failed"; message: string }
  | {
      conversationId: string;
      status: "ready";
      messages: readonly DirectMessage[];
      more: boolean;
      olderLoading: boolean;
    };

/** Where a state's next step lives, when it lives in Settings. */
type OpenSettings = (section: "cloud" | "members") => void;

type ConversationProps = Reporting & {
  conversationId: string;
  onOpenSettings?: OpenSettings;
  variant: "panel" | "page";
  onBack?: () => void;
  /** The other person's name, once the list knows it, for the tab. */
  onTitle?: (title: string) => void;
  /** The name saved with the tab, shown until the list reads. */
  savedName?: string;
};

/** One direct conversation, read from the server. */
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
  const scope = ready?.scope ?? null;
  const conversation =
    ready?.conversations.find((entry) => entry.conversationId === conversationId) ?? null;
  const reporting = useRef<Reporting>(props);
  reporting.current = props;

  const [history, setHistory] = useState<History>({ conversationId, status: "loading" });
  const shown =
    history.conversationId === conversationId
      ? history
      : ({ conversationId, status: "loading" } as const);
  // The newest page and an older page are read apart, so loading earlier messages doesn't drop a newest read that fills a gap.
  const newestRequest = useRef(0);
  const olderRequest = useRef(0);
  const historyIdentity = `direct-history:${conversationId}`;
  // The history is read as the account the list names, once the list has read.
  const load = useCallback(
    async (before?: number) => {
      if (viewerId === null || scope === null) return;
      const request = before === undefined ? newestRequest : olderRequest;
      const mine = ++request.current;
      if (before !== undefined) {
        setHistory((current) =>
          current.conversationId === conversationId && current.status === "ready"
            ? { ...current, olderLoading: true }
            : current,
        );
      }
      try {
        const page = await bridge().directHistory({
          viewerId,
          scope,
          conversationId,
          ...(before === undefined ? {} : { before }),
        });
        if (mine !== request.current) return;
        reporting.current.onClearError?.(historyIdentity);
        setHistory((current) => {
          const previous =
            current.conversationId === conversationId && current.status === "ready"
              ? current
              : null;
          const messages = mergeDirectPage(previous?.messages ?? [], page, before === undefined);
          // An older page, a first page, or a newest page that replaced the rest says what is before it.
          // A newest page that joined what was shown leaves that unchanged.
          const joined =
            before === undefined &&
            previous !== null &&
            previous.messages.length > 0 &&
            messages[0]?.seq === previous.messages[0]?.seq;
          return {
            conversationId,
            status: "ready",
            messages,
            more: joined ? previous.more : page.more,
            olderLoading: before === undefined ? (previous?.olderLoading ?? false) : false,
          };
        });
      } catch (cause) {
        if (mine !== request.current) return;
        const message = ipcErrorMessage(cause, "dohc could not read this conversation.");
        // Signed out, the view says to sign in once the list learns it, so a notice would only repeat that.
        if (refusalCode(cause) === DIRECT_SIGNED_OUT) void store.refresh();
        else
          reportDirect(reporting.current, message, cause, () => void load(before), undefined, {
            identity: historyIdentity,
          });
        setHistory((current) =>
          current.conversationId === conversationId && current.status === "ready"
            ? { ...current, olderLoading: before === undefined ? current.olderLoading : false }
            : { conversationId, status: "failed", message },
        );
      }
    },
    [conversationId, historyIdentity, store, viewerId, scope],
  );

  useEffect(() => {
    void load();
    return () => {
      newestRequest.current += 1;
      olderRequest.current += 1;
    };
  }, [load]);
  // The server says something new arrived, or a send skipped past a message: read the newest page again.
  const lastSeq = conversation?.last.seq ?? 0;
  const shownSeq = shown.status === "ready" ? directShownThrough(shown.messages) : null;
  const endSeq = shown.status === "ready" ? (shown.messages.at(-1)?.seq ?? 0) : 0;
  useEffect(() => {
    if (shownSeq !== null && Math.max(lastSeq, endSeq) > shownSeq) void load();
  }, [lastSeq, endSeq, shownSeq, load]);

  const records = useMemo(
    () =>
      shown.status === "ready"
        ? shown.messages.map((message) => directMessageRecord(conversationId, message, viewerId))
        : [],
    [conversationId, shown, viewerId],
  );

  const listRef = useRef<ChatMessageListHandle | null>(null);
  const newestInView = useNewestInView(listRef, conversationId, shown.status === "ready");
  const newestSeq = shownSeq ?? 0;
  useEffect(() => {
    if (!conversation || conversation.unread === 0 || !newestInView || newestSeq === 0) return;
    store.markRead(conversationId, newestSeq);
  }, [conversation, conversationId, newestInView, newestSeq, store]);
  // Notices reads the conversation's row while the conversation shows.
  const root = useRef<HTMLDivElement | null>(null);
  useEffect(
    () => (root.current ? showChat(directScreenKey(conversationId), root.current) : undefined),
    [conversationId],
  );

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
  // New message handed over: take its words and focus, whether this conversation already showed or just opened.
  const composer = useRef<MentionComposerHandle | null>(null);
  const [handedOff, setHandedOff] = useState(0);
  useEffect(
    () =>
      store.onHandOff((key) => {
        if (key !== conversationId) return;
        setDraftState(store.draft(key));
        setHandedOff((count) => count + 1);
      }),
    [store, conversationId],
  );
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const sendIdentity = `direct-send:${conversationId}`;
  const name = conversation
    ? directPersonName(conversation.person)
    : (!ready && state.status !== "signed-out" && props.savedName) || "Direct message";
  // A send and its Try again name the account that wrote them, so main refuses them once another account signs in.
  const send = useCallback(
    async (sender: DirectViewer, body: string, messageId: string, to: string) => {
      if (sendingRef.current) return;
      sendingRef.current = true;
      setSending(true);
      const session = store.session();
      try {
        const result = await bridge().directSend({
          ...sender,
          conversationId,
          messageId,
          body,
        });
        if (session !== store.session()) return;
        store.sent(conversationId, messageId);
        reporting.current.onClearError?.(sendIdentity);
        if (store.draft(conversationId).trim() === body) {
          store.setDraft(conversationId, "");
          setDraftState((current) => (current.trim() === body ? "" : current));
        }
        setHistory((current) => {
          if (current.conversationId !== conversationId || current.status !== "ready")
            return current;
          const mine: DirectMessage = {
            seq: result.seq,
            messageId,
            authorId: sender.viewerId,
            // Named as the server named this account's earlier messages, until the next read names it.
            authorName:
              current.messages.findLast((message) => message.authorId === sender.viewerId)
                ?.authorName ?? null,
            body,
            createdAtMs: Date.now(),
          };
          return {
            ...current,
            messages: mergeDirectPage(current.messages, { messages: [mine] }, false),
          };
        });
        requestAnimationFrame(() => listRef.current?.scrollToEnd());
      } catch (cause) {
        // The words stay in the composer. A failure that lands after the account changed only takes its notice back.
        if (session !== store.session()) {
          reporting.current.onClearError?.(sendIdentity);
          return;
        }
        const message = ipcErrorMessage(cause, "dohc could not send your message.");
        reportDirect(
          reporting.current,
          message,
          cause,
          () => void send(sender, body, messageId, to),
          undefined,
          { identity: sendIdentity, title: `Your message to ${to} wasn't sent` },
        );
        // One outage, one notice: this one takes the place of a failed list read's that says the same.
        store.sendFailed(message);
        const list = store.snapshot();
        if (list.status === "ready" && list.failure === message)
          reporting.current.onClearError?.(LIST_IDENTITY);
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    },
    [conversationId, sendIdentity, store],
  );
  const submit = () => {
    const body = draft.trim();
    if (!body || viewerId === null || scope === null) return;
    void send({ viewerId, scope }, body, store.messageIdFor(conversationId, body), name);
  };

  // Signed out, or as another account, the name stays hidden with the rest of the conversation.
  const known = conversation !== null;
  useEffect(() => {
    if (known) onTitle?.(name);
  }, [known, onTitle, name]);
  const person = conversation?.person ?? null;
  const setBlocked = (blocked: boolean) => {
    if (person) void blockPerson({ store, conversationId, person, blocked, reporting: props });
  };
  const menuItems: MoreMenuItem[] = !person
    ? []
    : [
        person.blocked
          ? { label: `Unblock ${name}`, onSelect: () => setBlocked(false) }
          : { label: `Block ${name}`, danger: true, onSelect: () => setBlocked(true) },
      ];

  const header = (
    <ChatHeader
      label={name}
      testId="chats-dm"
      large={props.variant === "page"}
      onBack={props.onBack}
      icon={
        person ? (
          <DirectAvatar person={person} viewerId={viewerId} />
        ) : (
          <User size={15} strokeWidth={1.9} aria-hidden className="shrink-0 text-muted" />
        )
      }
      action={
        menuItems.length > 0 ? (
          <MoreMenu
            label="Conversation options"
            testId="chats-dm-options"
            items={menuItems}
            width={220}
          />
        ) : undefined
      }
    />
  );

  let body: ReactNode;
  if (state.status === "signed-out") {
    body = (
      <EmptyState
        data-testid="chats-dm-signed-out"
        icon={CloudOff}
        title="Sign in to your server to read your direct messages."
      >
        <SettingsStep
          onOpenSettings={props.onOpenSettings}
          section="cloud"
          label="Sync and sharing"
          testId="chats-dm-signed-out-action"
        />
      </EmptyState>
    );
  } else if (state.status === "failed") {
    // The list never read, so nothing here can either. Try again reads both.
    body = (
      <div className="flex flex-1 flex-col items-center justify-center">
        <RetryRow testId="chats-dm-history-retry" onRetry={() => void store.refresh()}>
          {state.message}
        </RetryRow>
      </div>
    );
  } else if (ready && !conversation && shown.status !== "ready") {
    body = (
      <EmptyState
        data-testid="chats-dm-missing"
        icon={User}
        title="dohc could not find this conversation."
      />
    );
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
      <ChatMessageList
        testIdPrefix="chats-dm"
        // At the top of the history, so it scrolls away with the messages and covers none of them.
        header={
          shown.more ? (
            <div className="flex justify-center pb-2 pt-1">
              <SecondaryButton
                size="compact"
                data-testid="chats-dm-older"
                disabled={shown.olderLoading}
                onClick={() => void load(shown.messages[0]?.seq)}
              >
                {shown.olderLoading ? "Loading…" : "Show earlier messages"}
              </SecondaryButton>
            </div>
          ) : null
        }
        messages={records}
        loading={false}
        emptyLabel={
          person
            ? `This is the start of your conversation with ${name}.`
            : "This is the start of your conversation."
        }
        emptyPicture={EMPTY_ART.posts}
        listRef={listRef}
        mentionCandidates={NO_CANDIDATES}
        column={props.variant === "page"}
      />
    );
  }

  // A sending composer is disabled and can't take focus, so a hand-over waits for the send to finish.
  const composerFocusable =
    person !== null && shown.status === "ready" && !person.blocked && !sending;
  useEffect(() => {
    if (composerFocusable && store.takeFocus(conversationId)) composer.current?.focusEnd();
  }, [composerFocusable, handedOff, store, conversationId]);

  let footer: ReactNode = null;
  if (person && shown.status === "ready") {
    footer = person.blocked ? (
      <DirectComposerLine
        testId="chats-dm-blocked-line"
        icon={<Ban size={13} aria-hidden />}
        action={{ label: "Unblock", run: () => setBlocked(false) }}
      >
        {`You blocked ${name}. They can't message you.`}
      </DirectComposerLine>
    ) : (
      <MentionComposer
        handle={composer}
        pinned
        testIdPrefix="chats-dm"
        composerId={`chats-dm-composer-${conversationId}`}
        value={draft}
        sending={sending}
        placeholder={`Message ${name}`}
        sendLabel="Send message"
        candidates={NO_CANDIDATES}
        noMentions
        onChange={setDraft}
        onSend={submit}
        inset={props.variant === "page" ? "stream" : "narrow"}
      />
    );
  }

  return (
    <div
      ref={root}
      data-testid="chats-dm-view"
      data-variant={props.variant}
      data-conversation-id={conversationId}
      className="flex min-h-0 flex-1 flex-col"
    >
      {header}
      <div
        className={`flex min-h-0 flex-1 flex-col ${props.variant === "page" ? "mx-auto w-full max-w-[720px]" : ""}`}
      >
        {body}
        {footer}
      </div>
    </div>
  );
}

function SettingsStep(props: {
  onOpenSettings: OpenSettings | undefined;
  section: "cloud" | "members";
  label: string;
  testId: string;
}) {
  const { onOpenSettings, section } = props;
  if (!onOpenSettings) return null;
  return (
    <SecondaryButton data-testid={props.testId} onClick={() => onOpenSettings(section)}>
      {props.label}
    </SecondaryButton>
  );
}

/** Where the composer would be, when it can't be: why, and what to do. */
function DirectComposerLine(props: {
  testId: string;
  icon: ReactNode;
  children: string;
  action: { label: string; run: () => void };
}) {
  // It sits where the composer would, so toasts stay above it and its action stays in reach.
  const ref = useRef<HTMLDivElement | null>(null);
  useToastsAbove(ref);
  return (
    <div
      ref={ref}
      data-testid={props.testId}
      role="status"
      className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-2"
    >
      <span className="shrink-0 text-subtle">{props.icon}</span>
      <p className="m-0 min-w-0 flex-1 text-[12px] leading-4 text-muted">{props.children}</p>
      <SecondaryButton
        size="compact"
        data-testid={`${props.testId}-action`}
        onClick={props.action.run}
      >
        {props.action.label}
      </SecondaryButton>
    </div>
  );
}

type Member = { memberId: string; name: string; paletteSlot: number };
type MemberList =
  | { workspaceId: string; status: "loading" }
  | { workspaceId: string; status: "failed"; message: string; cause: unknown }
  // A workspace only on this computer has no members to message yet. Nothing failed.
  | { workspaceId: string; status: "unsynced" }
  | { workspaceId: string; status: "ready"; members: readonly Member[] };

/** The workspace's other active members, by name. Emails stay out of Chats. */
function messageableMembers(result: MembersResult): Member[] {
  if (result.status !== "ready") return [];
  const viewer = result.view.viewer.memberId;
  return result.view.people
    .filter((person) => person.state === "active" && person.memberId !== viewer)
    .map((person) => ({
      memberId: person.memberId,
      name: person.name?.trim() || "Unnamed member",
      paletteSlot: person.paletteSlot,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

type NewMessageProps = Reporting & {
  workspaceId: string;
  onOpenSettings?: OpenSettings;
  memberId?: string;
  variant: "panel" | "page";
  onBack?: () => void;
  onOpenConversation: (conversationId: string, title: string) => void;
};

/** New message: pick one of this workspace's members, then write the first message. */
export function NewDirectMessage(props: NewMessageProps) {
  // A change of account starts over with no one picked: the pick was made as the last account.
  const { store } = useDirectConversations();
  const session = store.session();
  const opened = useRef(session);
  return (
    <NewMessageForAccount
      key={session}
      {...props}
      memberId={session === opened.current ? props.memberId : undefined}
    />
  );
}

function NewMessageForAccount(props: NewMessageProps) {
  const { workspaceId } = props;
  const { state, store } = useDirectConversations();
  const viewerId = state.status === "ready" ? state.viewerId : null;
  const reporting = useRef<Reporting>(props);
  reporting.current = props;
  const [list, setList] = useState<MemberList>({ workspaceId, status: "loading" });
  const members =
    list.workspaceId === workspaceId ? list : ({ workspaceId, status: "loading" } as const);
  const [attempt, setAttempt] = useState(0);
  const membersIdentity = `direct-members:${workspaceId}`;
  useEffect(() => {
    let current = true;
    setList((previous) =>
      previous.workspaceId === workspaceId && previous.status === "ready"
        ? previous
        : { workspaceId, status: "loading" },
    );
    bridge()
      .workspaceMembers({ workspaceId, request: { action: "list" } })
      .then(
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
          setList({
            workspaceId,
            status: "failed",
            message: ipcErrorMessage(cause, "dohc could not read this workspace's members."),
            cause,
          });
        },
      );
    return () => {
      current = false;
    };
  }, [workspaceId, attempt, membersIdentity]);
  // One outage, one notice: while the title bar names the server, the failed read says so only in place.
  const serverNamed = props.serverNamed === true;
  useEffect(() => {
    if (members.status !== "failed") return;
    if (serverNamed) reporting.current.onClearError?.(membersIdentity);
    else
      reportDirect(
        reporting.current,
        members.message,
        members.cause,
        () => setAttempt((count) => count + 1),
        undefined,
        { identity: membersIdentity },
      );
  }, [members, serverNamed, membersIdentity]);

  const [picked, setPicked] = useState<string | null>(props.memberId ?? null);
  // Opened for someone, such as from Members' Message: their existing conversation opens directly,
  // until the person changes the pick or writes.
  const goStraight = useRef(props.memberId !== undefined);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [pickError, setPickError] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();
  const errorId = useId();
  const byId = useMemo(
    () =>
      new Map(
        members.status === "ready"
          ? members.members.map((member) => [member.memberId, member])
          : [],
      ),
    [members],
  );
  // A preselected member this workspace doesn't list is dropped once the list reads.
  const pick = members.status === "ready" && picked !== null && !byId.has(picked) ? null : picked;
  const pickName = pick === null ? null : (byId.get(pick)?.name ?? "Unnamed member");
  const matches = useMemo(() => {
    if (members.status !== "ready") return [];
    const words = query.trim().toLocaleLowerCase();
    return words
      ? members.members.filter((member) => member.name.toLocaleLowerCase().includes(words))
      : members.members;
  }, [members, query]);
  // With someone picked, the list closes until the person types another name or removes the pick.
  const listShown = pick === null || query !== "";
  const activeIndex = Math.min(highlight, matches.length - 1);
  const active = activeIndex >= 0 ? matches[activeIndex]! : null;
  const choose = (memberId: string | null) => {
    goStraight.current = false;
    setPickError(false);
    setPicked(memberId);
    setQuery("");
    // A pick closes the list. The next list opens with its first row active.
    setHighlight(0);
    inputRef.current?.focus();
  };
  // Focus stays in the To field, so the list scrolls to keep the active member in view.
  const moveTo = (index: number) => {
    setHighlight(index);
    const member = matches[index];
    if (member)
      document
        .getElementById(`${listId}-${member.memberId}`)
        ?.scrollIntoView?.({ block: "nearest" });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter, the arrows and Backspace work an IME's candidates while it composes.
    if (isComposingKey(event)) return;
    // A closed list takes no arrows or Enter. Backspace still removes the pick.
    if (!listShown && event.key !== "Backspace") return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveTo(Math.min(activeIndex + 1, matches.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveTo(Math.max(activeIndex - 1, 0));
    } else if (event.key === "Enter" && active) {
      event.preventDefault();
      choose(active.memberId);
    } else if (event.key === "Backspace" && query === "" && pick !== null) {
      choose(null);
    }
  };

  // Whether the two of you already have a conversation, so the first message lands there.
  // Member ids are not account ids, so whether the viewer blocks this person is known only once the pick resolves.
  const [resolution, setResolution] = useState<{
    memberId: string;
    conversationId: string | null;
    person: DirectPerson;
  } | null>(null);
  // Moves after an Unblock here, so the pick resolves again.
  const [resolveAgain, setResolveAgain] = useState(0);
  useEffect(() => {
    if (pick === null || members.status !== "ready" || viewerId === null) return;
    let current = true;
    bridge()
      .directResolve({ viewerId, workspaceId, memberId: pick })
      .then(
        (resolved) => {
          if (!current) return;
          if (goStraight.current && resolved.conversationId && !draftRef.current.trim()) {
            goStraight.current = false;
            openConversation.current(resolved.conversationId, directPersonName(resolved.person));
            return;
          }
          setResolution({ memberId: pick, ...resolved });
        },
        // Sending says why, if this person can't be messaged.
        () => undefined,
      );
    return () => {
      current = false;
    };
  }, [pick, members.status, viewerId, workspaceId, resolveAgain]);
  const resolved = resolution?.memberId === pick ? resolution : null;
  const title = resolved ? directPersonName(resolved.person) : (pickName ?? "");
  // A blocked person has a conversation with the viewer: a block is made from one.
  const blockedIn =
    resolved?.person.blocked && resolved.conversationId
      ? { conversationId: resolved.conversationId, person: resolved.person }
      : null;
  const unblock = () => {
    if (blockedIn) {
      void blockPerson({
        store,
        ...blockedIn,
        blocked: false,
        reporting: props,
        onDone: () => setResolveAgain((count) => count + 1),
      });
    }
  };

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
  // Words written here go along to the conversation, unless it already holds words of its own.
  const openExisting = (conversationId: string) => {
    if (store.handOff(conversationId, draft)) setDraft("");
    props.onOpenConversation(conversationId, title);
  };
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const sendIdentity = `direct-start:${workspaceId}`;
  // A start and its Try again name the account that wrote them, so main refuses them once another account signs in.
  const start = useCallback(
    async (sender: string, memberId: string, body: string, messageId: string, to: string) => {
      if (sendingRef.current) return;
      sendingRef.current = true;
      setSending(true);
      const session = store.session();
      try {
        const result = await bridge().directStart({
          viewerId: sender,
          workspaceId,
          memberId,
          messageId,
          body,
        });
        if (session !== store.session()) return;
        store.sent(`new:${memberId}`, messageId);
        // A Try again can land after the person wrote something else here.
        if (store.draft("new").trim() === body) {
          store.setDraft("new", "");
          setDraftState((current) => (current.trim() === body ? "" : current));
        }
        reporting.current.onClearError?.(sendIdentity);
        void store.refresh();
        openConversation.current(result.conversationId, to);
      } catch (cause) {
        // The words stay in the composer. A failure that lands after the account changed only takes its notice back.
        if (session !== store.session()) {
          reporting.current.onClearError?.(sendIdentity);
          return;
        }
        const message = ipcErrorMessage(cause, "dohc could not send your message.");
        reportDirect(
          reporting.current,
          message,
          cause,
          () => void start(sender, memberId, body, messageId, to),
          undefined,
          {
            identity: sendIdentity,
            title:
              message === DIRECT_START_INACTIVE_MESSAGE
                ? `Your message to ${to} may not have been sent`
                : `Your message to ${to} wasn't sent`,
          },
        );
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    },
    [sendIdentity, store, workspaceId],
  );
  const submit = () => {
    const body = draft.trim();
    if (!body || viewerId === null) return;
    if (pick === null) {
      setPickError(true);
      inputRef.current?.focus();
      return;
    }
    void start(viewerId, pick, body, store.messageIdFor(`new:${pick}`, body), title);
  };

  let content: ReactNode;
  if (state.status === "signed-out") {
    content = (
      <EmptyState
        data-testid="chats-dm-new-signed-out"
        icon={CloudOff}
        title="Sign in to your server to send direct messages."
      >
        <SettingsStep
          onOpenSettings={props.onOpenSettings}
          section="cloud"
          label="Sync and sharing"
          testId="chats-dm-new-signed-out-action"
        />
      </EmptyState>
    );
  } else if (state.status === "failed") {
    content = (
      <div className="flex flex-1 flex-col items-center justify-center">
        <RetryRow testId="chats-dm-new-list-retry" onRetry={() => void store.refresh()}>
          {state.message}
        </RetryRow>
      </div>
    );
  } else if (members.status === "loading") {
    content = (
      <SkeletonRows label="Loading members…" className="pt-3" testId="chats-dm-new-loading" />
    );
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
      <EmptyState
        data-testid="chats-dm-new-unsynced"
        icon={CloudOff}
        title="Sync this workspace to message its members."
      >
        <SettingsStep
          onOpenSettings={props.onOpenSettings}
          section="cloud"
          label="Set up sync"
          testId="chats-dm-new-unsynced-action"
        />
      </EmptyState>
    );
  } else if (members.members.length === 0) {
    content = (
      <EmptyState
        data-testid="chats-dm-new-empty"
        icon={Users}
        title="No one else is a member of this workspace yet."
      >
        <SettingsStep
          onOpenSettings={props.onOpenSettings}
          section="members"
          label="Members"
          testId="chats-dm-new-empty-action"
        />
      </EmptyState>
    );
  } else if (!listShown) {
    // The composer stays at the bottom, where it was while the list showed.
    content = <div className="min-h-0 flex-1" />;
  } else {
    content = (
      <ul
        id={listId}
        role="listbox"
        aria-label="Members"
        data-testid="chats-dm-new-members"
        className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-1"
      >
        {matches.length === 0 ? (
          <li className="px-2 py-2 text-[12px] text-muted">{`No members match "${query.trim()}".`}</li>
        ) : (
          matches.map((member, index) => {
            const selected = pick === member.memberId;
            return (
              <li
                key={member.memberId}
                id={`${listId}-${member.memberId}`}
                role="option"
                aria-selected={selected}
                data-testid="chats-dm-new-member"
                data-member-id={member.memberId}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => {
                  if (highlight !== index) setHighlight(index);
                }}
                onClick={() => choose(member.memberId)}
                data-active={active?.memberId === member.memberId || undefined}
                className={`flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] text-ink ${MENU_ACTIVE_OPTION}`}
              >
                <ChatAvatar
                  presentation={relayPresentation(member.paletteSlot)}
                  name={member.name}
                  kind="human"
                  size="strip"
                />
                <span className="min-w-0 flex-1 truncate">{member.name}</span>
                {selected ? <Check size={14} aria-hidden className="shrink-0 text-accent" /> : null}
              </li>
            );
          })
        )}
      </ul>
    );
  }

  const canPick =
    state.status === "ready" && members.status === "ready" && members.members.length > 0;
  return (
    <div
      data-testid="chats-dm-new"
      data-variant={props.variant}
      className="flex min-h-0 flex-1 flex-col"
    >
      <ChatHeader
        label="New message"
        testId="chats-dm-new"
        large={props.variant === "page"}
        onBack={props.onBack}
        icon={<PenSquare size={13} aria-hidden className="shrink-0 text-subtle" />}
      />
      <div
        className={`flex min-h-0 flex-1 flex-col ${props.variant === "page" ? "mx-auto w-full max-w-[640px]" : ""}`}
      >
        {canPick ? (
          <div className="shrink-0 border-b border-line px-3 py-2">
            <div className="flex flex-wrap items-center gap-1">
              <label htmlFor={`${listId}-input`} className="mr-1 text-[12px] text-muted">
                To
              </label>
              {pick !== null && pickName !== null ? (
                <span
                  data-testid="chats-dm-new-pick"
                  data-member-id={pick}
                  className="inline-flex h-6 items-center gap-1 rounded-full border border-line bg-panel-2 pl-1 pr-0.5 text-[12px] text-ink"
                >
                  <ChatAvatar
                    presentation={relayPresentation(byId.get(pick)?.paletteSlot ?? -1)}
                    name={pickName}
                    kind="human"
                    size="strip"
                    className="size-4 text-[8px]"
                  />
                  <span className="max-w-40 truncate">{pickName}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${pickName}`}
                    title={`Remove ${pickName}`}
                    onClick={() => choose(null)}
                    className="grid size-5 cursor-pointer place-items-center rounded-full text-subtle hover:bg-hover hover:text-ink"
                  >
                    <X size={11} aria-hidden />
                  </button>
                </span>
              ) : null}
              <input
                ref={inputRef}
                id={`${listId}-input`}
                data-testid="chats-dm-recipients"
                role="combobox"
                aria-expanded={listShown}
                aria-controls={listShown ? listId : undefined}
                aria-activedescendant={
                  listShown && active ? `${listId}-${active.memberId}` : undefined
                }
                aria-invalid={pickError || undefined}
                aria-describedby={pickError ? errorId : undefined}
                autoFocus={pick === null}
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
            {pickError ? (
              <FieldError id={errorId} className="mt-1">
                Choose who to message.
              </FieldError>
            ) : null}
          </div>
        ) : null}
        {content}
        {canPick && resolved?.conversationId ? (
          <div
            data-testid="chats-dm-new-existing"
            className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-2 text-[12px] text-muted"
          >
            <span className="min-w-0 flex-1">{`You already have a conversation with ${title}. Sending adds your message to it.`}</span>
            <SecondaryButton
              size="compact"
              data-testid="chats-dm-new-open-existing"
              onClick={() => openExisting(resolved.conversationId!)}
            >
              Open conversation
            </SecondaryButton>
          </div>
        ) : null}
        {canPick && blockedIn ? (
          <DirectComposerLine
            testId="chats-dm-new-blocked-line"
            icon={<Ban size={13} aria-hidden />}
            action={{ label: "Unblock", run: unblock }}
          >
            {`You blocked ${title}. They can't message you.`}
          </DirectComposerLine>
        ) : canPick ? (
          <MentionComposer
            pinned
            testIdPrefix="chats-dm-new"
            composerId="chats-dm-new-composer"
            value={draft}
            sending={sending}
            placeholder={pick !== null ? `Message ${title}` : "Write a message"}
            sendLabel="Send message"
            candidates={NO_CANDIDATES}
            noMentions
            onChange={setDraft}
            onSend={submit}
            inset={props.variant === "page" ? "stream" : "narrow"}
          />
        ) : null}
      </div>
    </div>
  );
}
