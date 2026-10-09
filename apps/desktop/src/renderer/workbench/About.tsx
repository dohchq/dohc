import type { AccessAnswer } from "@dohc/workspace-contracts/access";
import { fileKindForPath } from "@dohc/workspace-contracts/kinds";
import { isSharedWithMePath } from "@dohc/workspace-core/paths";
import {
  AppWindow,
  ChevronDown,
  ChevronRight,
  CloudOff,
  Eye,
  EyeOff,
  FileText,
  FileX,
  History,
  Link2,
  LogIn,
  MessageSquare,
  Pencil,
  Share2,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { ChatThreadRecord, EngineMomentRecord } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import { basenameOf } from "../path";
import { formatChatTime, formatShortTime } from "../time";
import { SecondaryButton } from "../ui/controls";
import { KindGlyph } from "../ui/KindGlyph";
import { SkeletonLines } from "../ui/SkeletonRows";
import { StateMark } from "../ui/StateMark";
import { ChatAvatar } from "./ChatAvatar";
import { engineMomentSourceLabel, engineMomentSummary } from "./EngineHistory";
import { historyHiddenWords } from "./HistoryPolicyStates";

// The About tab: everything about the open file, one section each. A section
// shows only what its own query answers, and every answer is held to the
// workspace and file it was asked for, so a slow answer for one file never
// lands under another.

export type AboutSectionId = "chats" | "history" | "access";

// The shell's error hook. A section read that fails is one Notices row per
// section and file, with Try again. A read that succeeds clears it, and so
// does the file leaving About. The section itself shows no error words, only
// the way to read again. An unchanged failure keeps an existing row's toast
// state. A changed message, or a missing row, toasts again.
export type AboutNotices = {
  report(failure: { identity: string; message: string; cause?: unknown; retry: () => void }): void;
  clear(identity: string): void;
};

// What explains an Access answer that covers nothing. `checking` waits for
// the workspace's server connection to be read; it claims nothing.
export type AccessReason = "checking" | "not-synced" | "signed-out" | "other-account" | "unexplained";
export type AccessSetup = {
  reason: AccessReason;
  openSyncSettings: () => void;
  connect: () => void;
};

// What this computer knows about the workspace's server connection, from the
// shell's cloud status: "checking" while it is read, and "unreadable" once
// reading it failed, which the shell reports on its own.
export type AccessFacts = {
  cloud: { connected: boolean; workspaceSynced: boolean; workspaceSyncConnected: boolean } | "checking" | "unreadable";
  shareView: boolean;
};
export type AccessContext = {
  facts: AccessFacts;
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
  const { cloud } = facts;
  if (cloud === "checking") return "checking";
  if (cloud === "unreadable") return "unexplained";
  if (facts.shareView || isSharedWithMePath(path)) return cloud.connected ? "unexplained" : "signed-out";
  if (!cloud.workspaceSynced) return "not-synced";
  if (!cloud.connected) return "signed-out";
  if (!cloud.workspaceSyncConnected) return "other-account";
  return "unexplained";
}

// A row in a section, inset from the panel's edges like the drawing's rows.
export const ABOUT_ROW =
  "flex w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-muted transition-colors duration-75";
export const ABOUT_ROW_BUTTON = `${ABOUT_ROW} cursor-pointer hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent`;

export function AboutHeader(props: { path: string }) {
  return (
    <div
      data-testid="about-header"
      className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3.5 text-[13px]"
    >
      <KindGlyph kind={fileKindForPath(props.path)} size={14} className="text-muted" />
      <span title={props.path} className="min-w-0 truncate font-semibold text-ink">
        {basenameOf(props.path)}
      </span>
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
  children: ReactNode;
}) {
  const bodyId = useId();
  const Icon = props.icon;
  return (
    <section data-testid={`about-${props.id}`} aria-label={props.label}>
      <h3 className="m-0">
        <button
          type="button"
          data-testid={`about-${props.id}-toggle`}
          aria-expanded={props.expanded}
          aria-controls={bodyId}
          onClick={props.onToggle}
          className="dohc-section-label flex w-full cursor-pointer items-center gap-1.5 px-4 pb-1.5 pt-3.5 text-left hover:text-muted focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        >
          <Icon size={12} strokeWidth={1.9} aria-hidden />
          {props.label}
          <span className="ml-auto flex items-center gap-2 font-mono text-[11px] font-normal normal-case tracking-normal">
            {props.count !== undefined ? (
              <span data-testid={`about-${props.id}-count`}>{props.count}</span>
            ) : null}
            {props.expanded ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
          </span>
        </button>
      </h3>
      {props.expanded ? (
        <div id={bodyId} className="px-2 pb-1">
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

// A section whose read failed. Its words are in the toast and its Notices
// row; here the mark says it failed and Try again reads again.
export function AboutRetry(props: { testId: string; onRetry: () => void }) {
  return (
    <div data-testid={props.testId} className="flex items-center gap-2 px-2 py-1">
      <TriangleAlert size={12} aria-hidden className="shrink-0 text-danger" />
      <SecondaryButton size="compact" onClick={props.onRetry}>
        Try again
      </SecondaryButton>
    </div>
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
      <MessageSquare size={14} aria-hidden className="shrink-0 text-subtle" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{props.thread.title}</span>
        <time dateTime={when.iso} className="truncate text-[11px] text-subtle">
          {when.label}
        </time>
      </span>
    </button>
  );
}

// A share link has no face: a dashed ring around the link mark.
function LinkMark() {
  return (
    <span
      aria-hidden
      className="inline-grid size-[18px] shrink-0 place-items-center rounded-full border border-dashed border-subtle text-subtle"
    >
      <Link2 size={10} />
    </span>
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
function useSectionRead<View>(key: string, identity: string, notices: AboutNotices) {
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

// ---- History ----

// The file History asks about. Its object id comes from the file's chats
// read: loading until that answers, null for a file the engine does not
// track, and a failed read offers that read's Try again.
export type AboutFile =
  | typeof LOADING
  | { status: "failed"; retry: () => void }
  | { status: "ready"; objectId: string | null };

// `held` is History holding the file's changes back, a state of the surface
// drawn in place (HistoryPolicyStates.tsx): its rules can't be read, or the
// workspace is still updating. Nothing failed, so it files no row.
export type HistoryView =
  | typeof LOADING
  | { status: "ready"; moments: EngineMomentRecord[]; more: boolean }
  | { status: "untracked" }
  | { status: "held"; words: string; retry: () => void }
  | { status: "failed"; retry: () => void };

const HISTORY_ROWS = 5;
const WORKSPACE_UPDATING_MESSAGE = "Workspace is still updating. Try again.";

function MomentAuthor(props: { moment: EngineMomentRecord }) {
  const { moment } = props;
  if (moment.agentAuthorName !== undefined) {
    return <ChatAvatar name={moment.agentAuthorName} kind="agent" size="strip" />;
  }
  if (moment.automationAuthor) return <ChatAvatar name={moment.automationAuthor.name} kind="automation" size="strip" />;
  if (moment.namedAuthor) return <ChatAvatar name={moment.namedAuthor.label} kind="human" size="strip" />;
  if (moment.personAuthorName !== undefined) {
    return <ChatAvatar name={moment.personAuthorName} kind="human" own size="strip" />;
  }
  if (moment.publicAuthor || moment.linkAuthor) return <LinkMark />;
  return <FileText size={14} aria-hidden className="shrink-0 text-subtle" />;
}

export function AboutHistory(props: {
  workspaceId: string;
  path: string;
  file: AboutFile;
  // Changes when the workspace's history grows, so the rows follow edits.
  revision: number;
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
  const load = useCallback(async () => {
    if (objectId === null) return;
    const request = begin();
    const failed = { status: "failed", retry: () => void load() } as const;
    try {
      const response = await bridge().listEngineMoments({ workspaceId, objectId, limit: HISTORY_ROWS });
      if (!("status" in response)) {
        request.settle({ status: "ready", moments: response.moments, more: response.nextBeforeMomentOrder !== null });
        return;
      }
      request.settle({
        status: "held",
        words: response.status === "updating" ? WORKSPACE_UPDATING_MESSAGE : historyHiddenWords(response.unreadable),
        retry: failed.retry,
      });
    } catch (error) {
      request.fail(failed, ipcErrorMessage(error, "Could not load History for this file."), error, failed.retry);
    }
  }, [begin, objectId, workspaceId]);
  useEffect(() => {
    if (!props.expanded || objectId === null) return;
    void load();
    return cancel;
  }, [cancel, load, objectId, props.expanded, props.revision]);

  const view: HistoryView =
    file.status === "loading" ? LOADING
    : file.status === "failed" ? { status: "failed", retry: file.retry }
    : file.objectId === null ? { status: "untracked" }
    : read.view;
  return <AboutHistoryView view={view} expanded={props.expanded} onToggle={props.onToggle} onOpenMoment={props.onOpenMoment} />;
}

// The History section for an answer already in hand. The states page draws it.
export function AboutHistoryView(props: {
  view: HistoryView;
  expanded: boolean;
  onToggle: () => void;
  onOpenMoment: (momentId: string, filePath: string) => void;
}) {
  const { view } = props;
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
        <AboutRetry testId="about-history-failed" onRetry={view.retry} />
      ) : view.status === "untracked" ? (
        <AboutNote testId="about-history-untracked">History does not track this file yet.</AboutNote>
      ) : view.status === "held" ? (
        // The words end in "try again", so the control they name is here.
        <AboutNote testId="about-history-held" icon={EyeOff} action={{ label: "Try again", run: view.retry }}>
          {view.words}
        </AboutNote>
      ) : view.moments.length === 0 ? (
        <AboutNote testId="about-history-empty">History has no changes to this file yet.</AboutNote>
      ) : (
        <ul className="m-0 list-none p-0">
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
                  <MomentAuthor moment={moment} />
                  <span className="min-w-0 flex-1 truncate">{engineMomentSummary(moment)}</span>
                  <span className="sr-only">{source}</span>
                  <time dateTime={when.iso} title={when.label} className="shrink-0 font-mono text-[11px] text-subtle">
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
const LEVELS: Record<ShareLevel, { icon: LucideIcon; label: string }> = {
  view: { icon: Eye, label: "View" },
  "read-only": { icon: Eye, label: "View" },
  comment: { icon: MessageSquare, label: "Comment" },
  edit: { icon: Pencil, label: "Edit" },
  "read-write": { icon: Pencil, label: "Edit" },
};

// What an empty list means, within what it covers. Never "no access": an
// answer with no coverage is unknown, not empty.
const EMPTY_WITHIN: Record<Exclude<AccessAnswer["coverage"]["kind"], "unavailable">, string> = {
  granted: "No share from this workspace includes this file.",
  "received-own-grant": "No grant to you includes this file.",
  "received-account": "No share to you includes this file.",
  collection: "No app or person has permissions on this Collection.",
};

function emptyWithin(answer: AccessAnswer): string | null {
  const kind = answer.coverage.kind;
  return answer.freshness === "unknown" || kind === "unavailable" ? null : EMPTY_WITHIN[kind];
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
          <ChatAvatar name={row.principal} kind="human" size="strip" />
        ) : (
          <AppWindow size={14} aria-hidden className="shrink-0 text-subtle" />
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
        <ChatAvatar name={who} kind="human" own={row.via === "received"} size="strip" />
      )}
      <span className="min-w-0 flex-1 truncate">{who}</span>
      {row.status !== "active" ? (
        <span className="shrink-0 font-mono text-[11px] text-subtle">
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

export function AboutAccess(props: {
  workspaceId: string;
  path: string;
  expanded: boolean;
  onToggle: () => void;
  notices: AboutNotices;
  context: AccessContext;
}) {
  const { workspaceId, path } = props;
  const { facts, openSyncSettings, connect } = props.context;
  const reason = accessReasonFor(facts, path);
  // The server connection the last refresh was asked under. A new one, such
  // as a Connect server that signed in, refreshes and reads again. A session
  // change reads the status twice, passing through "checking" each time, so
  // only a connection that was read counts.
  const connection = typeof facts.cloud === "string" ? facts.cloud
    : `${facts.cloud.connected}:${facts.cloud.workspaceSynced}:${facts.cloud.workspaceSyncConnected}`;
  const read = useSectionRead<AccessView>(`${workspaceId}\0${path}`, `about-access:${path}`, props.notices);
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
          ref: { kind: "path", path, versionId: null },
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
        request.fail({ status: "failed" }, ipcErrorMessage(error, "Could not check who has access to this file."), error, retry);
      }
    },
    [begin, path, workspaceId],
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
    />
  );
}

// Why an answer covers nothing, in the words and the one action that can
// change it. Only a cause dohc cannot name offers Try again.
function AccessUnknown(props: { answer: AccessAnswer; setup: AccessSetup; onRetry: () => void }) {
  const { answer, setup } = props;
  if (answer.visibility === "hidden") {
    return <AboutNote testId="about-access-unknown" reason="hidden" icon={EyeOff}>Shares do not include this file.</AboutNote>;
  }
  if (answer.visibility === "missing") {
    return (
      <AboutNote testId="about-access-unknown" reason="missing" icon={FileX}>
        This file is no longer available at this path.
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
        <AboutNote testId="about-access-unknown" reason="not-synced" icon={CloudOff}
          action={{ label: "Sync and sharing", run: setup.openSyncSettings }}>
          Shares need sync, and this workspace does not sync.
        </AboutNote>
      );
    case "signed-out":
      return (
        <AboutNote testId="about-access-unknown" reason="signed-out" icon={LogIn}
          action={{ label: "Connect server", run: setup.connect }}>
          Connect your server to check who has access.
        </AboutNote>
      );
    case "other-account":
      return (
        <AboutNote testId="about-access-unknown" reason="other-account" icon={LogIn}
          action={{ label: "Connect server", run: setup.connect }}>
          This workspace syncs with another account. Connect that account to check who has access.
        </AboutNote>
      );
    case "unexplained":
      return (
        <>
          <div className="px-2 pb-1">
            <StateMark testId="about-access-freshness" state={answer.freshness} shown="access-unknown" />
          </div>
          <AboutNote testId="about-access-unknown" reason="unexplained" action={{ label: "Try again", run: props.onRetry }}>
            Access information is unavailable for this file. This does not mean that no one has access.
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
}) {
  const { view } = props;
  const empty = view.status === "ready" ? emptyWithin(view.answer) : null;
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
        <AboutRetry testId="about-access-failed" onRetry={props.onRetry} />
      ) : (
        <div
          data-testid="about-access-answer"
          data-freshness={view.answer.freshness}
          data-coverage={view.answer.coverage.kind}
          data-visibility={view.answer.visibility}
        >
          {empty === null ? (
            <AccessUnknown answer={view.answer} setup={props.setup} onRetry={props.onRetry} />
          ) : (
            <>
              <div className="flex items-center gap-2 px-2 pb-1">
                <StateMark
                  testId="about-access-freshness"
                  state={view.answer.freshness}
                  shown={`access-${view.answer.freshness}`}
                />
                {view.answer.checkedAtMs !== null ? (
                  <time
                    dateTime={formatChatTime(view.answer.checkedAtMs).iso}
                    title={formatChatTime(view.answer.checkedAtMs).label}
                    className="font-mono text-[11px] text-subtle"
                  >
                    {formatShortTime(view.answer.checkedAtMs)}
                  </time>
                ) : null}
              </div>
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
                    <button
                      type="button"
                      data-testid="about-access-more"
                      onClick={() => props.onMore(view.answer)}
                      className={`${ABOUT_ROW_BUTTON} h-7 text-[12px]`}
                    >
                      Show more
                    </button>
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
