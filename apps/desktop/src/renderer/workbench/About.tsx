import type { AccessAnswer } from "@dohc/workspace-contracts/access";
import { fileKindForPath } from "@dohc/workspace-contracts/kinds";
import {
  AppWindow,
  ChevronDown,
  ChevronRight,
  Eye,
  FileText,
  History,
  Link2,
  MessageSquare,
  Pencil,
  Share2,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
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

// One line inside a section that is not a row: an empty answer or a failure,
// with the action that can change it.
export function AboutNote(props: {
  testId: string;
  failed?: boolean;
  children: ReactNode;
  onRetry?: () => void;
}) {
  return (
    <div data-testid={props.testId} className="flex flex-col items-start gap-2 px-2 py-1">
      <p className="m-0 flex items-start gap-1.5 text-[12px] leading-4 text-muted">
        {props.failed ? (
          <TriangleAlert size={12} aria-hidden className="mt-0.5 shrink-0 text-danger" />
        ) : null}
        <span>{props.children}</span>
      </p>
      {props.onRetry ? (
        <SecondaryButton size="compact" onClick={props.onRetry}>
          Try again
        </SecondaryButton>
      ) : null}
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

// ---- History ----

export type HistoryView =
  | typeof LOADING
  | { status: "ready"; moments: EngineMomentRecord[]; more: boolean }
  | { status: "unavailable"; message: string };

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
  objectId: string;
  // Changes when the workspace's history grows, so the rows follow edits.
  revision: number;
  expanded: boolean;
  onToggle: () => void;
  onOpenMoment: (momentId: string, filePath: string) => void;
}) {
  const { workspaceId, objectId } = props;
  const key = `${workspaceId}\0${objectId}`;
  const [state, setState] = useState<Keyed<HistoryView>>({ key: "", view: LOADING });
  const token = useRef(0);
  const load = useCallback(async () => {
    const request = ++token.current;
    const commit = (view: HistoryView) => {
      if (request === token.current) setState({ key, view });
    };
    try {
      const response = await bridge().listEngineMoments({ workspaceId, objectId, limit: HISTORY_ROWS });
      if ("status" in response) {
        commit({
          status: "unavailable",
          message: response.status === "updating" ? WORKSPACE_UPDATING_MESSAGE : historyHiddenWords(response.unreadable),
        });
        return;
      }
      commit({ status: "ready", moments: response.moments, more: response.nextBeforeMomentOrder !== null });
    } catch (error) {
      commit({ status: "unavailable", message: ipcErrorMessage(error, "Could not load History for this file.") });
    }
  }, [key, objectId, workspaceId]);
  useEffect(() => {
    if (!props.expanded) return;
    void load();
    return () => {
      token.current += 1;
    };
  }, [load, props.expanded, props.revision]);

  return (
    <AboutHistoryView
      view={state.key === key ? state.view : LOADING}
      expanded={props.expanded}
      onToggle={props.onToggle}
      onRetry={() => void load()}
      onOpenMoment={props.onOpenMoment}
    />
  );
}

// The History section for an answer already in hand. The states page draws it.
export function AboutHistoryView(props: {
  view: HistoryView;
  expanded: boolean;
  onToggle: () => void;
  onRetry: () => void;
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
      ) : view.status === "unavailable" ? (
        <AboutNote testId="about-history-failed" failed onRetry={props.onRetry}>
          {view.message}
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
  | { status: "failed"; message: string };

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
}) {
  const { workspaceId, path } = props;
  const key = `${workspaceId}\0${path}`;
  const [state, setState] = useState<Keyed<AccessView>>({ key: "", view: LOADING });
  const token = useRef(0);
  // Asking main to check again happens when a person opens the section or
  // tries again, not on every file they pass through with it open.
  const read = useCallback(
    async (refresh: boolean) => {
      const request = ++token.current;
      const current = () => request === token.current;
      try {
        if (refresh) {
          // The answer below says how current it is, refreshed or not.
          await bridge().requestAccessRefresh({ workspaceId, reason: "access-expand" }).catch(() => undefined);
          if (!current()) return;
        }
        const answer = await bridge().getObjectAccess({
          workspaceId,
          ref: { kind: "path", path, versionId: null },
        });
        if (current()) setState({ key, view: { status: "ready", answer } });
      } catch (error) {
        if (current()) {
          setState({
            key,
            view: { status: "failed", message: ipcErrorMessage(error, "Could not check who has access to this file.") },
          });
        }
      }
    },
    [key, path, workspaceId],
  );
  const loadMore = useCallback(
    async (answer: AccessAnswer) => {
      if (answer.nextCursor === null) return;
      const request = ++token.current;
      try {
        const next = await bridge().getObjectAccess({
          workspaceId,
          ref: { kind: "path", path, versionId: null },
          cursor: answer.nextCursor,
        });
        if (request !== token.current) return;
        setState({ key, view: { status: "ready", answer: { ...next, rows: [...answer.rows, ...next.rows] } } });
      } catch (error) {
        if (request !== token.current) return;
        setState({
          key,
          view: { status: "failed", message: ipcErrorMessage(error, "Could not check who has access to this file.") },
        });
      }
    },
    [key, path, workspaceId],
  );
  // Opening the section refreshes; a new file while it is open only reads.
  const refreshed = useRef(false);
  useEffect(() => {
    if (!props.expanded) {
      refreshed.current = false;
      return;
    }
    const refresh = !refreshed.current;
    refreshed.current = true;
    void read(refresh);
    return () => {
      token.current += 1;
    };
  }, [props.expanded, read]);

  return (
    <AboutAccessView
      view={state.key === key ? state.view : LOADING}
      expanded={props.expanded}
      onToggle={props.onToggle}
      onRetry={() => void read(true)}
      onMore={(answer) => void loadMore(answer)}
    />
  );
}

// The Access section for an answer already in hand. The states page draws it.
export function AboutAccessView(props: {
  view: AccessView;
  expanded: boolean;
  onToggle: () => void;
  onRetry: () => void;
  onMore: (answer: AccessAnswer) => void;
}) {
  const { view } = props;
  const empty = view.status === "ready" ? emptyWithin(view.answer) : null;
  return (
    <AboutSection
      id="access"
      icon={Share2}
      label="Access"
      count={view.status === "ready" && empty !== null ? `${view.answer.rows.length}${view.answer.nextCursor ? "+" : ""}` : undefined}
      expanded={props.expanded}
      onToggle={props.onToggle}
    >
      {view.status === "loading" ? (
        <SkeletonLines rows={2} className="px-2 py-1" />
      ) : view.status === "failed" ? (
        <AboutNote testId="about-access-failed" failed onRetry={props.onRetry}>
          {view.message}
        </AboutNote>
      ) : (
        <div
          data-testid="about-access-answer"
          data-freshness={view.answer.freshness}
          data-coverage={view.answer.coverage.kind}
          data-visibility={view.answer.visibility}
        >
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
          {empty === null ? (
            <AboutNote testId="about-access-unknown" onRetry={props.onRetry}>
              dohc could not check who has access. This does not mean that no one has access.
            </AboutNote>
          ) : view.answer.rows.length === 0 ? (
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
        </div>
      )}
    </AboutSection>
  );
}
