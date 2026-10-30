import { ArrowDown, MessageSquareText, MoreHorizontal, SquareTerminal } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ChatMessageRecord, ChatRunRecord, WorkspaceHeadingRecord } from "../../ipc/bridgeContract";
import type { MentionCandidate } from "@dohc/workspace-contracts/chat-mentions";
import { CopyButton } from "../ui/CopyButton";
import { Menu } from "../ui/Menu";
import { ChatMessageList, TOOLBAR_BUTTON, type ChatMessageListHandle, type ChatReactionControls } from "./chatMessages";
import { ChatThreadPanel, splitThreads, ThreadSummary, WorkingLine, WorkingRow, type ChatWorking } from "./ChatThreadPanel";
import { MentionComposer, type FileMentionCandidate } from "./MentionComposer";
import { RunDetails } from "./ChatPosts";
import { showChat } from "./chatsOnScreen";

// Within this distance of the end the reader is following the conversation.
// Matches the list's own maintain-at-end threshold.
const FOLLOW_THRESHOLD_PX = 40;

// Under this width a thread takes the conversation's place instead of
// opening beside it.
const SIDE_BY_SIDE_PX = 720;

// A conversation whose messages can each start a thread, which opens beside
// it. The host loads and sends; this keeps which thread is open, each
// thread's unsent reply, and where the reader is. Key it by conversation so
// a thread from one never opens in another.
export function ThreadedChat(props: {
  testIdPrefix: string;
  // The conversation's thread, once it has one, so an agent's notice about
  // a reply shown here is skipped.
  chatId?: string | null;
  messages: readonly ChatMessageRecord[];
  loading: boolean;
  emptyLabel: string;
  // Where a thread is, for its header: "# general" or a name.
  place: ReactNode;
  // Over the conversation: its header and any banners. A thread opened
  // beside it runs the full height next to them.
  header?: ReactNode;
  // Under the messages, over the notice and composer, such as who's typing.
  belowList?: ReactNode;
  // One line over the composer when something is wrong, with its fix.
  notice?: ReactNode;
  composer: (inset: "stream" | "narrow") => ReactNode;
  // Shown in a thread instead of its composer, when the reader can't reply.
  replyNotice?: ReactNode;
  // Sends a reply in a message's thread; true once it's sent.
  onSendReply: (rootId: string, body: string) => Promise<boolean>;
  replyDisabled?: boolean;
  mentionCandidates: readonly MentionCandidate[];
  fileCandidates?: readonly FileMentionCandidate[];
  loadFileHeadings?: (path: string) => Promise<readonly WorkspaceHeadingRecord[]>;
  onOpenPath?: (path: string, headingAnchor?: string) => void;
  reactionControls?: ChatReactionControls;
  // More under a message, such as its poll.
  renderMessageFooter?: (message: ChatMessageRecord) => ReactNode;
  // The run behind each agent reply, by message, for its Run details.
  runs?: Readonly<Record<string, ChatRunRecord>>;
  // An agent at work, and the message it answers.
  working?: ChatWorking | null;
  workingMessageId?: string | null;
  listRef: RefObject<ChatMessageListHandle | null>;
  firstUnreadMessageId?: string | null;
  flashMessageId?: string | null;
  bottomSpace?: number;
}) {
  const { testIdPrefix: prefix, listRef } = props;
  const [openRootId, setOpenRootId] = useState<string | null>(null);
  const [replyDrafts, setReplyDrafts] = useState<ReadonlyMap<string, string>>(new Map());
  const [replying, setReplying] = useState(false);
  // The message whose run details show under it.
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(false);
  const [atEnd, setAtEnd] = useState(true);
  // Messages the reader had seen when last at the end.
  const seenCount = useRef(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const threadListRef = useRef<ChatMessageListHandle | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  // Beside a narrow conversation there's no room for a thread, so it
  // takes the conversation's place.
  useEffect(() => {
    const node = rootRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width < SIDE_BY_SIDE_PX);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const { chatId } = props;
  useEffect(() => {
    const node = rootRef.current;
    if (!node || !chatId) return;
    return showChat(chatId, node);
  }, [chatId]);

  const threads = useMemo(() => splitThreads(props.messages), [props.messages]);
  const stream = threads.top;
  const streamShown = !(narrow && openRootId !== null);

  // Follow the reader's position so arrivals while reading history are
  // counted instead of pulling the view to the end.
  const hasList = !props.loading && stream.length > 0;
  useEffect(() => {
    const node = hasList && streamShown ? listRef.current?.getScrollableNode() : null;
    if (!node) return;
    const onScroll = () => {
      setAtEnd(node.scrollHeight - node.scrollTop - node.clientHeight <= FOLLOW_THRESHOLD_PX);
    };
    onScroll();
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => node.removeEventListener("scroll", onScroll);
  }, [hasList, listRef, streamShown]);
  useEffect(() => {
    if (atEnd) seenCount.current = stream.length;
  }, [atEnd, stream.length]);
  const newCount = atEnd ? 0 : Math.max(0, stream.length - seenCount.current);

  const openThread = useCallback((messageId: string) => setOpenRootId(messageId), []);
  const closeThread = useCallback(() => setOpenRootId(null), []);
  const replyDraft = openRootId ? replyDrafts.get(openRootId) ?? "" : "";
  const setReplyDraft = useCallback((value: string) => {
    if (!openRootId) return;
    setReplyDrafts((drafts) => new Map(drafts).set(openRootId, value));
  }, [openRootId]);
  const { onSendReply } = props;
  const sendReply = useCallback(async () => {
    const rootId = openRootId;
    const body = (rootId ? replyDrafts.get(rootId) ?? "" : "").trim();
    if (!rootId || body.length === 0 || replying) return;
    setReplying(true);
    try {
      if (!(await onSendReply(rootId, body)) || !mounted.current) return;
      threadListRef.current?.scrollToEnd();
      setReplyDrafts((drafts) => {
        const next = new Map(drafts);
        next.delete(rootId);
        return next;
      });
    } finally {
      if (mounted.current) setReplying(false);
    }
  }, [onSendReply, openRootId, replyDrafts, replying]);

  // The thread the working agent answers in, if it was asked in one.
  const workingRootId = useMemo(() => {
    const asking = props.workingMessageId;
    if (!asking) return null;
    for (const [rootId, replies] of threads.replies) {
      if (replies.some((reply) => reply.id === asking)) return rootId;
    }
    return null;
  }, [props.workingMessageId, threads.replies]);
  const working = props.working ?? null;

  const { renderMessageFooter, mentionCandidates, runs } = props;
  const runDetails = useCallback((message: ChatMessageRecord) => {
    const run = detailsId === message.id ? runs?.[message.id] : undefined;
    return run ? (
      <div
        role="group"
        aria-label="Run details"
        data-testid={`${prefix}-run-details`}
        className="mt-1.5 grid max-w-sm gap-2 rounded-lg border border-line bg-panel p-3"
      >
        <RunDetails run={run} />
      </div>
    ) : null;
  }, [detailsId, prefix, runs]);
  const moreAction = useCallback((message: ChatMessageRecord, testId: string) => runs?.[message.id] ? (
    <MessageMore
      testId={testId}
      detailsShown={detailsId === message.id}
      onToggleDetails={() => setDetailsId((shown) => (shown === message.id ? null : message.id))}
    />
  ) : null, [detailsId, runs]);
  const renderThreadFooter = useCallback((message: ChatMessageRecord) => (
    <>
      {renderMessageFooter?.(message)}
      {runDetails(message)}
    </>
  ), [renderMessageFooter, runDetails]);
  // Under a stream message: its poll, its thread, and the agent answering in it.
  const renderStreamFooter = useCallback((message: ChatMessageRecord) => {
    const replies = threads.replies.get(message.id);
    return (
      <>
        {renderMessageFooter?.(message)}
        {runDetails(message)}
        {replies ? <ThreadSummary testIdPrefix={prefix} replies={replies} mentionCandidates={mentionCandidates} onOpen={() => openThread(message.id)} /> : null}
        {working && workingRootId === message.id && openRootId !== message.id ? <WorkingLine testIdPrefix={prefix} working={working} /> : null}
      </>
    );
  }, [mentionCandidates, openRootId, openThread, prefix, renderMessageFooter, runDetails, threads.replies, working, workingRootId]);
  const streamActions = useCallback((message: ChatMessageRecord) => (
    <>
      <button
        type="button"
        data-testid={`${prefix}-reply-in-thread`}
        aria-label="Reply in thread"
        title="Reply in thread"
        onClick={() => openThread(message.id)}
        className={TOOLBAR_BUTTON}
      >
        <MessageSquareText size={15} strokeWidth={1.9} aria-hidden />
      </button>
      <CopyButton iconOnly label="Copy text" getText={() => message.body} testId={`${prefix}-copy-text`} />
      {moreAction(message, `${prefix}-more`)}
    </>
  ), [moreAction, openThread, prefix]);
  const threadActions = useCallback((message: ChatMessageRecord) => (
    <>
      <CopyButton iconOnly label="Copy text" getText={() => message.body} testId={`${prefix}-thread-copy-text`} />
      {moreAction(message, `${prefix}-thread-more`)}
    </>
  ), [moreAction, prefix]);

  const openRoot = openRootId ? stream.find((message) => message.id === openRootId) ?? null : null;
  const openReplies = openRootId ? threads.replies.get(openRootId) ?? [] : [];
  // A thread whose message is gone closes.
  useEffect(() => {
    if (openRootId && !props.loading && !openRoot) setOpenRootId(null);
  }, [openRoot, openRootId, props.loading]);

  return (
    <div ref={rootRef} data-testid={prefix} className="flex min-h-0 flex-1">
      {streamShown ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {props.header}
          <ChatMessageList
            testIdPrefix={prefix}
            messages={stream}
            loading={props.loading}
            emptyLabel={props.emptyLabel}
            listRef={listRef}
            mentionCandidates={mentionCandidates}
            onOpenPath={props.onOpenPath}
            flashMessageId={props.flashMessageId}
            reactionControls={props.reactionControls}
            renderMessageFooter={renderStreamFooter}
            rowActions={streamActions}
            openMessageId={openRootId}
            firstUnreadMessageId={props.firstUnreadMessageId}
            footer={working && workingRootId === null ? <WorkingRow testIdPrefix={prefix} working={working} density={narrow ? "narrow" : "stream"} /> : null}
            density={narrow ? "narrow" : "stream"}
            bottomSpace={props.bottomSpace}
          />
          <span role="status" aria-live="polite" className="sr-only">
            {newCount > 0 ? `${newCount} ${newCount === 1 ? "new message" : "new messages"}` : ""}
          </span>
          {newCount > 0 ? (
            <div className="relative h-0">
              <button
                type="button"
                data-testid={`${prefix}-new-messages`}
                onClick={() => listRef.current?.scrollToEnd()}
                className="dohc-pop-in absolute bottom-2 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-full border border-line bg-panel px-2.5 py-1 text-[11px] font-medium text-ink shadow-sm transition-colors hover:bg-line"
              >
                <ArrowDown size={11} aria-hidden />
                <span className="tabular-nums">{newCount}</span>
                {newCount === 1 ? "new message" : "new messages"}
              </button>
            </div>
          ) : null}
          {props.belowList}
          {props.notice}
          {props.composer(narrow ? "narrow" : "stream")}
        </div>
      ) : null}
      {openRootId ? (
        <ChatThreadPanel
          testIdPrefix={prefix}
          place={props.place}
          parent={openRoot}
          replies={openReplies}
          loading={props.loading}
          narrow={narrow}
          onClose={closeThread}
          mentionCandidates={mentionCandidates}
          onOpenPath={props.onOpenPath}
          reactionControls={props.reactionControls}
          renderMessageFooter={renderThreadFooter}
          rowActions={threadActions}
          listRef={threadListRef}
          working={working && workingRootId === openRootId ? working : null}
          composer={props.replyNotice ?? (
            <MentionComposer
              testIdPrefix={`${prefix}-thread`}
              composerId={`${prefix}-thread-composer`}
              value={replyDraft}
              sending={replying}
              disabled={props.replyDisabled === true || props.loading}
              placeholder="Reply…"
              sendLabel="Send reply"
              candidates={mentionCandidates}
              fileCandidates={props.fileCandidates}
              loadFileHeadings={props.loadFileHeadings}
              onChange={setReplyDraft}
              onSend={() => void sendReply()}
              inset={narrow ? "narrow" : "thread"}
            />
          )}
        />
      ) : null}
    </div>
  );
}

// A message's other actions, after its reactions, reply, and copy.
function MessageMore(props: { testId: string; detailsShown: boolean; onToggleDetails: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Menu
      label="More"
      open={open}
      onOpenChange={setOpen}
      width={176}
      menuTestId={`${props.testId}-menu`}
      topLayer
      items={[{
        id: "run-details",
        label: props.detailsShown ? "Hide run details" : "Run details",
        icon: <SquareTerminal size={14} aria-hidden />,
        onSelect: props.onToggleDetails,
        testId: `${props.testId}-run-details`,
      }]}
      trigger={(trigger) => (
        <button {...trigger} type="button" data-testid={props.testId} aria-label="More" title="More" className={TOOLBAR_BUTTON}>
          <MoreHorizontal size={15} strokeWidth={1.9} aria-hidden />
        </button>
      )}
    />
  );
}
