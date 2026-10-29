import type { ChatLinksPage } from "@dohc/workspace-contracts/chat-links";
import { Link, Link2Off } from "lucide-react";
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ipcErrorMessage } from "../ipcError";
import { RetryRow } from "../ui/controls";
import { Ref } from "../ui/Ref";
import { SkeletonLines } from "../ui/SkeletonRows";
import {
  ABOUT_ROW_BUTTON,
  AboutAccess,
  AboutGathering,
  AboutHeader,
  AboutMore,
  AboutNote,
  AboutSection,
  OFFSCREEN_ROW,
  gatherDelay,
  useFocusAddedRow,
  type AboutNotices,
} from "./About";
import type { AboutConversation } from "./aboutConversation";
import type { AccessContext } from "./accessReason";
import { AgentName, ChatAvatar } from "./ChatAvatar";
import { useChatLinks } from "./useChatLinks";

export type ConversationSectionId = "links" | "access";

// About for the open conversation: a Group, a person or an agent. Its name and
// who is here come from the conversation's own page; Links reads the files it
// mentions, and Access asks main about the chat's grants, the way it asks
// about a file's.
export function AboutConversationPanel(props: {
  workspaceId: string;
  conversation: AboutConversation;
  // The rail holds which sections are open, so they stay open between chats.
  // Access stays closed until opened, like a file's: opening it is what asks
  // main to check again.
  sectionsOpen: Record<ConversationSectionId, boolean>;
  onToggleSection: (id: ConversationSectionId) => void;
  onOpenFile: (path: string) => void;
  notices: AboutNotices;
  accessContext: AccessContext;
}) {
  const { conversation, onToggleSection } = props;
  return (
    <div data-testid="about-panel" data-conversation-kind={conversation.kind} className="flex min-h-0 flex-1 flex-col">
      <AboutHeader subject={conversation} />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2">
        <AboutConversationLinks
          workspaceId={props.workspaceId}
          channelWireId={conversation.channelWireId}
          expanded={props.sectionsOpen.links}
          onToggle={() => onToggleSection("links")}
          onOpenFile={props.onOpenFile}
          notices={props.notices}
        />
        <AboutAccess
          workspaceId={props.workspaceId}
          subject={{ kind: "chat", channelWireId: conversation.channelWireId }}
          received={conversation.received}
          expanded={props.sectionsOpen.access}
          onToggle={() => onToggleSection("access")}
          notices={props.notices}
          context={props.accessContext}
        />
      </div>
    </div>
  );
}

// ---- Links ----

type Page = NonNullable<ChatLinksPage>;
type Author = Page["entries"][number]["author"];

// One file the conversation mentions, and who mentioned it, newest first.
export type MentionedFile = { objectId: string; path: string; authors: Author[] };

// `unlisted` is a conversation main has no Links for, such as a Group that
// has not arrived on this computer yet. Nothing failed, so it files no row.
export type ConversationLinksView =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "unlisted" }
  | { status: "ready"; files: MentionedFile[]; more: boolean; building: boolean; partial: boolean };

const LINKS_FAILED = "dohc could not load the files this conversation mentions.";

const authorKey = (author: Author) => `${author.kind}\0${author.presentation.group}\0${author.displayName}`;

// Each entry is one mention, newest first. A file shows once, where it was
// last mentioned, with everyone who mentioned it in the pages read so far.
export function mentionedFiles(pages: readonly Page[]): MentionedFile[] {
  const files = new Map<string, { path: string; authors: Map<string, Author> }>();
  for (const page of pages) {
    for (const entry of page.entries) {
      let file = files.get(entry.file.objectId);
      if (!file) files.set(entry.file.objectId, (file = { path: entry.file.path, authors: new Map() }));
      if (!file.authors.has(authorKey(entry.author))) file.authors.set(authorKey(entry.author), entry.author);
    }
  }
  return [...files].map(([objectId, file]) => ({ objectId, path: file.path, authors: [...file.authors.values()] }));
}

function AboutConversationLinks(props: {
  workspaceId: string;
  channelWireId: string;
  expanded: boolean;
  onToggle: () => void;
  onOpenFile: (path: string) => void;
  notices: AboutNotices;
}) {
  const { workspaceId, channelWireId, expanded, notices } = props;
  const key = `${workspaceId}\0${channelWireId}`;
  const identity = `about-conversation-links:${channelWireId}`;
  // The conversation whose newest read failed. A read that answers with no
  // page did not fail.
  const [failed, setFailed] = useState<string | null>(null);
  const retry = useRef(() => {});
  const onError = useCallback((error: unknown) => {
    setFailed(key);
    notices.report({ identity, message: ipcErrorMessage(error, LINKS_FAILED), cause: error, retry: () => retry.current() });
  }, [identity, key, notices]);
  const { pages, status, load, loadMore } = useChatLinks({ workspaceId, channelWireId, onError });
  const read = useCallback(() => {
    setFailed(null);
    void load();
  }, [load]);
  retry.current = read;

  // Shown, or shown for another conversation, it reads from the start. So
  // does coming back to the window: a message elsewhere may mention a file.
  useEffect(() => {
    if (!expanded) return;
    read();
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, [expanded, read]);

  // A read that lands ends the conversation's row, and so does the
  // conversation leaving About.
  const landed = status === "loaded" || (status === "unavailable" && failed !== key);
  useEffect(() => {
    if (landed) notices.clear(identity);
  }, [identity, landed, notices]);
  useEffect(() => () => notices.clear(identity), [identity, key, notices]);

  // While the index builds, a read from the start is the one that sees it
  // finish: soon at first, then less often.
  const building = pages.some((page) => page.indexBuilding);
  const gathering = useRef({ key, reads: 0 });
  useEffect(() => {
    if (gathering.current.key !== key || !building) gathering.current = { key, reads: 0 };
    if (!expanded || status !== "loaded" || !building) return;
    const timer = setTimeout(read, gatherDelay(++gathering.current.reads));
    return () => clearTimeout(timer);
  }, [building, expanded, key, pages, read, status]);

  const files = useMemo(() => mentionedFiles(pages), [pages]);
  const view: ConversationLinksView =
    pages.length === 0
      ? status === "unavailable" ? { status: failed === key ? "failed" : "unlisted" } : { status: "loading" }
      : {
          status: "ready",
          files,
          more: pages.at(-1)!.nextCursor !== null,
          building,
          partial: pages.some((page) => !page.complete || !page.mountsCovered),
        };
  return (
    <AboutConversationLinksView
      view={view}
      expanded={expanded}
      onToggle={props.onToggle}
      onOpenFile={props.onOpenFile}
      onMore={() => void loadMore()}
      onRetry={read}
    />
  );
}

const fileKey = (file: MentionedFile) => file.objectId;

// The Links section for an answer already in hand. The states page draws it.
export function AboutConversationLinksView(props: {
  view: ConversationLinksView;
  expanded: boolean;
  onToggle: () => void;
  onOpenFile: (path: string) => void;
  onMore: () => void;
  onRetry: () => void;
  toggleRef?: RefObject<HTMLButtonElement | null>;
}) {
  const { view } = props;
  const ready = view.status === "ready" ? view : null;
  const ownToggle = useRef<HTMLButtonElement>(null);
  const toggleRef = props.toggleRef ?? ownToggle;
  const focusAdded = useFocusAddedRow(ready?.files ?? null, fileKey, toggleRef, '[data-testid="about-conversation-link"]');
  return (
    <AboutSection id="links" icon={Link} label="Links"
      count={ready ? `${ready.files.length}${ready.more || ready.building ? "+" : ""}` : undefined}
      expanded={props.expanded} onToggle={props.onToggle} toggleRef={toggleRef}>
      {view.status === "loading" ? (
        <SkeletonLines rows={2} className="px-2 py-1" />
      ) : view.status === "failed" ? (
        <RetryRow testId="about-conversation-links-failed" onRetry={props.onRetry} />
      ) : view.status === "unlisted" ? (
        <AboutNote testId="about-conversation-links-unlisted" icon={Link2Off}>
          dohc does not list links in this conversation yet.
        </AboutNote>
      ) : (
        <>
          {view.files.length > 0 ? <MentionedFileList files={view.files} onOpenFile={props.onOpenFile} /> : null}
          {view.more ? (
            <AboutMore testId="about-conversation-links-more" onMore={(focused) => {
              if (focused) focusAdded();
              props.onMore();
            }} />
          ) : null}
          {/* Under the list, what it may still be missing. Files the reader
              cannot open never reach it, so they are never counted here. A
              page main emptied of such files can still have more after it:
              then Show more is the next step, and nothing says it is empty. */}
          {view.building ? (
            <AboutGathering testId="about-conversation-links-gathering" />
          ) : view.partial ? (
            <AboutNote testId="about-conversation-links-partial">This list may not include every file mentioned here.</AboutNote>
          ) : view.files.length === 0 && !view.more ? (
            <AboutNote testId="about-conversation-links-empty">
              No files mentioned here yet. Type{" "}
              <kbd className="rounded border border-line bg-bg px-1 font-mono text-[11px] text-muted">/</kbd> in a message
              to add one.
            </AboutNote>
          ) : null}
        </>
      )}
    </AboutSection>
  );
}

const MentionedFileList = memo(function MentionedFileList(props: {
  files: MentionedFile[];
  onOpenFile: (path: string) => void;
}) {
  return (
    <ul data-testid="about-conversation-links-list" className="m-0 list-none p-0">
      {props.files.map((file) => (
        <li key={fileKey(file)} className={OFFSCREEN_ROW}>
          <MentionedFileRow file={file} onOpen={() => props.onOpenFile(file.path)} />
        </li>
      ))}
    </ul>
  );
});

// A file the conversation mentions: the file, then who mentioned it. The
// avatars are hidden from screen readers, so an agent or an automation is
// named as one in words, as a sentence elsewhere says "Paused by agent".
function MentionedFileRow(props: { file: MentionedFile; onOpen: () => void }) {
  const { file } = props;
  return (
    <button
      type="button"
      data-testid="about-conversation-link"
      data-path={file.path}
      onClick={props.onOpen}
      className={`${ABOUT_ROW_BUTTON} py-1`}
    >
      <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
        <Ref path={file.path} folder />
        <span className="flex min-w-0 max-w-full items-center gap-1.5 text-[12px] leading-4">
          <span className="flex shrink-0">
            {file.authors.slice(0, 3).map((author) => (
              <ChatAvatar key={authorKey(author)} name={author.displayName} kind={author.kind}
                presentation={author.presentation} size="strip" className="-ml-1 first:ml-0" />
            ))}
          </span>
          <span data-testid="about-conversation-link-authors" className="min-w-0 truncate">
            <span className="sr-only">Mentioned by </span>
            {file.authors.map((author, index) => (
              <Fragment key={authorKey(author)}>
                {index > 0 ? ", " : null}
                {author.kind === "human" ? null : <span className="sr-only">{author.kind === "link" ? "link holder" : author.kind} </span>}
                <AgentName kind={author.kind} presentation={author.presentation}>{author.displayName}</AgentName>
              </Fragment>
            ))}
          </span>
        </span>
      </span>
    </button>
  );
}
