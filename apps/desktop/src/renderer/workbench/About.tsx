import type { AccessAnswer, AccessObjectRef } from "@dohc/workspace-contracts/access";
import { fileKindForPath } from "@dohc/workspace-contracts/kinds";
import type { LinksInResult } from "@dohc/workspace-contracts/links";
import { isSharedWithMePath } from "@dohc/workspace-core/paths";
import {
  ChevronDown,
  ChevronRight,
  CloudOff,
  Eye,
  EyeOff,
  FileText,
  FileX,
  History,
  Link,
  Link2Off,
  LoaderCircle,
  LogIn,
  MessageSquare,
  Pencil,
  Share2,
  type LucideIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ChatFileMentionRecord, ChatThreadRecord, EngineMomentRecord } from "../../ipc/bridgeContract";
import { isChatMentionPageChanged, isWorkspaceUpdatingError } from "../../ipc/errorWords";
import { bridge } from "../bridge";
import { SYNC_UNCONFIRMED_ACCOUNT } from "../cloudSyncWords";
import { ipcErrorMessage } from "../ipcError";
import { basenameOf } from "../path";
import { formatChatTime, formatShortTime } from "../time";
import { RetryRow, SecondaryButton } from "../ui/controls";
import { KindGlyph, ObjectGlyph } from "../ui/KindGlyph";
import { Ref } from "../ui/Ref";
import { SkeletonLines } from "../ui/SkeletonRows";
import { StateMark } from "../ui/StateMark";
import { PresenceFaces } from "../collab/PresenceIndicators";
import type { AboutConversation } from "./aboutConversation";
import { accessReasonForLane, type AccessContext, type AccessFacts, type AccessReason } from "./accessReason";
import { ChatAvatar, LinkMark } from "./ChatAvatar";
import { neutralPresentation, ownPresentation, ownAgentPresentation, relayPresentation } from "./actorPresentation";
import { HistoryPaused, HistoryUpdating, MARK_BOX, MomentAuthor, engineMomentSourceLabel, engineMomentSummary } from "./EngineHistory";
import { historyHiddenWords } from "./HistoryPolicyStates";

// The About tab: everything about the open file or chat, one section each. A
// section shows only what its own query answers, and every answer is held to
// the workspace and object it was asked for, so a slow answer for one never
// lands under another.

export type AboutSectionId = "links" | "chats" | "history" | "access";

// The shell's error hook. A section read that fails is one Notices row per
// section and file, with Try again. A read that succeeds clears it, and so
// does the file leaving About. The section itself shows no error words, only
// the way to read again. An unchanged failure keeps an existing row's toast
// state. A changed message, or a missing row, toasts again.
export type AboutNotices = {
  report(failure: { identity: string; message: string; cause?: unknown; retry: () => void }): void;
  clear(identity: string): void;
};

export type AccessSetup = {
  reason: AccessReason;
  openSyncSettings: () => void;
  connect: () => void;
};

// The cause for one file, the way main answers it (accessOwner.ts). The
// workspace's own files are listed from its owner's roster, which needs the
// workspace to sync and its account to be signed in. A shared view's files
// and files under shared-with-me/ are listed from the account's received
// shares, which need only a signed-in account. Signed in, a received file
// can still go unanswered: the account or server the share went to differs,
// or the list has not arrived. The renderer cannot tell those apart.
export function accessReasonFor(facts: AccessFacts, path: string): AccessReason {
  return accessReasonForLane(facts, facts.shareView || isSharedWithMePath(path) ? "received" : "granted");
}

// A row in a section, inset from the panel's edges like the drawing's rows.
export const ABOUT_ROW =
  "flex w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-muted transition-colors duration-75";
export const ABOUT_ROW_BUTTON = `${ABOUT_ROW} cursor-pointer hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent`;

// The open object: its mark, its name, then who is here.
export function AboutHeader(props: { subject: { path: string } | AboutConversation }) {
  const { subject } = props;
  const name = "path" in subject ? basenameOf(subject.path) : subject.name;
  const person = "path" in subject || subject.kind !== "person" ? undefined : subject.present.find(peer => !peer.isSelf);
  return (
    <div
      data-testid="about-header"
      className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3 text-[13px]"
    >
      {"path" in subject ? (
        <KindGlyph kind={fileKindForPath(subject.path)} size={14} className="text-muted" />
      ) : subject.kind === "group" ? (
        <ObjectGlyph kind="group" size={14} className="text-muted" />
      ) : (
        <ChatAvatar presentation={subject.kind === "agent" ? ownAgentPresentation : person ? relayPresentation(person.paletteSlot) : neutralPresentation} name={subject.name} kind={subject.kind === "agent" ? "agent" : "human"} size="strip" />
      )}
      <span title={"path" in subject ? subject.path : subject.name} className="min-w-0 truncate font-semibold text-ink">
        {name}
      </span>
      {/* The conversation's own header announces who arrives; this copy
          only shows them. */}
      {"path" in subject ? null : <PresenceFaces others={subject.present} live={false} className="ml-auto" />}
    </div>
  );
}

// A section head is its disclosure: the icon, the label, then the count.
export function AboutSection(props: {
  id: AboutSectionId;
  icon: LucideIcon;
  label: string;
  count?: string;
  expanded: boolean;
  onToggle: () => void;
  // For a section that hands focus to its own head.
  toggleRef?: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
}) {
  const bodyId = useId();
  const Icon = props.icon;
  return (
    <section data-testid={`about-${props.id}`} aria-label={props.label} className="mt-4 first:mt-2">
      <h3 className="m-0">
        <button
          ref={props.toggleRef}
          type="button"
          data-testid={`about-${props.id}-toggle`}
          aria-expanded={props.expanded}
          aria-controls={bodyId}
          onClick={props.onToggle}
          className="dohc-section-label flex h-6 w-full cursor-pointer items-center gap-2 px-3 text-left hover:text-muted focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        >
          <Icon size={12} strokeWidth={1.9} aria-hidden />
          {props.label}
          {props.expanded ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
          {props.count !== undefined ? (
            <span
              data-testid={`about-${props.id}-count`}
              className="ml-auto text-[11px] font-normal tabular-nums normal-case tracking-normal"
            >
              {props.count}
            </span>
          ) : null}
        </button>
      </h3>
      {props.expanded ? (
        <div id={bodyId} className="px-1">
          {props.children}
        </div>
      ) : null}
    </section>
  );
}

// One line inside a section that is not a row: what an answer means, with
// the one action that can change it.
export function AboutNote(props: {
  testId: string;
  icon?: LucideIcon;
  children: ReactNode;
  action?: { label: string; run: () => void };
  reason?: string;
}) {
  const Icon = props.icon;
  return (
    <div data-testid={props.testId} data-reason={props.reason} className="flex flex-col items-start gap-2 px-2 py-1">
      <p className="m-0 flex items-start gap-1.5 text-[12px] leading-4 text-muted">
        {Icon ? <Icon size={12} aria-hidden className="mt-0.5 shrink-0 text-subtle" /> : null}
        <span>{props.children}</span>
      </p>
      {props.action ? (
        <SecondaryButton size="compact" onClick={props.action.run}>
          {props.action.label}
        </SecondaryButton>
      ) : null}
    </div>
  );
}

// Said while a link index builds: the rows shown may grow. Its words start
// where a row's name does.
export function AboutGathering(props: { testId: string }) {
  return (
    <p role="status" data-testid={props.testId} className="m-0 flex items-center gap-2 px-2 py-1 text-[12px] text-muted">
      <span aria-hidden className={`${MARK_BOX} text-subtle`}>
        <LoaderCircle size={12} className="motion-safe:animate-spin" />
      </span>
      Gathering links
    </p>
  );
}

// The row that reads a list's next page, the same control while pages arrive,
// so focus on it stays. `onMore` hears whether the row had focus when it was
// pressed. With `onSeen`, the row coming into view reads the page too, and it
// checks again whether it is in view each time `watch` changes. A caller
// passes the rows: only a read that lands makes new rows, so a page that
// failed, or was refused while the workspace updated, does not check again,
// and the list's read guard pauses the row coming back into view until a
// read lands.
export function AboutMore(props: {
  testId: string;
  onMore: (focused: boolean) => void;
  onSeen?: () => void;
  watch?: unknown;
}) {
  const node = useRef<HTMLButtonElement>(null);
  const onSeen = useRef(props.onSeen);
  onSeen.current = props.onSeen;
  const watches = props.onSeen !== undefined;
  const { watch } = props;
  useEffect(() => {
    const button = node.current;
    if (!watches || !button || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onSeen.current?.();
    });
    observer.observe(button);
    return () => observer.disconnect();
  }, [watch, watches]);
  return (
    <button
      ref={node}
      type="button"
      data-testid={props.testId}
      onClick={() => props.onMore(node.current === document.activeElement)}
      className={`${ABOUT_ROW_BUTTON} h-7 text-[12px]`}
    >
      Show more
    </button>
  );
}

// One chat about the file: its title, then when it last changed.
export function AboutChatRow(props: { thread: ChatThreadRecord; onOpen: () => void }) {
  const when = formatChatTime(props.thread.updatedAtMs);
  return (
    <button
      type="button"
      data-testid="linked-chat-open"
      data-thread-id={props.thread.id}
      onClick={props.onOpen}
      className={`${ABOUT_ROW_BUTTON} h-10`}
    >
      <span aria-hidden className={`${MARK_BOX} text-subtle`}>
        <MessageSquare size={14} />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{props.thread.title}</span>
        <time dateTime={when.iso} className="truncate text-[11px] text-subtle">
          {when.label}
        </time>
      </span>
    </button>
  );
}

// The answer for one workspace and file. A key that is not the current one is
// still loading, so the first render after a switch shows nothing stale.
type Keyed<View> = { key: string; view: View };
const LOADING = { status: "loading" } as const;

// A read for the current workspace and file. Its answer lands only while it
// is the newest read for the file still on screen. A failure files one
// Notices row, and the row goes when the file leaves About, so every row
// left has a Try again that reads.
export function useSectionRead<View>(key: string, identity: string, notices: AboutNotices) {
  const [state, setState] = useState<Keyed<View | typeof LOADING>>({ key: "", view: LOADING });
  const token = useRef(0);
  const currentKey = useRef(key);
  currentKey.current = key;
  const begin = useCallback(() => {
    const request = ++token.current;
    const current = () => request === token.current && currentKey.current === key;
    return {
      current,
      settle(view: View) {
        if (!current()) return;
        notices.clear(identity);
        setState({ key, view });
      },
      fail(view: View, message: string, cause: unknown, retry: () => void) {
        if (!current()) return;
        setState({ key, view });
        notices.report({ identity, message, cause, retry });
      },
    };
  }, [identity, key, notices]);
  const cancel = useCallback(() => {
    token.current += 1;
  }, []);
  // A new read key, even for the same path, ends the last one's row.
  useEffect(() => () => {
    token.current += 1;
    notices.clear(identity);
  }, [identity, key, notices]);
  return { view: state.key === key ? state.view : LOADING, begin, cancel };
}

// ---- Links ----

type LinkEntry = NonNullable<LinksInResult>["entries"][number];

// A list read a page at a time. A read again from the start reads on until it
// holds as many rows as it showed, so the list never shrinks under the person
// reading, and pages that came back sparse while the index built cost nothing
// once it has. `gathering` counts the reads in a row that found the
// workspace's files still being read, or its link index still building. Each
// is read again from the start, soon at first. Nothing failed, so it files no
// row.
type PagedRows<Row> = { status: "ready"; rows: Row[]; next: string | null; gathering: number };
type ReadyLinks = PagedRows<LinkEntry>;
type ReadyChatLinks = PagedRows<ChatFileMentionRecord>;
export type LinksView = typeof LOADING | { status: "failed" } | ReadyLinks;
export type ChatLinksView = typeof LOADING | { status: "failed" } | ReadyChatLinks;

const GATHER_FIRST_MS = 250;
const GATHER_LAST_MS = 8_000;
export const gatherDelay = (reads: number) => Math.min(GATHER_FIRST_MS * 2 ** (reads - 1), GATHER_LAST_MS);
// A read the engine refused while it reads the workspace's files keeps the
// rows it would replace and gathers on.
const gatheringOn = <Row,>(kept: PagedRows<Row> | undefined): PagedRows<Row> =>
  ({ status: "ready", rows: kept?.rows ?? [], next: kept?.next ?? null, gathering: (kept?.gathering ?? 0) + 1 });
// A read that failed keeps the rows it would replace and stops gathering.
// With no rows to keep, only Try again shows, so nothing claims the list is
// empty.
const failedOver = <Row,>(kept: PagedRows<Row> | undefined): PagedRows<Row> | { status: "failed" } =>
  kept && kept.rows.length > 0 ? { ...kept, gathering: 0 } : { status: "failed" };

// One read at a time for one list. A read from the start replaces one in
// flight, since it answers for newer rows. Show more pressed while a read
// from the start runs waits for it, then reads the page after it, so a page
// never lands on rows that read replaced. Pressed again while the next page
// is read, it asks for nothing. Show more coming into view during any read
// is checked again once the read lands.
//
// A read that failed, or was refused while the workspace updated, pauses
// Show more coming into view until a read lands: Try again, or the
// gathering's read from the start. Pressing Show more still asks at once.
type ReadGuard = { reading: "start" | "more" | null; moreAfter: boolean; paused: boolean };
const NO_READ: ReadGuard = { reading: null, moreAfter: false, paused: false };
function asksMore(guard: ReadGuard, seen: boolean | undefined): boolean {
  if (seen && guard.paused) return false;
  if (guard.reading === "start" && !seen) guard.moreAfter = true;
  return guard.reading === null;
}
// The read that ends, if it is still the newest: whether Show more waits on it.
function readEnds(guard: ReadGuard, landed: boolean): boolean {
  const more = guard.moreAfter && landed;
  guard.reading = null;
  guard.moreAfter = false;
  guard.paused = !landed;
  return more;
}

const LINKS_FAILED = "dohc could not load the links to this file.";
const CHAT_LINKS_FAILED = "dohc could not load the chats that link to this file.";
// Without chats to open, no chat rows are drawn to press.
const OPENS_NO_CHAT = () => undefined;

export function AboutLinks(props: {
  workspaceId: string;
  path: string;
  // Changes when the workspace's files change, so the rows follow edits.
  revision: number;
  expanded: boolean;
  onToggle: () => void;
  onOpenLink: (path: string, line: number) => void;
  // Where this workspace's chats can be read: what opens a chat that links here.
  onOpenChat?: (mention: ChatFileMentionRecord) => void;
  notices: AboutNotices;
}) {
  const { workspaceId, path, revision, notices } = props;
  // A file under shared-with-me/ is linked from its share's own workspace,
  // which this one does not read yet.
  const shared = isSharedWithMePath(path);
  const reads = props.expanded && !shared;
  const readsChats = reads && props.onOpenChat !== undefined;
  const key = `${workspaceId}\0${path}`;
  const links = useSectionRead<LinksView>(key, `about-links:${path}`, notices);
  const chats = useSectionRead<ChatLinksView>(key, `about-chat-links:${path}`, notices);
  const { begin: beginLinks, cancel: cancelLinks } = links;
  const { begin: beginChats, cancel: cancelChats } = chats;
  // What each list holds, for a read that keeps or extends it: the newest
  // answer, set as it lands and again as it renders. Show more pressed or
  // seen after a page lands, but before React draws it, reads after that
  // page, never after the one its own render held.
  const shownLinks = useRef<ReadyLinks | null>(null);
  shownLinks.current = links.view.status === "ready" ? links.view : null;
  const shownChats = useRef<ReadyChatLinks | null>(null);
  shownChats.current = chats.view.status === "ready" ? chats.view : null;
  const linksGuard = useRef<ReadGuard>({ ...NO_READ });
  const chatsGuard = useRef<ReadGuard>({ ...NO_READ });

  // A read from the start, until it holds as many rows as `again` showed, or
  // the page after `after`. A read that fails keeps the rows it would replace.
  const loadLinks = useCallback(async (from: { after?: ReadyLinks; again?: ReadyLinks }) => {
    const request = beginLinks();
    linksGuard.current.reading = from.after ? "more" : "start";
    const kept = from.after ?? from.again;
    let rows = from.after?.rows ?? [];
    let cursor = from.after?.next ?? undefined;
    let building = false;
    let landed: ReadyLinks | null = null;
    try {
      do {
        const page = await bridge().linksIn({ workspaceId, subject: { path }, ...(cursor ? { cursor } : {}) });
        if (!request.current()) return;
        rows = rows.concat(page?.entries ?? []);
        building ||= page?.indexBuilding ?? false;
        cursor = page?.nextCursor ?? undefined;
      } while (cursor && rows.length < (from.again?.rows.length ?? 0));
      landed = {
        status: "ready",
        rows,
        next: cursor ?? null,
        // Rows read while the index built are read again, even when the
        // index finished before the page after them.
        gathering: building ? (kept?.gathering ?? 0) + 1 : (from.after?.gathering ?? 0),
      };
      shownLinks.current = landed;
      request.settle(landed);
    } catch (error) {
      if (!request.current()) return;
      if (isWorkspaceUpdatingError(error)) {
        shownLinks.current = gatheringOn(kept);
        request.settle(shownLinks.current);
      } else {
        const view = failedOver(kept);
        shownLinks.current = view.status === "ready" ? view : null;
        request.fail(view, ipcErrorMessage(error, LINKS_FAILED), error,
          () => void loadLinks({ again: shownLinks.current ?? undefined }));
      }
    } finally {
      if (request.current() && readEnds(linksGuard.current, landed !== null) && landed?.next) void loadLinks({ after: landed });
    }
  }, [beginLinks, path, workspaceId]);

  const loadChats = useCallback(async (from: { after?: ReadyChatLinks; again?: ReadyChatLinks; restarted?: boolean }) => {
    const request = beginChats();
    chatsGuard.current.reading = from.after ? "more" : "start";
    // A row repeated across pages shows once.
    const rows = new Map((from.after?.rows ?? []).map((row) => [row.attachment.attachmentId, row]));
    let cursor = from.after?.next ?? undefined;
    let landed: ReadyChatLinks | null = null;
    try {
      do {
        const page = await bridge().chatFileMentionsPage({ workspaceId, subject: { path }, ...(cursor ? { cursor } : {}) });
        if (!request.current()) return;
        for (const row of page?.entries ?? []) rows.set(row.attachment.attachmentId, row);
        cursor = page?.nextCursor ?? undefined;
      } while (cursor && rows.size < (from.again?.rows.length ?? 0));
      landed = { status: "ready", rows: [...rows.values()], next: cursor ?? null, gathering: 0 };
      shownChats.current = landed;
      request.settle(landed);
    } catch (error) {
      if (!request.current()) return;
      // A cursor that lost the access or version its rows were read under
      // takes those rows with it, and the list reads once from the start.
      if (isChatMentionPageChanged(error) && !from.restarted) {
        shownChats.current = null;
        request.settle(LOADING);
        void loadChats({ restarted: true });
        return;
      }
      const kept = from.after ?? from.again;
      if (isWorkspaceUpdatingError(error)) {
        shownChats.current = gatheringOn(kept);
        request.settle(shownChats.current);
      } else {
        const view = failedOver(kept);
        shownChats.current = view.status === "ready" ? view : null;
        request.fail(view, ipcErrorMessage(error, CHAT_LINKS_FAILED), error,
          () => void loadChats({ again: shownChats.current ?? undefined }));
      }
    } finally {
      if (request.current() && readEnds(chatsGuard.current, landed !== null) && landed?.next) void loadChats({ after: landed });
    }
  }, [beginChats, path, workspaceId]);

  // Coming back to the window reads again: an edit in another app may have
  // added or removed a link.
  const [returns, setReturns] = useState(0);
  useEffect(() => {
    if (!reads) return;
    const onFocus = () => setReturns((count) => count + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reads]);

  // Another file, or the section closing, ends every read and what waited on
  // one. Declared before the reads, so it ends them before the next begins.
  useEffect(() => () => {
    linksGuard.current = { ...NO_READ };
    chatsGuard.current = { ...NO_READ };
  }, [key, reads]);

  useEffect(() => {
    if (!reads) return;
    void loadLinks({ again: shownLinks.current ?? undefined });
    return cancelLinks;
  }, [cancelLinks, loadLinks, reads, returns, revision]);

  useEffect(() => {
    if (!readsChats) return;
    void loadChats({ again: shownChats.current ?? undefined });
    return cancelChats;
  }, [cancelChats, loadChats, readsChats, returns, revision]);

  const linksView = links.view;
  useEffect(() => {
    if (!reads || linksView.status !== "ready" || linksView.gathering === 0) return;
    const timer = setTimeout(() => void loadLinks({ again: linksView }), gatherDelay(linksView.gathering));
    return () => clearTimeout(timer);
  }, [linksView, loadLinks, reads]);
  const chatsView = chats.view;
  useEffect(() => {
    if (!readsChats || chatsView.status !== "ready" || chatsView.gathering === 0) return;
    const timer = setTimeout(() => void loadChats({ again: chatsView }), gatherDelay(chatsView.gathering));
    return () => clearTimeout(timer);
  }, [chatsView, loadChats, readsChats]);

  // As Search keeps focus in its own panel after a jump, a link that opens
  // another file keeps it in About: on this section's head, which stays as
  // About turns to that file, where the row pressed goes.
  const toggleRef = useRef<HTMLButtonElement>(null);
  const { onOpenLink } = props;
  const openLink = useCallback((source: string, line: number) => {
    const toggle = toggleRef.current;
    if (source !== path && toggle?.closest("section")?.contains(document.activeElement)) toggle.focus();
    onOpenLink(source, line);
  }, [onOpenLink, path]);

  return (
    <AboutLinksView
      links={shared ? null : linksView}
      chats={shared || props.onOpenChat === undefined ? null : chatsView}
      expanded={props.expanded}
      onToggle={props.onToggle}
      toggleRef={toggleRef}
      onOpenLink={openLink}
      onOpenChat={props.onOpenChat ?? OPENS_NO_CHAT}
      onMoreLinks={(seen) => {
        const shown = shownLinks.current;
        if (shown?.next && asksMore(linksGuard.current, seen)) void loadLinks({ after: shown });
      }}
      onMoreChats={(seen) => {
        const shown = shownChats.current;
        if (shown?.next && asksMore(chatsGuard.current, seen)) void loadChats({ after: shown });
      }}
      onRetryLinks={() => void loadLinks({})}
      onRetryChats={() => void loadChats({})}
    />
  );
}

// About for a file where this workspace's chats cannot be read: its links,
// which the engine's own index answers, then why the rest is missing.
export function AboutFileChatsOff(props: {
  workspaceId: string;
  path: string;
  revision: number;
  onOpenLink: (path: string, line: number) => void;
  notices: AboutNotices;
  words: string;
}) {
  const [linksOpen, setLinksOpen] = useState(true);
  return (
    <div data-testid="about-panel" className="flex min-h-0 flex-1 flex-col">
      <AboutHeader subject={{ path: props.path }} />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-2">
        <AboutLinks
          workspaceId={props.workspaceId}
          path={props.path}
          revision={props.revision}
          expanded={linksOpen}
          onToggle={() => setLinksOpen((open) => !open)}
          onOpenLink={props.onOpenLink}
          notices={props.notices}
        />
        <p data-testid="about-rail-off" className="m-0 px-4 py-6 text-center text-sm text-muted">
          {props.words}
        </p>
      </div>
    </div>
  );
}

function linksCount(links: ReadyLinks, chats: ReadyChatLinks | null): string {
  const more = links.next !== null || links.gathering > 0 || (chats !== null && (chats.next !== null || chats.gathering > 0));
  return `${links.rows.length + (chats?.rows.length ?? 0)}${more ? "+" : ""}`;
}

// The line around a link, with the link's own words marked. Main clamps the
// range; this guards a range that drifted anyway, so it never throws.
function LinkSnippet(props: { link: LinkEntry }) {
  const { snippet } = props.link;
  const start = Math.max(0, Math.min(props.link.highlightStart, snippet.length));
  const end = Math.max(start, Math.min(props.link.highlightEnd, snippet.length));
  return (
    <span className="line-clamp-2 text-[12px] leading-4 [overflow-wrap:anywhere]">
      {snippet.slice(0, start)}
      <mark className="bg-transparent font-medium text-ink">{snippet.slice(start, end)}</mark>
      {snippet.slice(end)}
    </span>
  );
}

// One link into the file: the file it is in, then the line around it. A
// file's next links leave out its chip, so they read as one group, and say
// the file only to a screen reader.
function LinkRow(props: { link: LinkEntry; first: boolean; onOpen: () => void }) {
  const { link } = props;
  return (
    <button
      type="button"
      data-testid="about-link"
      data-path={link.source}
      data-line={link.line}
      onClick={props.onOpen}
      className={`${ABOUT_ROW_BUTTON} py-1`}
    >
      <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
        {props.first ? (
          <Ref path={link.source} title={link.title} folder />
        ) : (
          <span className="sr-only">{`${link.title} ${link.source}`}</span>
        )}
        <LinkSnippet link={link} />
      </span>
    </button>
  );
}

// The rows render again only when a read lands, not on every render of the
// panel around them, so a long list costs nothing while someone types there.
// A row out of the rail's view skips layout and paint until it scrolls in;
// its focus ring and hover fill sit inside it, so nothing is clipped.
export const OFFSCREEN_ROW = "[content-visibility:auto] [contain-intrinsic-size:auto_48px]";

// What makes a row the same row from one page to the next.
const linkKey = (link: LinkEntry) => `${link.source}\0${link.ordinal}`;
const chatLinkKey = (mention: ChatFileMentionRecord) => mention.attachment.attachmentId;

const LinkList = memo(function LinkList(props: { rows: LinkEntry[]; onOpenLink: (path: string, line: number) => void }) {
  return (
    <ul data-testid="about-links-list" className="m-0 list-none p-0">
      {props.rows.map((link, index) => {
        const first = index === 0 || props.rows[index - 1]!.source !== link.source;
        return (
          <li key={linkKey(link)} className={`${OFFSCREEN_ROW} ${first && index > 0 ? "mt-1.5" : ""}`}>
            <LinkRow link={link} first={first} onOpen={() => props.onOpenLink(link.source, link.line)} />
          </li>
        );
      })}
    </ul>
  );
});

const ChatLinkList = memo(function ChatLinkList(props: {
  rows: ChatFileMentionRecord[];
  onOpenChat: (mention: ChatFileMentionRecord) => void;
}) {
  return (
    <ul data-testid="chat-file-mentions" className="m-0 list-none p-0">
      {props.rows.map((mention) => (
        <li key={chatLinkKey(mention)} className={OFFSCREEN_ROW}>
          <ChatLinkRow mention={mention} onOpen={() => props.onOpenChat(mention)} />
        </li>
      ))}
    </ul>
  );
});

// A chat message that links to the file: where it was said and when, then
// who said it and what. The record names no author kind, so no avatar
// guesses one.
function ChatLinkRow(props: { mention: ChatFileMentionRecord; onOpen: () => void }) {
  const { mention } = props;
  const when = formatChatTime(mention.message.createdAtMs);
  return (
    <button
      type="button"
      data-testid="chat-file-mention"
      data-thread-id={mention.thread.id}
      onClick={props.onOpen}
      className={`${ABOUT_ROW_BUTTON} py-1`}
    >
      <span className={`${MARK_BOX} self-start text-subtle`}>
        <ObjectGlyph kind={mention.channelKind === "channel" ? "group" : "chat"} size={14} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate">{mention.channelName ?? mention.thread.title}</span>
          <time dateTime={when.iso} title={when.label} className="shrink-0 text-[11px] tabular-nums text-subtle">
            {formatShortTime(mention.message.createdAtMs)}
          </time>
        </span>
        <span className="line-clamp-2 text-[12px] leading-4 [overflow-wrap:anywhere]">
          <span className="font-medium">{mention.message.authorDisplayName}</span> {mention.message.preview}
        </span>
      </span>
    </button>
  );
}

// Show more pressed with focus on it hands focus to the first row the page
// adds, so a keyboard reader goes on from there, and keeps a place when the
// last page takes Show more away. Only while focus is still on Show more, or
// was lost with it: a person who moved on keeps their place.
export function useFocusAddedRow<Row>(
  rows: readonly Row[] | null,
  keyOf: (row: Row) => string,
  toggle: RefObject<HTMLButtonElement | null>,
  selector: string,
) {
  const pressedFrom = useRef<Element | null | undefined>(undefined);
  const shown = useRef(rows);
  useEffect(() => {
    const before = shown.current;
    shown.current = rows;
    const from = pressedFrom.current;
    if (from === undefined) return;
    if (rows === null) {
      pressedFrom.current = undefined;
      return;
    }
    // A page adds rows after the ones shown, the same rows by key, though a
    // row the page repeats is a new record. A read from the start that lands
    // first replaces them instead, and the press waits on its page.
    const added = before !== null && rows.length > before.length &&
      before.every((row, index) => keyOf(rows[index]!) === keyOf(row));
    if (!added) return;
    pressedFrom.current = undefined;
    const section = toggle.current?.closest("section");
    const active = document.activeElement;
    const lost = active === null || active === document.body || (section != null && active.contains(section));
    if (active === from || lost) section?.querySelectorAll<HTMLElement>(selector)[before.length]?.focus();
  }, [keyOf, rows, selector, toggle]);
  return useCallback(() => {
    pressedFrom.current = document.activeElement;
  }, []);
}

// The Links section for answers already in hand. The states page draws it.
export function AboutLinksView(props: {
  // Null for a file under shared-with-me/, whose links dohc does not list yet.
  links: LinksView | null;
  // Null where this workspace's chats are not read.
  chats: ChatLinksView | null;
  expanded: boolean;
  onToggle: () => void;
  toggleRef?: RefObject<HTMLButtonElement | null>;
  onOpenLink: (path: string, line: number) => void;
  onOpenChat: (mention: ChatFileMentionRecord) => void;
  // The page after the newest answer the owner holds, which may be newer than
  // the one drawn here. `seen` when a Show more row came into view rather
  // than being pressed.
  onMoreLinks: (seen?: boolean) => void;
  onMoreChats: (seen?: boolean) => void;
  onRetryLinks: () => void;
  onRetryChats: () => void;
}) {
  const { links, chats } = props;
  const linkRows = links?.status === "ready" ? links : null;
  const chatRows = chats?.status === "ready" ? chats : null;
  const count = linkRows !== null && (chats === null || chatRows !== null) ? linksCount(linkRows, chatRows) : undefined;
  const ownToggle = useRef<HTMLButtonElement>(null);
  const toggleRef = props.toggleRef ?? ownToggle;
  const focusAddedLink = useFocusAddedRow(linkRows?.rows ?? null, linkKey, toggleRef, '[data-testid="about-link"]');
  const focusAddedChat = useFocusAddedRow(chatRows?.rows ?? null, chatLinkKey, toggleRef, '[data-testid="chat-file-mention"]');
  return (
    <AboutSection id="links" icon={Link} label="Links" count={count} expanded={props.expanded} onToggle={props.onToggle}
      toggleRef={toggleRef}>
      {links === null ? (
        <AboutNote testId="about-links-shared" icon={Link2Off}>
          dohc does not list links into files shared with you yet.
        </AboutNote>
      ) : links.status === "loading" ? (
        <SkeletonLines rows={2} className="px-2 py-1" />
      ) : links.status === "failed" ? (
        <RetryRow testId="about-links-failed" onRetry={props.onRetryLinks} />
      ) : (
        <>
          {links.gathering > 0 || (chatRows?.gathering ?? 0) > 0 ? <AboutGathering testId="about-links-gathering" /> : null}
          {links.rows.length > 0 ? <LinkList rows={links.rows} onOpenLink={props.onOpenLink} /> : null}
          {links.next !== null ? (
            <AboutMore testId="about-links-more" watch={links.rows}
              onMore={(focused) => {
                if (focused) focusAddedLink();
                props.onMoreLinks();
              }}
              onSeen={() => props.onMoreLinks(true)} />
          ) : null}
        </>
      )}
      {chats === null ? null : chats.status === "loading" ? (
        // Below rows already shown, chats that link here arrive without a
        // placeholder. With none shown, the section is still loading.
        linkRows !== null && linksCount(linkRows, null) === "0" ? (
          <SkeletonLines rows={1} className="px-2 py-1" />
        ) : null
      ) : chats.status === "failed" ? (
        <RetryRow testId="about-chat-links-failed" onRetry={props.onRetryChats} />
      ) : (
        <>
          {chats.rows.length > 0 ? <ChatLinkList rows={chats.rows} onOpenChat={props.onOpenChat} /> : null}
          {chats.next !== null ? (
            <AboutMore testId="about-chat-links-more" watch={chats.rows}
              onMore={(focused) => {
                if (focused) focusAddedChat();
                props.onMoreChats();
              }}
              onSeen={() => props.onMoreChats(true)} />
          ) : null}
        </>
      )}
      {count === "0" ? (
        <AboutNote testId="about-links-empty">
          No links to this file yet. Type{" "}
          <kbd className="rounded border border-line bg-bg px-1 font-mono text-[11px] text-muted">[[</kbd> in another file
          to add one.
        </AboutNote>
      ) : null}
    </AboutSection>
  );
}

// ---- History ----

// The file History asks about. Its object id comes from the file's chats
// read: loading until that answers, updating while the engine still reads the
// workspace's files in, null for a file the engine does not track, and a
// failed read offers that read's Try again.
export type AboutFile =
  | typeof LOADING
  | { status: "updating" }
  | { status: "failed"; retry: () => void }
  | { status: "ready"; objectId: string | null };

// `held` is History holding the file's changes back because its rules can't
// be read, a state of the surface drawn in place (HistoryPolicyStates.tsx).
// `updating` is History still taking in recent changes, read again soon at
// first. Nothing failed in either, so neither files a row.
export type HistoryView =
  | typeof LOADING
  | { status: "ready"; moments: EngineMomentRecord[]; more: boolean }
  | { status: "untracked" }
  | { status: "updating" }
  | { status: "held"; words: string; retry: () => void }
  | { status: "failed"; retry: () => void };

const HISTORY_ROWS = 5;

// A change with no one author, or several, keeps the file mark here.
const FILE_MARK = (
  <span aria-hidden className={`${MARK_BOX} text-subtle`}>
    <FileText size={14} />
  </span>
);

export function AboutHistory(props: {
  workspaceId: string;
  path: string;
  file: AboutFile;
  // Changes when the workspace's history grows, so the rows follow edits.
  revision: number;
  // History stopped recording, so its answers may be missing changes.
  paused: boolean;
  expanded: boolean;
  onToggle: () => void;
  onOpenMoment: (momentId: string, filePath: string) => void;
  notices: AboutNotices;
}) {
  const { workspaceId, file } = props;
  const objectId = file.status === "ready" ? file.objectId : null;
  const read = useSectionRead<HistoryView>(
    `${workspaceId}\0${props.path}\0${objectId ?? ""}`,
    `about-history:${props.path}`,
    props.notices,
  );
  const { begin, cancel } = read;
  // History can finish taking in changes without adding one, so no newer
  // revision is sure to come: an updating answer schedules the next read.
  // Any read that starts first replaces it.
  const nextRead = useRef<ReturnType<typeof setTimeout>>(undefined);
  const load = useCallback(async (updatingReads = 0) => {
    if (objectId === null) return;
    clearTimeout(nextRead.current);
    const request = begin();
    const failed = { status: "failed", retry: () => void load() } as const;
    try {
      const response = await bridge().listEngineMoments({ workspaceId, objectId, limit: HISTORY_ROWS });
      if (!("status" in response)) {
        request.settle({ status: "ready", moments: response.moments, more: response.nextCursor !== null });
        return;
      }
      if (response.status === "updating") {
        if (!request.current()) return;
        request.settle({ status: "updating" });
        nextRead.current = setTimeout(() => void load(updatingReads + 1), gatherDelay(updatingReads + 1));
        return;
      }
      request.settle({ status: "held", words: historyHiddenWords(response.unreadable), retry: failed.retry });
    } catch (error) {
      request.fail(failed, ipcErrorMessage(error, "Could not load History for this file."), error, failed.retry);
    }
  }, [begin, objectId, workspaceId]);
  useEffect(() => {
    if (!props.expanded || objectId === null) return;
    void load();
    return () => {
      cancel();
      clearTimeout(nextRead.current);
    };
  }, [cancel, load, objectId, props.expanded, props.revision]);

  const view: HistoryView =
    file.status === "loading" || file.status === "updating" ? file
    : file.status === "failed" ? { status: "failed", retry: file.retry }
    : file.objectId === null ? { status: "untracked" }
    : read.view;
  return (
    <AboutHistoryView view={view} paused={props.paused} expanded={props.expanded} onToggle={props.onToggle} onOpenMoment={props.onOpenMoment} />
  );
}

// The History section for an answer already in hand. The states page draws it.
export function AboutHistoryView(props: {
  view: HistoryView;
  // History stopped recording: the line replaces taking in changes and heads
  // any rows, which may be missing changes.
  paused?: boolean;
  expanded: boolean;
  onToggle: () => void;
  onOpenMoment: (momentId: string, filePath: string) => void;
}) {
  const { view } = props;
  // Its words start where a row's name does.
  const paused = props.paused ? <HistoryPaused testId="about-history-paused" className="px-2 py-1" /> : null;
  return (
    <AboutSection
      id="history"
      icon={History}
      label="History"
      count={view.status === "ready" ? `${view.moments.length}${view.more ? "+" : ""}` : undefined}
      expanded={props.expanded}
      onToggle={props.onToggle}
    >
      {view.status === "loading" ? (
        <SkeletonLines rows={2} className="px-2 py-1" />
      ) : view.status === "failed" ? (
        <RetryRow testId="about-history-failed" onRetry={view.retry} />
      ) : view.status === "untracked" ? (
        <AboutNote testId="about-history-untracked">History does not track this file yet.</AboutNote>
      ) : view.status === "updating" ? (
        paused ?? <HistoryUpdating testId="about-history-updating" className="px-2 py-1" />
      ) : view.status === "held" ? (
        // The words end in "try again", so the control they name is here.
        <AboutNote testId="about-history-held" icon={EyeOff} action={{ label: "Try again", run: view.retry }}>
          {view.words}
        </AboutNote>
      ) : view.moments.length === 0 ? (
        paused ?? <AboutNote testId="about-history-empty">History has no changes to this file yet.</AboutNote>
      ) : (
        <ul className="m-0 list-none p-0">
          {paused ? <li>{paused}</li> : null}
          {view.moments.map((moment) => {
            const when = formatChatTime(moment.recordedAtMs);
            const source = engineMomentSourceLabel(moment);
            return (
              <li key={moment.id}>
                <button
                  type="button"
                  data-testid="about-history-open"
                  data-moment-id={moment.id}
                  title={source}
                  onClick={() => props.onOpenMoment(moment.id, moment.path)}
                  className={`${ABOUT_ROW_BUTTON} h-7`}
                >
                  <MomentAuthor moment={moment} fallback={FILE_MARK} />
                  <span className="min-w-0 flex-1 truncate">{engineMomentSummary(moment)}</span>
                  <span className="sr-only">{source}</span>
                  <time dateTime={when.iso} title={when.label} className="shrink-0 text-[11px] tabular-nums text-subtle">
                    {formatShortTime(moment.recordedAtMs)}
                  </time>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </AboutSection>
  );
}

// ---- Access ----

export type AccessView =
  | typeof LOADING
  | { status: "ready"; answer: AccessAnswer }
  | { status: "failed" };

type AccessRow = AccessAnswer["rows"][number];
type ShareLevel = NonNullable<Extract<AccessRow, { kind: "share" }>["access"]>;

// The level a share grants, in the words the share lists use.
export const LEVELS: Record<ShareLevel, { icon: LucideIcon; label: string }> = {
  view: { icon: Eye, label: "View" },
  "read-only": { icon: Eye, label: "View" },
  comment: { icon: MessageSquare, label: "Comment" },
  edit: { icon: Pencil, label: "Edit" },
  "read-write": { icon: Pencil, label: "Edit" },
};

// What Access is about, in the words its notes use.
export type AccessNoun = "file" | "chat";

// What an empty list means, within what it covers. Never "no access": an
// answer with no coverage is unknown, not empty.
const EMPTY_WITHIN: Record<Exclude<AccessAnswer["coverage"]["kind"], "unavailable">, (noun: AccessNoun) => string> = {
  granted: (noun) => `No share from this workspace includes this ${noun}.`,
  "received-own-grant": (noun) => `No grant to you includes this ${noun}.`,
  "received-account": (noun) => `No share to you includes this ${noun}.`,
  collection: () => "No app or person has permissions on this Collection.",
};

function emptyWithin(answer: AccessAnswer, noun: AccessNoun): string | null {
  const kind = answer.coverage.kind;
  return answer.freshness === "unknown" || kind === "unavailable" ? null : EMPTY_WITHIN[kind](noun);
}

// The count is who has access now: ended and damaged grants stay listed, but
// do not count.
function grantedCount(answer: AccessAnswer): string {
  const active = answer.rows.filter((row) => row.kind === "collection" || row.status === "active").length;
  return `${active}${answer.nextCursor ? "+" : ""}`;
}

function AccessRowView(props: { row: AccessRow }) {
  const { row } = props;
  if (row.kind === "collection") {
    return (
      <div className={`${ABOUT_ROW} h-7`}>
        {row.appId === null ? (
          <ChatAvatar presentation={neutralPresentation} name={row.principal} kind="human" size="strip" />
        ) : (
          <span className={`${MARK_BOX} text-subtle`}>
            <ObjectGlyph kind="app" size={14} />
          </span>
        )}
        <span className="min-w-0 flex-1 truncate">{row.principal}</span>
      </div>
    );
  }
  const who =
    row.via === "link"
      ? "Anyone with the link"
      : row.via === "received"
        ? "You"
        : (row.recipientEmail ?? row.recipientUserId ?? "Unnamed person");
  const level = row.access === null ? null : LEVELS[row.access];
  const sharer = row.via === "received" ? (row.sharerName ?? row.granterEmail) : null;
  return (
    <div
      data-testid="about-access-row"
      data-via={row.via}
      data-status={row.status}
      title={sharer ? `Shared by ${sharer}` : undefined}
      className={`${ABOUT_ROW} h-7`}
    >
      {row.via === "link" ? (
        <LinkMark />
      ) : (
        <ChatAvatar presentation={row.via === "received" ? ownPresentation : neutralPresentation} name={who} kind="human" size="strip" />
      )}
      <span className="min-w-0 flex-1 truncate">{who}</span>
      {row.status !== "active" ? (
        <span className="shrink-0 text-[11px] text-subtle">
          {row.status === "damaged" ? "damaged" : "ended"}
        </span>
      ) : level ? (
        <span role="img" aria-label={level.label} title={level.label} className="shrink-0 text-subtle">
          <level.icon size={13} aria-hidden />
        </span>
      ) : null}
    </div>
  );
}

// What Access asks about: a file by its path, or a chat by its wire identity.
export type AccessSubject = { kind: "path"; path: string } | { kind: "chat"; channelWireId: string };

export function AboutAccess(props: {
  workspaceId: string;
  subject: AccessSubject;
  // For a chat: whether this workspace reads it through someone else's
  // share. Null until the Chats page knows, which explains nothing.
  received?: boolean | null;
  expanded: boolean;
  onToggle: () => void;
  notices: AboutNotices;
  context: AccessContext;
}) {
  const { workspaceId, subject } = props;
  const { facts, openSyncSettings, connect } = props.context;
  const noun = subject.kind === "path" ? "file" : "chat";
  const reason: AccessReason =
    subject.kind === "path" ? accessReasonFor(facts, subject.path)
    : props.received == null ? "unexplained"
    : accessReasonForLane(facts, props.received ? "received" : "granted");
  // The key names the subject in full, kind first so a path never reads as a
  // wire id, and a read keyed on it asks about the ref it was built from.
  const subjectKey = subject.kind === "path" ? `file:${subject.path}` : `chat:${subject.channelWireId}`;
  const ref: AccessObjectRef = subject.kind === "path"
    ? { kind: "path", path: subject.path, versionId: null }
    : { kind: "chat", channelWireId: subject.channelWireId };
  // The server connection the last refresh was asked under. A new one, such
  // as a Connect server that signed in, refreshes and reads again. A session
  // change reads the status twice, passing through "checking" each time, so
  // only a connection that was read counts.
  const connection = typeof facts.cloud === "string" ? facts.cloud
    : `${facts.cloud.connected}:${facts.cloud.workspaceSynced}:${facts.cloud.workspaceSyncConnected}`;
  const read = useSectionRead<AccessView>(`${workspaceId}\0${subjectKey}`, `about-access:${subjectKey}`, props.notices);
  const { begin, cancel } = read;
  // One read: from the start, or the page after `after`. Asking main to
  // check again happens when a person opens the section or tries again, not
  // on every file they pass through with it open. Its outcome is the
  // answer's own freshness, so a refused refresh is not reported apart.
  const load = useCallback(
    async (options: { refresh?: boolean; after?: AccessAnswer }) => {
      const request = begin();
      const retry = () => void load({ refresh: true });
      try {
        if (options.refresh) {
          await bridge().requestAccessRefresh({ workspaceId, reason: "access-expand" }).catch(() => undefined);
          if (!request.current()) return;
        }
        const cursor = options.after?.nextCursor ?? undefined;
        const answer = await bridge().getObjectAccess({
          workspaceId,
          ref,
          ...(cursor ? { cursor } : {}),
        });
        // A page cursor belongs to the listing it came from. When that
        // listing changed, main refuses the cursor, so read from the start.
        if (options.after && answer.coverage.kind === "unavailable") {
          if (request.current()) void load({});
          return;
        }
        request.settle({
          status: "ready",
          answer: options.after ? { ...answer, rows: [...options.after.rows, ...answer.rows] } : answer,
        });
      } catch (error) {
        request.fail({ status: "failed" }, ipcErrorMessage(error, `Could not check who has access to this ${noun}.`), error, retry);
      }
    },
    // `ref` follows `subjectKey`.
    [begin, noun, subjectKey, workspaceId],
  );
  const refreshedUnder = useRef<string | null>(null);
  useEffect(() => {
    if (!props.expanded) {
      refreshedUnder.current = null;
      return;
    }
    const checking = connection === "checking";
    const refresh = !checking && refreshedUnder.current !== connection;
    if (!checking) refreshedUnder.current = connection;
    void load({ refresh });
    return cancel;
  }, [cancel, connection, load, props.expanded]);

  const setup = useMemo<AccessSetup>(() => ({ reason, openSyncSettings, connect }), [connect, openSyncSettings, reason]);
  return (
    <AboutAccessView
      view={read.view}
      expanded={props.expanded}
      onToggle={props.onToggle}
      onRetry={() => void load({ refresh: true })}
      onMore={(answer) => void load({ after: answer })}
      setup={setup}
      noun={noun}
    />
  );
}

// The freshness of an answer, when main checked it, and for a list, what it covers.
export function AccessChecked(props: { testId: string; answer: AccessAnswer; scope?: string }) {
  const { answer } = props;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-2 pb-1">
      <StateMark testId={props.testId} state={answer.freshness} shown={`access-${answer.freshness}`} className="shrink-0" />
      {answer.checkedAtMs !== null ? (
        <time
          dateTime={formatChatTime(answer.checkedAtMs).iso}
          title={formatChatTime(answer.checkedAtMs).label}
          className="shrink-0 text-[11px] tabular-nums text-subtle"
        >
          {formatShortTime(answer.checkedAtMs)}
        </time>
      ) : null}
      {props.scope ? (
        <span data-testid={`${props.testId}-scope`} className="whitespace-nowrap text-[11px] text-subtle">
          {props.scope}
        </span>
      ) : null}
    </div>
  );
}

const unexplainedFor = (noun: AccessNoun) =>
  `Access information is unavailable for this ${noun}. This does not mean that no one has access.`;
export const SIGNED_OUT_ACCESS = "Connect your server to check who has access.";
const MISSING: Record<AccessNoun, string> = {
  file: "This file is no longer available at this path.",
  chat: "This chat is no longer in this workspace.",
};

// Why an answer covers nothing, in the words and the one action that can
// change it. Only a cause dohc cannot name offers Try again. `testId` names
// the surface; `unexplained` is what an answer dohc cannot explain means
// there, and `signedOut` what connecting would show there.
export function AccessUnknown(props: {
  testId: string;
  unexplained: string;
  signedOut: string;
  answer: AccessAnswer;
  setup: AccessSetup;
  onRetry: () => void;
  noun?: AccessNoun;
}) {
  const { answer, setup, testId } = props;
  if (answer.visibility === "hidden") {
    return <AboutNote testId={`${testId}-unknown`} reason="hidden" icon={EyeOff}>Shares do not include this {props.noun ?? "file"}.</AboutNote>;
  }
  if (answer.visibility === "missing") {
    return (
      <AboutNote testId={`${testId}-unknown`} reason="missing" icon={FileX}>
        {MISSING[props.noun ?? "file"]}
      </AboutNote>
    );
  }
  switch (setup.reason) {
    // Nothing explains the answer until the server connection is read, so
    // nothing is claimed: it reads as still loading.
    case "checking":
      return <SkeletonLines rows={2} className="px-2 py-1" />;
    case "not-synced":
      return (
        <AboutNote testId={`${testId}-unknown`} reason="not-synced" icon={CloudOff}
          action={{ label: "Sync and sharing", run: setup.openSyncSettings }}>
          Shares need sync, and this workspace does not sync.
        </AboutNote>
      );
    case "signed-out":
      return (
        <AboutNote testId={`${testId}-unknown`} reason="signed-out" icon={LogIn}
          action={{ label: "Connect server", run: setup.connect }}>
          {props.signedOut}
        </AboutNote>
      );
    // Settings' Sync and sharing says the same, and holds what resumes it.
    case "other-account":
      return (
        <AboutNote testId={`${testId}-unknown`} reason="other-account" icon={CloudOff}
          action={{ label: "Sync and sharing", run: setup.openSyncSettings }}>
          {SYNC_UNCONFIRMED_ACCOUNT} Resume sync to check who has access.
        </AboutNote>
      );
    case "unexplained":
      return (
        <>
          <div className="px-2 pb-1">
            <StateMark testId={`${testId}-freshness`} state={answer.freshness} shown="access-unknown" title={props.unexplained} />
          </div>
          <AboutNote testId={`${testId}-unknown`} reason="unexplained" action={{ label: "Try again", run: props.onRetry }}>
            {props.unexplained}
          </AboutNote>
        </>
      );
  }
}

// The Access section for an answer already in hand. The states page draws it.
export function AboutAccessView(props: {
  view: AccessView;
  expanded: boolean;
  onToggle: () => void;
  onRetry: () => void;
  onMore: (answer: AccessAnswer) => void;
  setup: AccessSetup;
  noun?: AccessNoun;
}) {
  const { view } = props;
  const noun = props.noun ?? "file";
  const empty = view.status === "ready" ? emptyWithin(view.answer, noun) : null;
  return (
    <AboutSection
      id="access"
      icon={Share2}
      label="Access"
      count={view.status === "ready" && empty !== null ? grantedCount(view.answer) : undefined}
      expanded={props.expanded}
      onToggle={props.onToggle}
    >
      {view.status === "loading" ? (
        <SkeletonLines rows={2} className="px-2 py-1" />
      ) : view.status === "failed" ? (
        <RetryRow testId="about-access-failed" onRetry={props.onRetry} />
      ) : (
        <div
          data-testid="about-access-answer"
          data-freshness={view.answer.freshness}
          data-coverage={view.answer.coverage.kind}
          data-visibility={view.answer.visibility}
        >
          {empty === null ? (
            <AccessUnknown testId="about-access" unexplained={unexplainedFor(noun)} signedOut={SIGNED_OUT_ACCESS} noun={noun}
              answer={view.answer} setup={props.setup} onRetry={props.onRetry} />
          ) : (
            <>
              <AccessChecked testId="about-access-freshness" answer={view.answer} />
              {view.answer.rows.length === 0 ? (
                <AboutNote testId="about-access-empty">{empty}</AboutNote>
              ) : (
                <>
                  <ul className="m-0 list-none p-0">
                    {view.answer.rows.map((row) => (
                      <li key={row.kind === "share" ? `${row.shareId}\0${row.grantId}\0${row.via}` : row.principal}>
                        <AccessRowView row={row} />
                      </li>
                    ))}
                  </ul>
                  {view.answer.nextCursor !== null ? (
                    <AboutMore testId="about-access-more" onMore={() => props.onMore(view.answer)} />
                  ) : null}
                </>
              )}
            </>
          )}
        </div>
      )}
    </AboutSection>
  );
}
